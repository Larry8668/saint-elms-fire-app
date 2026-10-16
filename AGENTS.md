# AGENTS.md

Start here if you are a coding agent (or a new developer) picking up Saint Elms Fire. This file covers orientation, commands, the rules that must not be broken, and where everything else is documented.

## What this is, in five lines

- An offline-first study app for a university programme: three Socratic AI teachers (Friend, Guide, Philosopher) running on local Gemma 4, plus a per-student **second brain** (a markdown vault) drawn over a **course sky** (the star map of released concepts).
- `server/uni` is the university's server: accounts, cohorts, course releases, ed25519-signed course packages, and the registrar admin API.
- `engine` is the student's local runtime: per-profile workspaces, agents, the brain pipeline, course sync, chat history and offline sign-in.
- `apps/desktop` is the React UI (with a Tauri shell): the student app. The registrar surface is `apps/admin`, a static build the uni serves at `/admin`.
- `packages/shared` holds the contracts shared by all three.

## Read next

| Doc | When |
| --- | --- |
| [HANDOVER.md](HANDOVER.md) | Runbook: setup, demo accounts, demo script, data locations, common tasks, troubleshooting |
| [docs/agentic-layer.md](docs/agentic-layer.md) | Teachers, tools, the chat-turn harness, source attribution, chat history, model providers |
| [docs/knowledge-graph.md](docs/knowledge-graph.md) | Course sky, second brain, mastery rules, the brain-update pipeline, the Sky view |
| [README.md](README.md) | Pitch, architecture diagram, hackathon tracks |

## Commands

```bash
pnpm install
pnpm dev                          # uni :4200, engine :4100, UI :5173 (all with hot reload)
pnpm typecheck                    # all packages; must pass
pnpm test                         # node:test suites; must pass
pnpm --filter @sef/engine test    # engine only (compiler, mastery, attribution, offline auth)
pnpm --filter @sef/desktop build  # production build of the UI
pnpm preflight                    # checks tools, models and services
```

You'll need Node 22+, pnpm, Ollama with `gemma4:e4b`, and optionally SearXNG (`pnpm search:up`). Every demo account's password is `harbor-lantern`.

## Invariants: do not break these

1. **Models propose, code decides.** Never let model output directly set mastery status, write a brain page outside the proposal pipeline (`compiler/` → `applyProposal`), or decide a contract check. Add a deterministic check or repair instead.
2. **Mastery is computed** from evidence in `engine/src/brain/mastery.ts`. The `status` field in frontmatter is only a cache.
3. **Released lessons only.** Teachers see only installed lessons, and only signed, released packages can be installed. Don't add a code path that reads courseware straight from the repo for a student.
4. **Per-student isolation.** Everything a student owns lives in their workspace (`engine/src/profiles/workspace.ts`). Route handlers must use `c.get('ws')`, never a global store.
5. **The Friend's lane check runs before the model** (`engine/src/agents/lanes.ts`). Privacy refusals must not depend on the model.
6. **No secrets in logs or in the UI.** API keys stay in the engine (the UI only sees `hasApiKey`). Never log passwords, tokens or keys.
7. **Atomic file writes** (`writeJson` / `writeFileAtomic`) for every JSON store. The engine can be killed at any time.
8. **Offline must keep working.** Anything a student needs while studying must work with the uni server down. New features that need the network must degrade gracefully.

## Code conventions

- **Modular and reusable.** One concern per file. Shared UI goes in `apps/desktop/src/components/ui/` (primitives, `loading.tsx`, `skeletons.tsx`); feature code goes in `features/<name>/`; pure helpers sit next to the feature (for example, `answer-parts.ts`).
- **Contracts first.** Any shape that crosses a package boundary belongs in `packages/shared`.
- **Logging.** Structured logs: `log.info('snake_case_event', { fields })` in the engine and uni server, and the same shape in the UI's `lib/log.ts`. Use `errorFields(error)` for caught errors.
- **Errors.** Routes return `{ error: string }` with a correct status code. The UI surfaces errors (toasts or inline) and never swallows them silently.
- **Loading states.** Use the shaped skeletons in `components/ui/skeletons.tsx` and `WorkingLabel` / `PixelLoader` from `components/ui/loading.tsx`. Don't use bare spinners or blank screens.
- **Comments** only for constraints the code can't show. No narration.
- **Tests** use `node:test` and live next to the code as `*.test.ts`.

## Git workflow

- **Never push to `main`.** Every change goes on a branch (`feat/…`, `fix/…`, `docs/…`) and lands through a pull request. PRs are reviewed by the ShipWright GitHub App; direct pushes are never reviewed.
- **One feature or fix per PR, under 5,000 changed lines** (larger PRs are skipped by the reviewer). If work depends on an unmerged PR, branch from it and open a stacked PR whose base is that branch.
- Open PRs as ready for review, not drafts. Address valid review comments with follow-up commits on the same branch (don't force-push over a reviewed commit), then merge.
- PR commands: `/shipwright rerun` reviews the latest commit again; `/shipwright verify` reviews a draft.

## Definition of done

- `pnpm typecheck` and `pnpm test` pass.
- New behaviour in the engine has a test where it's deterministic (validators, attribution, mastery, stores).
- UI changes have been looked at in a browser: sign in with a demo account and exercise the flow.
- The docs above are updated if you change a contract, an agent, a tool, the brain pipeline or a command.
