# Session orchestrator (PR-42)

When a student signs in on the web, the university server gives them their own short-lived study workspace. It is an Instabox VM made from the golden snapshot (PR-44) and running the engine. When they log out or go idle, the server flushes their vault to the object store (PR-41) and deletes the VM.

**Product promise: this is "uni-hosted".** The university's operator holds the Instabox key, the VMs, the vault store and the central model. Staff tooling can see that a session exists, and the operator can reach the VM. It is not "a machine only you control", and the docs and the UI must not claim that it is. Prompts that contain vault excerpts reach the central model gateway (PR-43). The local laptop engine and vault export stay as they are, for students who want their data to stay on their own device.

Code: `server/uni/src/instabox/` (the typed Instabox client and a fake server used in tests), `server/uni/src/sessions/` (the lease store, the spawn worker, teardown, the reaper and the routes), and migration `005_student_sessions.sql`. The gateway token format (shared with PR-43a) is in `packages/shared/src/node/gateway-token.ts`.

## Flow

```
student ──POST /v1/session──▶ uni ── lease (Postgres row; one live row per account)
                               │
                               ├─ create  POST /v1/machines {snapshotId, vault:false,
                               │          metadata {app:'sef-session', account, session}}   Idempotency-Key from the row
                               ├─ start   /start or /resume if the box came back stopped or suspended; exec `true` probe
                               ├─ publish POST /ports {4100}  → https://4100-<id>.instabox.tech
                               ├─ session_start  exec `bash /data/home/sef-seat/session-start.sh`, values in exec envs only
                               └─ health  GET <url>/api/health until ok and (sync.state = 'ready' or no sync field)
student ◀── {state:'ready', url} ── GET /v1/session (polled by the "Starting your workspace…" screen)
student ──POST /v1/session/heartbeat (every minute or so)──▶ extends the lease
student ──DELETE /v1/session (logout)──▶ stopping → exec session-stop.sh (flush) → DELETE machine → ended
reaper (every 30 s): no heartbeat for SESSION_IDLE_MINUTES, or lease expired → same teardown; orphan sweep
```

After each step, the step and its result (machine id, URL) are written to the row before the next step starts. Measured against real Instabox, login to ready took **16.5 s**: create 10.3 s, start under 1 s (the box came back running), publish 1.1 s, session-start 3.2 s, and health about 1 s. Teardown took 2.9 s. The details are in `docs/internal/CLOUD_SEAT_NOTES.md` §10.

## API

All routes need an **approved, enrolled student**. That can be a better-auth session that passes the existing admission guard (verified email, active profile, approved enrolment with a cohort), or a legacy `sef1` student token for an enabled account. Each route reads and changes only the caller's own session. No route takes a session id from a student.

| Route | Answer |
|---|---|
| `POST /v1/session` | `200` with the ready session, or `202` with `{state:'spawning'|'queued', step, steps[], position?}`. A second call, from another tab or a concurrent login, returns the same session. While the session is `stopping` it says so; call again once it has `ended`. |
| `GET /v1/session` | The live session, or the most recent one (so the client can show `failed` or `ended`). `404 no_session` if there has never been one. |
| `POST /v1/session/heartbeat` | Extends the lease by `SESSION_IDLE_MINUTES`. `404` when there is no live session or it is already stopping. |
| `DELETE /v1/session` | Logout. A queued lease just ends. A spawning or ready session goes to `stopping`, then is torn down (`202`). |
| `GET /v1/admin/sessions` | Staff (session staff or legacy admin). The live sessions: id, account, state, step, machine id, heartbeat, lease, `lastError`. No URL, token or idempotency key. |
| `POST /v1/admin/sessions/:id/end` | Staff with a fresh session (30 min), or legacy admin. Force-ends a session; the action is audited. |

The status body (`StudentSessionStatus` in `@sef/shared`) has `steps[]`, each with a `label` the progress screen can show, from "Creating your workspace" to "Restoring your vault". It has `url` only once the session is `ready`. While the spawn waits for Instabox capacity, `error` is `{code:'no_capacity', retryable:true}`; once it has failed, `error` is `{code:'spawn_failed'}`. The student never sees internals. Staff see them in `lastError`.

## States

| State | Holds the lease | Has (or will have) a VM | Next |
|---|---|---|---|
| `queued` | yes | no | `spawning` when a slot frees (FIFO); `ended` on logout or idle |
| `spawning` | yes | yes | `ready`; `stopping` on logout or failure |
| `ready` | yes | yes | `stopping` on logout, idle, an expired lease or staff end |
| `stopping` | **yes** | yes, until deleted | `ended`, or `failed` if the spawn had failed |
| `ended` / `failed` | no | no | terminal |

