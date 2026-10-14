# Instructions for the OpenQodex reviewer

Write here what a reviewer of this repo must know. The agent reads this file at the start of every review and follows it for what to flag and what not to flag. Commit it so the whole team shares it.

## What this repo is

Saint Elms Fire: a local-first learning platform. Monorepo with pnpm workspaces: `apps/desktop` (React 19 + Vite + Tauri, student and registrar UI), `engine` (Hono daemon on 127.0.0.1, owns per-profile workspaces, agents, brain vault, chat history), `server/uni` (Hono, owns accounts, cohorts, signed course packages, enrolment), `packages/shared` (Zod contracts; `./node` subpath is Node-only and must never be imported by browser code).

## Conventions the code follows

- Zod strictObject schemas at every package boundary; `schemaVersion` on versioned contracts.
- Models propose, deterministic code decides. No schema may let LLM output set mastery or write raw files.
- Tests run with `node --test --import tsx 'src/**/*.test.ts'` in packages/shared; other workspaces use their existing runners.
- JSON writes must be atomic (`writeJson`/`writeFileAtomic`). Never log secrets, tokens, passwords, or full lesson bodies.
- New modules are additive; existing live wire formats stay live until a deliberate migration.

## Never flag

- Versioned schemas with no runtime consumer yet — contract-first PRs are the intended sequencing.
- Placeholder hashes/fixture data inside `packages/shared/src/testing/` — synthetic by design, exported only via `@sef/shared/testing`.
- `Date.parse` comparisons on ISO timestamps — canonical format is enforced by TimestampSchema.
- Missing comments — the codebase deliberately avoids them.

## Always check

- Any path where model or peer input could set mastery, write files directly, or bypass a validator.
- Strict schemas accidentally accepting secrets, tokens, or credential-bearing URLs.
- Identifier fields that could be used as filesystem paths without sanitisation.
- Schema invariants that contradict each other (e.g. a status that requires a field another rule forbids).
- Cross-boundary leaks: Node-only helpers exported from the shared root, or engine/uni importing test fixtures.

## Tooling note

You run without Bash. All evidence must come from reading files; do not attempt to run commands, tests, or scripts — treat the change as a static review and report findings from source alone.
