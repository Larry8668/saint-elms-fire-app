# Cloud seat notes (PR-37..40): Instabox working notes and handover

> **Historical document.** These are dated engineering notes. Observations, machine/snapshot
> ids, paths and timings below may be obsolete, and private ops scripts they reference may not
> exist in this repository — this is not a current machine inventory or an executable
> deployment procedure. For the current state see [START_HERE.md](START_HERE.md) and
> [../HANDOVER.md](../HANDOVER.md).

Last updated: 2026-10-17 (PR-38 done; see section 8. PR-42 orchestrator smoke: section 10). Originally kept as private working notes; this copy is tracked. Keep secrets and current private operator material under `docs/internal/`.

## 1. Purpose and status
The "cloud seat" series (PR-37 engine served from the box, PR-38 seat provisioning, PR-39 seat card/wake UX, PR-40 snapshot/teardown) puts each student's engine on an Instabox machine. This file holds the verified API facts, the live probe results and a runbook. Status: API verified against the OpenAPI spec, the site docs and ONE live probe machine (`sef-probe-1`, since deleted). PR-38 is not yet built.

### Decisions settled by the user (2026-10-17)
- **Offline-login is disabled on public seats** (PR-37a). A seat requires connectivity anyway, and on a public URL it was a password-less sign-in by profile id. Local desktop installs keep it, because there they are loopback-only.
- **Device-flow `flowKey` binding stays** (PR-37a). Only the browser that started a device sign-in can collect the approved session. This is the standard device-flow fix and is needed whether or not the box is public.
- **The sign-in banner returns:** public `/api/health` gains a bare uni-reachability boolean (follow-up on #67), and nothing else is exposed.
- **An optional Tailscale private-access mode is added to PR-40** (SSM-style, no public port, off by default). See the MEGAPLAN PR-40 section.
- **Pricing context:** one box per student is only viable because billing is usage-based and idle boxes suspend. A hybrid (a small per-student engine box plus shared or local inference) is the likely cost answer once Instabox prices exist. The CPU tokens/sec benchmark from PR-38 decides whether CPU-only seats are usable.

## 2. Credentials and account facts
- API key: `~/.config/sef/instabox.env` (`INSTABOX_API_KEY=ibk_...`), chmod 600, never in the repo (it was moved out of the worktree `.env`). Scope: full access. Load with `set -a; . ~/.config/sef/instabox.env; set +a`.
- Account (`GET /v1/me`): login `thecont1` (teammate's account), activated, not admin, `allowedSpecs` = 4 vCPU / 8 GiB / 20 GiB only. Quota 5 machines.
- One pre-existing user machine, `box-c0ab84` (`m_agquefbpjpw44s6hobhn2zhbhi`), suspended, template universal 2026-10-15.4. MUST NOT be touched (no exec, no lifecycle, no ports).
- Rule for agents: never print or log the key; use `-H "X-API-Key: $INSTABOX_API_KEY"`, no `curl -v`.

## 3. Machine ledger (append here)
| name | id | purpose | created (UTC) | deleted (UTC) | final state |
|---|---|---|---|---|---|
| box-c0ab84 | m_agquefbpjpw44s6hobhn2zhbhi | pre-existing, belongs to the user, DO NOT TOUCH | 2026-10-16 00:19 | - | suspended (untouched) |
| sef-probe-1 | m_agquty4ni5xojecy4lj64hpa5u | API probe (vault false, autoSuspend 120) | 2026-10-17 12:43:32 | 2026-10-17 12:48:48 (delete op succeeded, GET returns 404) | deleted |
| sef-seat-e2e-1 | m_agquudskm6tjef4hlnbtbki6by | PR-38 bootstrap development + measurements (vault false, metadata app:sef-seat, autoSuspend 1800), created by curl | 2026-10-17 13:30:12 | 2026-10-17 13:50:13 (op op_agquuie4pskabsis4zllf62fpq succeeded 13:50:16, GET 404) | deleted |
| sef-seat-e2e-2 (attempt 1) | (not recorded; op failed) | PR-38 harness run (ClaimRunner + Rust commands, vault false, app:sef-seat) | 2026-10-17 13:53:30 | create operation FAILED no_capacity 13:53:32; Instabox auto-removed it, list showed only box-c0ab84 | never existed |
| sef-seat-e2e-2 (attempt 2) | (op failed) | same harness, resumed in a new process from the machine step | 2026-10-17 13:54:58 | create op FAILED no_capacity 13:55:01, auto-removed | never existed |
| sef-seat-e2e-2 (attempt 3) | (op failed) | harness retry | 2026-10-17 13:55:51 | create op FAILED no_capacity 13:55:53, auto-removed | never existed |
| sef-seat-e2e-2 (attempt 4) | (op failed) | harness retry | 2026-10-17 13:58:03 | create op FAILED no_capacity 13:58:04, auto-removed | never existed |
| sef-seat-e2e-2 (attempt 5) | (op failed) | harness retry | 2026-10-17 13:59:29 | create op FAILED no_capacity 13:59:30, auto-removed | never existed |
| sef-seat-e2e-2 | m_agquulififxw7v2crdngvbe3a4 | PR-38 full flow via harness (ClaimRunner + Rust commands + keychain; vault false, app:sef-seat, autoSuspend 1800) | 2026-10-17 14:03:45 | 2026-10-17 14:08:13 (op op_agquumixbwn4wtr6irv5vy3die succeeded 14:08:19, GET 404; list shows only box-c0ab84) | deleted |
| sef-golden-builder | m_agquvoa3nvegg4jmorqx2srtcm | PR-44 golden snapshot builder (build-snapshot; universal, vault false, metadata app:sef-golden, autoSuspend 1800), op op_agquvoa3nxj4t7xq2ytxscdjcm | 2026-10-17 16:35:42 | 2026-10-17 16:36:18 (by build-snapshot after the snapshot; delete op succeeded) | deleted |
| (snapshot) sef-golden-9946999-202610171636 | sn_agquvoffdwntsavcwjqifjtzuy | PR-44 golden snapshot #1 of the builder above (stopped box, 201 sync; data 20 GiB nominal, root 16 GiB), engine commit 99469999 | 2026-10-17 16:36:17 | - | ready |
| sef-smoke-163712 | m_agquvol4fs5qw3db34eifdelsq | PR-44 smoke-session from sn_agquvoffdwntsavcwjqifjtzuy (vault false, metadata app:sef-session-smoke, autoSuspend 600); kept briefly for probes (detach timing, stop/start survival) | 2026-10-17 16:37:12 | 2026-10-17 16:38:41 (smoke-session delete op succeeded; list shows only box-c0ab84) | deleted |
| sef-golden-builder (2) | m_agquvqp6p46snpybmjfotiwzg4 | PR-44 rebuild at the reviewed PR head 942573f (build-snapshot; universal, vault false, app:sef-golden), op op_agquvqp6p6mdrvlub5kq5qrsbu | 2026-10-17 16:46:30 | 2026-10-17 16:47:12 (by build-snapshot; delete op succeeded) | deleted |
| (snapshot) sef-golden-942573f-202610171647 | sn_agquvqu6h2bc33n7w2bfctcxni | PR-44 golden snapshot #2 = FINAL DELIVERABLE, engine commit 942573f702d0d8316b31744aadfcec708ffe7c2f (stopped box, 201 sync) | 2026-10-17 16:47:11 | - | ready (kept) |
| (snapshot) sef-golden-9946999-202610171636 | sn_agquvoffdwntsavcwjqifjtzuy | snapshot #1 (smoke-tested) superseded by #2; deleted by hand so only the final one remains | 2026-10-17 16:36:17 | 2026-10-17 16:47:23 (DELETE 204) | deleted |
| sef-session-b7b37e9b148840e79309 | m_agquvwvhut2sujtolzzwypwmw4 | PR-42 orchestrator real smoke: session VM spawned by the local uni (3610) for demo student ananya from sn_agquvqu6h2bc33n7w2bfctcxni (vault false, metadata app:sef-session, account:ananya, session:b7b37e9b-1488-40e7-9309-9417a910c94e, autoSuspend 1800) | 2026-10-17 17:13:26 | 2026-10-17 17:14:16 (by DELETE /v1/session teardown; delete op succeeded, GET 404; list shows only box-c0ab84) | deleted |
| sef-golden-builder (3) | m_agquwatpeemfth7i2nj3fvwzv4 | PR-44 rebuild at #77 head b02ea1b (native-Ollama gateway path + session-start sync values; build-snapshot; universal, vault false, app:sef-golden), op op_agquwatpehnh2qsyvnnwoo7qxu | 2026-10-17 17:56:53 | 2026-10-17 17:57:37 (by build-snapshot after the snapshot; delete op succeeded, list shows only box-c0ab84) | deleted |
| (snapshot) sef-golden-b02ea1b-202610171757 | sn_agquwaykk47e4x4cns5gfcv2pa | PR-44 golden snapshot #3 = CURRENT, engine commit b02ea1bf962442fc5b89b7d95562e4d35a7a56b1 (stopped box, 201 sync; data 20 GiB nominal, root 16 GiB) | 2026-10-17 17:57:32 | - | ready (kept) |
| sef-smoke-175751 | m_agquwa2q3no4guqf7avnx43ghe | PR-44 smoke-session from sn_agquwaykk47e4x4cns5gfcv2pa (vault false, app:sef-session-smoke, autoSuspend 600), op op_agquwa2q3p5nazy6jfpz3tzijq | 2026-10-17 17:57:51 | 2026-10-17 17:58:26 (smoke-session delete op succeeded; list shows only box-c0ab84) | deleted |
| sef-golden-builder (4) | m_agquw3mtjuy5bl4ij6cw44xkpa | Rebuild 4 at main 4d6c32c (build-snapshot; universal, vault false, app:sef-golden), op op_agquw3mtjwptlm5u2j3absk6iu | 2026-10-17 19:53:54 | 2026-10-17 19:54:35 (by build-snapshot after the snapshot) | deleted |
| (snapshot) sef-golden-4d6c32c-202610171954 | sn_agquw3rpykrsqophbvuy3hnlpy | golden snapshot #4 = CURRENT, engine commit 4d6c32c7d92abd720f34849a178c8d4936a3bd4f (stopped box) | 2026-10-17 19:54:35 | - | ready (kept) |
| (snapshot) sef-golden-942573f-202610171647 | sn_agquvqu6h2bc33n7w2bfctcxni | rotated out by build-snapshot (keep 2) | 2026-10-17 16:47 | 2026-10-17 19:54:38 | deleted |
| sef-smoke-195443 | m_agquw3srpaxurla6pbhidi4kwe | Rebuild 4 smoke-session from sn_agquw3rpykrsqophbvuy3hnlpy (SMOKE_KEEP=1; app:sef-session-smoke) | 2026-10-17 19:54:43 | 2026-10-17 ~19:55:2x (second smoke-session run deleted it) | deleted |
| sef-smoke-195530 | m_agquw3xakdxjy5w26kxzy75wxm | Rebuild 4 second smoke-session (no state file left, so it created a fresh VM; 3 creates in total) | 2026-10-17 ~19:55:2x | 2026-10-17 19:55:38 (smoke-session delete) | deleted |
| sef-session-23513754… (Render uni) | m_agquxc6d3jaeh2ouc7csrmlv2i | Render deploy e2e #1: session VM spawned by the hosted uni (sef-uni.onrender.com) for ananya from sn_agquw3rpykrsqophbvuy3hnlpy (vault false, app:sef-session). FAILED at health: `sync_error` (restore 403 InvalidAccessKeyId: the free-tier, diskless MinIO had spun down and come back empty) | 2026-10-17 ~20:26:5x | 2026-10-17 20:27:30 (orchestrator, no flush; session `failed`) | deleted |
| sef-session-609ebf1715a446869a3f | m_agquxdrbi7u7rrkkxqre7u4adm | Render deploy e2e #2 (after re-running MinIO init): ananya, ready in 34.6 s, health `uni.reachable:true, sync.state:ready`, VM sign-in + one Guide turn via the Render gateway | 2026-10-17 20:29:27 (create op done 20:29:56) | 2026-10-17 20:30:35 (DELETE /v1/session; flush `{"ok":true,"pushed":0,"version":1}`; list shows only box-c0ab84) | deleted |
| sef-golden builder (rebuild 5) | m_agquxknrhywoxbno6sc6rq3dlq | build-snapshot from main 0bde963 (app:sef-golden) | 2026-10-17 20:59:3x | 2026-10-17 21:00:16 (build-snapshot) | deleted |
| (snapshot) sef-golden-0bde963-202610172100 | sn_agquxksmadilsip5f3k42n7o7u | golden snapshot #5 = CURRENT (uni SEF_GOLDEN_SNAPSHOT_ID), main 0bde963 (session-start.sh with ENGINE_ALLOWED_ORIGINS) | 2026-10-17 21:00:14 | - | ready |
| (snapshot) sef-golden-b02ea1b-202610171757 | sn_agquwaykk47e4x4cns5gfcv2pa | rotated out by rebuild 5 (keep 2) | 2026-10-17 17:57 | 2026-10-17 21:00:17 | deleted |
| smoke (rebuild 5) | m_agquxkupndhnvpmz26kqbm7y2a | smoke-session of sn_agquxksmadilsip5f3k42n7o7u, login-to-ready 18 s | 2026-10-17 21:00:3x | 2026-10-17 21:00:52 | deleted |
| sef-session (UI rehearsal 1) | m_agquxwtikvgaedwc4ctsodqdoi | §13 run 1: ananya, ready 22.9 s; Guide, note, image | 2026-10-17 21:52:46 | 2026-10-17 22:08:16 (UI sign-out; flush ok, pushed 1, v23) | deleted |
| sef-session (UI rehearsal 2) | m_agqux2hwqbavnwydi2fq2ytjci | §13 run 2: ananya, restore check | 2026-10-17 22:08:40 | 2026-10-17 22:09:31 (UI sign-out; flush ok, pushed 1, v25) | deleted |
| sef-session-a40b7cbb6e4a4a808e5db9c0620c4e5c | m_agqux2qs347vlrjt45lkayetdq | PERSISTENT demo VM ananya (autoSuspend 300, uni idle 10080 min) | 2026-10-17 22:09:52 | 2026-10-17 22:52:25 (§14 P0-B: DELETE /v1/session as ananya; flush ok pushed 0 v51; machine deleted; list shows only box-c0ab84) | deleted |
| sef-session-005fcc7d667b4f5baec394db51f8ca7f | m_agqux2vafhekz5pskog6idazsq | PERSISTENT demo VM brinda | 2026-10-17 22:10:28 | 2026-10-17 22:52:25 (§14 P0-B: DELETE /v1/session as brinda; flush ok pushed 0 v13) | deleted |
| sef-session-e6d119b9d9ba4c2388fa61079c2dffb4 | m_agqux2zpzs3w3ek5qu65dksrba | PERSISTENT demo VM chetna | 2026-10-17 22:11:05 | 2026-10-17 22:52:23 (§14 P0-B: DELETE /v1/session as chetna; flush ok pushed 0 v19) | deleted |
| sef-session-4d6dea2083ed4da882352d356a730efb | m_agquzamruxce5u6wilgbffhzau | PERSISTENT demo VM ananya, recreated for §14 (seeded vault; POST /v1/session; snapshot sn_agquxksmadilsip5f3k42n7o7u; autoSuspend 300) | 2026-10-18 00:55:22 (ready 00:55:45.9, 24.6 s) | - | kept (suspends when idle) |
| sef-session-76677034329d443b8f20ffdf8cfe5f98 | m_agquzap2kjrrm3i2f5pfao27oq | PERSISTENT demo VM brinda, recreated for §14 | 2026-10-18 00:55:49 (ready 00:56:57.6, 69.4 s) | - | kept |
| sef-session-6b2464c3295b4f0d931a0ec2ea69f4c5 | m_agquzayrnw347ifqvfo2snuppa | PERSISTENT demo VM chetna, recreated for §14 | 2026-10-18 00:57:00 (ready 00:58:54.4, 114.7 s) | - | kept |

## 4. API corrections to the megaplan (from REPORT.md; WRONG / PARTLY rows)
| Claim | Verdict | Reality |
|---|---|---|
| Mutations are async Operations | partly | Only create/start/stop/suspend/resume/delete. Exec, publish port, PATCH, wake, vault push are synchronous. Live snapshot returns a Snapshot (pending), not an Operation. |
| All mutations need Idempotency-Key | WRONG (partly) | Needed on machine lifecycle, PATCH and snapshot create. NOT on exec, publish port, wake, redeem, keys. Exec is not idempotent: a retry re-runs the command. |
| `trigger:'request'` on publish | WRONG | No such param. `trigger` is only an Operation field. |
| URL wakes a paused box | PARTLY | Only an idle auto-suspended box wakes on a request. Manual suspend, stop, timeout, archive stay offline (503) until `/wake` (idle only), `/resume` or `/start`. Wake needs `machines:write`, so the read-only key in PR-39 is not enough for those cases. |
| `archiveSeconds` for teardown (PR-40) | WRONG | It only stops the box, max 24 h from creation. Use DELETE. |
| App calls API from the webview | WRONG | No CORS on api.instabox.sh (preflight gets 404). |
| Key in localStorage/Tauri store | RISK | Use the OS keychain. |
| PR-40 restore from snapshot | note | A snapshot-restored box starts `stopped`; call `/start` and poll. Needs `images:write/read` and `machines:delete`; template needs `identity-reset`. |
| Early-access 20 vCPU / 40 GB | UNVERIFIED/false for this account | `allowedSpecs` is 4/8 GiB/20 GiB only. |
| Node 22 / corepack in universal | now CONFIRMED | See section 5. |
| SSE through port edge | now CONFIRMED streaming | See section 5. |

Design consequences:
- All Instabox HTTP goes through the Tauri Rust side (tauri-plugin-http or an invoke command; allowlist `https://api.instabox.sh/*` and `https://*.instabox.tech/*`). Webview fetch cannot work.
- Key stored in the OS keychain, never in webview-reachable storage.
- Wake: a plain request wakes only after idle auto-suspend. Anything else needs `/wake` or `/start` with a write-scoped key.
- Exec is blocking (max 600 s), not streamed, non-idempotent. Long steps: `setsid nohup ... &` with a log, then poll with a second exec. Make bootstrap steps idempotent in the script itself.
- Idempotency-Key only on lifecycle/PATCH/snapshot; reuse the SAME key when retrying the same create.
- A snapshot-restored box starts stopped.

## 5. Probe results (2026-10-17, machine sef-probe-1, template universal 2026-10-15.4)
1. Create operation: POST 202 at 12:43:32.04, op `queued`; first poll returned `succeeded` (updatedAt 12:43:32.60, about 0.6 s). No `phase` field was ever returned. Machine was `running`, `runtime.ready:true` immediately and exec worked at once. Create is effectively instant (probably a pre-warmed pool); do not assume that under load (`no_capacity` is possible).
2. Inventory:
   - OS: Debian 13 (trixie), kernel 6.18.54-instabox, x86_64. 4 CPU, 7964 MiB RAM.
   - Disk: `/data` 20G (vdb, persistent), `/` 16G (3.0G used).
   - User: exec runs as **`user`** (uid 1000, groups sudo, docker), NOT `dev` as REPORT.md said. `guestUser` is `user`. HOME=`/data/home` (contains AGENTS.md, MACHINE.md). `sudo -n true` works (passwordless). Docker usable without sudo (docker group).
   - Node v22.23.3 preinstalled (`/usr/local/bin/node`), corepack 0.36.0. `pnpm` is NOT on PATH, but `corepack pnpm -v` worked (printed 12.14.0, may download on first use; needs outbound network). Docker 29.8.2, Compose v5.6.0. python3 3.13.5, curl, git, nohup, setsid present. **tmux missing. ollama not installed.**
   - Docker daemon: `systemctl is-enabled docker` = enabled; systemd running.
   - Outbound: github.com and ollama.com both HTTP/2 200.
3. Detached job: exec with `setsid nohup bash -c '...' &` returned in about 1 s (the HTTP round trip) while the loop kept going; later execs saw the log grow (4 lines after 6 s, 27 after about 55 s, 30 total). Pattern works.
4. Edge / streaming (port 4100 published):
   - URL shape: `https://4100-<machine id without m_>.instabox.tech` (domain **instabox.tech**, no trailing slash in the response). Wildcard cert `*.instabox.tech` (SAN `DNS:*.instabox.tech`), issuer Let's Encrypt (CN=YE1), valid 2026-10-13 to 2027-01-11. Only one DNS level, so the wildcard covers every port/machine host.
   - `/health` JSON OK, HTTP/2.
   - **SSE streams incrementally**: 10 events received at 1.0 s spacing (arrival timestamps tracked the server timestamps within about 0.2 s). Not buffered. (Server sent `Cache-Control: no-cache`, `Connection: close`, flushed per event.)
   - **/echo headers seen by the box**: `Host: 127.0.0.1:4100` (NOT the public hostname), `X-Forwarded-For: <client public IP>`, `X-Forwarded-Host: 4100-agquty4ni5xojecy4lj64hpa5u.instabox.tech`, `X-Forwarded-Proto: https`, plus passthrough `Origin`, `User-Agent`, `Accept`. TCP peer was 127.0.0.1 (the edge connects over loopback). `Connection: close` was added.
   - CORS: the edge neither adds nor strips CORS. OPTIONS reached the app (a Python server without do_OPTIONS answered 501 itself), and a second test server on 4101 returning `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers` and a custom `X-Custom` had all of them passed through intact. So the engine must set its own CORS.
   - Response headers the edge adds: `cache-control: no-store`, `referrer-policy: no-referrer`, `x-content-type-options: nosniff`, `x-robots-tag: noindex, nofollow` (some appeared duplicated).
   - Unpublished port (4200 nginx, actually running): 404 `This URL is not published.` (CSP default-src 'none'), so not reachable.
   - Latency baseline: every public request from this Mac took about 0.92-1.0 s regardless (including a warm /health), so treat about 1 s as edge RTT.
5. Wake behaviour:
   - (a) Idle suspend: box went `suspended` at 12:48:01 (`autoSuspendedAt`), about 120 s after the last activity (about 12:45:03; that was my last exec, state GETs did not appear to reset the timer). First public GET `/health` while suspended: HTTP 200 in **0.92 s** total, i.e. wake is essentially invisible on top of the 1 s baseline. After wake: `runtime {ready:true, processesPreserved:true}`, state running. Python servers (pids unchanged) and the 30-line log job survived, uptime continued (boot 12:43:27, uptime 290 s).
   - (b) Docker container with `--restart unless-stopped` (nginx:alpine on 4200) was still up after wake (Up 4 minutes, serving).
   - (c) Explicit stop: POST /stop at 12:48:24, op succeeded in about 3 s (12:48:27). While stopped, public URL returned **503** `Sandbox offline. Its owner must start it to use this URL.` (about 0.94 s); exec returned 409 `machine_not_running`. Port publication persisted (list ports unchanged). Start: POST /start 12:48:32, op succeeded in about 3 s (12:48:35), machine `running` and ready. After start: the real reboot happened (boot time 12:48:32), **plain background processes (python servers, job) were gone** (public URL returned 502 `Nothing is listening on this port in the sandbox. Start an HTTP server on port 4100.`), but the docker `--restart unless-stopped` container came back by itself (Up 2 seconds), and `/data` files persisted. Docker daemon active. Published ports persisted with the same URL. Note `processesPreserved` stayed true in the machine record while stopped (stale; do not rely on it after stop).
6. Discrepancies vs REPORT.md: exec user is `user`, not `dev`; guest user "user"; public domain is `instabox.tech` (was unknown); Node 22 confirmed (22.23.3) and corepack present but bare `pnpm` is not on PATH; tmux not installed (the "tmux" suggestion in the docs is not usable without apt); create operation has no `phase`; operation completes in under a second; the `/v1/templates` listing includes hidden base/dev; publish-port response has no trailing slash; box API 409 when exec on stopped box; wake after idle is about 0 extra latency (docs imply a wait).
7. Cleanup: DELETE op `op_agqut2c6hhu6s55mnrfijuzycq` succeeded (about 1 s); `GET /v1/machines` shows only `box-c0ab84`; GET of the deleted id is 404.

## 6. Recommendations
- PR-37 (engine): behind the edge the engine sees `Host: 127.0.0.1:<port>`, so an `ENGINE_PUBLIC_HOST` gate must NOT compare against the Host header. Use `X-Forwarded-Host` (public hostname) and `X-Forwarded-Proto: https`, and only trust them from the loopback peer (trust-proxy = loopback only; the edge connects from 127.0.0.1). Client IP comes from `X-Forwarded-For`. Engine must set its own CORS and handle OPTIONS. SSE works natively through the edge; keep a heartbeat anyway (idle timeout not tested beyond 10 s).
- PR-38 (provisioning): create with `templateId:"universal"`, `vault:false`, metadata `{app:"sef-seat"}`, precheck via `GET /v1/machines?metadata=app:sef-seat`. Create is near instant, but keep polling logic and `no_capacity` handling. Bootstrap prerequisites: Node 22 and corepack are already there, use `corepack pnpm` (or `corepack enable` first, needs sudo/`--install-directory`); do not assume tmux (apt install via sudo if wanted) or ollama (must be installed by bootstrap if needed, outbound network works). Run long steps with `setsid nohup ... > log 2>&1 < /dev/null &` and poll the log. Use `/data` for state.
- PR-38/39 process model: the engine needs to survive stop/start and not just suspend. Plain processes die on stop/start (and on any reboot), so run the engine as a Docker container with `--restart unless-stopped` (verified to come back, Docker is enabled at boot), or as a systemd unit (sudo is passwordless; not tested). Idle suspend preserves processes.
- PR-39 (wake UX): idle wake is about 1 s total on top of the edge RTT, so a "waking" spinner mainly matters for stopped/user-suspended boxes. Seat card: read state from `GET /v1/machines/{id}`; if `suspended` with `autoSuspendedAt` set, a plain request wakes it; otherwise call `/wake` or `/start` (needs write scope). Stop/start each take about 3 s plus the engine's own boot time; 502 means the box is up but the app is not listening yet, 503 means the box is offline.
- PR-40: delete takes about 1 s. Remember snapshot-restored boxes start stopped. Do not use `archiveSeconds`.
- Auto-suspend minimum is 120 s; consider a longer value (default 1800 s) for real seats, since process-preserving suspend is cheap.

## 7. Runbook (key from env, never literal)
```sh
set -a; . ~/.config/sef/instabox.env; set +a
B=https://api.instabox.sh; H="X-API-Key: $INSTABOX_API_KEY"
# list (our machines)
curl -s -H "$H" "$B/v1/machines?metadata=app:sef-seat"
# create (reuse the SAME key on retry of the same create)
K=$(uuidgen); curl -s -X POST -H "$H" -H "Idempotency-Key: $K" -H 'Content-Type: application/json' "$B/v1/machines" \
  -d '{"name":"sef-x","templateId":"universal","vault":false,"metadata":{"app":"sef-seat"},"autoSuspendAfterSeconds":1800}'
# poll operation
curl -s -H "$H" "$B/v1/operations/$OP?wait=25s"
# get machine
curl -s -H "$H" "$B/v1/machines/$MID"
# exec (not idempotent, blocking, max 600 s)
curl -s -X POST -H "$H" -H 'Content-Type: application/json' "$B/v1/machines/$MID/exec" -d '{"cmd":"node -v","timeoutSeconds":60}'
# detached job
#   cmd: 'setsid nohup bash -c "long thing" > /data/home/job.log 2>&1 < /dev/null & echo started'
# publish port (idempotent, no Idempotency-Key)
curl -s -X POST -H "$H" -H 'Content-Type: application/json' "$B/v1/machines/$MID/ports" -d '{"port":4100,"name":"engine"}'
# stop / start / wake (fresh Idempotency-Key each; wake takes none)
curl -s -X POST -H "$H" -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' "$B/v1/machines/$MID/stop" -d '{}'
curl -s -X POST -H "$H" -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' "$B/v1/machines/$MID/start" -d '{}'
curl -s -X POST -H "$H" "$B/v1/machines/$MID/wake"
# delete, then poll op to succeeded and re-list
curl -s -X DELETE -H "$H" -H "Idempotency-Key: $(uuidgen)" "$B/v1/machines/$MID"
```
Always list afterwards and append to the ledger in section 3. Never touch `box-c0ab84`.

## 8. PR-38 (seat provisioning): what was built, how to run it, evidence (2026-10-17)

### Built (stacked PRs, base `feat/37c-served-ui`)
- **38a #72** `feat/38a-seat-bootstrap`: `infra/seat/bootstrap.sh`, `docker-compose.seat.yml`, `seat.env.template`, dry-run fixture (`apps/desktop/src/features/seat/bootstrap-script.test.ts`), `docs/hosted-seat.md` "Provisioning a seat on Instabox".
- **38b #73** `feat/38b-seat-client`: Rust `src-tauri/src/seat/` (keychain via `keyring`, reqwest client, 13 narrow commands, bootstrap launch/status, fake-Instabox contract tests), `examples/seat_cli.rs` harness, TS `apps/desktop/src/lib/instabox.ts`.
- **38c #74** `feat/38c-claim-seat`: `features/seat/claim.ts` (ClaimRunner state machine), `ClaimSeatDialog.tsx`, `SeatEntry.tsx` (one line in SignInView), `lib/seat.ts` (stored seat URL, PR-39 seam), 2-line `api.ts` change (ENGINE_URL prefers a stored seat, read once at startup; switching reloads).

### Design decisions (vs megaplan)
- All Instabox HTTP in Rust (no CORS). Key in OS keychain (service `app.saintelmsfire.desktop`, account `instabox-api-key`); JS only calls `seat_key_save` once.
- Commands are fixed/narrow: create body fixed (universal, vault:false, app:sef-seat, autoSuspend 1800); exec only sends the compiled-in launcher (`include_str!` of bootstrap.sh) or a read-only status probe; health probes `/api/health` on a named https host only (not tied to instabox.tech, so a Tailscale/private URL can reuse it in PR-40).
- **Checklist order: key, machine (precheck/create), ready (poll/start/resume), publish, bootstrap, health, save.** Publish moved before bootstrap because the engine env needs `ENGINE_PUBLIC_HOST` from the publish response; publishing is instant/idempotent and starts nothing.
- Idempotency: create key persisted before the call; kept on unknown outcome (status 0), rotated after a definite refusal (no_capacity/quota) because a replay would return the refusal. Failed create op → progress resets to "after key". Power (start/resume) keys persisted per attempt.
- Engine runs with host networking (`ENGINE_HOST=127.0.0.1`, default trusted proxies), Ollama on 127.0.0.1:11434, both `restart: unless-stopped`. Build runs in the `node:24-slim` container (same libc as the runtime).
- vault:false: a `machines:write` key could read the owner's Instabox Vault through exec on boxes it creates; the seat needs none of it. Students can opt in later.
- Uni "sponsored seat" boolean: deferred (not needed, uni code is a conflict hotspot).

### How to run the flow without the UI (harness)
```sh
cd apps/desktop/src-tauri && cargo build --example seat_cli
set -a; . ~/.config/sef/instabox.env; set +a; printf '%s' "$INSTABOX_API_KEY" | target/debug/examples/seat_cli key-save; unset INSTABOX_API_KEY
target/debug/examples/seat_cli list            # labelled seats only
# full ClaimRunner against the real API: scratchpad harness claim-e2e.mts (invoke -> seat_cli)
```
macOS note: rebuilding the (unsigned) example changes its code identity; the keychain then refuses silently in a headless shell ("User canceled"). Fix: `security delete-generic-password -s app.saintelmsfire.desktop -a instabox-api-key` and key-save again from the new binary.

### Findings
- **(a) X-Forwarded-For: the edge OVERWRITES it.** Sent `X-Forwarded-For: 1.2.3.4` (and `1.2.3.4, 5.6.7.8`) → box saw only the real client IP (149.88.106.138). It also overwrites X-Forwarded-Host and X-Forwarded-Proto (sent `evil.test`/`http` → replaced). `X-Real-IP` passes through untouched (engine ignores it). Engine `auth_failed` logged the real IP for a spoofed request. No PR-37 bug; no 37 branch change made.
- **(b) CPU model speed (4 vCPU / 8 GiB, gemma4:e2b via ollama 0.40.3 container):** generation 6.1–6.2 tok/s (9-token and 376-token runs), prompt eval 92–144 tok/s, cold load 61 s (first load from disk). RAM with engine + ollama loaded: ollama container 6.06 GiB, engine 177 MiB, `available` 2.36 GiB of 7.96. A ~300-token answer ≈ 60 s: usable but slow; streaming matters. `gemma4:e2b` is 4.6 GB on disk, `embeddinggemma` 621 MB; pull ≈ 30 s total.
- **(c) Bootstrap timings (box 1, first run):** preflight 8 s, checkout 3 s, configure 0 s, ollama (image pull) 89 s, models ∥ build (build failed first time: youtube-dl-exec needs Python → fixed with YOUTUBE_DL_SKIP_PYTHON_CHECK). Re-run after fix: total 17 s (build 12 s incl. vite 5 s, engine 2 s).
- **Exec over ~60 s gets cut**: a blocking exec running ~60+ s returned HTTP 000 at 61 s client side (curl) even with timeoutSeconds 120. Treat 60 s as the practical exec ceiling; everything long must be detached (as the bootstrap is).
- **no_capacity is real**: from 13:53 to at least 13:59 every create op failed `no_capacity` (op state failed, error.code no_capacity, machine auto-removed, nothing listed). The flow surfaced it and resumed correctly.
- Safety model `shieldgemma:2b` is not pulled by bootstrap → `/api/health/detail` shows it "model not pulled" (advisory feature).
- YouTube ingest unavailable on a seat (no Python in the engine container).

### Box 2 end-to-end evidence (`sef-seat-e2e-2`, `m_agquulififxw7v2crdngvbe3a4`, created 14:03:45, deleted 14:08:13)
- Driven by: the real `ClaimRunner` and `instabox.ts` in Node, with `invoke` replaced by `seat_cli`, which calls the same Rust command functions; key from the macOS Keychain. The dialog UI was checked in Chromium against a mocked Tauri bridge, plus the plain-browser path. Not clicked through the real Tauri window.
- Five create ops failed `no_capacity` at 13:53–13:59 and were auto-removed; the 6th (14:03:45) succeeded. Create → saved seat: about 110 s.
- **(c) Bootstrap timings (fresh box):** inputs 0, preflight 2, checkout 1, configure 0, ollama 62, models 29 (parallel), build 14, engine 4; total 98 s.
- Killed the harness mid-bootstrap and resumed in a new process: same machine adopted, no second create, the running bootstrap was joined (exactly one "bootstrap starting" in bootstrap.log), then completed.
- Public URL: `/api/health` 200 `{"ok":true,"engine":"0.2.0","uni":{"reachable":true}}`; `/api/health/detail` 401; `/` serves the UI. Real sign-in (ananya, demo password, through the tunnel uni): `online`, `/me` 200; detail shows the uni reachable, e2b/embeddinggemma reachable, shieldgemma not pulled.
- Chat SSE over the edge: Guide and Friend turns. Status/tool events arrived at about 1.0 s, `done` at 29–31 s on the same stream (not buffered). Both teachers refused for lack of grounding: a fresh seat student has no installed lessons, so multi-delta token streaming was not exercised. Box 1 earlier showed 1 s-paced events.
- Teardown done: harness, cloudflared, uni (4510), Postgres container `sef-seat-e2e-pg` (4532), Vite (4530); keychain item deleted; no 45xx listeners left. Final list: only `box-c0ab84` (suspended).

### Follow-ups / known limitations (documented in `docs/hosted-seat.md`, not fixed in PR-38)
- About 6 tok/s CPU-only (`gemma4:e2b`), with about a 61 s cold load: chat is usable but slow.
- About a 60 s practical exec ceiling despite the documented 600 s; long work must be detached.
- YouTube ingest is unavailable on a seat (no Python in the engine container).
- `shieldgemma:2b` is not pulled.
- A fresh seat has no lessons installed until the student syncs; the teachers refuse ungrounded questions. PR-39 should consider a first-sync step.
- Dev desktop builds: rebuilding changes the code identity, so the keychain asks again (headless: silently refused).

## 9. Golden snapshot (PR-44, 2026-10-17)

**Deliverable: `sn_agquvoffdwntsavcwjqifjtzuy`** (`sef-golden-9946999-202610171636`, status ready), engine commit `99469999ab07d567d254ef7cfd9238d7644979f1` on `feat/44-golden-snapshot`. Template universal, 4 vCPU / 8 GiB, data 20 GiB nominal (1.2 GB used), root 16 GiB.

**How it was built:** `GOLDEN_REF=<sha> infra/seat/golden/build-snapshot` (bash + curl + jq, key from env via `-H @-`). Builder `m_agquvoa3nvegg4jmorqx2srtcm` (app:sef-golden) ran `bootstrap.sh` with `SEAT_MODE=golden SEAT_MODEL_MODE=central` (no Ollama, no models), verify (node:24-slim present, tsx, dist/index.html, no containers), scrub (engine-data empty, no session.env, no secret-looking values), stop, snapshot (201 sync), delete, rotate (keep newest 2). State/keys in `$GOLDEN_STATE_DIR/build.state`.

**Build timings (create to snapshot, 39 s total):** create + ready 4 s; bootstrap 24 s wall (inputs 0, preflight 2, checkout 1, configure 0, build 13, image 0, scrub 0; the rest is exec round trips); verify 1; scrub 1; stop 3; snapshot 4; delete 1; rotate 1.

**Session from snapshot (smoke-session, VM `m_agquvol4fs5qw3db34eifdelsq`): login-to-ready 19 s.** create 13 s (the box came back `running`, NOT stopped: the create op itself took ~11 s for the restore), ready/start 2 s, publish 1 s, session-start.sh 3 s (engine healthy 2 s after `compose up`), public `/api/health` immediately. Checks: health exactly `{"ok":true,"engine":"0.2.0","uni":{"reachable":false}}`, `/api/health/detail` 401, `/` served the UI.

**Probes on the session VM:** engine-data held only `settings.json` and `trust` (created at boot); the uni provider pointed at the gateway URL with `apiKey:null` on disk (the token stays in env only); session.env mode 600; RAM used 713 MiB of 7964 (no Ollama). Stop 2 s, start 4 s, public health 6 s after the start began: the engine container and session.env survive a stop/start.

**Exec finding:** `cd X && setsid nohup cmd > log 2>&1 < /dev/null &` backgrounds the whole `&&` list in a subshell that keeps the exec's stdout open, so the exec blocks until the job ends (21 s for a 20 s sleep). `cd X || exit 1; setsid nohup ... &` returns in 1 s. build-snapshot uses the latter.

**Final (supersedes the deliverable line above): `sn_agquvqu6h2bc33n7w2bfctcxni`** (`sef-golden-942573f-202610171647`), rebuilt at the reviewed PR #77 head `942573f702d0d8316b31744aadfcec708ffe7c2f` (ShipWright review fixes: scrub golden-only, gateway view re-points on-box roles). Builder `m_agquvqp6p46snpybmjfotiwzg4`. Build 45 s: builder 5, bootstrap 29 (build 17), verify 1, scrub 1, stop 3, snapshot 4, delete 1, rotate 1. The launch exec now returns in ~2 s (the `;` fix). Snapshot #1 `sn_agquvoffdwntsavcwjqifjtzuy` (the one smoke-tested above) was deleted at 16:47:23, so only the final one remains. The final snapshot was NOT smoke-tested separately (3-create cap for this PR); its pipeline, session-start.sh and compose are the same as #1's.

End state 16:47:23: machines = only `box-c0ab84` (suspended, untouched); snapshots = only `sn_agquvqu6h2bc33n7w2bfctcxni` (ready).

**Rebuild 3 (2026-10-17 17:56-17:58 UTC): `sn_agquwaykk47e4x4cns5gfcv2pa`** (`sef-golden-b02ea1b-202610171757`), engine commit `b02ea1bf962442fc5b89b7d95562e4d35a7a56b1` (#77 head: the gateway is reached through the engine's native Ollama provider at the gateway root with `Authorization: Bearer`, and session-start.sh accepts `VAULT_SYNC_ACCOUNT`/`SYNC_FLUSH_TOKEN`). Builder `m_agquwatpeemfth7i2nj3fvwzv4`. Build 48 s: builder 7, bootstrap 23 (preflight 1, checkout 1, build 13), verify 1, scrub 2, stop 4, snapshot 6, delete 4, rotate 1. Rotation (keep 2) deleted nothing: the two `sef-golden-*` snapshots are #2 `sn_agquvqu6h2bc33n7w2bfctcxni` (942573f) and #3. Smoke session `m_agquwa2q3no4guqf7avnx43ghe`: login-to-ready 28 s (create 16, start 4, publish 1, session-start 4 with the engine healthy 2 s after compose up, public health 3); session.env got all 7 names incl. the two sync values; health exactly `{"ok":true,"engine":"0.2.0","uni":{"reachable":false}}`, detail 401, UI served; VM deleted in 3 s. Two creates in total (builder, smoke). Does NOT contain #82 (`session-stop.sh`) or #83 (sync engine code): rebuild after they merge.

**Rebuild 4 (2026-10-17 19:53-19:55 UTC): `sn_agquw3rpykrsqophbvuy3hnlpy`** (`sef-golden-4d6c32c-202610171954`), engine commit `4d6c32c7d92abd720f34849a178c8d4936a3bd4f` (main after #82/#83 merged; has `infra/seat/session-stop.sh`). Builder `m_agquw3mtjuy5bl4ij6cw44xkpa`. Build 45 s: builder 4, bootstrap 29 (preflight 1, checkout 1, build 14), verify 1, scrub 1, stop 3, snapshot 4, delete 1, rotate 2. Rotation deleted #2 `sn_agquvqu6h2bc33n7w2bfctcxni`; kept #3 `sn_agquwaykk47e4x4cns5gfcv2pa` and #4. Smoke session `m_agquw3srpaxurla6pbhidi4kwe`: login-to-ready 23 s (create 16, start 2, publish 1, session-start 3, public health 1); session.env got all 7 names incl. VAULT_SYNC_ACCOUNT/SYNC_FLUSH_TOKEN; health exactly `{"ok":true,"engine":"0.2.0","uni":{"reachable":false}}` (no `sync` key: no object store given, sync off), detail 401, UI served. A second smoke-session invocation (meant to delete the kept VM) deleted it and also created and deleted one more VM (16 s login-to-ready, session-start 4); 3 creates in total.

End state 17:58:30: machines = only `box-c0ab84` (suspended, untouched); snapshots = `sn_agquvqu6h2bc33n7w2bfctcxni` (ready, #2) and `sn_agquwaykk47e4x4cns5gfcv2pa` (ready, #3, current).

**Rebuild 5 (2026-10-17 20:59-21:00 UTC): `sn_agquxksmadilsip5f3k42n7o7u`** (`sef-golden-0bde963-202610172100`), main `0bde963` (after #92/#93: `session-start.sh` passes `ENGINE_ALLOWED_ORIGINS`). Built in 44 s (bootstrap 29 s), smoke login-to-ready 18 s (create 12, start 1, publish 1, session-start 3, health 1). Set as the Render uni's `SEF_GOLDEN_SNAPSHOT_ID`. Rotated out `sn_agquwaykk47e4x4cns5gfcv2pa`; snapshots now `sn_agquw3rpykrsqophbvuy3hnlpy` (#4) and `sn_agquxksmadilsip5f3k42n7o7u` (#5, current).

## 10. Session orchestrator (PR-42, 2026-10-17)

**What ran:** the uni server's orchestrator (`server/uni/src/sessions/`, TS Instabox client in `server/uni/src/instabox/`) on a local uni (127.0.0.1:3610, disposable Postgres on 3633, `SEED_DEMO`), reached by the VM through a `cloudflared` quick tunnel (torn down afterwards). Demo student `ananya` signed in with the legacy password login, then `POST /v1/session`. Dummy gateway (`https://gateway.invalid/v1`, HMAC token minted) and dummy `OBJECT_STORE_*` values. One create in total (cap was 2).

**Login-to-ready: 16.5 s** (login request to `GET /v1/session` = ready; the spawn itself 16.2 s from lease to ready), against 19 s for PR-44's smoke-session:
- create (from the golden snapshot, create op incl. restore) 10.3 s; the VM came back `running`, so `start` was only the readiness probe (<1 s);
- publish 1.1 s;
- session-start.sh 3.2 s (the script: "engine healthy after 3s");
- public health ready on the first probe, about 1 s (no `sync` field: the snapshot predates PR-41b, which counts as ready).

**Checks:** public `/api/health` was exactly `{"ok":true,"engine":"0.2.0","uni":{"reachable":true}}` (the VM reached the tunnelled uni), `/api/health/detail` 401, `/` served the UI. A real sign-in on the VM (`POST /api/auth/login`, ananya) came back `online`, profile `ananya`, full access: `ENGINE_SEAT_OWNER=ananya` (the legacy `account.id`) matches what the password sign-in pins. `brinda` was refused: "This seat belongs to another student."

**Teardown (DELETE /v1/session): 2.9 s.** stopping → flush exec 1.5 s (`session-stop.sh` is not on this image: exit 127, logged `session_flush_unavailable`, not retried) → delete 1.3 s (op succeeded, GET 404) → row `ended`, `end_reason logout`, `last_error "flush: session-stop.sh not found on the image"`.

**Findings / contract notes:**
- The golden image keeps the scripts in `SEAT_HOME=/data/home/sef-seat` (`session-start.sh` is copied there by bootstrap.sh), not under `infra/seat/`. The orchestrator runs `bash /data/home/sef-seat/session-start.sh`, and for the flush tries `/data/home/sef-seat/session-stop.sh`, then `/data/home/sef-seat/src/infra/seat/session-stop.sh`.
- #77's session-start.sh writes only its own list of keys to session.env: `VAULT_SYNC_ACCOUNT` and `SYNC_FLUSH_TOKEN` are passed in the exec envs but dropped until PR-41b adds them to its `check` list (and copies session-stop.sh next to it).
- no_capacity: replaying a refused create's Idempotency-Key returns the refusal again, so the orchestrator retries with a FRESH key after a definite refusal (the sandbox was auto-removed) and keeps the key only when the outcome is unknown (network).

End state 17:14:20: machines = only `box-c0ab84` (suspended, untouched); snapshots = only `sn_agquvqu6h2bc33n7w2bfctcxni` (ready, untouched).

## 12. Render deployment (2026-10-17 UTC, branch infra/render)

URLs: uni https://sef-uni.onrender.com (`/health`, `/app`), gateway https://sef-gateway.onrender.com, MinIO (S3 API only) https://sef-minio.onrender.com, Postgres `sef-uni-db` (internal only). Region singapore. Secrets in `~/.config/sef/render.env` (600). Gateway upstream = cloudflared quick tunnel to the laptop's Ollama (`--http-host-header localhost:11434`, else Ollama answers 403).

**Plan caveat:** the workspace has no payment method, so Starter / disks / paid Postgres were refused (`need_payment_info`); everything runs on **free** (sleeps after 15 idle min, no disks, free Postgres expires after 30 days). The diskless MinIO lost its bucket and engine key on its first spin-down, which failed session #1. Until upgraded: re-run the MinIO init after any MinIO restart, and keep traffic on the services.

Timings: uni build+boot ~4 min (first), gateway ~1 min; uni login 0.3–0.8 s; **login → ready 34.6 s** (create op ~29 s, session-start 4.3 s, health 0.6 s); **first Guide answer 3.65 s** for the whole turn (gemma4:e2b already warm; the cold e2b load through the tunnel took 40.8 s on the direct gateway test); teardown 3.6 s (flush 1.4 s, delete 1.3 s). Gateway direct: no token 401; signed token streams `/api/chat` (e4b 1.3 s, e2b cold 40.8 s). Store contract (incl. If-Match / If-None-Match) 9/9 and vault-sync integration (A flushes, B restores) 1/1 against the Render MinIO. The vault after session #2 holds the Guide conversation (`ananya/files/sessions/s-c6ffb7f3-….json`). **Restore on a second VM was NOT run:** the 2-create cap was used by the failed #1 and #2.

## 13. UI rehearsal (2026-10-17 21:52-22:18 UTC, main 1776f48, Vercel production at 1776f48)

Setup: uni + gateway on branch `main`; vault store = the laptop's MinIO (compose `store` profile, named volume `saint-elms-fire_minio-data`, operator keys) through a cloudflared quick tunnel (no `--http-host-header`: S3 signs the Host); `sef-minio` suspended. Store contract 9/9 (If-Match incl.) and vault-sync integration 1/1 through the tunnel. Uni env: `SEF_GOLDEN_SNAPSHOT_ID=sn_agquxksmadilsip5f3k42n7o7u`, `APP_PUBLIC_ORIGIN`/`VITE_APP_URL=https://saint-elms-fire.vercel.app` (the portal bundle on Render contains it), `SESSION_IDLE_MINUTES=10080`, `SESSION_MAX_CONCURRENT=4`, `SESSION_AUTO_SUSPEND_SECONDS=300`, `MODEL_GATEWAY_TOKEN_MINUTES=1440`. Headless Chromium (Playwright), scripts in the session scratchpad.

**Deviation: demo personas cannot use the hosted sign-in UIs.** ananya/brinda/chetna are legacy accounts (no better-auth user): the portal's email sign-in answers "do not match an account", and on the VM the hosted sign-in offers only the device flow (approval needs a better-auth portal session) and the "Exploring the demo?" buttons, which send the public `harbor-lantern` password. So the rehearsal took the lease with the legacy token (`POST /v1/auth/login` → `POST /v1/session`, i.e. what "Open my workspace" does), opened the exact hand-off URL the portal builds (`<app>/?workspace=<VM>`), and signed in on the VM through the app's own `POST /api/auth/login` from the page, storing `sef.session` as the app does. Everything after that is the real UI.

Run 1 (VM m_agquxwtikvgaedwc4ctsodqdoi): uni login 0.34 s; **login → ready 22.9 s**. Hand-off: landed on `https://saint-elms-fire.vercel.app/` with `sef.workspace={"engineUrl":…}` stored and `?workspace` stripped (0.6-1.3 s); "Signing in to <VM host>" shown; VM sign-in 1.5-2.3 s (mode online). Library → Download all: six verified courses. **Guide**, first answer (cold, e2b): 21.5 s for the turn; a warm second question 6.1 s. The turn's steps stream in (DOM grows at 0.6/1.4/2.2 s), the answer text lands whole at the end (checked before display: "3/5 checks"). Before the courses were installed, the Guide refused ("Your released lessons don't back that"). Add to my wiki: a "My own thinking" note (filed twice by a script retry) and `diagram.png` via Upload a file → sources filed. Sync row (status-dot tooltip): "Saved · just now"; `/api/health/detail` sync `{state:ready,pending:false}` within ~60 s; the image is in the vault as `blobs/sha256/0a/0af9e990…` (matches the file's sha256). Sign out (profile menu) → workspace ended in 2.6 s UI, uni: flush `{"ok":true,"pushed":1,"version":23}`, machine deleted, session ended 4.7 s after the click.

Run 2 (VM m_agqux2hwqbavnwydi2fq2ytjci): **login → ready 21.6 s** (create 9.9 s, session-start 4.0 s, health incl. **restore 6.7 s**). After sign-in: sync `state:ready`; the note and the `diagram` source are back; opening the image fetched `/api/sources/<id>/raw` (image/png) lazily, shown in 1.8 s. Sign out → flush ok (pushed 1, v25), machine deleted, ended 4.7 s. List: only box-c0ab84.

Idle: with `SESSION_IDLE_MINUTES=5` (as first set) an idle VM was torn down 5 min after its last heartbeat, but only while the free uni is awake (the reaper runs in the uni process). Now 10080 for the persistent demo VMs below; Instabox's own 300 s auto-suspend parks them instead.

Persistent demo VMs (left running; lease 7 days, never reaped while heartbeat-free for < 7 days): ananya m_agqux2qs347vlrjt45lkayetdq (ready 35.9 s), brinda m_agqux2vafhekz5pskog6idazsq (37.2 s), chetna m_agqux2zpzs3w3ek5qu65dksrba (16.7 s), created with `autoSuspendAfterSeconds=300`.
By 22:17:39 all three were `suspended` (Instabox), their uni rows still `ready`, and the reaper logged no idle end or orphan delete (it skips machines a live row owns). **Wake:** `POST /v1/session` as brinda returned the existing ready session and its URL in 72 ms; the first `GET <url>/api/health` woke the VM through the Instabox edge and answered 200 `{ok, uni.reachable:true, sync.state:ready}` after **7.7 s**. It re-suspends after 5 idle minutes.

Risks: the uni has no disk, so every redeploy **and every free-tier spin-down** regenerates its ed25519 signing key (`KEYS_DIR`, no env option); the persistent VMs pinned key fingerprint `ecf18b3ce8146f83` (sha256 of `/v1/keys` PEM, 22:1x UTC). Demo account ids are fixed literals (`packages/shared/src/demo.ts`), so seat-owner pins survive a re-seed. The VM's gateway token is minted once at session start (now 24 h) and never refreshed.

## 14. Seeded persona vaults (P0-B, 2026-10-17 22:5x UTC, main 5171e8e = PR #97)

**Why:** the hosted VMs restored near-empty vaults, so the demo personas had no brain on the cloud stack. Goal: each of ananya/brinda/chetna restores the full local demo seed (`engine/src/demo/seed.ts` + `personas.ts`) on a fresh VM.

**How the seed maps to the store:** `SEED_DEMO=true` seeds all three personas into one data dir on boot (before the server listens, before vault sync's restore); vault sync carries exactly one profile (`VAULT_SYNC_ACCOUNT`, scope = `brain/ sessions/ quizzes/ content/ plans/` + four JSON files, `engine/src/sync/scope.ts`). So one local engine per account, each in a fresh `ENGINE_DATA_DIR`, pushing only its own profile. Seeded courses are installed from the repo courseware with `signedMetadata: true` and the same derived versions the uni releases; nothing on the VM re-verifies installed content on read, so the VM accepts it (a later course sync replaces it with the uni-signed package of the same version).

**Steps:**
1. Ended the three persistent sessions with `DELETE /v1/session` as each student (22:52:20; flushes ok, machines deleted 22:52:23-25; Instabox list = only box-c0ab84). Ledger §3.
2. Wiped `vaults/{ananya,brinda,chetna}/` in the laptop MinIO with the root creds, every version and delete marker (225+2 / 201 / 361 versions before; 0 after). Nothing else touched (two `test-*` prefixes remain).
3. Seeded and flushed (local engines on 2741-2743, `OBJECT_STORE_ENDPOINT=http://127.0.0.1:9000`, engine key, `UNI_SERVER_URL=https://sef-uni.onrender.com`, seat owner = account, not hosted):

| account | seed (pages / links / sessions / courses / personal-sky) | flush | manifest v1 files | brain/concepts | content courses |
|---|---|---|---|---|---|
| ananya | 62 / 4 / 2 / 8 / 0 | pushed 126 | 126 | 62 | 8 |
| brinda | 752 / 14 / 2 / 21 / 3 | pushed 945 | 945 | 750 (+1 question, +1 synthesis, 3 raw sources) | 21 |
| chetna | 1384 / 16 / 3 / 40 / 1 | pushed 1712 | 1712 | 1383 (+1 question, 1 raw source) | 40 |

4. P0-A applied by the user (`apply-p0.sh`): env key PUT 200, uni deploy dep-dba1gpajnfac73e0coqg live at 5171e8e (/health 200 00:54:41), Vercel `VITE_DEMO_MODE=true` + prod redeploy. Uni log 00:54:28 `signing_keys_from_env` fingerprint **3303b43e2ac10326**; `/v1/keys` hashes to the same fingerprint (issuer "Saint Elms University").
5. Recreated the three VMs with `POST /v1/session` as each student, one after another: 3 creates, each on the first attempt (no no_capacity). Instabox list afterwards: box-c0ab84 (suspended, untouched) + the three below.

**VM verification (00:55-01:05 UTC):**

| account | VM / URL | lease → ready | create / session-start / health incl. restore | health | brain pages | Sky lit (graph nodes) | Philosopher | Library / course sync |
|---|---|---|---|---|---|---|---|---|
| ananya | m_agquzamruxce5u6wilgbffhzau, https://4100-agquzamruxce5u6wilgbffhzau.instabox.tech | 24.6 s | 12.6 / 4.1 / 7.9 s | `uni.reachable:true, sync.state:ready` | 62 | 62 (of 337) | answered (lane `answered`), anchored to legacy concept page `centripetal-acceleration`, 30.9 s | 8 courses restored; `install-all` updated all 8 to the uni-signed packages in 9.0 s, then 8 `installed` |
| brinda | m_agquzap2kjrrm3i2f5pfao27oq, https://4100-agquzap2kjrrm3i2f5pfao27oq.instabox.tech | 69.4 s | 9.0 / 3.7 / 56.7 s | ready | 750 concept pages (752 with question + synthesis) | 752 (of 1039) | answered, anchor `uniform-continuity`, 56.2 s | 21 restored → 21 `installed` |
| chetna | m_agquzayrnw347ifqvfo2snuppa, https://4100-agquzayrnw347ifqvfo2snuppa.instabox.tech | 114.7 s | 8.1 / 4.0 / 102.6 s | ready | 1383 concept pages (1384 with question) | 1384 (of 2080) | first try cut off mid-stream at 74 s while the 40-course install still ran; retry answered (lane `answered`, anchor `band-gap`) in 5.5 s | 40 restored → 40 `installed` |

Sign-in on each VM: engine `POST /api/auth/login` with the demo password → `mode: online`, the right profile. Anchor catalogue: ananya 62, brinda 749, chetna 1383. So ananya has no personal-sky pages but still gets an anchor: her seeded legacy concept pages qualify. Every course install passed the package signature check against the key the fresh VM pinned from `/v1/keys` (= 3303b43e2ac10326). Signature failures would have made install fail; I didn't read the VM's own engine log (that needs exec).

**Findings:**
- Seeded courses show as `update` in the Library until synced. The seed installs the repo courseware with derived versions (e.g. `722c874088716f26`); the uni releases `v1-…` versions. One "Download all" fixes it, and the course sync on all three VMs did exactly that.
- `POST /api/sync/install-all` for 21/40 courses runs past the Instabox edge's ~21 s timeout: the client gets a 502 ("sandbox service disconnected"), but the install finishes on the VM. The UI should install per course or poll status.
- Restore time scales with vault size through the cloudflared tunnel to the laptop MinIO: 7.9 s for 126 files, 56.7 s for 945, 102.6 s for 1712.
- The three VMs are left running; they auto-suspend after 300 s idle.

## 15. Vercel production deploys (2026-10-18, 01:10)

- Vercel has **no git integration**: every production deploy so far was `vercel --prod --yes` from the
  `saint-elms-fire-app-vercel` worktree (holds the `.vercel/` project link). A push to `main` does not deploy.
- Before deploying, put that worktree on the commit you want (`git checkout --detach origin/main`). The
  first deploy of the day shipped PR-45d because the worktree was stale; redeployed from `5171e8e`.
- Production env on Vercel: `VITE_DEMO_MODE=true`, `VITE_WORKSPACE_HOST_SUFFIX`, `VITE_APP_URL` (see §12).
- Verified click-through after the redeploy: portal demo sign-in 2.3 s → `POST /v1/session` reused
  ananya's lease → hand-off 3.3 s → persona button prompts for the demo password → workspace sign-in
  3.8 s → dashboard at 11.1 s total (62 of 286 lit). Script: scratchpad `signin/hosted-demo.mjs`.

## 16. Audio on seats, golden rebuild, pinned demo workspaces (2026-10-18, 01:30–02:00)

**Why audio failed on seats:** the seat engine container is `node:24-slim` (no ffmpeg → 503 `ffmpeg_missing`),
and the gateway had no `/v1/audio/transcriptions` route, so the engine refused to call it for the gateway
provider. Images worked because vision goes through the gateway to gemma4 E-models (which carry the audio
encoder). YouTube additionally needs yt-dlp (Python) and datacenter IPs are often blocked; left out.

**PR #99 (merged, `b2d8d1d`):** bootstrap.sh step `tools` installs a static ffmpeg (BtbN
`autobuild-2026-10-17-20-51`, `ffmpeg-n8.1.3-18-g46d899d7a0`, sha256 pinned per arch) under
`$SEAT_HOME/cache/bin`; `FFMPEG_PATH=/seat/cache/bin/ffmpeg` in seat.env; gateway routes
`POST /v1/audio/transcriptions` (multipart, model form field checked) to Ollama workers; engine posts chunks
to `<gateway>/v1/audio/transcriptions` with the session token. Verified: scratch VM from the golden snapshot
(x86_64, 5 s download, runs in node:24-slim as uid 1000), local gateway + laptop Ollama transcribed the
spoken WAV in 13.7 s, 403 on a disallowed model, 401 without a token.

**Live VMs patched (no recreate):** scratchpad `ffmpeg-vm/patch-vm.sh <mid> <ref>` runs `remote-patch.sh` on the box:
install ffmpeg, append FFMPEG_PATH to seat.env, move `src/` to the ref (lockfile unchanged check), recreate the
engine. ananya 5 s, brinda 2 s, chetna 5 s to healthy; sync ready on all three afterwards.

**Golden snapshot rebuilt:** `sn_agquzmervope4cyky4atfddtvm` (`sef-golden-b2d8d1d-202610180146`, 58 s).
Rotated out `sn_agquw3rpykrsqophbvuy3hnlpy`. Uni env `SEF_GOLDEN_SNAPSHOT_ID` must be moved to it
(scratchpad `apply-uni.sh` does that together with the pinned accounts).

**Gateway deploy:** scratchpad `apply-gateway.sh` (POST deploy at origin/main, waits for live). Until it runs, VM
audio uploads reach the old gateway and get 404 → the engine reports the chunks as failed.

**Pinned demo workspaces (PR for `feat/50-pinned-sessions`):** `SESSION_PINNED_ACCOUNTS=ananya,brinda,chetna`.
Logout flushes and keeps the VM + lease (`202`, state stays `ready`); next sign-in resumes the suspended box.
Staff end / idle reaper / expired lease still tear down. Integration tests (ephemeral Postgres) 72 pass.

**E2E audio check (after the gateway deploy):** scratchpad `audio/e2e-upload.mjs <engine url> <email>` signs in on
the VM's engine with the demo password and posts `audio/hello.wav` (macOS `say`, Newton's second law) as an
audio source; expect `extraction.method: audio` with the sentence in `text`.

**Rollout done (02:10 UTC / 07:40 IST):** gateway live at `b2d8d1d` (dep-dba2c3vbtjjs73dh441g); uni live at
`6ab7e9c` (dep-dba2jomq1p3s73a2u5vg) with `SESSION_PINNED_ACCOUNTS=ananya,brinda,chetna` and
`SEF_GOLDEN_SNAPSHOT_ID=sn_agquzmervope4cyky4atfddtvm`. PR #100 merged.
- E2E audio on ananya's VM: `POST /api/sources` 201 in 17.6 s, `extraction.method: audio`, full transcript.
- Pinned logout on ananya: POST ready → DELETE 202 (flush 1.9 s, state stays `ready`) → POST same id and URL.
- Demo-day rule that no longer applies: signing out on stage is safe for the three demo accounts.

## 17. UI issues noted by the user during the runbook walk-through (2026-10-18, 08:00 IST) — to research when asked

1. **Teachers: suggestions shown twice.** The teacher intro shows three suggested questions in the centre,
   and the suggested-question bank shows five more chips above the composer. Two sources (intro prompts vs
   PR-33 suggestion bank) rendered at once; pick one placement, or make the intro use the bank.
2. **Peers on a hosted workspace with a demo account:** "Sign in needed — Sharing needs a live university
   session. Sign in while online, then try again." The legacy demo sign-in on the VM has no uni session the
   share routes accept (PR-35 shares need a `session` principal; legacy tokens are not accepted there, or the
   engine never received one). Decide: accept legacy tokens on `/v1/shares*` for demo, or hide Peers for
   legacy accounts with a clear message.
3. **Sky: the left panel (Next up, Plans) stays open when a star is selected** and competes with the right
   detail panel. Collapse the left column (or slide it away) while a star is selected; restore on close.

## 18. Real accounts on the hosted uni: mail + admission (2026-10-18, 08:20–09:05 IST)

- **Mail:** Render blocks outbound SMTP, so Resend SMTP (which works from the laptop on 465/587) never
  connected from the uni: sign-up hung ~10–20 s on nodemailer's connection timeout, then the portal still
  said "Sent" (UX bug: portal/better-auth report success although the server logged `mail_send_failed`).
  PR #101 (merged `698d72e`): `MAIL_RESEND_API_KEY` → HTTPS API transport. Render uni env now has
  `MAIL_RESEND_API_KEY` (from `RESEND_API_KEY` in render.env) and `MAIL_FROM=Saint Elms University
  <onboarding@resend.dev>`; `MAIL_SMTP_URL` removed. Resend account has NO verified domain: sandbox,
  sends only from onboarding@resend.dev and only to the account owner's address (arry8668@gmail.com).
  Verify a domain in Resend to mail anyone else. PR #102 (merged `87a8c06`): HTML templates; needs a
  uni redeploy (`scratchpad/deploy-uni.sh`).
- **Admission:** no staff UI exists for enrolment decisions and the first staff grant needs the DB.
  Render Postgres `dpg-db9tae3ncjis73ajea10-a` now has an ipAllowList (operator /32 + 106.192.0.0/16,
  "demo day only - remove after"); external URL saved as `UNI_DATABASE_URL_EXTERNAL` in render.env
  (append `?sslmode=no-verify`). Operator script: `scratchpad/admit/operator-approve.local.mts`, copy into
  `server/uni/` to run (`pnpm -s exec tsx ./operator-approve.local.mts list | approve <id> <version>`);
  never commit it (it slipped into PR #101 once and was removed). Approved enrolment
  `3588e812-…` (user's own account) into `bsc-pma-2026` at 03:31Z.
- Remaining for real accounts: a staff screen for decisions; portal to report mail failures honestly;
  verified Resend domain.

## 19. Tunnel outage + first real-account workspace (2026-10-18, 09:10–09:25 IST)

- The laptop's internet drop killed the MinIO quick tunnel (hostname dead, process alive). Every new spawn
  failed at `health` with `sync_error: The engine could not restore the vault` and the **portal retried in
  a loop** (create → fail → delete every ~15 s; 6 VMs churned). Flaw: the portal should stop after a
  spawn failure and show the reason. Already-restored VMs kept working (restore happens at start only).
- Fix: restarted the tunnel (`scratchpad/minio-tunnel.{pid,url,log}`, new host
  division-nomination-browsers-delivering.trycloudflare.com), repointed the three demo VMs by editing
  `OBJECT_STORE_ENDPOINT` in `session.env` + engine recreate (`scratchpad/store/repoint-vm.sh <mid>`,
  4–14 s to ready), and `scripts/store-target.sh` on the uni (`scratchpad/apply-store.sh`).
- First real account (better-auth, email verified via Resend, enrolment approved by operator): spawn
  03:51:09 → machine 13 s → engine 8 s → **ready in 22 s**, empty vault restored as fresh.
- If the tunnel dies again: `curl $(cat scratchpad/minio-tunnel.url)/minio/health/live` must be 200;
  otherwise restart it and run apply-store.sh + repoint-vm.sh for each live VM. Gateway/Ollama tunnel is
  separate (`scratchpad/cloudflared.pid`, check https://sef-gateway.onrender.com/health → healthy 1).

## 20. YouTube on seats: probe result (2026-10-18, 10:05 IST) — blocked

yt-dlp 2026.08.19 (standalone `yt-dlp_linux`, sha256 58162f9b…230a) runs inside the seat's node image
(installed at `/data/home/sef-seat/cache/bin/yt-dlp` on brinda's VM, harmless, no env points at it).
Both metadata and audio fetch from the Instabox IP fail with YouTube's "Sign in to confirm you're not a
bot" wall. Options, none for demo day: browser cookies (fragile, risks the account), a residential proxy
or PO-token provider, a different egress IP (DO droplet tomorrow may or may not pass). Decision: YouTube
stays "upload a file instead" on hosted workspaces. Branch `feat/56-seat-ytdlp` has no changes.

## 21. Polish batch (2026-10-18, 10:00–10:50 IST): PRs #103–#105

- **#104 (merged `a7af33c`) portal honesty:** better-auth 1.7.7 runs `sendVerificationEmail` in
  `runInBackgroundOrAwait` and swallows the throw, so the uni answered 200 while logging
  `mail_send_failed`. Uni now sets `x-mail-delivery: failed` (AsyncLocalStorage per request, header
  exposed via CORS); portal shows "We could not send the email" + Send again. Spawn flow: a failing spawn
  is reported failed at once, at most one auto-restart, uni sends `error.reason` (fixed sentence per code,
  `spawnFailureReason` in orchestrator.ts; `reason` in packages/shared session.ts). Peers on a demo
  account: empty state "Peers are not available on demo accounts" (`features/peers/demo-account.ts`,
  detects legacy profile = no `programmeId`); NO Peers code removed; uni authz unchanged.
- **#105 (merged `d32edbb`) multimodal + library:** images are read on upload through the vision role
  (`engine/src/media/vision.ts`, plain-text `/api/chat` call because gemma4:e4b ignores the JSON schema;
  "Read it again" falls back the same way). Live check: 800×800 PNG → `method: vision` in 3.4 s. Library
  "Download all" installs per course (`features/library/install-all.ts`, progress "Installing 7 of 21…",
  per-course failures listed). Summaries: cards flatten markdown (`lib/markdown-text.ts`), sheet/dialog
  render compact markdown. Caveats: the read happens inside the upload request (edge 21 s budget);
  images near 25 MB exceed the gateway's 32 MB body once base64-encoded → "could not read", image kept.
- **#103 (open, T3 → owner label) web app polish:** teacher intro cards are static starters
  (`TEACHERS[id].samplePrompts`) and the rail is the proactive bank; both kept, headed "Ways to start with
  this teacher" / "From your recent work", duplicates filtered. Sky: left column slides out while the
  concept sheet is open (camera inset 330 → 24). Hosted origin with no workspace: "Sign in through your
  university" + portal button. Demo persona preselect: the portal appends `&demo=<id>` to the hand-off
  (demo accounts only); the app accepts it only with `VITE_DEMO_MODE` and a known persona, stores it in
  `sef.workspace`, preselects it on the workspace sign-in. (The engine hides `/api/auth/profiles` from
  remote callers on purpose, so no engine change.)
- Rollout: demo VMs' engines patched to `d32edbb` (ops/ffmpeg-vm/patch-vm.sh); Vercel + uni via
  `scratchpad/apply-all.sh` (= ops/apply-vercel.sh + ops/deploy-uni.sh) after #103 merges.