`stopping` keeps the lease on purpose. A new VM for the same student must not restore the vault before the old VM's final flush has pushed it. A partial unique index (`student_sessions_one_live_uidx`) makes a second live row for an account impossible, even if two requests race. A transaction-scoped advisory lock serialises capacity decisions.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `INSTABOX_API_KEY` | (unset = orchestrator off) | The operator's Instabox key. Server only: it is never logged, never in an error, never sent to a client, and never on a VM. |
| `SEF_GOLDEN_SNAPSHOT_ID` | (unset = off) | The golden snapshot new sessions boot from (currently `sn_agquvqu6h2bc33n7w2bfctcxni`). |
| `INSTABOX_API_URL` | `https://api.instabox.sh` | Tests point it at the fake. |
| `SESSION_MAX_CONCURRENT` | `3` | Machines the orchestrator may hold at once. The account quota is 5 machines in total and the operator's own box takes one, so 3 leaves one spare. Logins beyond this wait as `queued`. |
| `SESSION_IDLE_MINUTES` | `15` | No heartbeat for this long ends the session. Each heartbeat sets the lease to now + this. |
| `SESSION_REAPER_INTERVAL_SECONDS` | `30` | How often the reaper runs. |
| `SESSION_AUTO_SUSPEND_SECONDS` | `1800` | Instabox's own idle suspend on the VM (0 or 120–86400). Teardown resumes a suspended box before the flush. |
| `SESSION_CAPACITY_WAIT_SECONDS` | `600` | How long a spawn keeps retrying `no_capacity` or `quota_exceeded` before it fails. |
| `SESSION_HEALTH_TIMEOUT_SECONDS` | `180` | How long to wait for public health to report ready (vault restore included). |
| `SESSION_WORKSPACE_ORIGINS` | `https://*.instabox.tech` | Origins the portal page (`/app`) may read a workspace's public health from (CSP `connect-src`), so the browser sees the VM answer before it is handed there (PR-45). https, or http on loopback for tests; anything else stops boot. |
| `UNI_PUBLIC_URL` | `http://localhost:4200` | Sent to the VM as `UNI_SERVER_URL`. It must be reachable from Instabox. |
| `MODEL_GATEWAY_URL` | `https://gateway.invalid/v1` | The central model gateway (PR-43). |
| `GATEWAY_TOKEN_SECRET` | (none) | At least 32 bytes. HMAC key for `MODEL_GATEWAY_TOKEN`. Required in production. |
| `MODEL_GATEWAY_TOKEN_MINUTES` | `480` | Token lifetime. The token is minted when the engine starts and is not refreshed yet (see the follow-ups). |
| `OBJECT_STORE_ENDPOINT`, `_REGION`, `_BUCKET`, `_ACCESS_KEY`, `_SECRET_KEY`, `_FORCE_PATH_STYLE` | (none) | Passed through to the VM for vault sync (PR-41). If any is unset, the engine runs without sync. |

The orchestrator also needs `UNI_DATABASE_URL` and migration 5 (`pnpm --filter @sef/uni-server db:migrate`). The uni does not migrate on boot. Without the table, the orchestrator stays off and logs `session_orchestrator_disabled`.

### What the VM gets (exec `envs` of session-start.sh)

