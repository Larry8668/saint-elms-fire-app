# Golden snapshot: the image session VMs start from

Operator-hosted sessions (the PR-41 to PR-45 series) give every signed-in student a fresh Instabox VM. The operator owns every VM, so one owner-private snapshot serves them all. That snapshot holds the engine and the built UI with **no** per-session data. A session then needs only a create, a start (when the box comes back stopped) and one exec.

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

These numbers are from the first build (`sef-golden-9946999-…`, smoke-tested, then superseded). The current snapshot is `sn_agquvqu6h2bc33n7w2bfctcxni` (`sef-golden-942573f-202610171647`). It was built in 45 s by the same pipeline (bootstrap 29 s, build 17 s), and uses 1.2 GB on `/data`.

| Build phase | Seconds |
| --- | --- |
| create the builder, ready for exec | 4 |
| bootstrap, golden mode (preflight 2, checkout 1, build 13; the rest is exec round trips) | 24 |
| verify, then scrub | 1 + 1 |
| stop | 3 |
| snapshot (stopped box: `201`, ready at once) | 4 |
| delete the builder, rotate | 1 + 1 |
| **total** | **39** |

| Session from the snapshot | Seconds |
| --- | --- |
| create from snapshot (the operation restores the disk; the box came back `running`) | 13 |
| ready for exec (`/start` when the box is `stopped`) | 2 |
| publish 4100 | 1 |
| `session-start.sh` (engine healthy 2 s after `compose up`) | 3 |
| public `/api/health` | 0 |
| **login-to-ready** | **19** |

Compared with a fresh seat bootstrap (98 s, 91 of it Ollama and the models), the session path is 19 s, and most of that is Instabox restoring the disk. After a stop/start of that session VM, the engine answered publicly 6 s after the start began, with no exec needed. The session VM used 713 MiB of RAM with no Ollama. On disk, the `uni` provider held the gateway URL and no key.

**Exec and detaching.** `cd X && setsid nohup job > log 2>&1 < /dev/null &` backgrounds the whole `&&` list, and that subshell keeps the exec's output open, so the exec waits for the job to end. `cd X || exit 1; setsid nohup job ... &` returns at once. Measured: 21 s against 1 s for a 20 s job.
