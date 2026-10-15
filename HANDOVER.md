# Handover

Everything a new teammate needs to understand, run, demo and extend Saint Elms Fire without reading the code first. Start with [README.md](README.md) for the pitch. A coding agent should read [AGENTS.md](AGENTS.md) first (commands, invariants, definition of done). The deep references are [docs/agentic-layer.md](docs/agentic-layer.md) (teachers, tools, harness, sources, chat history) and [docs/knowledge-graph.md](docs/knowledge-graph.md) (course sky, second brain, mastery).

---

## 1. Concepts in one page

| Term | Meaning |
| --- | --- |
| **University (uni) server** | The institution's side. It owns accounts, cohorts, which courses are released to which cohort, signs course packages, relays peer shares, and serves the registrar's API. |
| **Engine** | The student's local runtime (a Node process on their device). It runs the teachers, keeps the brain, syncs courses and works offline. The desktop UI only ever talks to the engine, except for the registrar app. |
| **Profile / workspace** | One student on a device. Each has its own folder: `.data/engine/profiles/<id>/{content,brain,sessions,quizzes}`. Several students can share a device without seeing each other's data. |
| **Cohort** | An intake year (`bsc-pma-2024`, `-2025`, `-2026`). Releases are set per cohort. |
| **Release** | The registrar switches a course on for a cohort. Only released courses appear in a student's Library and can be installed. |
| **Course package** | A course's lessons plus a manifest of SHA-256 hashes, signed with the university's ed25519 key. The engine pins the key on first sync and rejects anything that doesn't verify. |
| **Dispersal** | Which version of each course each student has installed, so the registrar can see who is out of date. Devices report it on every catalogue check. |
| **Second brain** | A markdown vault of concept pages written in the student's own words. Models propose edits; a validator accepts or rejects them. |
| **Mastery** | `unseen` / `met` / `shaky` / `solid`, computed from evidence (quizzes, open misconceptions). Never written by a model. |
| **Sky** | The visual map of every course concept. Stars light up as the brain grows; aurora lines are links the student made. |
| **Reflect** | After a chat, send the session to the brain keeper to propose updates. The student sees a diff of what landed and what was rejected. |
| **Capture** | Photograph handwritten notes; the vision model transcribes them and the brain keeper proposes updates from them. |
| **Peer share** | A student sends a brain page to a classmate through the uni relay. The registrar can remove shares. |
| **Sources** | The lessons, brain pages and web results behind an answer. Lesson sources are checked against the finished answer: only lessons it measurably drew on are shown as cited, and each links to the exact section of the lesson. |
| **Chat history** | Every conversation is saved as JSON in the student's workspace, including each answer's sources and checks. Reopen it from History; a reload restores the open conversation. |

## 2. Repository map

