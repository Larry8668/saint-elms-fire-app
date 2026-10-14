# Agents, harness and the second brain

This document explains how the AI parts of Saint Elms Fire work and why they are shaped this way. Read it before changing a prompt, adding a tool, or touching the brain pipeline.

The guiding principle is simple: **models propose, code decides.** A small local model (Gemma 4 E4B by default) is good at language and decent at following a schema. It is not reliable at enforcing rules. So every rule that matters (privacy, grounding, citation format, what enters the brain, mastery) is enforced in deterministic code around the model, and the student can see the result of every check.

---

## 1. The cast

| Agent | Kind | Model role | Tools | Contract |
| --- | --- | --- | --- | --- |
| **Friend** (Socrates my Friend) | teacher | `tutor` | `search_lessons` (support corpus only), `handoff` | Campus life only, from university support notes. Never shares another student's details. Academic questions go to the Guide. |
| **Guide** (Socrates my Guide) | teacher | `tutor` (or `vision` with an image) | `search_lessons`, `read_lesson`, `brain_lookup`, `weakest_concepts`, `handoff` | Teaches only from released lessons, Socratically: explain, then ask one checking question. Probes open misconceptions instead of just correcting them. |
| **Philosopher** (Socratest my Philosopher) | teacher | `tutor` | `search_lessons`, `web_search`, `brain_lookup`, `handoff` | Every substantive line tagged `[course]` or `[web]`; `[web]` only for things in the web results; ends with exactly one `Trailhead:` question. |
| **Brain keeper** | worker | `brain` (thinking on) | none: structured output | Reads a session or capture and proposes page updates, misconceptions, resolutions and links, using only allowed concept names. |
| **Notes reader** | worker | `vision` | none: structured output | Transcribes a photo of notes into topic, transcription (with LaTeX) and concepts. Feeds the brain keeper. |
| **Quiz master** | worker | `tutor` | none: structured output | Writes 3 multiple-choice questions from lesson text, at least one targeting an open misconception. |

The briefs live in `engine/src/agents/prompts.ts`. Tool definitions and per-teacher tool sets are in `engine/src/agents/tools.ts`. Agents are built with Mastra (`engine/src/agents/factory.ts`).

## 2. One chat turn, end to end

`engine/src/agents/harness.ts → runChatTurn()` handles one turn. Each step is deterministic unless marked *model*.

