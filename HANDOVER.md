# Handover

Current repository behavior as of 2026-10-18, through PR #130. This is the runbook for `saint-elms-fire-app`, the pnpm monorepo. The separate `saint-elms-fire` Next.js/Docker project has a different runtime and commands.

Read [README.md](README.md) for the product and [AGENTS.md](AGENTS.md) before changing code. This document describes the checked-in implementation; a deployed UI, uni server or golden snapshot may be on an older revision.

## 1. Concepts in one page

| Term | Meaning |
| --- | --- |
| University server | Accounts, admission, cohorts, releases, signed course packages, peer relay, `/app` portal, `/admin` registrar and hosted workspace orchestration. |
| Engine | The student's runtime, on a laptop or a university-hosted VM. Owns teachers, installed lessons, wiki, sources, chat, quizzes and settings. |
| Profile / workspace | A student's isolated stores under `.data/engine/profiles/<id>/`. Local devices can hold multiple profiles; a hosted seat is pinned to its owner. |
| Course sky | Released, installed lessons and concepts with the student's evidence overlaid. The **Sky** view shows course progress and Next up. |
| Second brain | A plain markdown wiki with concept, synthesis, question and source-summary pages. The separate **Brain** view opens with a full-screen map of this wiki. |
| Proposal | A model draft normalized by code and checked against source evidence and current revisions. Model-drafted page edits wait for explicit student review. |
| Mastery | `unseen`, `met`, `shaky`, `solid`, computed from evidence and open misconceptions. Collected or model-generated material is not demonstrated understanding. |
| Source | An immutable original and versioned extraction, carrying origin and attribution. Correcting a read appends a revision; erasure leaves a tombstone. |
| Ask your brain | A wiki-only question/answer flow using the tutor model and checked page citations. A saved answer goes back through the proposal pipeline. |
| Logistics | Private, confirmed deadlines/notices, accessed through the **Logistics** sidebar item. Only the Friend may use them; they are excluded from peer-share payloads. |
| Limited session | Read/export access when admission or a signed offline entitlement no longer permits studying. Other operations refuse with `access_limited`. |

Course packages have a signed manifest and SHA-256 hashes. The engine pins the university's ed25519 key and rejects an unexpected replacement. Students install only packages released to their cohort; teachers read installed material, not the repository's courseware directory.

## 2. Repository map

| Path | Responsibility |
| --- | --- |
| `apps/desktop` | React 19 + Tailwind 4 student UI, Tauri 2 shell, and separate `/app` portal build. |
| `apps/desktop/src/features/teachers` | Composer, anchored exploration, streamed status, source/check panels and conversation history. |
| `apps/desktop/src/features/sky` | Course-oriented react-three-fiber map, concept sheets and Next up. |
| `apps/desktop/src/features/brain` | Wiki pages, Canvas 2D brain map, Ask, provenance, learning story, disagreements, maintenance and quiz UI. |
| `apps/desktop/src/features/contribute` | Source intake, reading/compile jobs and proposal review. |
| `apps/admin` | Static registrar UI served at `/admin`: students, admission decisions, record changes and audit. |
| `engine/src/agents` | Teacher harness, policies, tools, evidence checks and source attribution. |
| `engine/src/brain` | Wiki store, compiler, merge policy, mastery, Ask, maintenance and portable vaults. |
| `engine/src/profiles` | Session/auth state and per-student workspace construction. |
| `engine/src/media` | Image reading, audio transcription, uploaded video reading and YouTube fetch. |
| `engine/src/store`, `engine/src/sync` | S3-compatible adapter and hosted profile sync. |
| `server/uni` | Account auth, admission, signing, releases, PostgreSQL migrations, staff APIs and session orchestration. |
| `server/gateway` | Authenticated model proxy for hosted engines. |
| `packages/shared` | Cross-package contracts, schemas and shared Node helpers. |
| `courseware` | Programme manifest, degree lessons and university support notes. |
| `infra/seat` | Bootstrap, golden image, per-session start/stop scripts. |
| `infra`, `render.yaml` | Container services, SearXNG, MinIO and hosted deployment template. |
| `e2e` | Playwright against isolated real uni/engine processes. |

Detailed references: [teachers and harness](docs/agentic-layer.md), [wiki and graph](docs/knowledge-graph.md), [hosted engine](docs/hosted-seat.md), [session orchestration](docs/session-orchestrator.md), [gateway](docs/model-gateway.md), [vault store](docs/object-store.md), [Render](docs/deploy-render.md), [Vercel](docs/deploy-vercel.md).

