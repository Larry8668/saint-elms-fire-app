# The knowledge graph: course sky and second brain

Saint Elms Fire keeps two graphs and draws one on top of the other:

- the **course sky**: every concept in the courses released to the student, and how they connect. It is built deterministically from lesson frontmatter, so it's identical for every student with the same releases;
- the **second brain**: what *this* student understands, one markdown page per concept, with evidence, misconceptions and links they made.

What you see in the Sky view is the course sky, coloured and connected by the brain. That's why three students on the same Mechanics course see three different skies.

---

## 1. The course sky

`engine/src/brain/course-graph.ts → buildCourseGraph(lessons)`

**Input:** the frontmatter of every installed lesson (`courseware/semester-<n>/<subject>/<course>/*.md`):

```yaml
lessonId: mechanics-m1-l1
courseId: mechanics
prerequisites: [bridge-course-m2-l3]
concepts:
  - Newton's first law
  - Inertial frames
```

**Nodes:**

| Node | Id | One per |
| --- | --- | --- |
| Lesson | `l:<lessonId>` | installed lesson |
| Concept | `c:<conceptKey>` | distinct concept across all installed lessons |

A concept's key is its normalised name (`conceptKey` in `packages/shared/src/concepts.ts`), so "Newton's first law" in two courses is the same star. The first lesson (in install order) that lists a concept **introduces** it; later lessons **mention** it.

**Course edges (origin `course`):**

| Edge | From → to | Meaning |
| --- | --- | --- |
| `part_of` | concept → the lesson that introduces it | "Introduced in …" |
| `builds_upon` | a later lesson → the concept | "… revisits …" |
| `prerequisite` | required lesson → lesson | from `prerequisites:` in frontmatter |

## 2. The second brain

A plain markdown vault per student at `.data/engine/profiles/<id>/brain/`. It opens cleanly in Obsidian.

```
SCHEMA.md            versioned conventions + how the vault works (human-readable)
index.md             every page with its summary, revision and provenance
log.md               append-only timeline: "## [date] kind | title"
raw/<source>/…       originals and frozen source snapshots (write once, never edited)
sources/<key>.md     generated source-summary pages
concepts/<key>.md    one page per concept: the course's knowledge and the student's, kept apart
syntheses/<key>.md   saved comparisons, derivations and applications
questions/<key>.md   investigations and open questions
.history/…           earlier revisions of every page (for diffs and undo)
.meta/manifest.json  the committed revision, hash and size of every page and source
.meta/sources/…      the typed source records
.meta/jobs/…         wiki jobs, one file each
.meta/journal/…      in-flight commits (a commit is cleared only once every file landed)
.meta/recovery/…     records of commits that were finished after a crash
```

`WikiStore` (`engine/src/brain/wiki-store.ts`) is the single authoritative writer for this vault.
It reads every file from disk on each call — never a cached map — so an edit made in Obsidian is
detected and reported (`out_of_band`) rather than overwritten. Writes take a per-vault lock
(`.meta/writer.lock`), require the revision the caller read (optimistic concurrency), record a
write-ahead journal, and only then touch the files. An interrupted commit is finished by
`recover()`, which the workspace runs when it opens a profile.

A page is YAML frontmatter plus prose. The frontmatter is typed (`schemaVersion`, `kind`, `id`,
`revision`, `state`, `summary`, `courseRefs`, `claims`, `links`, `learner`, `sourceIds`,
`provenance`) and **revisions are content-addressed**: `revision` is a hash of the page's metadata
and body, so the same content always has the same revision and any edit shows up as a mismatch.

```markdown
---
id: newton-s-second-law
kind: concept
schemaVersion: 2
revision: rev-9f2c…
state: committed
title: Newton's second law
summary: Force as the rate of change of momentum.
updatedAt: …
courseRefs: [{ programmeId, courseId, conceptKey, lessonId }]
claims: [{ id, text, kind, origin, status, citations, supersedes }]
links:  [{ toPageId, type, origin, why, citations }]
learner: { inMyWords, stuck, connections, evidenceIds }
sourceIds: []
provenance: null
---
# Newton's second law
## In my words
## Where I got stuck
## Connections I made
## Links            ← carried over on migration; legacy links stay in `provenance`, not in `links`
```

