# Object store: where vaults live between sessions

Status: **PR-41a** added an S3-compatible bucket and an engine adapter; **PR-41b** syncs the seat
owner's profile through it (below), and PR-41c makes media lazy and caches embeddings. With
`OBJECT_STORE_*` or `VAULT_SYNC_ACCOUNT` unset (the default), the engine behaves exactly as before.

Why it exists: study sessions are moving to ephemeral per-session VMs. A backend spawns a fresh
VM, restores the student's vault from a central store, syncs often, then makes a final sync and
tears the VM down on idle. The store is S3-compatible: MinIO locally and in docker, and
DigitalOcean Spaces later. Switching is configuration only.

## What is stored where

One bucket (`sef-vaults`), one prefix per student. The keys come from `engine/src/store/keys.ts`
(`vaultKey`, `blobKey`, `syncManifestKey`), which rejects traversal, empty segments, control
characters, non-NFC names and any account id outside `[A-Za-z0-9_-]`. No other code builds keys.

```
vaults/<accountId>/
  manifest.json                 the sync manifest: which bytes make up the latest version (CAS-only)
  files/<relPath>               text files, relPath relative to ENGINE_DATA_DIR/profiles/<id>/
    brain/concepts/ … brain/.meta/manifest.json, sessions/, quizzes/, content/, plans/, …
  blobs/sha256/<hh>/<sha256>    media and large files, content-addressed
```

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

`engine/src/store/`: `ObjectStore` (`put` with optional `ifNoneMatch: '*'` or `ifMatch: <etag>`, `get`, `head`,
paginated `list`, idempotent `delete`, `ping`), `S3ObjectStore` (SigV4 over `fetch` via
`aws4fetch`, zero transitive dependencies), and `MemoryObjectStore` for tests.
`createObjectStore(config.objectStore)` returns `null` when the store is off. Bodies are buffers
for now (see the risks below).

## Vault sync (PR-41b)

`engine/src/sync/`. On when the object store is configured **and** `VAULT_SYNC_ACCOUNT` names the
seat owner's uni account id (it must be in `ENGINE_SEAT_OWNER` when that is set, or boot fails).
It syncs one profile: `ENGINE_DATA_DIR/profiles/<VAULT_SYNC_ACCOUNT>/`.

### What is synced

The scope is an allowlist (`engine/src/sync/scope.ts`): a store added later is not synced until
it is named there.

| Profile path | Synced | How | Why |
| --- | --- | --- | --- |
| `brain/` pages, `index.md`, `log.md`, `SCHEMA.md`, `.history/` | yes | text, `files/…` | The vault is the source of truth; the graph is recomputed from it |
| `brain/.meta/` manifest, sources, extracted text, events, proposals, jobs, recovery, tombstones, maintenance | yes | text | Pending proposals and job status are what a student resumes |
| `brain/raw/` (uploaded originals) | yes | `blobs/…` | Uploaded once per hash; fetched during the restore (lazily from PR-41c) |
| `brain/.meta/embeddings/` | no (cache in PR-41c) | | Derived and rebuilt by the existing code |
| `brain/.meta/journal/`, `brain/.meta/writer.lock` | no | | In-flight state of one process; `recover()` finishes a commit locally and the result syncs |
| `sessions/`, `quizzes/`, `plans/` | yes | text | Chat history, quiz evidence (mastery is computed from it), approved plans |
| `content/` (installed courseware) | yes | text | Saves a re-install per session. Trusted at the bucket's level (see risks) |
| `logistics.json`, `feeds.json` (consents), `signals.json` (dismissals), `shares.json` | yes | text | The student's own state |
| any other file ≥ 1 MiB in the scope | yes | `blobs/…`, eager | Uploaded once per hash; fetched during the restore |
| `private-settings.json` | **no** | | Holds provider credentials; a session VM gets its model config from its own env |
| `eval-events.jsonl` | **no** | | Local-only counters, promised never to leave the device |
| `suggestions-*.json` | no | | A cache, regenerated |
| `.vault-sync.json` | no | | This machine's sync state (last etag, stat cache) |
| device files: `settings.json`, `profiles.json`, `auth-sessions.json`, `trust/`, `seat-owner.json`, credentials | **no** | | Outside the profile; sessions and secrets are per machine |
| symlinks, `*.tmp` | no | | Never followed; temp files of an atomic write |

### Manifest

`vaults/<acc>/manifest.json` is `{format, account, version, updatedAt, files, tombstones}`
with `files: {relPath: {sha256, size, mtime, kind}}` (`kind` is `text`, `media` or `large`) and
`tombstones: {relPath: {deletedAt, sha256}}`. Every write is a compare-and-swap: `If-Match` on the
etag this machine last saw (`If-None-Match: *` for a new account). The adapter gained `ifMatch`
for this; the shared store contract tests it, including on live MinIO.

