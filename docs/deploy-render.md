# Hosted backends on Render

`render.yaml` (a Render Blueprint) describes how to deploy the hosted half of the demo: the
university server with the session orchestrator, the model gateway, the SearXNG search
service, the MinIO vault store and Postgres. It declares target configuration — plans, disks
and env placeholders — not a report of what is currently deployed; verify the console before
treating any of it as live. Student workspaces are Instabox VMs
(docs/session-orchestrator.md); models run on whatever `GATEWAY_UPSTREAMS` points at.

```
browser ──▶ sef-uni (accounts, /app portal, /v1/session) ──Instabox API──▶ session VM (engine)
                │ Postgres (sef-uni-db, private network)                      │   │
                                                                              │   ├─▶ sef-minio (vault sync, S3 API)
                                                                              │   └─▶ sef-search (SearXNG, via SEARXNG_URL)
                                                                              └─▶ sef-gateway ──▶ GATEWAY_UPSTREAMS (Ollama)
```

| Service | What | URL |
|---|---|---|
| `sef-uni` | Docker, `infra/docker/node-service.Dockerfile` (`uni` stage), runs `db:migrate` then the server (`start:migrate`) | https://sef-uni.onrender.com (`/health`, `/ready`, `/app`) |
| `sef-gateway` | same Dockerfile, `SERVICE=@sef/gateway` | https://sef-gateway.onrender.com (`/health`) |
| `sef-search` | Docker, `infra/searxng/Dockerfile` (SearXNG), port `8080`, health `/healthz`; its URL is the uni's `SEARXNG_URL`, passed to every seat | https://sef-search.onrender.com |
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
| uni | `MAIL_SMTP_URL` | | an actual SMTP relay. `smtp://127.0.0.1:1025` satisfies the production check without sending: sign-up, verification and password reset fail until it is real |
| uni | `MAIL_RESEND_API_KEY` | yes | Alternative to `MAIL_SMTP_URL`: Resend's HTTPS API (Render blocks outbound SMTP ports). `MAIL_FROM` defaults to `onboarding@resend.dev`, the only sender a Resend account without a verified domain may use; such an account also delivers only to its owner's address. Setting the key is no promise that mail arrives |
| uni | `SEED_DEMO`, `DEMO_PASSWORD` | password: yes | `true` for the public demo build (`false` for a private deployment); production refuses the public `harbor-lantern`, so set a private `DEMO_PASSWORD` |
| uni | `INSTABOX_API_KEY` | yes | operator key |
| uni | `SEF_GOLDEN_SNAPSHOT_ID` | | `<current golden snapshot id>` — what the golden build last produced (see Deployment checks) |
| uni | `SESSION_MAX_CONCURRENT`, `SESSION_IDLE_MINUTES` | | `3` (blueprint), `15` (code default) — configurable capacity/idle limits; `SESSION_PINNED_ACCOUNTS` workspaces survive a student's own workspace end but still yield to staff end, idle reaping and lease expiry |
| uni | `SESSION_PINNED_ACCOUNTS` | | comma-separated account ids (e.g. the demo personas) whose VMs are kept on `DELETE /v1/session` |
| uni | `MODEL_GATEWAY_URL` | | `https://sef-gateway.onrender.com/v1` |
| uni + gateway | `GATEWAY_TOKEN_SECRET` | yes | one value, shared (the uni mints, the gateway verifies) |
| uni | `SEARXNG_URL` | | `https://sef-search.onrender.com` — sent to every seat; unset, seats have no web search |
| uni | `OBJECT_STORE_ENDPOINT`, `_BUCKET`, `_REGION`, `_FORCE_PATH_STYLE`, `_ACCESS_KEY` | | the vault store's endpoint — the persistent-disk MinIO in this blueprint is `https://sef-minio.onrender.com` (see Vault store), `sef-vaults`, `us-east-1`, `true`, `sef-engine` |
| uni | `OBJECT_STORE_SECRET_KEY` | yes | the engine key's secret (bucket-scoped, created by the init below) |
| uni | `APP_PUBLIC_ORIGIN` | | the student web app's https origin, e.g. `https://saint-elms-fire.vercel.app` — required for the Vercel app to call VMs; see [deploy-vercel.md](deploy-vercel.md) |
| uni (portal build) | `VITE_APP_URL`, `VITE_DEMO_MODE`, `VITE_DEMO_SELF_SERVE`, `VITE_DEMO_PASSWORD` | demo password: yes (public by design) | the web-app origin and the demo/self-serve switches baked into the `/app` bundle — values and analytics keys (`VITE_POSTHOG_*`, `PORTAL_ANALYTICS_ORIGINS`) are in [deploy-vercel.md](deploy-vercel.md) |
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
the file behaviour is unchanged. Rotating it invalidates engines that pinned the previous key; preserve continuity for existing students.