```
apps/desktop/          React 19 + Tailwind 4 UI (also the Tauri 2 shell in src-tauri/)
  src/app/             Root (sign-in gate), App (student shell), Sidebar, ProfileMenu, BootSplash
  src/features/
    auth/              SignInView: email + password (students and registrar), demo-account helper, offline notice
    teachers/          TeachersView (coordinator), chat-store (SSE + saved sessions), Composer, MessageRow,
                       ThoughtTrace, AnswerFooter (source chips, previews, actions), ConversationHistory,
                       ReflectDialog, VerificationPanel, answer-parts (pure helpers)
    sky/               star map (react-three-fiber), layout, camera, labels, next-up, loading sky
    brain/             wiki view, concept sheet, brain diff, quiz dialog, lint
    library/           catalogue, install/update, lesson reader (deep links to sections)
    capture/           photo → transcription → brain diff
    settings/          model providers per role, uni server URL, thinking toggle
    admin/             registrar app: overview, releases, courses, students, dispersal, moderation, audit
  src/components/ui/   primitives, overlays, loading (PixelLoader, WorkingLabel), skeletons
  src/lib/             api client, session context, nav (hash routes), query hooks, stick-to-bottom scroll
engine/src/
  profiles/            registry (local accounts + scrypt verifiers), sessions, workspace manager, auth
  agents/              harness, prompts, tools, lanes, validators, attribution, Mastra factory
  brain/               vault, validator, applier, mastery, lint, graph, course-graph
  sessions/            chat history store (one JSON file per conversation)
  content/ + sync/     installed lessons, search, package download and verification
  demo/                personas, deterministic seed generator, bootstrap
  models/              role → provider/model resolution
  http/routes/         Hono routes: auth, student (sync, library, chat, sessions, brain, quiz), settings…
docs/                  agentic-layer.md, knowledge-graph.md
server/uni/src/
  routes/              auth, student (catalogue, packages, shares), admin
  store/               accounts, releases, dispersal, shares, audit (JSON files with atomic writes)
packages/shared/src/   contracts shared by all packages: auth, brain, teachers, demo personas, API types
courseware/            B.Sc. Physics/Maths/Astro programme: semester-<n>/<subject>/<course>/ lessons + university-support/
infra/                 Dockerfiles and SearXNG config
scripts/preflight.sh   demo-machine checklist
```

## 3. Running it

**Prerequisites:** Node 22+, pnpm (via `corepack enable`), Ollama with `gemma4:e4b`, and Docker (optional, for SearXNG or the full stack). Rust is needed only for `pnpm desktop`.

```bash
pnpm install
cp .env.example .env     # optional: every value has a default
pnpm ollama:pull         # pulls the default Gemma 4 model
pnpm search:up           # SearXNG on :8888 (the Philosopher degrades gracefully without it)
pnpm dev                 # uni :4200, engine :4100, UI :5173
pnpm preflight           # green/red checklist before a demo
```

**Self-hosted stack:** `pnpm docker:up` runs the uni server, SearXNG and the engine. Add the Ollama container with `docker compose --profile ollama up -d`.

**Where data lives:**
- uni server: `.data/uni/` (accounts, releases, dispersal, shares, `audit.jsonl`) and `server/uni/keys/` (the signing key, created on first boot);
- engine: `.data/engine/` (`profiles.json`, `auth-sessions.json`, `settings.json`, `trust/` for the pinned key, `profiles/<id>/…`).

**Resetting the demo:** stop everything and delete `.data/engine/` and `.data/uni/`. Both services re-seed the demo accounts on the next boot, and the engine regenerates the three brains, which is deterministic, so you get the same demo every time. Keep `server/uni/keys/` unless you also want to reset the pinned key. If you delete the keys, delete the engine data as well, or sync will (correctly) refuse the new key.

## 4. Demo accounts and personas

Password for all accounts: **`harbor-lantern`** (`DEMO_PASSWORD`). Personas are defined once in `packages/shared/src/demo.ts`, and their brains are generated by `engine/src/demo/seed.ts` from the real courseware.

The demo accounts are a hackathon fixture. For a real deployment, set `SEED_DEMO=false` (the engine stops seeding demo profiles), build the desktop app with `VITE_DEMO_MODE=false` (no "Exploring the demo?" panel and no demo password in the UI), and use a private `DEMO_PASSWORD` or none. The uni server logs `demo_password_default` whenever it seeds accounts with the public password.

| | Ananya | Brinda | Chetna |
| --- | --- | --- | --- |
| Cohort / stage | 2026 · Semester 1, week 6 | 2025 · end of Semester 3 | 2024 · Semester 5, thesis prep |
| Sky | ~60 lit, ~12 solid | ~750 lit, ~470 solid | ~1,380 lit, ~990 solid |
| Story | Mechanics half done; textbook misconceptions open: force needed for motion, centrifugal force, friction always μN | Strong and well connected; her own links from physics to maths (F = dp/dt → derivative, SHM → 2nd-order ODEs); one Coriolis gap | Research mode: Philosopher trails, peer links, band gap being self-corrected |
| Show off | Amber stars, the Guide probing a misconception, a quiz turning shaky into solid | Dense gold sky, student-made aurora links, the wiki's connections | Near-complete sky, `[web]`/`[course]` trails, peer shares |

