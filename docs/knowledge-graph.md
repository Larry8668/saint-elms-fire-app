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
.meta/events/…       the growth ledger, one typed learning event per file
.meta/jobs/…         wiki jobs, one file each
.meta/journal/…      in-flight commits (a commit is cleared only once every file landed)
.meta/recovery/…     records of commits that were finished after a crash
.meta/tombstones/…   erasure markers: a deleted source leaves one record a sync can carry
.meta/embeddings/…   derived vector indexes for semantic search — rebuildable, never exported
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

### Taking the vault with you

`VaultPortabilityService` (`engine/src/brain/portable/`, routes under `/api/vault/*`, Settings →
"Your vault, yours to carry") makes the student's knowledge portable independent of enrolment,
entitlement or network:

- **Export** (`POST /api/vault/export`) packs the student's own state into one versioned
  `sef-vault-export` document: every page file, the `.history/` snapshots, source records and
  their extraction-ledger text, the `raw/` originals (optionally narrowed to `sourceIds`), the
  growth ledger, erasure tombstones and `log.md`. Each file carries its sha-256; the manifest
  records the export's schema version, vault layout, counts and the exporting profile as
  provenance — never adopted on import. Credential, session, provider, entitlement and
  in-flight material (journal, jobs, proposals, index, manifest, lock) never enters an export;
  paths it leaves out are listed under `skipped`, not silently dropped.
- **Preview** (`POST /api/vault/import/preview`) validates the envelope, every per-file hash and
  every path against the vault-owned areas, then computes a plan: size, page/source counts,
  and the conflicts — a page the destination already holds at a different revision is named
  with both revisions. Nothing is written.
- **Restore** (`POST /api/vault/import`) re-derives the plan and commits through the same
  journal as every writer, with per-path sha preconditions re-checked inside the writer lock —
  a vault that moved since the plan is refused, not overwritten. Conflicted pages are skipped
  unless the student names them in `overwritePageIds`; an overwrite first preserves the live
  revision to `.history/`. Derived state (manifest, `index.md`) is rebuilt from the imported
  bytes; `log.md` merges entry-wise; immutable files that disagree (`raw/`, history, events,
  records) are reported, never forced. A source record declaring a media type this engine
  would never serve is skipped with a warning — its original bytes still land, as an orphan
  no live record can serve. A restore never touches the profile registry: it cannot
  grant admission, and `exportedBy` stays provenance.

Export sits behind the local sign-in alone and is the one write a limited (read/export-only)
session may still make, so an expired entitlement or a suspended enrolment cannot hold the
student's files hostage; preview likewise needs only the local sign-in, but a limited session
is refused — it would plan a restore that session could never run. Restore and erase keep the
approved-profile guard of every other vault writer. Source erasure lists its dependent pages
first (`GET /api/sources/:id/dependents`), then `POST /api/sources/:id/erase` removes the
record, the derived extraction text and the original under `raw/` — erasure is the only
write allowed to touch `raw/`; maintenance and model actions never reach it. The tombstone
under `.meta/tombstones/` records the delete for a future sync.

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
| `solid` | no open misconceptions **and** two *distinct* passing quiz checks (≥ 70%) | gold |
| `met` | a page exists and neither of the above applies | blue-white |

The `status` in frontmatter is only a cache, recomputed on every save and every graph read.
Quiz checks are deduplicated by attempt: resubmitting the same `attemptId` — or the identical
answers — replays the stored result instead of recording a second pass, so a retried submit can
never inflate a concept into `solid`. Only student-authored artifacts reach
`learner.evidenceIds`; peer-imported and model-generated material is recorded in the growth
ledger but can never feed mastery.

A generated quiz is a *signal*, not a certification: the dialog says so in words, and nothing in
the engine treats a pass as proof of understanding.

### The growth ledger

`engine/src/brain/growth.ts → deriveGrowthEvents()` turns every committed plan into typed
**learning events**, written beside the page under `.meta/events/<id>.json` inside the same
journaled commit:

| Kind | Fires when a commit shows |
| --- | --- |
| `encounter` | the first revision of a concept page |
| `application` | the first revision of a synthesis or question |
| `explanation` | `learner.inMyWords` changed |
| `struggle` | `learner.stuck` changed |
| `correction` | a claim was superseded or disputed |
| `connection` | a link was added (origin preserved) |
| `review` | learner sections revisited without new claims or links |

