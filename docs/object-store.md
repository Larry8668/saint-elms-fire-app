# Object store: where vaults live between sessions

Status: **PR-41a, plumbing only.** This PR adds an S3-compatible bucket and an engine adapter.
Nothing reads or writes vaults through it yet; `pnpm store:check` is the only caller. With
`OBJECT_STORE_*` unset (the default), the engine behaves exactly as before.

Why it exists: study sessions are moving to ephemeral per-session VMs. A backend spawns a fresh
VM, restores the student's vault from a central store, syncs often, then makes a final sync and
tears the VM down on idle. The store is S3-compatible: MinIO locally and in docker, and
DigitalOcean Spaces later. Switching is configuration only.

## What is stored where

One bucket (`sef-vaults`), one prefix per student. The keys come from `engine/src/store/keys.ts`
(`vaultKey`, `blobKey`), which rejects traversal, empty segments, control characters, non-NFC
names and any account id outside `[A-Za-z0-9_-]`. No other code builds keys.

```
vaults/<accountId>/
  files/<relPath>               the vault tree, mirroring ENGINE_DATA_DIR/profiles/<id>/
    concepts/ sources/ syntheses/ questions/   markdown pages — the source of truth
    .history/                   page revisions
    .meta/manifest.json         vault manifest (and journal/, proposals/, jobs/, tombstones/ …)
  blobs/sha256/<hh>/<sha256>    raw/ media (video, audio, images, PDFs), content-addressed
```

| Vault data | In the store | Notes |
| --- | --- | --- |
| Pages, `.history/`, `.meta/` (manifest, journal, proposals, jobs, tombstones) | `files/…`, synced eagerly | Small text; the knowledge graph is recomputed from pages, so there is no graph DB |
| `raw/` uploads | `blobs/sha256/…` | Stored once per hash, immutable, fetched lazily |
| `.meta/embeddings/` | `files/.meta/embeddings/…` as a cache, at most | Derived and rebuildable; a missing cache is never an error |

Versioning is **on** for the bucket. This is cheap protection against sync bugs: an overwrite or
delete leaves the previous version recoverable by an operator. The engine key cannot purge
versions or change versioning (explicit Deny in `infra/minio/engine-policy.json`).

## Run MinIO locally

```bash
pnpm store:up        # MinIO on 127.0.0.1:9000, console on 127.0.0.1:9001, plus minio-init
pnpm store:console   # opens http://127.0.0.1:9001 — log in as sef-minio-admin / sef-minio-local-dev-only
pnpm store:down      # stop (data stays in the minio-data volume)
```

`minio-init` is a one-shot, idempotent bootstrap (`infra/minio/init.sh`), safe on every `up`. It:

1. creates the bucket `OBJECT_STORE_BUCKET` (default `sef-vaults`) if it is missing;
2. turns versioning on;
3. creates the user `OBJECT_STORE_ACCESS_KEY` with a policy limited to that bucket: list, get,
   put and delete objects, with no admin rights, no other buckets and no version purge.

The engine uses that key and never the root login. To point a host-run engine at it, uncomment
the `OBJECT_STORE_*` block in `.env` (the dev defaults match compose), then run:

```bash
pnpm store:check     # store: configured — … / store: reachable in 40ms
```

A compose-run engine container must use `OBJECT_STORE_ENDPOINT=http://minio:9000`.
Plain `http` is accepted only for loopback and single-label (compose service) hosts; anything
else needs `https`. Set your own `MINIO_ROOT_PASSWORD` and `OBJECT_STORE_SECRET_KEY` before the
store holds anything you care about. The defaults are local-only.

**Image note.** Upstream MinIO stopped publishing images and archived its repository in 2026;
`minio/minio` and `minio/mc` no longer pull from Docker Hub. Compose uses Chainguard's maintained
builds (`cgr.dev/chainguard/minio`, `…/minio-client`), pinned by multi-arch index digest. Bump the
digests in `docker-compose.yml` and `infra/minio/init.Dockerfile` together. Any S3-compatible
server works with the adapter if this source ever goes away.

### Integration test

`engine/src/store/s3-store.integration.test.ts` runs the shared ObjectStore contract (also run
against the in-memory store in `pnpm test`) against a real server. It is skipped unless
`OBJECT_STORE_TEST_ENDPOINT` is set:

```bash
pnpm store:up
OBJECT_STORE_TEST_ENDPOINT=http://127.0.0.1:9000 OBJECT_STORE_TEST_BUCKET=sef-vaults \
OBJECT_STORE_TEST_ACCESS_KEY=sef-engine OBJECT_STORE_TEST_SECRET_KEY=sef-engine-local-dev-only \
  pnpm --filter @sef/engine exec node --test --import tsx src/store/s3-store.integration.test.ts
```

It writes under a random `vaults/test-<uuid>/` prefix and deletes it afterwards. Versioning keeps
delete markers, which are harmless in a dev bucket.

## Switch to DigitalOcean Spaces

1. Create a Space (bucket) in a region, e.g. `blr1`, and turn on versioning in its settings.
2. Go to **API → Spaces Keys → Generate New Key**. Prefer a key limited to that one bucket
   (Spaces supports per-bucket access keys) with read/write rights.
3. Set the engine environment:

   ```bash
   OBJECT_STORE_ENDPOINT=https://blr1.digitaloceanspaces.com
   OBJECT_STORE_REGION=blr1
   OBJECT_STORE_BUCKET=<your-space>
   OBJECT_STORE_ACCESS_KEY=<spaces key>
   OBJECT_STORE_SECRET_KEY=<spaces secret>
   OBJECT_STORE_FORCE_PATH_STYLE=false   # https://<space>.blr1.digitaloceanspaces.com/<key>
   ```

4. Run `pnpm store:check`.

## Adapter

`engine/src/store/`: `ObjectStore` (`put` with optional `ifNoneMatch: '*'`, `get`, `head`,
paginated `list`, idempotent `delete`, `ping`), `S3ObjectStore` (SigV4 over `fetch` via
`aws4fetch`, zero transitive dependencies), and `MemoryObjectStore` for tests.
`createObjectStore(config.objectStore)` returns `null` when the store is off. Bodies are buffers
today; streaming large media is part of the next PR.

## Next: the sync service (PR-41b)

- **Text sync by manifest and hash.** The engine keeps a local sync manifest of
  `relPath → sha256, size, remote etag`. Push uploads only changed files. Pull compares the remote
  manifest object and fetches only what differs. Manifest updates are compare-and-swap, so two
  writers cannot silently interleave. That needs `If-Match` on put, which the adapter will gain.
- **Lazy media.** `raw/` files upload once to `blobs/sha256/…` with `ifNoneMatch: '*'`, which
  dedupes by content. A restored VM gets only the pages and manifest, and media is fetched on
  first open.
- **Deletes are tombstones.** A delete writes `.meta/tombstones/…`, which already exists for
  source erasure. Peers apply it, and the object is deleted after the tombstone syncs. Bucket
  versioning stays as the safety net.
- **Leases in Postgres.** One writer per vault: the backend grants a session VM a lease (account,
  VM, expiry, heartbeat) in the uni Postgres, together with sync state (last manifest etag, last
  sync time). A VM without a live lease is read-only. Final sync on idle releases the lease.
- **Per-session credentials.** Rather than one shared engine key, the backend mints short-lived
  credentials scoped to `vaults/<accountId>/` (STS / session policy) for each VM.
