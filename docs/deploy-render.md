# Hosted backends on Render

`render.yaml` (a Render Blueprint) describes the hosted half of the demo: the university server
with the session orchestrator, the model gateway, the MinIO vault store and Postgres. Student
workspaces are Instabox VMs (docs/session-orchestrator.md); models run on whatever
`GATEWAY_UPSTREAMS` points at.

```
browser ──▶ sef-uni (accounts, /app portal, /v1/session) ──Instabox API──▶ session VM (engine)
                │ Postgres (sef-uni-db, private network)                      │   │
                                                                              │   └─▶ sef-minio (vault sync, S3 API)
                                                                              └─▶ sef-gateway ──▶ GATEWAY_UPSTREAMS (Ollama)
```

| Service | What | URL |
|---|---|---|
| `sef-uni` | Docker, `infra/docker/node-service.Dockerfile` (`uni` stage), runs `db:migrate` then the server (`start:migrate`) | https://sef-uni.onrender.com (`/health`, `/ready`, `/app`) |
| `sef-gateway` | same Dockerfile, `SERVICE=@sef/gateway` | https://sef-gateway.onrender.com (`/health`) |
| `sef-minio` | `cgr.dev/chainguard/minio`, same digest as `docker-compose.yml`; S3 API only (`MINIO_BROWSER=off`, no console port) | https://sef-minio.onrender.com |
| `sef-uni-db` | Render Postgres 17, internal connection string only | - |

All in `singapore`. Render passes service env vars to the Docker build as build args, which is how
`SERVICE` selects the workspace package. The uni must be on a plan that never sleeps: the session
reaper (idle VMs, orphan sweep) runs inside the uni process.

## Environment

Secrets are marked. The operator's copies live in `~/.config/sef/render.env` (mode 600, never in
the repo); `INSTABOX_API_KEY` comes from `~/.config/sef/instabox.env`.

| Service | Variable | Secret | Value |
|---|---|---|---|
| uni | `SERVICE`, `PORT`/`UNI_PORT` | | `@sef/uni-server`, `4200` |
| uni | `UNI_DATA_DIR`, `KEYS_DIR` | | `/data`, `/data/keys` (the disk: signing keys, legacy accounts, releases, shares, audit) |
| uni | `UNI_SIGNING_PRIVATE_KEY` | yes | base64 of the ed25519 PKCS#8 PEM (see Signing key). Set: wins over `KEYS_DIR`, nothing is written there |
| uni | `UNI_DATABASE_URL` | yes | Postgres internal connection string |
| uni | `UNI_PUBLIC_URL` | | `https://sef-uni.onrender.com` (production requires https) |
| uni | `BETTER_AUTH_SECRET` | yes | generated, 32+ chars |
| uni | `MAIL_SMTP_URL` | | `smtp://127.0.0.1:1025`: a deliberate no-op. Demo (legacy) logins send no mail; sign-up, verification and password reset will fail until this is a real relay |
| uni | `SEED_DEMO`, `DEMO_PASSWORD` | password: yes | `true`; production refuses the public `harbor-lantern`, so a private one is generated |
| uni | `INSTABOX_API_KEY` | yes | operator key |
| uni | `SEF_GOLDEN_SNAPSHOT_ID` | | `sn_agquw3rpykrsqophbvuy3hnlpy` |
| uni | `SESSION_MAX_CONCURRENT`, `SESSION_IDLE_MINUTES` | | `4`, `5` (an idle VM is ended 5 min after its last heartbeat, while the uni is awake) |
| uni | `MODEL_GATEWAY_URL` | | `https://sef-gateway.onrender.com/v1` |
| uni + gateway | `GATEWAY_TOKEN_SECRET` | yes | one value, shared (the uni mints, the gateway verifies) |
| uni | `OBJECT_STORE_ENDPOINT`, `_BUCKET`, `_REGION`, `_FORCE_PATH_STYLE`, `_ACCESS_KEY` | | the laptop MinIO's tunnel URL (see Vault store), `sef-vaults`, `us-east-1`, `true`, `sef-engine` |
| uni | `OBJECT_STORE_SECRET_KEY` | yes | the engine key's secret (bucket-scoped, created by the init below) |
| uni | `APP_PUBLIC_ORIGIN` | | not set yet (lands with the client PR) |
| gateway | `GATEWAY_HOST`, `PORT`/`GATEWAY_PORT` | | `0.0.0.0`, `4300` |
| gateway | `GATEWAY_MODELS` | | `gemma4:e2b,gemma4:e4b,embeddinggemma,shieldgemma:2b` |
| gateway | `GATEWAY_UPSTREAMS` | | the model workers (see below) |
| minio | `PORT`, `MINIO_BROWSER` | | `9000`, `off` |
| minio | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | password: yes | `sef-minio-admin`, generated; never given to the uni or a VM |

