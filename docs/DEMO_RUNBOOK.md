# Demo runbook: the hosted stack, happy path for every feature in place

Written 2026-10-18 02:30 UTC (08:00 IST) against the live stack. Every step below was run on the real
deployment tonight unless marked **(not re-run today)**. Companion: `CLOUD_SEAT_NOTES.md` (§12 Render,
§15 Vercel, §16 audio + pinned workspaces) for the why and the ids.

## 0. Before you start (2 minutes)

The laptop still hosts two things behind cloudflared tunnels: **Ollama (Gemma)** for every answer and
**MinIO** for the student vaults. If either tunnel is down, the Guide/Philosopher answers fail and
new VMs cannot restore a vault. Check:

```bash
# Ollama up with the demo models
ollama list | grep -E "gemma4:e2b|gemma4:e4b|embeddinggemma|shieldgemma"
# gateway sees a healthy worker through the tunnel
curl -s https://sef-gateway.onrender.com/health      # {"ok":true,"upstreams":{"healthy":1,"total":1}}
# uni up, demo mode on
curl -s https://sef-uni.onrender.com/health           # {"ok":true,...,"demo":true}
# the three demo workspaces (first hit wakes a suspended VM: 4–20 s)
for u in agquzamruxce5u6wilgbffhzau agquzap2kjrrm3i2f5pfao27oq agquzayrnw347ifqvfo2snuppa; do
  curl -s --max-time 60 https://4100-$u.instabox.tech/api/health; echo; done
# expect {"ok":true,"engine":"0.2.0","uni":{"reachable":true},"sync":{"state":"ready"}} x3
```

If the gateway shows `healthy: 0`: the Ollama tunnel URL rotated. Restart cloudflared for Ollama, then
set `GATEWAY_UPSTREAMS` on the Render gateway to the new URL and redeploy (§12 of the notes). If a VM
restore fails with `sync.state: error`: the MinIO tunnel rotated; `scripts/store-target.sh` updates
`OBJECT_STORE_*` on the uni (§12).

**Demo password:** `DEMO_PASSWORD` in `~/.config/sef/render.env` (never paste it into a doc or chat).

**Free VM slot:** Instabox quota is 5. Live: the 3 demo VMs + `box-c0ab84`. One spare for a 4th login.

## 1. The three personas and what their brains should show

| Persona | Portal label | Email | Sky | Courses | Pages |
|---|---|---|---|---|---|
| ananya | First-year student (Semester 1, week 6) | ananya@saintelms.local | 62 of 286 lit, 7 courses in S1 | 8 | 62 |
| brinda | Second-year student (End of Semester 3) | brinda@saintelms.local | 752 of 1039 lit, S1–S3 | 21 | 752 |
| chetna | Third-year student (Semester 5, thesis prep) | chetna@saintelms.local | 1383 of 1773 lit, S1–S5 + 1 own page | 40 | 1384 |

The growth story: same programme, three points in time. Show ananya first, chetna last.

## 2. Sign in and reach the workspace (every persona)

1. Open **https://sef-uni.onrender.com/app** (the portal; the Vercel root alone shows a "engine isn't
   running" developer screen until a workspace has been handed to that browser once).
2. Click **"Sign in as a demo student"** (underlined, bottom of the card). Pick the persona, enter the
   demo password, **Sign in**.
3. Click **"Open my workspace"**. The portal asks the uni for the student's session; the VM is already
   there (pinned), so this takes about 3 s, then the browser lands on
   `https://saint-elms-fire.vercel.app` with the workspace attached. The connecting animation shows
   while the VM wakes if it was suspended (4–20 s).
4. The workspace shows its own sign-in with the demo panel already open and the same persona preselected
   (passed in the hand-off): enter the demo password, **Sign in**. Expected: the Sky dashboard with the numbers in §1 (measured 11 s from
   portal to dashboard for ananya).

If the browser already did steps 1–3 once, opening the Vercel URL directly works from then on.

### 2b. A brand-new account (works since 09:25 IST; only for the Resend owner's email)

1. Portal → **Create an account** with the email that owns the Resend account (sandbox: no other address
   receives mail until a domain is verified in Resend). Verification mail arrives from onboarding@resend.dev
   within seconds (HTML template). Sign in.
2. **Apply to the programme** → "Your application is with the registrar". There is no staff screen: an
   operator approves it from the laptop (`CLOUD_SEAT_NOTES.md` §18, `operator-approve.local.mts approve
   <id> <version>`), then **Refresh status** → "You are enrolled".