Sources are frozen first: `putSource()` writes the original into `raw/` with an exclusive create
and refuses any later write that is not byte-identical, so neither the keeper nor the model can
replace a source the student already has. The keeper's write paths refuse any path under `raw/`;
only student-controlled erasure (`eraseSource`) may remove one.

### Conventions live with the vault

SCHEMA.md carries a versioned `sef:vault-conventions` block that `readConventions()` parses and a
future job must be prepared against: a proposal whose `conventionRevision` no longer matches is
refused. The block can only *describe* invariants the code already enforces (the schema is strict
and the required rules cannot be dropped), so a document — or text inside a source or a peer page —
cannot grant itself a capability, and text in a source is data, never an instruction.

### Earlier vaults

The earlier layout (`concepts/` only, with `status`/`evidence`/`misconceptions`/`sections` in the
frontmatter and `.history/<key>/`) is still read during the transition: a page without a
`schemaVersion` is parsed as version 1. `migrateLegacyVault()` adopts those pages — the student's
prose is kept byte for byte, the sections become `learner`, and everything whose provenance cannot
be resolved (evidence with no citation, misconceptions, unevidenced links, course references, the
old status cache) is preserved verbatim in the page's `provenance` block rather than upgraded by
guesswork. A single page can also be adopted on first write, by passing the revision it had on disk.

### Brain edges

Brain links run concept → concept, and each records its **origin**:

| Origin | Who made it | Shown in the sky as |
| --- | --- | --- |
| `student` | the student said it themselves (the brain keeper only marks a link `student` when the student made the connection) | bright aurora (teal) line |
| `suggested` | the brain keeper inferred it | faint blue line |
| `peer` | arrived with a page a classmate shared | violet line |
| `course` | the course sky (section 1) | very faint line |

Allowed link types (`EDGE_TYPES` in `packages/shared/src/brain.ts`): `prerequisite`, `builds_upon`, `related_to`, `contrasts_with`, `part_of`. Free-text types from the model are normalised (for example, "builds on" becomes `builds_upon`); anything else is rejected. Colours live in `apps/desktop/src/lib/brain-style.ts`.

### Mastery is computed, never generated

`engine/src/brain/mastery.ts`:

| Status | Rule | Colour |
| --- | --- | --- |
| `unseen` | no page | dim star |
| `shaky` | any unresolved misconception, **or** the latest quiz below 70% | amber (ember) |
| `solid` | no open misconceptions **and** the last two quizzes both at least 70% | gold |
| `met` | a page exists and neither of the above applies | blue-white |

The `status` in frontmatter is only a cache, recomputed on every save and every graph read.

## 3. How the brain changes

Every keeper-authored write goes through one pipeline — the **compiler** in
`engine/src/brain/compiler/` — used by **Reflect** (after a chat), **Capture** (photo of
notes) and the `POST /api/sources/:jobId/compile` route:

1. **Freeze.** The material becomes a source: the original bytes are stored immutably, the
   extraction (transcript, transcription, parsed text) is frozen beside the record under
   `.meta/sources/<id>/extracted/`, and a durable job tracks it. Reflect freezes exactly the
   turns that had not been reflected on before; the transcript range travels with the source.
2. **Context** (`context.ts`). The keeper sees the conventions revision, `index.md`, the
   pages this material plausibly touches (source citations, title and concept matches, one
   hop of links — capped at 10), and the source text itself. Nothing else enters the prompt.
3. **Draft** (`draft.ts`). The model returns a loose draft: pages, claims and links, each
   optionally carrying a *verbatim quote* of the passage it rests on.
