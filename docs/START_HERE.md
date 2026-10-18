# Start here: hosted demo stack handover (2026-10-18, 10:10 IST, updated 10:45)

Read this first, then `DEMO_RUNBOOK.md` to try the app, then `CLOUD_SEAT_NOTES.md` when you need the
why and the ids. Everything under `docs/internal/` is gitignored: share these files directly.

## 1. What runs where (the whole picture in ten lines)

| Piece | Where | What it is | Deploy |
|---|---|---|---|
| Web app (student workspace UI) | Vercel, https://saint-elms-fire.vercel.app | `apps/desktop` "app" build. Talks to the student's own VM cross-origin | `ops/apply-vercel.sh` from the `saint-elms-fire-app-vercel` worktree on main. **Git pushes do not deploy production** |
| Portal (sign-in, admission, "Open my workspace") | Render uni, https://sef-uni.onrender.com/app | `apps/desktop` "portal" build served by the uni | with the uni |
| Uni server + session orchestrator | Render `srv-db9tblnavr4c73fbj2h0`, https://sef-uni.onrender.com | `server/uni`: accounts (better-auth + legacy demo), courseware releases, enrolments, Instabox orchestration, Postgres `dpg-db9tae3ncjis73ajea10-a` | `ops/deploy-uni.sh` (code only) or the `apply-*.sh` that also set env |
| Model gateway | Render `srv-db9tam0m7kps73elmbi0`, https://sef-gateway.onrender.com | `server/gateway`: token-checked proxy to Ollama workers (chat, embed, vision, audio transcriptions) | `ops/apply-gateway.sh` |
| Student VMs ("seats") | Instabox, one per logged-in student, from golden snapshot `sn_agquzmervope4cyky4atfddtvm` | `engine/` + ffmpeg, restores the student's vault from the store at start, flushes on logout | golden rebuild: `infra/seat/golden/build-snapshot` (needs a free Instabox slot) |
| Gemma models (Ollama) | **the laptop**, via cloudflared tunnel → `GATEWAY_UPSTREAMS` | gemma4:e2b / e4b, embeddinggemma, shieldgemma | tomorrow: DO GPU droplet, swap `GATEWAY_UPSTREAMS` |
| Vault store (S3 API) | **the laptop's MinIO**, via cloudflared tunnel → uni `OBJECT_STORE_*` | bucket `sef-vaults`, one prefix per account | tomorrow: DO Spaces via `scripts/store-target.sh` (`ops/apply-store.sh` is the wrapper) |

Flow: portal sign-in → uni finds/creates the student's VM (`POST /v1/session`) → browser handed to the
web app with the VM address → the web app signs in on the VM's engine (demo password, or device-code
approved on the portal for real accounts) → everything else is engine ↔ gateway ↔ store.

## 2. Secrets and tokens (never commit, never paste into docs or chats)

- `~/.config/sef/instabox.env`: `INSTABOX_API_KEY` (full access, quota 5 machines).
- `~/.config/sef/render.env`: `DEMO_PASSWORD`, `UNI_SIGNING_PRIVATE_KEY`, `GATEWAY_TOKEN_SECRET`,
  `OBJECT_STORE_*`, `MINIO_*`, `RESEND_API_KEY`, `UNI_DATABASE_URL_EXTERNAL` (append `?sslmode=no-verify`).
- Render API token: `~/.render/cli.yaml` (the scripts read it). Vercel: `vercel login` done; project link in
  `saint-elms-fire-app-vercel/.vercel/`.
- `DO_NOT_TRACK=1` is exported for the Render and Vercel CLIs (user does not want telemetry).

## 3. Live state right now

- Instabox: `box-c0ab84` (the owner's own box, **never touch**), three pinned demo VMs (ananya
  `m_agquzamruxce5u6wilgbffhzau`, brinda `m_agquzap2kjrrm3i2f5pfao27oq`, chetna `m_agquzayrnw347ifqvfo2snuppa`;
  auto-suspend 300 s, wake 4–20 s; logout keeps them: `SESSION_PINNED_ACCOUNTS`), plus the owner's real
  account VM. **All 5 slots are used**: a golden rebuild or another real login needs the real-account VM
  signed out (its logout deletes it).