1. **Lane check (Friend only).** `lanes.ts` classifies the message with regexes *before* any model call:
   - `privacy` (a classmate's phone number, for example) returns a fixed refusal.
   - `academic` returns a fixed redirect to the Guide, with a handoff.
   - `smalltalk` and `ops` go through to the model.

   This holds even if the model is weak or jailbroken, because the model never sees the request.
2. **Retrieval.** Lessons are searched from the right pool: the support corpus for the Friend, academic courses for the others. Only *installed* lessons exist on the device, and only *released* lessons can be installed, so "released lessons only" holds by construction, not by prompt.
3. **Brain context (Guide and Philosopher).** The concept keys mentioned in the hits are looked up in the student's vault. Their pages (status plus "in my words") and up to five open misconceptions go into a `STUDENT BRAIN` block.
4. **Web search (Philosopher).** SearXNG is queried up front, and the results are passed in a `WEB RESULTS` block. If search is down, the block says so, and the model is told to use `[course]` lines only.
5. ***Model.*** The teacher runs with its tools for up to 4 steps, streaming text to the UI over SSE. Tool calls are recorded in a `TurnContext` (sources, lessons touched, handoff).
6. **Validation and repair.**
   - Philosopher: `checkPhilosopherFormat` checks the tags and the single trailhead. If it fails, `repairPhilosopherFormat` rewrites the answer deterministically (tags untagged lines, keeps exactly one trailhead) instead of re-prompting a slow model. The check is then re-run and marked "Repaired by validator".
   - Guide and Friend: `checkGrounding` passes if at least one lesson was used *or* the answer honestly says the topic isn't covered.
   - Image turns record whether the image was read on-device.
7. **Persist.** The turn is appended to `sessions/<id>.json` in the student's profile. Image bytes are never stored; only the fact that an image was sent.
8. **Done event.** The UI receives a `Verification` object (model, provider, sources, checks, tool calls, handoff, lane) and renders it in the verification panel under the answer.

## 3. The second brain

### On disk

Each student profile has a vault at `.data/engine/profiles/<id>/brain/`:

```
SCHEMA.md            how the vault works (human-readable)
index.md             every page with its status
log.md               append-only timeline: "## [date] kind | title"
concepts/<key>.md    one page per concept
.history/<key>/…     previous versions of each page (for diffs and undo)
```

A concept page is markdown with YAML frontmatter, so it opens cleanly in Obsidian:

```markdown
---
concept: Newton's second law
key: newton-s-second-law
course_refs: [mechanics]
status: shaky                    # cache only: recomputed from evidence on every save
evidence:                        # quizzes, sessions, captures, lessons, shares
  - { kind: quiz, ref: …, at: …, score: 1, outOf: 3 }
misconceptions:
  - { claim: "…", course: "…", flagged: …, resolved: false }
links:
  - { to: derivative, type: builds_upon, origin: student, why: "F = dp/dt" }
updated: …
---
# Newton's second law
## In my words
## Where I got stuck
## Connections I made
## Links            ← regenerated from frontmatter so Obsidian's graph matches ours
```

### How an update happens

`engine/src/brain/service.ts → runIngest()` is used by **Reflect** (after a chat session), **Capture** (photo of notes) and the quiz flow.

1. **Scope.** Build the *allowed concepts*: concepts of the lessons touched, plus course concepts named in the material (capped at 40). Nothing outside this set can be written.
2. ***Propose.*** The brain keeper returns a flat, capped object (`brainProposalSchema` in `packages/shared/src/brain.ts`) with `pages`, `misconceptions`, `resolved` and `edges`. Concept fields are a **Zod enum of the allowed names**, so a small model can't invent concepts. Edge types are free text and normalised by `normalizeEdgeType` (so "builds on" becomes `builds_upon`).
3. **Validate.** `engine/src/brain/validator.ts` turns the proposal into edit ops and rejects anything that breaks a rule, with a reason the UI shows:
   - the concept is not in the allowed set;
   - the edge references unknown concepts, is a self-loop, has an unknown type, or would create a prerequisite cycle;
   - a misconception doesn't cite a released lesson, or is missing either the claim or the course statement;
   - a "resolved" doesn't match a currently open misconception.

   Links are recorded with their **origin**: `student` only if the student said it themselves, `suggested` otherwise. `course` and `peer` links come from elsewhere.
4. **Apply.** `applier.ts` executes the ops, snapshots the previous version to `.history/`, recomputes status, and returns a per-page diff (before / after / status change). The UI shows it as a brain diff.
5. **Log.** A line is appended to `log.md`.

### Mastery is computed, never generated

`engine/src/brain/mastery.ts`:

| Status | Rule |
| --- | --- |
| `unseen` | no page |
| `shaky` | any unresolved misconception, **or** the latest quiz is below 70% |
| `solid` | no open misconceptions **and** the last two quizzes are both 70% or higher |
| `met` | a page exists and none of the above applies |

The `status` stored in frontmatter is only a cache; it is recomputed on every save and every read for the graph.

### Lint

`lint.ts` surfaces open misconceptions, oversized pages and **shaky prerequisites** (a concept you are working on whose prerequisite is shaky). The sidebar shows an ember dot when there are open questions.

## 4. Model plumbing

- `engine/src/models/registry.ts` resolves each **role** (`tutor`, `brain`, `vision`) to a provider and model from Settings. The provider kinds are `ollama`, `openai-compatible` (vLLM, LM Studio, a university server), `openai` and `anthropic`. API keys stay inside the engine; the UI only ever sees `hasApiKey`.
- Ollama runs with a fixed context window and output budget (`OLLAMA_NUM_CTX`, `OLLAMA_NUM_PREDICT`), so switching roles doesn't trigger a model reload. Thinking mode is enabled for the brain keeper only, and only if Settings → *Thinking* is on.
- `generateStructured` (in `factory.ts`) parses partial JSON tolerantly (`lib/partial-json.ts`) because small models sometimes stop mid-object.

## 5. Identity and data boundaries (what the agents can see)

- Each signed-in student gets a **workspace** (`engine/src/profiles/workspace.ts`): their own content store, vault, sessions and quizzes under `.data/engine/profiles/<id>/`. Agents receive only that workspace, so one student's brain can't leak into another's prompt on a shared device.
- The student's name in the teacher prompt comes from the verified profile, not from editable settings.
- Course content reaches a device only as a package signed by the university (ed25519), checked file by file against the manifest hashes, from a key pinned on first sync.

## 6. Adding or changing an agent: checklist

1. **Brief:** add or edit it in `prompts.ts`. Keep the rules short and checkable.
2. **Tools:** define them in `tools.ts` and add them to the teacher's tool set. Record sources with `ctx.addSource` and calls with `ctx.recordTool`, so they show up in the verification panel.
3. **Contract:** if the agent has a format or safety rule, write a validator in `validators.ts` that returns `VerificationCheck[]`, and prefer a deterministic **repair** over a retry.
4. **Structured output:** keep schemas flat, cap the arrays, and pass enums for any value that must come from a known set.
5. **Tests:** add a `*.test.ts` next to the code. The validator and mastery tests show the pattern (`pnpm --filter @sef/engine test`).
6. **UI:** if the agent is a new teacher, add it to `TEACHER_IDS` in `packages/shared/src/teachers.ts` and to `features/teachers/teacher-meta.ts`.