## 3. Running it

### Local demo

Install Node 22+, pnpm 10.18.0 (the version pinned in `package.json`) and Ollama. Start Ollama before pulling models. Docker is optional for SearXNG, PostgreSQL/Mailpit or the container stack. Rust is needed only for the Tauri shell. Audio/video files need ffmpeg; YouTube links also need yt-dlp and Python 3 for the vendored binary.

```bash
corepack enable
pnpm install
cp .env.example .env     # first setup only; preserve an existing .env
pnpm ollama:pull         # gemma4:e4b, embeddinggemma, shieldgemma:2b
pnpm search:up           # optional SearXNG on :8888; requires Docker
pnpm dev                # uni :4200, engine :4100, student UI :5173
```

Open <http://localhost:5173>. Run `pnpm preflight` in another terminal for tool/model/service checks. The three development services hot-reload. `pnpm dev` does not start Ollama, the model gateway, or build the account/admin portals.

**Environment loading matters:** engine scripts and Vite read the root `.env`; host-run uni scripts read the process environment. Export uni settings in the shell that starts `pnpm dev` or `pnpm dev:uni`. In particular a custom `DEMO_PASSWORD` must reach both uni and engine. The stock no-database demo works because the uni defaults to seeding demo users and `.env.example` opts the engine/UI in with `SEED_DEMO=true` and `VITE_DEMO_MODE=true`.

The local demo does not need PostgreSQL. Registration, admission, the staff portal and peer sharing do; follow §4 for those. Without SearXNG the Philosopher can still answer from course evidence, but cannot supply current web results.

### Commands

| Command | What it runs |
| --- | --- |
| `pnpm dev:uni`, `pnpm dev:engine`, `pnpm dev:app` | Individual dev processes; useful for the offline drill. |
| `pnpm typecheck` | TypeScript checks across workspaces. |
| `pnpm test` | Workspace `node:test` suites; external-service integrations may skip when unconfigured. |
| `pnpm --filter @sef/engine test` | Engine suite only. |
| `pnpm --filter @sef/desktop build` | Student UI typecheck and production build. |
| `pnpm build:hosted` | Portal and admin static bundles, served by the uni. |
| `pnpm test:e2e:install`, `pnpm test:e2e` | Install Chromium, then run browser/release drills. |
| `pnpm eval` | Agent scenario runner; separate from unit tests. |
| `pnpm desktop`, `pnpm desktop:build` | Tauri development/build; the engine is not bundled as a sidecar. |
| `pnpm dev:gateway` | Model gateway only. |
| `pnpm search:up`, `pnpm search:down` | Start/stop SearXNG. |
| `pnpm store:up`, `pnpm store:check`, `pnpm store:down` | Optional local MinIO and adapter probe; see object-store guide. |

### Container stack

`docker-compose.yml` runs PostgreSQL, uni, engine and SearXNG; optional profiles add Mailpit, MinIO, Ollama and the gateway. The uni image includes `/app` and `/admin`. The production-mode services refuse the public demo password, so configure a non-default `DEMO_PASSWORD` before starting this path, alongside the database/auth/mail settings appropriate to the deployment.

```bash
docker compose build uni
docker compose up -d postgres
docker compose run --rm uni pnpm --filter @sef/uni-server db:migrate
pnpm docker:up
```

The uni server itself never migrates on boot. The Render `start:migrate` command explicitly runs migrations before starting it; Compose requires the migration step above. Use `pnpm docker:logs`, `pnpm docker:status`, and `pnpm docker:down` to operate the stack. `docker compose --profile ollama up -d` starts the optional Ollama service; model availability still needs checking.

### Models

Roles are `tutor`, `brain`, `vision`, `embed` and `safety`. The defaults are Gemma 4 E4B, embeddinggemma and ShieldGemma 2B. Settings exposes per-role providers and hardware suggestions; suggestions fill the form and require Save. An unavailable embed model falls back to keyword retrieval; unavailable safety screening is reported and does not block sharing.

Local profiles default to thinking enabled for supported worker calls; central-model seats set `ENGINE_THINKING_DEFAULT=false` and default tutor/brain/vision to `gemma4:e4b`. These are first-run defaults: stored profile settings win. Gateway credentials are applied from the environment on each settings read and never returned to the UI. See the hosted-engine guide before changing a central seat.