The registrar is `admin@saintelms.local`. Releases are seeded so each cohort sees the right semesters.

The sign-in screen deliberately shows no names. Type an email, or open **Exploring the demo?** and pick "First-year student" (Ananya), "Second-year student" (Brinda), "Third-year student" (Chetna) or "Registrar"; that fills in the form.

## 5. Suggested demo script (about 7 minutes)

1. **Sign in** via *Exploring the demo? → First-year student*. Mention that the university verifies the sign-in and that the device keeps an offline verifier.
2. **Sky.** Mechanics is half lit and the amber stars are her misconceptions. Click one: the panel shows "in my words" and the open misconception.
3. **Guide.** Ask "why does a moving thing need a force to keep moving?". Watch the thought trace (steps and timer). It answers from her lessons, names the misconception and asks a checking question. Then:
   - click a **lesson source chip** to see the exact passage used, then **Open at this section** to jump into the lesson;
   - point out "+1 also retrieved": a lesson that was looked at but not used;
   - open the **checks** chip: grounding ("draws on 2 lessons of 3 retrieved"), tool calls, and the model running on-device.
4. **Reflect** the session. Show the brain diff: what landed, and what the validator rejected and why.
4a. **History.** Reload the page: the conversation is still there. Open **History** to show saved conversations, including the seeded ones and the "not reflected" badges.
5. **Philosopher.** Ask about the same idea in the real world. Point out the `[course]`/`[web]` tags and the trailhead.
6. **Friend.** Ask for a classmate's phone number. It refuses instantly, without calling the model.
7. **Switch to Brinda, then Chetna.** Same Mechanics course, three different skies.
8. **Offline.** Stop the uni server, sign out, and sign back in: *Signed in offline*, and everything still works.
9. **Registrar.** Sign in as admin. Toggle a release for a cohort, open **Dispersal** to see stale devices, then **Audit** to see the action logged.

## 6. Auth and offline, precisely

- **Online student sign-in:** the engine forwards the credentials to the uni server and gets back a signed student token. It caches the profile and a **scrypt verifier** of the password in `profiles.json`, then issues its own engine session token to the UI.
- **Offline sign-in:** if the uni server can't be reached (network error only, never on a wrong password), the engine checks the cached verifier. A profile that has never signed in online on this device can't sign in offline.
- **Engine sessions** last `ENGINE_SESSION_HOURS` (14 days by default). A 401 from the engine logs the UI out.
- **The uni token** lasts `STUDENT_TOKEN_HOURS` (30 days) so devices can sync after weeks offline. If it expires, the Library shows a "sign in while online" prompt; studying still works.
- **Registrar:** the UI talks to the uni server directly with a short-lived admin token (`ADMIN_TOKEN_HOURS`). Every admin write goes to `audit.jsonl`.

## 7. Common tasks

**Add a course or lesson:** add markdown under `courseware/semester-<n>/<subject>/<course-id>/` with frontmatter (copy an existing lesson; the key fields are `courseId`, `lessonId`, `lessonName`, `releaseOrder`, `prerequisites` and `concepts`), restart the uni server, release it to a cohort in the registrar app, then install it from the student's Library. The version bump is what makes devices appear stale in Dispersal.

**Add a demo persona:** add the identity (id, email, cohort, stage, persona text) to `DEMO_PERSONAS` in `packages/shared/src/demo.ts`, and its brain script (heroes, misconceptions, links, sessions) to `engine/src/demo/personas.ts`. Then reset the demo data; both servers pick it up.

