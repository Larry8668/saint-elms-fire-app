# Getting started

[← Back to the README](../README.md)

Run the whole stack on one machine: the uni server, the student engine and the web UI.

## Prerequisites

| Tool | Why |
| --- | --- |
| Node 22+ | Everything |
| pnpm 10.18 | Pinned in `package.json`; `corepack` provides it |
| [Ollama](https://ollama.com) | Runs Gemma 4 locally |
| Docker *(optional)* | SearXNG web search for the Philosopher, or the container stack |
| ffmpeg *(optional)* | Audio and video sources |
| yt-dlp and Python 3 *(optional)* | YouTube links |

## Run it

```bash
corepack enable
pnpm install
cp .env.example .env     # first setup only; keep an existing .env
pnpm ollama:pull         # gemma4:e4b + embeddinggemma + shieldgemma:2b
pnpm search:up           # optional: SearXNG web search for the Philosopher (Docker)
pnpm dev                 # uni server :4200, engine :4100, web UI :5173
```

Open <http://localhost:5173>, choose **Exploring the demo?** and pick a student. The default local demo password is **`harbor-lantern`**; set `DEMO_PASSWORD` to change it.

The first start seeds the three demo students, which takes a few seconds. Browsing the sky, the brain and saved conversations works without Ollama. Chat, reading sources and drafting proposals need the models.

> [!NOTE]
> The engine and the Vite UI read the root `.env`. The uni server's dev script reads the host process environment, so export uni settings such as a custom `DEMO_PASSWORD` in the shell that starts it.
>
> This quickstart is the no-database demo. Real accounts, the staff portal and Peers need Postgres; the bootstrap is in [HANDOVER.md](../HANDOVER.md) §4.

## Demo students

All three follow the same B.Sc. Physics, Mathematics and Astrophysics programme, at different stages. Compare them on the same **Mechanics** course to see one curriculum grow into three different brains.

| Account | Stage | What to look at |
| --- | --- | --- |
| `ananya@saintelms.local` | Semester 1, week 6 | Small sky, Mechanics half lit, open misconceptions in amber: force vs. motion, centrifugal force, μN friction |
| `brinda@saintelms.local` | End of Semester 3 | Dense, mostly gold sky; her own links from physics to the maths underneath (F = dp/dt → derivative) |
| `chetna@saintelms.local` | Semester 5, thesis prep | Near-complete sky, Philosopher research trails, peer links, one self-correcting shaky node (band gap) |

Staff sign in at the registrar portal the uni hosts itself, `http://localhost:4200/admin`. It needs the Postgres account stack.

## Try it offline

1. Sign in once with everything running.
2. Stop only the uni. Run `pnpm dev:uni`, `pnpm dev:engine` and `pnpm dev:app` in separate terminals for this, because stopping the combined `pnpm dev` stops all three.
3. Keep the engine and Ollama up. Sign out, then sign back in with the password.

Courses, chat and the brain still work. Web search, Peers and course sync need their services. Device-authorized real accounts use a signed offline entitlement instead, and explicitly signing out of the last device clears it ([HANDOVER.md](../HANDOVER.md) §6).

## Repository commands

```bash
pnpm dev           # everything, with hot reload (uni :4200, engine :4100, UI :5173)
pnpm typecheck     # all packages
pnpm test          # node:test suites (uni auth & signing, engine validator, mastery, offline auth)
pnpm test:e2e      # Playwright release drill against a real uni + engine
pnpm eval          # engine agent-eval scenario runner
pnpm preflight     # checks tools, models and services on a demo machine
pnpm build:hosted  # the /app portal + /admin bundles the uni serves
pnpm dev:gateway   # model gateway alone
pnpm docker:up     # self-hosted stack
pnpm search:up     # optional SearXNG for the Philosopher
pnpm store:up      # optional MinIO object store for vault sync (docs/object-store.md)
pnpm ollama:pull   # gemma4:e4b + embeddinggemma + shieldgemma:2b
pnpm desktop       # Tauri desktop shell (needs Rust)
```

Full setup, the demo script and troubleshooting are in **[HANDOVER.md](../HANDOVER.md)**. Coding agents start at **[AGENTS.md](../AGENTS.md)**.