### Proactive study tools

The attention rail and teacher badges derive signals from the student's existing stores. Suggested questions use policy-scoped seeds and deterministic ranking; model-drafted wording is opt-in. Subject feeds require per-feed consent. Study plans are bounded proposals that the student approves, with evidence driving progress. These flows live in `engine/src/signals`, `engine/src/suggest`, `engine/src/feeds` and `engine/src/plans`; `pnpm eval` exercises agent scenarios separately from the ordinary test suite.

## 4. Demo accounts and account-server setup

| Local demo login | Stage | Demonstration |
| --- | --- | --- |
| `ananya@saintelms.local` | Semester 1, week 6 | Mechanics partly learned, open misconceptions. |
| `brinda@saintelms.local` | End of Semester 3 | Dense sky, strong physics-to-mathematics connections. |
| `chetna@saintelms.local` | Semester 5, thesis preparation | Advanced concepts, personal syntheses and research trails. |

The local password is **`harbor-lantern`**, unless overridden by `DEMO_PASSWORD`. Personas live in `packages/shared/src/demo.ts`; `engine/src/demo/personas.ts` and `seed.ts` generate their vaults deterministically from courseware. Counts change as people use a persistent workspace.

Demo data is a fixture. Engine seeding and UI helpers are opt-in; the uni's seed default is separate. Disable `SEED_DEMO` and `VITE_DEMO_MODE` for a normal deployment. The legacy operator admin still seeds and production refuses its public default password. Self-serve hosted builds additionally use `VITE_DEMO_SELF_SERVE` and `VITE_DEMO_PASSWORD`; the latter is deliberately embedded in public JavaScript and is only for demo credentials.

### Real accounts, staff and Peers on a development machine

Run these from the repository root with Docker available:

```bash
docker compose --profile mail up -d mailpit
docker run -d --name sef-uni-db -p 127.0.0.1:5433:5432 \
  -e POSTGRES_DB=sef_uni -e POSTGRES_USER=sef -e POSTGRES_PASSWORD=sef-uni-local-dev-only \
  postgres:17-alpine
export UNI_DATABASE_URL=postgres://sef:sef-uni-local-dev-only@127.0.0.1:5433/sef_uni
pnpm --filter @sef/uni-server db:migrate
pnpm build:hosted
pnpm dev
```

Reuse an existing compatible database instead of starting another container. Keep `UNI_DATABASE_URL` exported in the shell that starts the uni. Development mail defaults to SMTP on `127.0.0.1:1025`; Mailpit's inbox is <http://127.0.0.1:8025>. A Compose uni needs `MAIL_SMTP_URL=smtp://mailpit:1025` instead.

Register at <http://localhost:4200/app>, verify the email in Mailpit, then bootstrap the first staff member in another shell with the same database environment:

```bash
pnpm --filter @sef/uni-server staff:grant -- --email you@example.edu --role owner
```

Staff sign in at <http://localhost:4200/admin>. The UI lists students, approves/rejects applications, suspends/reinstates enrolments, assigns cohorts, corrects records and shows audit events. Registration alone grants neither admission nor staff access. A student applies at `/app`, waits for approval, then authorizes a device from the student app.

The legacy `admin@saintelms.local` login is for the release-management API, not the registrar UI. Obtain its bearer through `/v1/auth/login`, then use `PUT /v1/admin/cohorts/<id>/releases`; the portal has no release-toggle screen.

**Peers:** the account stack stores published shares in Postgres. With demo seeding enabled it creates admission rows for the demo personas and permits their legacy tokens on the sharing routes. Each persona belongs to a different cohort. To demonstrate one student importing another's page, use two approved students in the same cohort. Imported material goes through source → compile → proposal → review; it never directly grants mastery.

## 5. Suggested demo script