Set it through the REST API, then deploy the intended revision from the Render dashboard:

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

## Vault store: persistent storage and migration

Durable vaults need a persistent store. The blueprint gives `sef-minio` a disk
(`minio-data`, 5 GB at `/data`) — without one the bucket and engine key are lost on every
restart and the MinIO init must be re-run. Which endpoint a *live* uni uses is whatever its
`OBJECT_STORE_*` env says; this guide does not infer it.

Switching the store (a different endpoint, a rotated tunnel, back to `sef-minio`) is, in
order:

1. **Run the store contract test first** against the new endpoint (the command under First
   deploy, step 3, with `OBJECT_STORE_TEST_ENDPOINT=<new>` and the matching
   `OBJECT_STORE_TEST_*` values). It must pass, `If-Match` included — S3 compatibility
   alone is insufficient.
2. **Pause new workspace creation and quiesce existing writers**, completing a final flush
   to the old endpoint before the final mirror. Keep writes paused until the uni and all
   retained VMs target the new store. **Mirror the vaults** if the old store has any
   (versions are not carried over, current objects are):
   `mc mirror --preserve old/sef-vaults new/sef-vaults` with root aliases for both.
3. Point the uni at it and redeploy:

   ```bash
   OBJECT_STORE_SECRET_KEY=<secret> scripts/store-target.sh <endpoint> [access-key] [bucket] [region] [path-style]
   scripts/store-target.sh   # prints the uni's current OBJECT_STORE_* (secret masked)
   ```

Running sessions keep the endpoint they started with — reconfigure or retire them. A
student's ordinary `DELETE` retires a non-pinned workspace, while a pinned demo VM is kept
by design, so ending one needs the staff session end or a recreate.

## Model workers

`GATEWAY_UPSTREAMS` is a comma-separated list of Ollama/OpenAI-compatible workers the
gateway load-balances (`#max=N` for per-worker concurrency; `vllm:https://…` for a vLLM
worker, plus `GATEWAY_UPSTREAM_TOKEN` if it has an API key). `GATEWAY_MODELS` lists the
models the gateway serves. Seats only ever know the gateway's stable URL and their token,
so upstreams can be swapped without touching a VM.

A typical target is one or more GPU boxes running Ollama with the demo models
(`gemma4:e2b gemma4:e4b embeddinggemma shieldgemma:2b`), `OLLAMA_HOST=0.0.0.0`,
`OLLAMA_CONTEXT_LENGTH=12288`, port firewalled to Render's outbound IPs (Dashboard →
sef-gateway → Connect → Outbound). Secure the network path — the workers see full prompts.

A laptop tunnel (for example cloudflared to a local Ollama, with
`--http-host-header localhost:11434` because Ollama refuses a non-local `Host`) is a
development option: quick tunnels rotate hostnames on every restart, so an upstream change
means updating `GATEWAY_UPSTREAMS` on the gateway service and redeploying it.

## Reset demo data

- **Local disposable data:** stop the services and remove `.data/engine/` and
  `.data/uni/` — see [HANDOVER.md](../HANDOVER.md) §7, including what that does *not*
  reset.
- **Hosted sessions:** a student's own workspace end (`DELETE /v1/session`) retires a
  non-pinned VM; staff `POST /v1/admin/sessions/:id/end` ends any session, pinned ones
  included.
- **Production data:** wiping Postgres, the uni disk or the vault bucket is a separate,
  deliberate maintenance procedure, not part of a demo reset — plan and verify it instead
  of improvising commands here.

## Deployment checks

The blueprint declares plans, disks and env placeholders; it does not prove what is
deployed. Verify in the Render console and against the endpoints themselves:

- `/ready` (not just `/health`) on the uni — it answers 200 only while the account layer
  is mounted and Postgres answers.
- `SEF_GOLDEN_SNAPSHOT_ID` matches the snapshot the last golden build produced; `SEARXNG_URL`
  and `APP_PUBLIC_ORIGIN` are set, or seats get no web search and the Vercel app fails CORS.
- The portal/app build variables (`VITE_APP_URL`, `VITE_DEMO_*`, `VITE_POSTHOG_*`) come from
  [deploy-vercel.md](deploy-vercel.md).
- Paid plans and disks in `render.yaml` are declared intent, not evidence they exist — check
  each service's actual plan and disk in the console.

Dated operator notes from earlier deploys are in
[CLOUD_SEAT_NOTES.md](CLOUD_SEAT_NOTES.md); treat them as historical context, not current
state.