**Change a teacher's behaviour:** edit its brief in `engine/src/agents/prompts.ts`. If you add a rule, enforce it in `validators.ts` too. See the checklist in [docs/agentic-layer.md](docs/agentic-layer.md#8-changing-or-adding-an-agent).

**Tune source attribution:** the thresholds are constants at the top of `engine/src/agents/attribution.ts`; the tests in `attribution.test.ts` pin the behaviour.

**Point a role at a different model:** use Settings → Model roles and Providers (per role: tutor, brain, vision), or change the defaults in `.env`.

**Add an admin screen:** add a tab under `apps/desktop/src/features/admin/`, a route under `server/uni/src/routes/admin.ts`, and call `audit.record(actor, action, detail)` for every write.

## 8. Conventions

- **Logging:** structured JSON lines via `log.info('event_name', { fields })` in both servers. Use snake_case event names and never log passwords, tokens or API keys. `errorFields(error)` formats caught errors.
- **Errors:** routes return `{ error: string }` with a proper status code. The UI surfaces them through the query layer; don't swallow them silently.
- **Contracts first:** a request or response shape that crosses packages belongs in `packages/shared`.
- **Versioned roadmap DTOs:** `contracts.ts`, `identity.ts`, `programme.ts`, `wiki.ts`, `sharing.ts` and `teacher-policy.ts` in `packages/shared/src` add `schemaVersion: 2` shapes for admission, full academic rows, the source-backed wiki, cohort publication and message-only teacher requests. The programme shape is live: the uni server validates `courseware/programme-manifest.yaml` into it at boot (`loadProgrammeManifest` in `@sef/shared/node`) and serves it as `GET /v1/programme`; the others are additive only — no route or runtime consumes them yet. Shape validation proves structure, not ownership, entitlement or truth. Synthetic fixtures for tests are exposed only via `@sef/shared/testing` (never the root export), and the shared package's `node:test` suite runs under `tsx` like the engine and uni suites.
- **Files as the database:** JSON stores are written atomically (write to a temp file, then rename). Keep it that way, since the engine can be killed at any time on a laptop.
- **Tests:** `node:test` next to the code (`*.test.ts`). Run `pnpm test` and `pnpm typecheck` before committing.

## 9. Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| UI stuck on the boot splash | Engine not running or wrong `VITE_ENGINE_URL`. Check `pnpm dev:engine` output. |
| Teacher replies very slowly | Model loading for the first time, or thinking is on for the tutor. Run `ollama ps`; keep the tutor's thinking off. |
| Philosopher never cites `[web]` | SearXNG is down. Run `pnpm search:up`, then `curl localhost:8888`. |
| "Signature check failed" on install | The uni key changed after the engine pinned it. Reset the engine data (see Running it). |
| Profile can't sign in offline | It has never signed in online on this device. Sign in once with the uni server running. |
| A source chip opens the lesson but not the right spot | The heading index and the rendered headings disagree (for example, a heading inside a list). The reader falls back to matching the heading text; check the browser console for `section_not_found`. |
| Chat history empty after a demo reset | Expected: sessions live in `.data/engine/profiles/<id>/sessions/` and are re-seeded on the next boot. |
| Antivirus quarantines files in `node_modules` | A false positive on bundled binaries. Allow-list the project folder, then run `pnpm install` again. |

## 10. Known gaps and next steps

- Peer shares are relayed but not end-to-end encrypted.
- The engine and the uni server trust the local network; there is no TLS in dev.
- The Tauri build doesn't yet bundle the engine as a sidecar (it expects the engine to be running).
- Source attribution is lexical (term overlap), not semantic; a heavily paraphrased answer can be under-credited. Seeded demo sessions have no stored sources.
- Retrieval is weighted keyword search, not embeddings. It's fine for about 500 lessons; a local embedding index is the natural next step.
- Ideas: spaced-repetition prompts from shaky stars, cohort-level anonymised misconception heatmaps for lecturers, and a vault export to Obsidian with one click.