1. **Enter a workspace.** Locally use Exploring the demo? → First-year student. On a self-serve hosted build choose a Try the demo card; every self-serve arrival requests the tour. ×/Esc stops it and Tour restarts it.
2. **Sky.** Show Mechanics, an amber misconception, Next up and the concept sheet. Compare the course with Brinda or Chetna later.
3. **Brain.** Pan/zoom the full-screen wiki map and replay its growth. Search a concept; switch to Ask and ask about material already in the wiki. Follow a cited page. Explain that this is the student's notes, not an independent fact checker.
4. **Provenance.** Scroll to What your brain learned and Your brain disagrees with itself. Open a page's Built from row to compare the original source and its extraction. Show the Wiki, Sources and Maintenance tabs.
5. **Guide.** Ask why a moving thing needs force to keep moving. Open source chips, the exact lesson section and the verification panel. A short follow-up uses earlier context for retrieval while evidence checks judge the latest message.
6. **Reflect or contribute.** Freeze the conversation, paste a note, or upload an image/PDF/audio/video file. Audio/video reading runs in the background. Review/correct the extraction, compile, inspect the proposal diff and accept it. Reopen Brain to see the resulting page and story entry.
7. **Philosopher.** Select a committed course-linked wiki page, then ask for a recent real-world application. Web search is enabled by the app for each turn; the anchor bar shows the query. Point out `[course]`, `[web]` and the Trailhead. If search is unavailable, show the honest course-only fallback.
8. **Friend.** Ask for a classmate's phone number to show the pre-model refusal. A notice photo can propose logistics; confirm it in Logistics before the Friend may assert it.
9. **Quiz/history.** A course-backed concept offers a short quiz. Generation is a background job with a visible waiting state. Show the stored conversation and its sources after reloading.
10. **Optional drills.** Use two same-cohort admitted accounts for Peers, the local-only offline drill in §6, or the staff portal in §4.

YouTube links depend on an external site's availability and can be blocked on cloud IPs. Prefer a prepared audio/video file for a predictable demo. A student can have four open wiki jobs; compile or cancel sources between runs. See [DEMO_RUNBOOK](docs/DEMO_RUNBOOK.md) for a short checklist.

## 6. Auth, offline and logout

- **Local demo/password flow:** online sign-in caches a scrypt password verifier and uni credential, then issues an engine session. If the uni is unreachable, the cached verifier permits local password sign-in; a wrong password never triggers fallback. Seeded local demo profiles also have a verifier.
- **Real account flow:** verified account → approved admission → device authorization. The engine keeps the university credential in its credential store, receives a signed offline entitlement and uses a local engine session. Browser clients do not supply conversation history or another profile's workspace.
- **Offline entitlement:** local device unlock verifies the cached signature and admission. An expired but valid entitlement gives read/export-only access. Hosted/remote callers cannot use the local profile picker or offline unlock.
- **Expiry:** `ENGINE_SESSION_HOURS` defaults to 336; legacy `STUDENT_TOKEN_HOURS` to 720; `ENTITLEMENT_HOURS` to 24. Session and entitlement expiry are different checks. Limited access preserves reads and vault export, not model calls or writes.
- **Engine logout (`POST /api/auth/logout`):** revokes the calling session. If another device session remains, it keeps the profile's uni credential. The last device attempts uni sign-out and clears stored uni credentials/entitlement. It keeps the legacy password verifier and the student's files. Device-authorized accounts must sign in online again after their last explicit logout to obtain a new entitlement.
- **Hosted app sign-out:** first requests `DELETE /api/workspace`, which relays `DELETE /v1/session`, then logs out of the engine. Ending an ordinary workspace flushes and retires its VM, affecting everyone using that workspace. `SESSION_PINNED_ACCOUNTS` makes that request keep the demo VM; separate browser sessions can continue. Staff end, idle reaping and lease expiry can still retire pinned workspaces.
- **Device list:** Settings lists/revokes engine sessions through `/api/auth/sessions`. Browser engine sessions, uni account sessions and the hosted VM lease are separate layers.

**Local offline drill:** first sign in with a demo password, with engine, uni and Ollama running. Stop only the uni process, sign out and sign back in using the password. Installed lessons, saved chat, the brain and local inference remain available; course sync, peer relay and web search need their respective services. Run individual `dev:*` commands in separate terminals for this drill: stopping the combined `pnpm dev` process stops all three services. For a real device-authorized account, retain the session/entitlement and disconnect the uni rather than explicitly logging out of the last session.

## 7. Data, backup and common tasks

| Data | Default location |
| --- | --- |
| Legacy uni accounts, releases/dispersal and audit files | `.data/uni/` |
| Account auth, admission, published shares and hosted session records | PostgreSQL (`UNI_DATABASE_URL`) |
| Signing key | `server/uni/keys/`, or `UNI_SIGNING_PRIVATE_KEY` when configured |
| Device profile/session metadata and shared endpoints | `.data/engine/{profiles.json,auth-sessions.json,settings.json}` and `trust/` |
| Per-profile study data | `.data/engine/profiles/<id>/` — content, brain, sessions, quizzes and supporting stores |
| Provider choices/secrets | `profiles/<id>/private-settings.json`; authentication secrets use the credential store |
| Kept Ask answers | `profiles/<id>/asks/`; operational state outside the portable vault |