## Signing key

Course packages and offline entitlements are signed with the uni's ed25519 key, and every engine
pins that key on first use (`engine/src/uni/trust.ts`): a different key later is refused. On a host
without a persistent disk a key in `KEYS_DIR` is regenerated on every boot, which breaks every
pinned device, so the hosted uni takes its key from the environment:

```bash
KEYS_DIR=$(mktemp -d) pnpm -s keys:uni:export >> ~/.config/sef/render.env   # generates a pair; stdout is only the env line
# from an existing keys dir instead: KEYS_DIR=/path/to/keys pnpm -s keys:uni:export
# or with openssl: printf 'UNI_SIGNING_PRIVATE_KEY=%s\n' "$(base64 < /path/to/keys/signing-private.pem | tr -d '\n')"
```

The value is base64 of the PEM (a raw PEM, with real or `\n`-escaped newlines, is accepted too).
On boot the uni logs `signing_keys_from_env` with the key's fingerprint (sha256 of the SPKI DER,
16 hex chars), never the key. A value that is not an ed25519 private key refuses to boot. Unset:
the file behaviour is unchanged. Rotating it invalidates every pinned device (VMs are recreated
fresh, so only long-lived engines are affected).

Set it through the REST API, then redeploy (see Model workers for the deploy call):

```bash
T=$(awk '/^ *key:/ {print $2; exit}' ~/.render/cli.yaml)
V=$(sed -n 's/^UNI_SIGNING_PRIVATE_KEY=//p' ~/.config/sef/render.env)
curl -fsS -o /dev/null -X PUT -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  https://api.render.com/v1/services/<uni-id>/env-vars/UNI_SIGNING_PRIVATE_KEY -d "{\"value\":\"$V\"}"
```

## First deploy

1. Dashboard → New → Blueprint → this repo; fill the `sync: false` values from the table.
   (The CLI only validates Blueprints: `render blueprints validate render.yaml`. Services can
   also be created one by one through the REST API, which is how the first deploy was done.)
2. One-time MinIO init, from a laptop with Docker, reusing `infra/minio/init.sh` unchanged:

   ```bash
   docker build -t sef-minio-init -f infra/minio/init.Dockerfile infra/minio
   set -a; . ~/.config/sef/render.env; set +a
   MINIO_INTERNAL_URL=https://sef-minio.onrender.com docker run --rm \
     -e MINIO_INTERNAL_URL -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD \
     -e OBJECT_STORE_BUCKET -e OBJECT_STORE_ACCESS_KEY -e OBJECT_STORE_SECRET_KEY sef-minio-init
   ```

   It is idempotent. Re-run it if the MinIO disk is ever replaced.
3. Check the store with the engine key, including the `If-Match` compare-and-swap:

   ```bash
   cd engine && OBJECT_STORE_TEST_ENDPOINT=https://sef-minio.onrender.com OBJECT_STORE_TEST_BUCKET=sef-vaults \
     OBJECT_STORE_TEST_ACCESS_KEY=sef-engine OBJECT_STORE_TEST_SECRET_KEY="$OBJECT_STORE_SECRET_KEY" \
     node --test --import tsx src/store/s3-store.integration.test.ts
   ```

## Vault store: the laptop's MinIO today, DO Spaces tomorrow

The free `sef-minio` service has no disk and comes back empty after every spin-down, so it is
**suspended** (kept as a fallback) and the uni points at the laptop's MinIO through a cloudflared
quick tunnel. Start it with the operator secrets so the tunnel never exposes the dev defaults; the
named volume `minio-data` keeps vaults across restarts:

```bash
set -a; . ~/.config/sef/render.env; set +a
docker compose --profile store up -d --build minio minio-init   # = pnpm store:up, with the real keys
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:9000   # no --http-host-header: S3 signs the Host
```

Switching the store (a new tunnel URL, DO Spaces, back to `sef-minio`) is one command, in order:

1. **Run the store contract test first** against the new endpoint (the command under First deploy,
   step 3, with `OBJECT_STORE_TEST_ENDPOINT=<new>`; for Spaces add `OBJECT_STORE_TEST_REGION` and
   `OBJECT_STORE_TEST_FORCE_PATH_STYLE=false`). It must pass, `If-Match` included.
2. **Mirror the vaults** if the old store has any (versions are not carried over, current objects are):
   `mc mirror --preserve old/sef-vaults new/sef-vaults` with root (or Spaces) aliases for both.