- Uni env of note: `SEF_GOLDEN_SNAPSHOT_ID`, `SESSION_PINNED_ACCOUNTS=ananya,brinda,chetna`,
  `SESSION_IDLE_MINUTES=10080`, `SESSION_AUTO_SUSPEND_SECONDS=300`, `SESSION_MAX_CONCURRENT=4`,
  `MAIL_RESEND_API_KEY` + `MAIL_FROM=… <onboarding@resend.dev>` (Resend sandbox: delivers only to the
  Resend owner's address until a domain is verified), `OBJECT_STORE_ENDPOINT` = current MinIO tunnel.
- Tunnels on the laptop: Ollama (`cloudflared … --url http://127.0.0.1:11434 --http-host-header
  localhost:11434`) and MinIO (`cloudflared … --url http://127.0.0.1:9000`). Quick tunnels get a NEW
  hostname every restart and die on an internet drop. The current MinIO hostname is in `ops/minio-tunnel.url`.
  Check: `curl $(cat ops/minio-tunnel.url)/minio/health/live` → 200, and
  `curl https://sef-gateway.onrender.com/health` → `healthy: 1`.
- If the MinIO tunnel dies: new sessions fail at "restore the vault" and the portal loops. Restart the
  tunnel, run `ops/apply-store.sh` (uni), and `ops/store/repoint-vm.sh <machine id>` for each live VM
  (edit the scripts' `minio-tunnel.url` path first: they point at the old session scratchpad).
- If the Ollama tunnel dies: restart it, set `GATEWAY_UPSTREAMS` on the gateway to the new URL, redeploy
  (`ops/apply-gateway.sh` deploys; set the env with the Render API like `render-apply.sh` does).

## 4. Tomorrow's swaps (plug-and-play by design)

1. Render: add the card, upgrade uni + gateway to Starter, add disks if wanted (no free-tier sleep).
2. DO GPU droplet with Ollama + the models → `GATEWAY_UPSTREAMS=https://<droplet>:11434#max=8` on the
   gateway, redeploy. Remove the laptop Ollama tunnel.
3. DO Spaces → run the store contract test (`docs/deploy-render.md`), `mc mirror` the three vault prefixes
   from local MinIO, then `OBJECT_STORE_SECRET_KEY=… scripts/store-target.sh <endpoint> <key> sef-vaults
   <region> false`. Existing VMs: `ops/store/repoint-vm.sh` each (or recreate them).
4. Remove the Postgres ipAllowList entry `106.192.0.0/16` after the demo.

## 5. Where things are documented

- `DEMO_RUNBOOK.md`: how to drive every feature on the live stack, expected numbers, what to avoid on stage.
- `CLOUD_SEAT_NOTES.md`: chronological engineering log (§3 machine ledger, §9 golden snapshots, §12 Render,
  §15 Vercel, §16 audio + pinned, §18 mail + admission, §19 tunnel outage). Append there.
- `MEGAPLAN.md`: the original plan; PR-41..45 section describes the ephemeral-session architecture.
- `SESSION_CONTRACT.md`: engine ↔ orchestrator contract. `TEST_IT_YOURSELF.md`: local seat-mode tests.
- Public docs in the repo: `docs/hosted-seat.md`, `docs/session-orchestrator.md`, `docs/model-gateway.md`,
  `docs/object-store.md`, `docs/deploy-render.md`, `docs/deploy-vercel.md`, `infra/seat/golden/README.md`,
  root `HANDOVER.md` (product concepts, repo map, local dev).
- `ops/`: the scripts used tonight (copied from the session scratchpad; some still reference the
  scratchpad path for `minio-tunnel.url`, fix the path when reusing). `ops/checks/*.mjs` are headless
  end-to-end checks (portal→workspace click-through, audio upload, pinned logout).

## 6. Conventions

- Every change is a PR; ShipWright reviews it; fix real findings, reply to noise, `/shipwright rerun`;
  merge when it approves (tier T3 "human approval" needs the owner's label). Stacked PRs are fine.
- Say "web app" for `apps/desktop`. One task at a time, few agents, no scope creep.
- Never print keys; scripts read them from the files above. Never keep-alive-ping Instabox (accounts get
  banned). Never create more Instabox machines than the quota leaves. Never touch `box-c0ab84`.
- The main checkout (`saint-elms-fire-app`) is on `fix/share-screen-per-policy` with uncommitted
  screening changes from the Cursor session; the owner's dev stack (4100/4200) runs there. Work in
  worktrees.

## 7. Done in the last batch (all merged and deployed, 10:45 IST)

- #103 web app polish: teacher starters vs proactive rail (both kept, de-duplicated), sky left column folds
  while the concept sheet is open, bare Vercel URL says "Sign in through your university" with a portal
  button, demo persona preselected on the workspace sign-in (passed in the portal hand-off as `&demo=`).
- #104 portal honesty: mail failures shown with Send again (uni header `x-mail-delivery`), no endless
  spawn retry (reason shown), Peers on demo accounts shows a clear empty state (no Peers code removed).
- #105 multimodal + library: images read on upload (vision via gateway), Download all per course with
  progress, markdown summaries.
- YouTube on seats: probed and dropped (YouTube bot wall on datacenter IPs; CLOUD_SEAT_NOTES §20).
- Deployed: Vercel + uni at main `bfef5f2`; engine on ananya's VM at `d32edbb`. **brinda and chetna VMs
  were still suspended with Instabox `no_capacity` on every resume at 10:45**; a retry loop was running.
  When they wake, run `ops/ffmpeg-vm/patch-vm.sh <mid> <main sha>` if the loop did not get to them
  (their engine would still be `b2d8d1d`: audio works, images-on-upload does not until patched).
- Not done: golden snapshot rebuild at the new main (needs a free Instabox slot); stale "update" badges on
  freshly recreated demo VMs (item 10, reseed vaults with uni release versions); typo "Socratest my
  Philosopher" on the workspace sign-in screen.

## 8. Known gaps, by priority

1. No staff screen for enrolment decisions (operator script `ops/admit/operator-approve.local.mts`,
   copy into `server/uni/` to run; never commit).
2. Resend has no verified domain (sandbox). 3. Seeded vaults carry repo-derived course versions, so a
freshly recreated demo VM shows "update" badges until Download all runs once. 4. Gateway tokens on
long-lived VMs last 24 h (`MODEL_GATEWAY_TOKEN_MINUTES=1440`), not refreshed. 5. Cold restore of a big
vault through the tunnel is slow (chetna ~2 min); Spaces should fix most of it.
