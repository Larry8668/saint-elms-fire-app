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
SCHEMA.md            how the vault works (human-readable)
index.md             every page with its status
log.md               append-only timeline: "## [date] kind | title"
concepts/<key>.md    one page per concept
.history/<key>/…     previous versions of each page (for diffs)
```

A page is YAML frontmatter plus sections:

```markdown
---
concept: Newton's second law
key: newton-s-second-law
course_refs: [mechanics]
status: shaky                    # cache only; recomputed from evidence
evidence:                        # quiz | session | capture | lesson | share
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

Every write goes through one pipeline (`engine/src/brain/service.ts → runIngest`), used by **Reflect** (after a chat), **Capture** (photo of notes) and **quizzes**:

1. **Scope.** Build the allowed concepts: concepts of the lessons the session touched, plus course concepts named in the material (capped at 40).
2. ***Propose.*** The brain keeper returns a flat, capped object (`brainProposalSchema`) of pages, misconceptions, resolutions and edges. Concept fields are a **Zod enum of the allowed names**, so a small model can't invent concepts.
3. **Validate** (`validator.ts`). The proposal becomes edit ops, and anything that breaks a rule is rejected with a reason:
   - the concept is not in the allowed set;
   - the edge references an unknown concept, is a self-loop, has an unknown type, or would create a prerequisite cycle;
   - a misconception doesn't cite a released lesson, or is missing the claim or the course statement;
   - a resolution doesn't match an open misconception.
4. **Apply** (`applier.ts`). Snapshot to `.history/`, write the page, recompute status, and return a per-page diff (before, after, status change).
5. **Log.** Append to `log.md`.

The student sees the diff, including what was rejected and why, in the "Your brain grew" dialog.

Quizzes add evidence directly: the score is evidence, and the next status recompute decides whether the star turns gold. **Lint** (`lint.ts`) surfaces open misconceptions, oversized pages and shaky prerequisites. These appear in Brain → Open questions, each with a "Work through it" button that opens the Guide with a prompt.

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