4. **Normalize** (`normalize.ts`) — code, not the model, decides:
   - quotes are resolved to real citations character-for-character; a `source_fact` or
     `student_belief` without a verbatim quote is dropped with a reason;
   - claim merges follow `merge-policy.ts`: **add**, **duplicate** (restatement), **supersede**
     (restated with more evidence) and **dispute** (same subject, different content — both
     versions stay, marked disputed). Earlier supported knowledge is never blind-replaced;
   - a student-origin link requires the student's actual statement; otherwise it is filed
     `suggested`;
   - a concept page's course mapping comes from the course graph, never the model; personal
     concepts get no `courseRefs` and stay unofficial;
   - a page that exists but was outside the prompt's scope keeps its body — claims merge in,
     but prose the model never read is not trusted;
   - the student's own words are only rewritten when a student-authored source backs them.
   The result is a `WikiProposal` with an expected base revision per page, filed under
   `.meta/proposals/` and the job moves to `awaiting_review`. A draft that survives nothing
   ends the job as `no_changes`, honestly.
5. **Review.** `POST /api/proposals/:id/accept` applies the proposal through the journaled
   write path — every page is re-read and revisions re-checked, so a stale proposal is
   refused. `POST /api/proposals/:id/reject` changes no pages and cancels the job. Reflect and
   Capture auto-accept: clicking the button *is* the student's review, and the record marks
   it `decidedBy: 'system'` for audit.
6. **Checkpoint.** Only `committed` or `no_changes` consumes transcript turns — a failed
   compile leaves them pending so a retry reads the same range.

**Quizzes** write evidence through the same machinery: the score becomes a durable result
artifact (`res_*`), a code-built proposal adds its id to the page's `learner.evidenceIds`,
and a page still in the earlier format is adopted (`upgradeLegacyPage`) first — there is no
legacy bypass writer left. The old `BrainVault` only *reads* typed pages now (as concept
views for the sky and mastery); its `save`/`writeSeeded` refuse to touch them.

The student sees the diff, including what the deterministic pass dropped and why, in the
"Your brain grew" dialog. **Lint** (`lint.ts`) surfaces open misconceptions, oversized pages
and shaky prerequisites — disputed claims appear as open misconceptions. These appear in
Brain → Open questions, each with a "Work through it" button that opens the Guide with a prompt.

## 4. Merging the two: the graph the UI draws

`engine/src/brain/graph.ts → buildGraphView(courseGraph, pages, courses)` returns `GraphResponse` (`GET /api/graph`):

- every lesson and concept node from the course sky, with concept nodes carrying the student's `status`, open misconception count, and whether a peer link touches them;
- course edges plus every brain link whose two ends are in the sky;
- `stats`: course concepts, lit (not unseen), shaky, solid, and student-made links. These drive the "62 of 286 lit" header.

## 5. The Sky view

`apps/desktop/src/features/sky/` renders the merged graph with react-three-fiber:

- **Layout** (`layout.ts`) is deterministic: one column per semester, one constellation per course, lessons along a gentle wave in teaching order, and concepts spiralling around the lesson that introduces them. Reading left to right is reading the programme.
- **Camera** (`MapCamera.tsx`) behaves like a map: drag pans, wheel or pinch zooms toward the cursor, and selecting a star centres it in the space not covered by the side sheet.
- **Labels** (`labels.ts`, `SkyLabels.tsx`) use semantic zoom: course names when far out, concept names when close. Collisions are resolved by priority, and the selection and hover labels always win.
- **Next up** (`next-up.ts`) points the student at open misconceptions first, then the next unseen concepts in teaching order.
- Clicking a star opens the **concept sheet**: the student's page, misconceptions, links, a quick quiz, and "Talk it through with the Guide".

## 6. Demo brains

The three demo students' vaults are generated deterministically by `engine/src/demo/seed.ts` from the real courseware and the personas in `packages/shared/src/demo.ts`. Each gets pages with evidence, misconceptions, student links and seeded chat sessions. The same seed always produces the same brains, so the demo is reproducible.