**Portable vault:** Settings → vault export/import packages the wiki, history, original sources, extractions, growth events and tombstones with hashes. Preview imports before committing. This is not a whole-account/database backup. Erasing a source removes its original and records a tombstone; dependent pages keep an explicit missing-source state. Details: [knowledge graph](docs/knowledge-graph.md#taking-the-vault-with-you).

**Hosted sync:** configure `OBJECT_STORE_*` and `VAULT_SYNC_ACCOUNT`; the final flush also uses `SYNC_FLUSH_TOKEN`. Sync restores the owner's profile at boot, lazily restores large media and writes a manifest using compare-and-swap. Starting MinIO alone does not enable sync. Verify a replacement store's contract, including `If-Match`, before switching it. Existing VMs keep their configured endpoint until reconfigured/recreated. See [object store](docs/object-store.md).

**Database backup:** `pnpm --filter @sef/uni-server db:backup <file>` uses `pg_dump` (use an absolute path — relative paths resolve from `server/uni`); restore into a fresh database with `pnpm --filter @sef/uni-server db:restore <file>` and run `db:check` before starting the server. Export `UNI_DATABASE_URL` and preserve the signing key alongside backups. `db:status` shows pending migrations; the disposable `db:test:integration` suite checks database behavior including backup/restore.

**Reset only disposable local demo data:** stop the local services and back up anything wanted before removing `.data/engine/` and `.data/uni/`. With demo seeding enabled the next boot recreates fixtures. This does not reset PostgreSQL, Docker volumes or a hosted object store. Preserve the signing key; changing it makes existing pinned engines reject sync. Never use this procedure on a live student workspace.

**Adopt old anonymous local data:** sign in to the intended profile, preview `GET /api/anonymous-data`, call `POST /api/anonymous-data/backup`, then claim with the returned `backupId`. Only the legacy content/brain/sessions/quizzes folders are imported, never credentials.

**Add courseware:** update lesson markdown and the programme manifest when adding a course, restart the uni, release the course to a cohort through the release API, then install/update from Library. Copy an existing lesson's frontmatter rather than inventing fields. Preserve signing-key continuity.

**Change a teacher:** edit the brief in `engine/src/agents/prompts.ts`, enforce boundaries in policy/validators and add deterministic tests. **Change models:** use per-profile Settings; env values are primarily first-run defaults. `UNI_SERVER_URL`/`SEARXNG_URL` do not replace already-saved endpoints — update Settings for existing workspaces.

## 8. Validation and conventions

Follow [AGENTS.md](AGENTS.md): per-profile isolation, released packages only, models propose/code decides, atomic writes, secret-free structured logs and graceful offline behavior. Keep shared contracts in `packages/shared` and deterministic tests beside code.

Run `pnpm typecheck` and `pnpm test` before committing. UI changes also need browser verification. E2E starts isolated uni/engine processes on 4310/4311 and requires PostgreSQL (`E2E_DATABASE_URL`) and Mailpit (`E2E_MAILPIT_URL`). Missing infrastructure is reported as a skip; that is not a successful release drill. Model-bound steps use `E2E_LIVE_MODEL` (default `gemma4:e4b`); inspect annotations and `test-results/` for skipped steps. These tests are separate from `pnpm eval`.

Use a feature/fix/docs branch and a ready-for-review PR; never push directly to `main`. Keep PRs under 5,000 changed lines and address valid ShipWright findings with follow-up commits.

## 9. Troubleshooting

| Symptom | Check |
| --- | --- |
| Local demo picker absent | Root `.env` has `VITE_DEMO_MODE=true`; restart Vite after env changes. Engine also needs `SEED_DEMO=true`. |
| Registration/staff/Peers returns unavailable | Uni needs exported `UNI_DATABASE_URL`, migrations and reachable Postgres; portals need `pnpm build:hosted`. |
| Custom demo password works on only one service | Host uni does not load root `.env`; export the same value in its shell. |
| UI stays on boot splash | Engine health at `http://127.0.0.1:4100/api/health`; check `VITE_ENGINE_URL` or hosted workspace hand-off. |
| Slow first answer or compile | Model cold start, provider health, or stored thinking setting. Central seats default thinking off; existing profiles can retain older choices. |
| Philosopher has no web sources | Select a committed course-linked anchor; check SearXNG and the saved search endpoint. The app enables search automatically; direct API calls still require `consent.web=true`. |
| Quiz disappears after restart | Quiz-generation jobs are in memory; a missing job returns `quiz_job_not_found`. Retry generation. |
| Audio/video fails or stays partial | Check ffmpeg and the vision provider's transcription/vision support; inspect the named reading failure before compiling. |
| YouTube link fails on a hosted VM | Site restrictions/bot checks; upload a prepared file instead. |
| Different demo personas see no shared posts | They are in different cohorts. Peer relay also requires the Postgres admission layer. |
| Signature mismatch | Verify university identity and key continuity. Don't discard a real student's trust/data to hide the mismatch. |
| Offline unlock unavailable | Remote seats forbid it; local real-account unlock needs a retained signed entitlement. Last-device logout clears it. |
| Workspace cannot wake | Inspect session status/capacity and retry. The orchestrator falls back from resume `no_capacity` to start on the same VM. |

## 10. Current limits

- Hosted sessions need the network; offline study is a local-engine capability.
- The Tauri shell expects a separately running engine.
- Peer shares are not end-to-end encrypted. The university operator can access hosted VMs, vault storage and inference traffic.
- Teacher attribution uses lexical evidence checks. Ask checks cited page identity and provenance views; neither guarantees factual truth.
- Web search and YouTube depend on external services. Uploaded video samples frames and can miss content between samples; partial reads are surfaced.
- The registrar has admission/record/audit views, but no course-release or share-moderation screen.
- Deployment versions, model capacity, mail delivery permissions and VM quotas must be checked by the operator. Old timing/count/quota snapshots are not current guarantees.
- Golden-image, gateway-token and storage lifecycle follow-ups are recorded in the hosted reference docs.

## 11. Hosted deployment and privacy

Flow: portal `/app` → approved or demo sign-in → uni provisions/resumes a per-student VM → vault restore → browser hand-off to the web app → engine calls the central model gateway. The gateway fronts the configured Ollama/OpenAI-compatible workers; SearXNG and the object store are separate services.

[Render deployment](docs/deploy-render.md) describes uni, gateway, SearXNG, MinIO and PostgreSQL. [Vercel deployment](docs/deploy-vercel.md) describes the separate web app, portal hand-off, self-serve demo builds and analytics. [Session orchestration](docs/session-orchestrator.md) covers golden snapshots, leases, pinned demos, idle retirement and capacity errors. Repository code, web bundles and golden snapshots must be updated deliberately; changing one does not update all the others.

A self-serve demo build embeds its demo password publicly. Optional `VITE_POSTHOG_KEY` enables analytics and session replay; without it the SDK is not loaded. Inputs are masked and event URL query/fragment fields are scrubbed, but this is not a promise that every displayed page is excluded from replay. Treat seeded public demos separately from private student data.

Local providers can keep inference on the laptop. External providers, hosted inference, peer publication, web/feed fetches and optional analytics create network paths. This is a technical data-minimisation design, not a compliance certification or a promise that the university operator cannot inspect hosted data.

## 12. Hosted entry points

| Surface | Configured demo URL |
| --- | --- |
| Portal | <https://sef-uni.onrender.com/app> |
| Student web app | <https://saint-elms-fire.vercel.app> |
| Registrar | <https://sef-uni.onrender.com/admin> |
| Uni liveness / readiness | <https://sef-uni.onrender.com/health> / <https://sef-uni.onrender.com/ready> |
| Gateway health | <https://sef-gateway.onrender.com/health> |
| Vault-store health | <https://sef-minio.onrender.com/minio/health/live> |

These are configured entry points, not a live health or deployed-version report. Use the portal first. A self-serve card opens the persona and requests the tour; manual builds require the configured demo password. Real accounts need working mail, verification and staff approval before opening a workspace.

[docs/START_HERE.md](docs/START_HERE.md) indexes the current runbooks. [docs/CLOUD_SEAT_NOTES.md](docs/CLOUD_SEAT_NOTES.md) is historical engineering context, not a current machine inventory or executable deployment procedure. Private operator notes and secrets remain outside tracked documentation.
