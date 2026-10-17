# Golden snapshot: the image session VMs start from

Operator-hosted sessions (the PR-41 to PR-45 series) give every signed-in student a fresh Instabox VM. The operator owns every VM, so one owner-private snapshot serves them all. That snapshot holds the engine and the built UI with **no** per-session data. A session then needs only a create, a start and one exec.

```
build-snapshot:  builder box ─ bootstrap.sh SEAT_MODE=golden ─ verify ─ scrub ─ stop ─ snapshot ─ delete builder ─ rotate
session (PR-42): create from snapshot ─ /start ─ publish 4100 ─ exec session-start.sh ─ engine healthy
```

## What is in the image

| Path (under `/data/home/sef-seat`) | In the snapshot |
| --- | --- |
| `src/` | The app at one pinned commit, its `node_modules` and `apps/desktop/dist` built same-origin |
| `docker-compose.yml`, `seat.env` | The compose file and the static half of the engine env: no host, owner, uni, gateway or store values, no `OLLAMA_URL` |
| `session-start.sh` | The per-session start script |
| `golden.json`, `built`, `bootstrap.inputs`, `bootstrap.log`, `status` | Provenance: ref, commit, image, build time and the build's log |
| `engine-data/` | **Empty**: no profiles, seat-owner pin, sessions, keys or `settings.json` |
| Docker | The `node:24-slim` image, so a session start never pulls. No Ollama, no models, no containers |

The scrub (`bootstrap.sh scrub`, run at the end of the golden bootstrap and again just before the snapshot) empties `engine-data/` and `cache/home/`, removes `session.env`, `session.state`, `status.prev` and the exec user's `.bash_history`, `.git-credentials`, `.npmrc` and `.docker/config.json`. It then **fails the build** if `engine-data/` is not empty, if `seat.env` holds a per-session variable, or if any file outside `src/` and `cache/` holds an `ibk_` key or a `TOKEN=`/`SECRET_KEY=`/`PASSWORD=` value. The dry-run fixture (`apps/desktop/src/features/seat/bootstrap-script.test.ts`) plants a session's leftovers and asserts what the scrub keeps and removes. The machine identity is reset by the template's `identity-reset` capability (`universal` has it).

## Per session: `session-start.sh`

The orchestrator runs `bash /data/home/sef-seat/session-start.sh` in one exec, passing the values in the exec's `envs`:

| Variable | Required | Source |
| --- | --- | --- |
| `ENGINE_PUBLIC_HOST` | yes | the publish-port response, `4100-<id>.instabox.tech` |
| `ENGINE_SEAT_OWNER` | yes | the student's uni account id (a session VM is never unpinned) |
| `UNI_SERVER_URL` | yes | the uni |
| `MODEL_GATEWAY_URL` | yes on this image | the central model gateway (PR-43) |
| `MODEL_GATEWAY_TOKEN` | no | a short-lived per-VM token from the orchestrator |
| `OBJECT_STORE_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY`, `_SECRET_KEY`, `_REGION`, `_FORCE_PATH_STYLE` | no | vault sync (PR-41) |

Each value is checked against a narrow pattern, written to `session.env` (mode 600, read by compose as the second `env_file`), and the engine container is recreated with `--pull never`. The script waits until loopback `/api/health` answers (`SESSION_WAIT_SECONDS`, default 45) and writes `session.state` (`ready <epoch>` or `failed <reason>`). It prints variable names only, never values. The engine container restarts by itself after a stop/start (`restart: unless-stopped`), so the script runs once per session.

## Build

```sh
set -a; . ~/.config/sef/instabox.env; set +a      # INSTABOX_API_KEY; never printed
GOLDEN_REF=<full commit sha or branch> infra/seat/golden/build-snapshot
```

It prints `SNAPSHOT_ID=sn_...` and appends it to `~/.local/state/sef-golden/snapshots.tsv` (`GOLDEN_STATE_DIR` to move it). The snapshot is named `sef-golden-<commit7>-<yyyymmddhhmm>` and pins that commit: an upgrade is a new snapshot, and new sessions use it.

**Resuming.** Run the same command again after any failure. The builder is found by `metadata app:sef-golden` (or the stored id). The create, stop, snapshot and delete Idempotency-Keys and the snapshot name are stored in `build.state` before each call, and are reused until that step succeeds. The bootstrap is relaunched only if it has not finished for this commit, and a relaunch while it runs is a no-op (its lock). A `no_capacity` create is retried with backoff, first with the same key. If Instabox replays the same failed operation, a new key is used.

**Rotation.** After the new snapshot is ready, `sef-golden-*` snapshots beyond the newest `GOLDEN_KEEP` (default 2) are deleted. The quota is 10 snapshots per account, and other snapshots are never touched.

**Why bash.** It matches `bootstrap.sh` and the runbook (curl and jq, nothing to install), and the steps are a linear list of HTTP calls. The key reaches curl on stdin (`-H @-`), never in argv. The typed, tested client belongs to the orchestrator (PR-42, a TypeScript server client), which will replace these scripts.

## Smoke test

```sh
infra/seat/golden/smoke-session sn_...            # SMOKE_KEEP=1 to leave the VM up for a look
```

It creates a VM from the snapshot (`metadata app:sef-session-smoke`), starts it, publishes 4100, runs `session-start.sh` with dummy uni and gateway URLs, then checks that public `/api/health` is exactly `{ok, engine, uni:{reachable}}`, that `/api/health/detail` is 401 and that `/` serves the UI. It prints each phase's time and deletes the VM.

## Measured (2026-10-17, 4 vCPU / 8 GiB `universal`)

MEASUREMENTS