`ENGINE_PUBLIC_HOST` (the host of the published URL, which is why publishing comes before session-start), `ENGINE_SEAT_OWNER` and `VAULT_SYNC_ACCOUNT` (the same account id: with sync on, the engine refuses to boot unless the sync account is a seat owner), `UNI_SERVER_URL`, `MODEL_GATEWAY_URL`, `MODEL_GATEWAY_TOKEN`, `SYNC_FLUSH_TOKEN` (32 random bytes per session, base64url: 43 characters, over the engine's 24-character minimum) and the `OBJECT_STORE_*` values. The command line is a fixed string with no values, because the command line shows up in the box's process list and in API logs.

**Which account id:** the engine pins the seat (PR-37d) to the id that the student's own sign-in produces. For a legacy password login that is the legacy `account.id` (for example `ananya`). For a better-auth device sign-in it is `user.id`. The orchestrator uses the same id: the token's `sub` for a legacy caller, and the session's `user.id` otherwise.

### Gateway token (PR-43a's format)

```
sefgw1.<base64url(claims JSON)>.<base64url(HMAC-SHA256(GATEWAY_TOKEN_SECRET, "sefgw1." + <claims part>))>
claims = {"sub": <account id>, "vm": <machine id>, "exp": <unix seconds>}   (at most 7 days)
```

The orchestrator mints with `mintGatewayToken` from `packages/shared/src/node/gateway-token.ts`. That file is byte-for-byte the one on PR-43a (#78), including its known-answer vector test, so the gateway's `verifyGatewayToken` accepts these tokens. Whichever PR merges second carries an identical file.

## Failure modes

| What | What happens |
|---|---|
| `no_capacity` (a failed create operation, or a 503) | Back off (2 s doubling, up to 30 s, with jitter) and retry until `SESSION_CAPACITY_WAIT_SECONDS`. The student sees `no_capacity`. Each retry uses a **fresh** Idempotency-Key, because Instabox replays a refused key's refusal; the refused sandbox was already removed, so a duplicate is impossible. |
| `quota_exceeded` | Treated like `no_capacity`. The cap should prevent it; if it happens, something else is holding machines on the account. |
| Network loss during create | Retried with the **same** key. A replay returns the original operation, never a second machine. |
| uni restart mid-spawn | On boot, `spawning` rows are driven again from their persisted step. A missing machine id is recovered by listing `app:sef-session, session:<id>`. Nothing is created blindly: an existing machine is adopted, and only if none exists is the stored key replayed. The box is started again if it stopped meanwhile. |
| uni restart mid-teardown | `stopping` rows are finished on boot and by every reaper tick. |
| A step fails (machine in error, ports off, session-start.sh fails twice, health never ready, `sync.state:'error'`) | `stopping` → the machine is deleted **without a flush** (the URL was never handed out, so the student cannot have changed anything) → `failed`. A new `POST` starts over. |
| The flush fails | session-stop.sh prints the engine's answer. `{ok:false, error:'push_failed'|'timeout'}`, or an answer that can't be read, is retried once. `conflict` and `not_restored` are not retried. Every failure is logged at error level (`session_flush_failed`, "VAULT CHANGES SINCE THE LAST PUSH MAY BE LOST"), recorded in `last_error`, and the teardown carries on and deletes the VM. The engine's own debounced pushes (PR-41b) bound the loss. |
| `session-stop.sh` is not on the image (snapshots from before PR-41b) | Exit 127, logged `session_flush_unavailable`, no retry. |
| Delete fails | The row stays `stopping` (still holding its lease and its capacity slot), and the reaper retries. |
| Orphans | Each tick lists `app:sef-session` machines and deletes those that no live row owns, either by machine id or, for a create that is still in flight, by its `session` label. |

## Trust model

- **The operator holds the Instabox key.** Only the uni process uses it, from the environment. The client keeps it in a private field, sends it only as `X-API-Key` to the API base, and leaves it out of errors, logs and `JSON.stringify`.
- **Machines are created with `vault:false`.** A write-scoped key could otherwise expose the operator's Instabox Vault to code on the VM.
- **The orchestrator only touches its own machines.** Every machine it touches is either one it created (the id comes from its own create, and teardown checks the `app:sef-session` label again before deleting) or one found by a label listing whose label it re-checks. The operator's own box (`box-c0ab84`) has no such label, so it cannot be selected.
- **A student acts only on their own session.** Every route looks up the session by the caller's own account. The staff list omits the URL, the tokens and the idempotency key.
- **The flush token** is random per session. It lives in the row (never returned) and in the VM's env, and the engine accepts it on loopback only (contract). The gateway token is short-lived and bound to one account and one VM.

## Limits and follow-ups

- **One uni process.** Spawns are de-duplicated per process. Two uni processes would both re-drive the same `spawning` row after a restart (the idempotency key and adoption still prevent a second VM, but session-start.sh would run twice). Add a row-level worker lease before scaling out.
- **The gateway token is not refreshed.** It is minted at session start with an 8-hour default lifetime, so sessions longer than that lose the model until PR-43 adds refresh.
- **The object-store key on the VM** is the shared engine key from PR-41a's minio-init for now. Per-account scoped keys are a follow-up.
- **Warm pool:** not built. Cold start is about 16 s.
- **The image contract:** #77's session-start.sh writes only its own list of keys to `session.env`. PR-41b must add `VAULT_SYNC_ACCOUNT` and `SYNC_FLUSH_TOKEN` to that list, and ship `session-stop.sh` in `SEAT_HOME` (or `src/infra/seat/`), for sync and the final flush to work.