Each event (`LearningEventSchema` in `packages/shared/src/wiki.ts`) carries `pageId`, `at`, an
**actor** (`student` / `peer` / `model`, derived from the backing source's origin — never from a
model's say-so), at least one evidence reference, and `knowledgeOnly`. Evidence is either a
verbatim `SourceCitation` or an `EventRef`: a vault `source` (id + frozen revision), a durable
`artifact` (a stored quiz result `res_*`), or the page `revision` itself — which is what makes an
event reproducible: the event id is a hash of `kind | pageId | revision | subject`, so replaying
a proposal or retrying a commit lands the identical file instead of a duplicate. An upsert that
would only re-stamp `updatedAt` is recognised as no change and emits nothing. Non-student actors
are forced to `knowledgeOnly: true` by the schema itself: **knowledge collected is kept separate
from understanding demonstrated**, structurally, not by convention.

`GET /api/brain/events?pageId=…` lists the ledger oldest-first; `GET /api/brain/records` lists
every vault page (concepts, syntheses, questions) as records; `GET /api/brain/pages/:id/record`
returns one page's detail view. The Brain view merges durable events with the older `log.md`
entries in its timeline, and each record sheet shows its own growth trail.

## 3. How the brain changes

Every keeper-authored write goes through one pipeline — the **compiler** in
`engine/src/brain/compiler/` — reached from **Contribute** (typed notes, pasted text,
uploads), **Reflect** (freezing a chat's fresh turns) and the
`POST /api/sources/:jobId/compile` route:

1. **Freeze.** The material becomes a source: the original bytes are stored immutably, the
   extraction (transcript, transcription, parsed text) is frozen beside the record under
   `.meta/sources/<id>/extracted/`, and a durable job tracks it. Ingest accepts only the
   allowlisted media types (Markdown, plain text, PDF, PNG, JPEG, and the `audio/*` family —
   `ACCEPTED_MEDIA` in `brain/sources/limits.ts`); anything else is a typed 415 refusal
   before a byte is written, and byte and pixel limits are enforced the same way. Audio
   carries its own caps: ≤256 MB of bytes, and a probed duration of ≤4 hours refused by name
   (`audio_too_long`) before the file is stored — ffmpeg (`FFMPEG_PATH` or PATH) validates
   the stream at probe time, so a file that merely *claims* to be audio is refused too. The
   recording then transcribes through `engine/src/media/audio.ts`: ffmpeg normalizes to mono
   16 kHz PCM once, ~50 s overlapping windows post to the vision-role provider's
   OpenAI-compatible `/v1/audio/transcriptions` endpoint, and the joined transcript is a
   timestamped ordinary extraction — failed chunks mark the pass `partial` with the reason.
   A video link is the third intake lane beside text and uploads: `engine/src/media/youtube.ts`
   accepts only an explicit host allowlist (`youtube.com`, `www.youtube.com`,
   `m.youtube.com`, `youtu.be` — no subdomain guessing), resolves `yt-dlp` via
   `YTDLP_PATH` → PATH → the vendored `youtube-dl-exec` binary, and splits the fetch into two
   consent-separated phases — `POST /api/sources/video-preview` runs `--dump-json` for the
   metadata card and no media bytes move, then `POST /api/sources/video` runs
   `-x --audio-format wav` into a bounded temp area whose bytes feed the same audio pipeline.
   The result is a `kind: 'video'` source — always `origin: 'external'`, carrying `link`
   provenance `{ provider: 'youtube', url, videoId, fetchedAt }` — whose stored original is
   the extracted audio track (`mediaType` is the audio container) and whose transcript cites
   through the ordinary `text` locator. Duration (≤4 h) and fetched-byte caps apply before and
   during the download, and egress is logged as `video_url_preview` / `video_url_fetch`;
   age-gated, geo-blocked, no-audio-stream and missing-`yt-dlp` each fail with a named code.
   Each source declares its **origin** (`student` or `external`) and optional attribution
   (creator, URL), and waits at `awaiting_source_review` until the student compiles it —
   before that they can fix a bad read with a *correction*, which appends a new
   `student_correction` extraction revision instead of overwriting the original. Reflect
   freezes exactly the turns that had not been reflected on before; the transcript range
   travels with the source. The `/raw` route serves an original back with
   `X-Content-Type-Options: nosniff`: PNG/JPEG and audio inline for preview and replay,
   everything else as an `application/octet-stream` download, so a stored type can never
   render active content in the engine origin.
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
   refused; the student may accept a subset of pages. `POST /api/proposals/:id/reject`
   changes no pages and cancels the job. There is no auto-accept left: every model-drafted
   proposal waits for the student's explicit choice, marked `decidedBy: 'student'`.
6. **Checkpoint.** Only `committed` or `no_changes` consumes transcript turns — a failed
   compile leaves them pending so a retry reads the same range.

**Quizzes** write evidence through the same machinery: the score becomes a durable result
artifact (`res_*`), a code-built proposal adds its id to the page's `learner.evidenceIds`,
and a page still in the earlier format is adopted (`upgradeLegacyPage`) first — there is no
legacy bypass writer left. `submitQuiz` accepts an `attemptId` (or falls back to a hash of
the answers) and keys the stored result on it, so retries and double-submits replay the
same result rather than stacking evidence. The old `BrainVault` only *reads* typed pages
now (as concept views for the sky and mastery); its `save`/`writeSeeded` refuse to touch them.

The student sees the diff, including what the deterministic pass dropped and why, in the
"Your brain grew" dialog. **Lint** (`lint.ts`) surfaces open misconceptions, oversized pages
and shaky prerequisites — disputed claims appear as open misconceptions. These appear in
Brain → Open questions, each with a "Work through it" button that opens the Guide with a prompt.

**Maintenance** (`maintenance/`, `MaintenanceService` on the workspace, routes under
`/api/maintenance/*`, Brain → Maintenance) keeps the vault itself honest. A lint pass runs
deterministic structural checks — orphan pages, missing sources and citations, dead or
unrecorded links, index drift, bad course mappings, oversized pages, schema and revision
drift — and every finding carries stable ids, the page revisions it was computed against,
and the evidence behind it. Findings are *suggestions*: code-supported ones can be filed
as ordinary `WikiProposal`s through the same review → `applyProposal` path (with base
revisions, so a manual edit in between refuses them as stale), and false ones can be
dismissed — dismissals persist in `.meta/maintenance.json` and survive reruns. "Rebuild
index" rewrites `index.md` and the manifest through the same journaled commit; drifted
entries keep their committed record so a mismatch stays visible. Raw sources are never
deleted. A separate semantic review (`POST /api/maintenance/review`) sends a bounded set
of pages (≤12, claims clipped) through the chat model for contradictions, stale claims,
missing connections and open questions; every page/claim reference the model returns is
validated in code — contradictions must cite both sides, dangling references are listed
under `dropped`, and a semantic finding expires when a cited page moves or a cited claim
is no longer current. Nothing it produces writes a page until the student accepts a
code-built proposal for it.

### Wiki-first answers, saved syntheses and restores

The compiled wiki is the first place a question is looked up, not the last
(`engine/src/brain/query.ts → WikiQuery`):

- **Search** is the same weighted keyword scorer the lesson pool uses, pointed at page
  titles, summaries, claims and bodies. The Guide and Philosopher get the top hits in a
  `WIKI PAGES` block before the model runs, and can call `search_wiki` / `read_wiki_page`
  for more — so a repeated question reuses the saved synthesis instead of being
  re-derived from raw sources.
- **A page read is a permitted view, not a dump.** `pageView` judges every claim live
  against the current source catalogue (`claim-evidence.ts`), so a claim whose provenance
  went stale reads as withheld. And because a source_summary, synthesis or question page
  is generated prose, `read_wiki_page` marks it **withheld in the turn's evidence set** —
  citable as context, never assertable. That is what stops a saved model answer from
  laundering itself into course evidence by being compiled.
- **Save to wiki** (`POST /api/wiki/save`) freezes one assistant answer as a
  `kind: 'answer'`, `origin: 'model'` source — pinned to the session and turn, carrying
  the sources and tool trace that produced it — and queues its job. The compile files a
  proposal like any other contribution; only the student's accept writes a page. An
  `answer` source can never carry `student` provenance and never counts as mastery
  evidence.
- **The catalogue** (`GET /api/wiki/pages`, `GET /api/wiki/pages/:id`) backs the Wiki tab:
  index summaries, per-kind counts, claims with live verdicts, links and the sources each
  page rests on — including source ids that no longer resolve, shown rather than hidden.
- **Restore is a write, and writes go through proposals.** `POST /api/brain/pages/:key/restore`
  reads the named `.history/` revision, rebuilds it as a code draft and applies it against
  the `baseRevision` the caller read — a stale base answers 409 instead of silently
  overwriting newer work. The current page is archived to `.history/` first, so restoring
  can never lose the version it replaced; history is append-only.

### Peer material runs the same pipeline

Cohort sharing lives in `engine/src/shares/` behind `/api/shares/*` (`routes/shares.ts`),
relayed to the university's authenticated feed by `PeerShareService`:

- **Publish** is preview-first: `POST /api/shares/prepare` builds the exact
  `PublishShareRequest` — title, markdown, citations, attachment *descriptors* — and
  `POST /api/shares/publish` relays it verbatim. The deterministic builder in
  `shares/payload.ts` keeps the page's title, summary and public body sections and cuts
  the private blocks (struggles, misconceptions, quiz results, contact details) by
  construction, not by model judgement; `[[page-id]]` links stay as explicit references
  to material the sender did not share. Attachment checkboxes pick source descriptors
  (`sha256`, `bytes`, `name`, `mediaType`) — the files themselves never leave the
  device. The preview lists what was excluded and does not promise perfect redaction.
- **Read** is `GET /api/shares/feed` (cursor-paginated, annotated with `mine` /
  `import` / `ignored` from the profile-local ledger in `shares/store.ts`) and
  `GET /api/shares/mine` for the author's own items including withdrawn ones. An
  unreachable uni, a missing session or a refused call is a response *state*
  (`offline` / `auth_required` / `unavailable`), never fabricated items.
- **Import** is `POST /api/shares/:id/import`: the share freezes as a `kind: 'peer'`,
  `origin: 'peer'` source carrying `{id, revision, senderId, cohortId}` provenance,
  then runs the ordinary ingest → compile → proposal → student-review → `applyProposal`
  pipeline — with no `autoAccept`, because importing is not reviewing. Repeating an
  import of the same share *and revision* replays the first (no duplicate source or
  job); a new revision freezes a new source. Peer material never touches mastery or
  the vault directly, and withdrawal stops future downloads without recalling
  already-imported copies.

## 4. Merging the two: the graph the UI draws

`engine/src/brain/graph.ts → buildGraphView(courseGraph, pages, courses)` returns `GraphResponse` (`GET /api/graph`):

- every lesson and concept node from the course sky, with concept nodes carrying the student's `status`, open misconception count, and whether a peer link touches them;
- **personal nodes**: every vault page is a star — concepts under `c:<pageId>`, syntheses under `s:<pageId>`, questions under `q:<pageId>` (`pageNodeId`/`parsePageNodeId` in `packages/shared/src/brain.ts`). Course concepts keep their `c:<conceptKey>` ids, so old navigation stays valid. Pages with no course mapping (`courseRefs` empty) live in a synthetic constellation, `PERSONAL_SKY_ID` ("Your own sky"), that no real course can collide with. Personal nodes carry `kind` (`concept` | `synthesis` | `question`), the link **origin** that brought them (`student`, `peer`, `suggested`, or `course` for official syllabus pages — kept distinct from personal provenance), `pageId`, `status`, and counts of collected vs demonstrated evidence;
- course edges plus every brain link whose two ends are in the sky;
- `stats`: course concepts, lit (not unseen), shaky, solid, student-made links, and personal-node counts. These drive the "62 of 286 lit" header.

## 5. The Sky view

`apps/desktop/src/features/sky/` renders the merged graph with react-three-fiber:

- **Layout** (`layout.ts`) is deterministic: one column per semester, one constellation per course, lessons along a gentle wave in teaching order, and concepts spiralling around the lesson that introduces them. Personal pages are grouped apart in the "Your own sky" constellation rather than scattered through the course columns. Reading left to right is reading the programme.
- **Shapes and rims** (`SkyCanvas.tsx`, `lib/brain-style.ts`) distinguish what a star is: course stars, personal concepts, syntheses and questions each get their own shape, and a rim marks peer- or suggested-origin nodes so imported material is visible at a glance.
- **Camera** (`MapCamera.tsx`) behaves like a map: drag pans, wheel or pinch zooms toward the cursor, and selecting a star centres it in the space not covered by the side sheet.
- **Labels** (`labels.ts`, `SkyLabels.tsx`) use semantic zoom: course names when far out, concept names when close. Collisions are resolved by priority, and the selection and hover labels always win.
- **Next up** (`next-up.ts`) points the student at open misconceptions first, then the next unseen concepts in teaching order.
- Clicking a star opens the **concept sheet**, which is kind-aware: a course concept offers a quick quiz and "Talk it through with the Guide"; a synthesis or question (and any personal concept with no introducing lesson) shows its record and growth trail instead — the quiz action exists only where a real lesson can back it.
- **Deep links**: the Sky view reads `?page=<pageId>` (`lib/nav.tsx`) to select a node — the stable anchor hook PR-21 builds on. The Brain view honours the same parameter for its record sheets.

## 6. Demo brains

The three demo students' vaults are generated deterministically by `engine/src/demo/seed.ts` from the real courseware and the personas in `packages/shared/src/demo.ts`. Each gets pages with evidence, misconceptions, student links and seeded chat sessions — and personal pages (a synthesis, a question, peer-imported concepts) written through the **real proposal path**, so the demo vaults carry genuine typed growth events rather than hand-planted ones. The same seed always produces the same brains, so the demo is reproducible.