3. Point the uni at it and redeploy:

   ```bash
   OBJECT_STORE_SECRET_KEY=<secret> scripts/store-target.sh <endpoint> [access-key] [bucket] [region] [path-style]
   scripts/store-target.sh   # prints the uni's current OBJECT_STORE_* (secret masked)
   ```

   DO Spaces: `scripts/store-target.sh https://sgp1.digitaloceanspaces.com <spaces-key> <bucket> sgp1 false`.
   Turn on bucket versioning there, and use a key limited to that bucket.

Running sessions keep the endpoint they started with; end them before switching.

## Model workers: the tunnel today, a GPU box tomorrow

`GATEWAY_UPSTREAMS` is the only thing that changes. Today it is a cloudflared quick tunnel to a
laptop's Ollama. Ollama refuses a non-local `Host` header, so the tunnel rewrites it:

```bash
cloudflared tunnel --no-autoupdate --http-host-header localhost:11434 --url http://127.0.0.1:11434
```

A quick tunnel gets a new `*.trycloudflare.com` URL every time it starts. To restart and rotate:

```bash
cloudflared tunnel --no-autoupdate --http-host-header localhost:11434 --url http://127.0.0.1:11434
# note the https://<new>.trycloudflare.com it prints, then (the CLI cannot edit env vars; the REST API can):
T=$(awk '/^ *key:/ {print $2; exit}' ~/.render/cli.yaml); GW=$(DO_NOT_TRACK=1 render services -o json | python3 -c 'import json,sys; print([s["service"]["id"] for s in json.load(sys.stdin) if s.get("service",{}).get("name")=="sef-gateway"][0])')
curl -fsS -X PUT -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  https://api.render.com/v1/services/$GW/env-vars/GATEWAY_UPSTREAMS -d '{"value":"https://<new>.trycloudflare.com"}'
curl -fsS -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  https://api.render.com/v1/services/$GW/deploys -d "{\"commitId\":\"$(git ls-remote origin refs/heads/main | cut -f1)\"}"
```

(A deploy request without `commitId` gets a 500 from the API.) Sessions need nothing else: VMs
only know the gateway's URL.

**DigitalOcean GPU box:** set `GATEWAY_UPSTREAMS=http://<droplet-ip>:11434` (or several,
comma-separated, `#max=N` for per-worker concurrency; `vllm:https://…` for a vLLM worker, plus
`GATEWAY_UPSTREAM_TOKEN` if it has an API key). Start Ollama there with `OLLAMA_HOST=0.0.0.0`,
`OLLAMA_CONTEXT_LENGTH=12288`, firewall 11434 to Render's outbound IPs (Dashboard → sef-gateway →
Connect → Outbound), and pull `gemma4:e2b gemma4:e4b embeddinggemma shieldgemma:2b`. Nothing else changes.

## Reset the demo data

- **Sessions only:** `DELETE /v1/session` per student, or staff `POST /v1/admin/sessions/:id/end`.
- **Accounts and the uni's files:** the uni seeds on first boot, i.e. when `/data` has no accounts.
  Wipe Postgres (`render psql <db-id>` → `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`) and
  the uni disk (`render ssh <uni-id>` → `rm -rf /data/*`), then restart (`render restart <uni-id>`).
  Migrations run again on start.
- **Vaults:** `mc rm --recursive --force --versions sef/sef-vaults/vaults/<accountId>/` with the root
  alias (the engine key cannot delete versions, by design).

## After merge

Services were created on the `infra/render` branch. Point them at `main`:
`render services update <id> --branch main --confirm -o json` for `sef-uni` and `sef-gateway`.

## Current state (2026-10-18): free tier until billing is added

The workspace has no payment method, so Render refused Starter, disks and paid Postgres
(`render blueprints validate render.yaml` reports `need_payment_info`). The services run on
**free** plans meanwhile: they sleep after 15 idle minutes (the uni's reaper sleeps with it), have
no disks, and the free database expires after 30 days. A sleeping MinIO comes back **empty**
(bucket and engine key gone), so re-run the one-time init after any MinIO restart until it has a disk.

To reach the `render.yaml` target:

1. Dashboard → Workspace settings → Billing → add a card.
2. `render services update <id> --plan starter --confirm -o json` for `sef-uni`, `sef-gateway`, `sef-minio`.
3. Dashboard → `sef-uni-db` → Info → Update → Basic-256mb (upgrades in place).
4. Dashboard → `sef-minio` → Disks → Add disk: mount path `/data`, 5 GB. Same for `sef-uni`, 1 GB.
   Both disks start empty: re-run the MinIO init, and the uni re-seeds its demo accounts on the
   next boot (same `DEMO_PASSWORD`). The MinIO image runs as uid 65532 and the uni as `node`:
   check each service's log for a write error on `/data` after the disk is attached.