**Push** (one at a time): scan the profile (stat first, rehash only what changed; text is read
under the vault's writer lock, so a page and its catalogue are one moment), diff against the last
synced manifest, `HEAD` the manifest to refuse early if it moved, upload changed text to
`files/<path>` and new blobs once (`HEAD`, then `If-None-Match: *`), then swap the manifest. Only
after a successful swap are objects the new version no longer names deleted: removed text files,
and blobs nothing references (an erased source is erased from the store too). A push with nothing
changed makes no request at all.

**A lost swap is a second writer.** With one VM per student (the PR-42 lease) it never happens. If
it does, sync refuses: no merge and no retry. It logs `vault_sync_conflict`, health reports
`sync.state: 'error'`, and later pushes are refused. The other writer's version stands, and
bucket versioning keeps everything.

**Deletes** become tombstones in the manifest (kept 90 days, at most 20,000); a machine restoring
a newer version deletes those paths locally. Erasing a source in the vault removes its `raw/` file,
so the next push tombstones it and deletes its blob.

**Restore** runs at boot, before `/api/*` is served: until it finishes, every `/api/*` route except
`/api/health` and the flush answers `503 vault_restoring` (or `vault_restore_failed`). It
downloads the manifest and every text file that differs and verifies the hashes. A missing
manifest is a new account; a missing manifest on a machine that already synced is an error, never
a silent fresh start. If the remote is still the version this machine last pushed (an engine
restart), nothing is pulled, so unpushed local edits survive. A text object whose hash is newer
than the manifest is what a push cut off between its uploads and its swap leaves behind; it is
kept ("rolled forward", logged) and the next push commits it. A blob that fails its hash fails
the restore. Three attempts with backoff, then `error`.

**Timing.** A push runs 7 s after the last write (capped at 30 s of continuous writes), plus a
safety push every 60 s that catches writes no hook saw (a background job, an edit in Obsidian).
Write notices come from the wiki store's commits and job writes, and from every successful
`/api/*` mutation. Pushes never overlap: requests during a push share one follow-up push.

### Health and the UI

Public `GET /api/health` gains `sync: {state}` (`restoring`, `ready` or `error`) when sync is on,
and nothing else; without sync the shape is unchanged. The orchestrator polls it until `ready`.
`/api/health/detail` (signed in) adds `savedAt` and `pending`; the sidebar's status tooltip shows
"Saved · just now" or "Sync error".

### Final flush

`POST /api/internal/sync/flush` pushes everything after any push in flight and returns `{ok, pushed, version}`, or `{ok: false, error}` (`conflict`, `push_failed`,
`timeout` after 50 s, `not_restored`). It is refused unless the socket peer is loopback, **no**
`X-Forwarded-*`, `Forwarded` or `X-Real-IP` header is present, and `Authorization: Bearer
$SYNC_FLUSH_TOKEN` matches (constant-time; at least 24 characters, else the endpoint stays shut).
On a hosted seat the edge connects from loopback but always adds `X-Forwarded-*`, so public
traffic can never reach it.

`infra/seat/session-stop.sh` calls it from inside the box and prints the JSON. It reads the token
from its environment, `$SEAT_ENV_FILE`, `$SEAT_HOME/session.env`, `$SEAT_HOME/seat.env` or the
repo `.env` (as data, never sourced), and passes it to curl on stdin.

### Environment

```bash
OBJECT_STORE_ENDPOINT=…  OBJECT_STORE_BUCKET=…  OBJECT_STORE_ACCESS_KEY=…  OBJECT_STORE_SECRET_KEY=…
OBJECT_STORE_REGION=…  OBJECT_STORE_FORCE_PATH_STYLE=…   # as above
VAULT_SYNC_ACCOUNT=<uni account id>                      # turns sync on; = ENGINE_SEAT_OWNER
SYNC_FLUSH_TOKEN=<random, ≥ 24 chars>                    # the flush endpoint's bearer
```

### Integration test

`engine/src/sync/vault-sync.integration.test.ts` runs two engines (two data dirs) for one account
against a real server: A writes pages, ~6 MB of history and a 4 MB image and flushes; B restores
and sees all of it; B then pushes and the stale A is refused.
Same variables as the store test:

```bash
OBJECT_STORE_TEST_ENDPOINT=http://127.0.0.1:9000 OBJECT_STORE_TEST_BUCKET=sef-vaults \
OBJECT_STORE_TEST_ACCESS_KEY=sef-engine OBJECT_STORE_TEST_SECRET_KEY=sef-engine-local-dev-only \
  pnpm --filter @sef/engine exec node --test --import tsx src/sync/vault-sync.integration.test.ts
```

### Risks and follow-ups

- **One shared engine key in v1.** Any VM holding it can read and write every student's prefix,
  so `content/` (and the vault) are only as trusted as the bucket. Per-session credentials scoped
  to `vaults/<accountId>/` (STS or a session policy) are the follow-up, as are leases in Postgres
  (PR-42).
- **`If-Match` on PUT** is supported by MinIO and AWS S3. Run the store contract test against
  DigitalOcean Spaces before switching: a store that ignored the header would make the CAS a no-op.
- Bodies are whole buffers: a 256 MB recording is held in memory while it uploads or downloads.
  Streaming is a follow-up.
- A compile job running at teardown is restored as it was last written, as after any engine restart.