3. **Open my workspace** → a new VM from the golden snapshot (22 s measured) → the workspace shows
   **Confirm this device** with a code → "Open the university site" → approve with one click (the portal
   is signed in) → back on the workspace: empty sky, "Get my courses" installs the cohort's releases.
4. The 5th Instabox slot is the only one free: one real account at a time while the 3 demo VMs exist.
   Logout of a real account deletes its VM (not pinned); the vault lives in the store.

**If "Starting your workspace" flips between "Creating" and "Saving your previous workspace"** the spawn
is failing and the portal is retrying: close the tab and check the uni log (`session_spawn_failed` carries
the reason). Tonight that was the MinIO tunnel; see §0 and CLOUD_SEAT_NOTES §19.

## 3. Sky (dashboard)

- **Whole sky**: one column per semester, one constellation per course, titles clipped to their column
  (fixed tonight; chetna's 40 courses no longer overlap). "Your second brain: N of M lit", shaky/solid
  counts, "links you made".
- **Next up**: open misconceptions first (triangle icon), then next lessons. Click one → the page opens.
- **Course chips** at the bottom (S1 Astrophysics I …): click to zoom to that constellation; lesson names
  appear along the wave; zoom one more step (+) for concept names.
- **Find a star**: type a concept ("centripetal"), pick it → camera flies there, neighbours named.
- **Eye icon**: hide unseen stars. **Browse your pages as a list**: the same brain as a list.
- Legend: Lesson / Unseen / Met / Shaky / Solid / Synthesis / Open question; link colours (your link /
  suggested / from a peer).

## 4. Teachers (sidebar: Teachers)

Three minds, each with an intro card and suggested questions:

- **Socrates my Friend**: campus life, fees, calendars, offices. Ask: "When is the fee deadline?" or
  "Where is the physics office?" Expected: an answer from the university's logistics, with the
  verification footer naming the source.
- **Socrates my Guide**: strictly from released lessons. Ask (ananya): "Explain Newton's second law with
  an example from my lab." Expected: streamed answer in a few seconds, anchored on a lesson page; the
  footer says it was answered from your released lessons by the hosted provider. Ask something outside
  the syllabus and the Guide declines by name.
- **Socrates my Philosopher**: beyond the syllabus, onto the web. Ask (chetna): "How does the band gap
  decide whether a material is a semiconductor?" Expected: an anchored answer (band-gap page) in 5–30 s.
  It is allowed to wander past the syllabus; that is its design.
- **Why / checks**: each answer has a verification view (the "why" panel) listing the checks that ran
  (source grounding, screening). Open it once on stage.

Timing reference tonight: Guide/Philosopher answers 5–30 s through gateway → tunnel → laptop Gemma.
A first question after a long idle can take longer while the model loads (~60 s worst case).

## 5. Add to my wiki (sidebar: Add to my wiki) — the multimodal highlight

Every upload becomes a **source**, is read by Gemma, and lands in the student's wiki (the second brain).
What works on the hosted VMs tonight:

| Kind | How | Expected |
|---|---|---|
| Note | paste text, title, Save | page appears in Brain within seconds; synced to the store |
| Image (PNG/JPEG) | upload a photo of handwritten notes or a diagram | read automatically on upload by the vision model (3–10 s); extraction shown (`method: vision`); the image is kept beside its text; "Read it again" re-runs it |
| PDF | upload a lecture PDF | text extracted, pages summarised |
| Audio (wav/m4a/mp3, a voice memo or recorded lecture) | upload | transcribed in ~50 s chunks; a 9-second memo took 17.6 s end to end tonight; transcript with timestamps `[0:00] …` |
| YouTube link | **not available on seats** (no yt-dlp on the VM; datacenter IPs are often blocked by YouTube). Do not demo. Use an audio/video file instead. |

Verify sync after an upload: the status dot in the sidebar footer stays green; the page survives a
logout/sign-in (the vault is flushed on logout and restored from the store on a fresh VM).

Audio sample used tonight: a macOS `say` recording of "Newton's second law says force equals mass times
acceleration…" (`scratchpad/audio/hello.wav` on the laptop). Bring your own short clip for the stage.

## 6. Brain (sidebar: Brain)

The wiki itself: pages per concept, lesson and synthesis, with status (unseen/met/shaky/solid), links,
open questions, and the sources that produced them. Open a page from the Sky, edit nothing on stage
(edits work but take a moment to sync), show the "sources" section and a concept's neighbours.

## 7. Plans (on the Sky dashboard: Plans → New plan)

Type a goal ("revise thermodynamics before Thursday"). Expected: a short checklist built from the
student's own pages and lessons. Verified in the earlier QA pass (chetna) **(not re-run today)**.

## 8. Peers and Logistics (sidebar)

- **Peers**: shared links and pages from classmates; the Sky legend's "From a peer" lines come from here.
  Expected to load with the seeded shares **(not re-run today)**.
- **Logistics**: calendars, fees, offices; the Friend's knowledge, browsable **(not re-run today)**.

## 9. Library (sidebar: Library)

Lists the released courses with install state: ananya 8/8, brinda 21/21, chetna 40/40 installed tonight.
"Download all" now installs one course at a time with "Installing 7 of 21…" progress, so it is safe on
stage; nothing needs installing on the demo VMs anyway. Open one course to show its lessons.

## 10. Settings (sidebar, bottom)

Model roles (tutor/brain/vision/safety) read "University model" on a hosted workspace; the status row
shows Engine / University / Web search. Proactivity toggles (nudges, drafted advice). Sessions list
(this device and others) with revoke. Show, change nothing.

## 11. Sign out and back in (pinned workspaces)

Sign out from the workspace (avatar, bottom-left). Expected: the uni flushes the vault (about 2 s) and
**keeps the VM** for the three demo accounts (`SESSION_PINNED_ACCOUNTS`). Sign in again from the portal:
same workspace, same URL, in about a second (plus the wake if it had suspended). Verified tonight on
ananya: POST ready → DELETE 202 (state stays ready) → POST same id.

## 12. If something goes wrong

| Symptom | Cause | Do |
|---|---|---|
| Vercel root shows "The engine isn't running" | opened without a workspace | go through the portal (§2) |
| "Establishing connection" lasts > 30 s | VM waking from suspend, or edge 502 during wake | wait; refresh once after 30 s |
| Guide/Philosopher answer fails or hangs | gateway cannot reach the laptop Ollama (tunnel) | §0 checks; restart the tunnel, update `GATEWAY_UPSTREAMS` |
| Library shows every course as "update" on a brand-new VM | version scheme of seeded courses vs uni releases | ignore, or Download all once on ananya only |
| A persona's VM is gone (Instabox list) | someone deleted it or staff ended the session | portal sign-in recreates it from the golden snapshot: ananya ~25 s, brinda ~70 s, chetna ~2 min (vault restore through the MinIO tunnel) |
| Audio upload answers 503 "ffmpeg" | VM predates tonight's patch | it was patched on all three; a recreated VM gets it from the snapshot `sn_agquzmervope4cyky4atfddtvm` |

## 13. Scripts (laptop, scratchpad of this session)

All under `/private/tmp/claude-501/-Users-leharadityakumar-project-hackathon/dda84b60-b075-4df2-ad07-cd3a56279865/scratchpad/`:

- `signin/hosted-demo.mjs`: headless click-through portal → workspace → dashboard (ananya).
- `audio/e2e-upload.mjs <engine url> <email>`: audio source upload through a VM's API.
- `pinned/check.mjs [email]`: proves logout keeps the VM.
- `ffmpeg-vm/patch-vm.sh <machine id> <commit>`: re-applies ffmpeg + engine code to a demo VM.
- `apply-gateway.sh`, `apply-uni.sh`, `apply-vercel.sh`: Render/Vercel deploys (run with `! bash …`).

Instabox key: `~/.config/sef/instabox.env`. Render secrets + demo password: `~/.config/sef/render.env`.
Render API token: `~/.render/cli.yaml`. Vercel: deploy from the `saint-elms-fire-app-vercel` worktree on
the commit you want (git pushes do not deploy production).

## 14. Issues spotted on the walk-through — status

- Fixed and live (PRs #103–#105): duplicated teacher suggestions; Peers message on demo accounts; sky left
  column while a star is selected; bare Vercel URL; persona re-selection; sign-up claiming "Sent" on a mail
  failure; endless retry after a failed spawn; Download all timeout; images not read on upload; raw
  markdown in summaries.
- Still open: YouTube on seats (blocked by YouTube, upload a file instead); "update" badges on a freshly
  recreated demo VM; typo "Socratest my Philosopher" on the workspace sign-in; no staff screen for
  enrolment decisions; Resend sandbox (owner's address only).
