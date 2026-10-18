# Demo runbook

A short walkthrough of the current build, local or hosted. Setup and data details live in
[HANDOVER.md](../HANDOVER.md); this is the drive-it-once checklist.

## Choose the path

- **Local:** after the one-time setup in HANDOVER §3 (Node 22+, pnpm 10.18, running
  Ollama), `pnpm dev`, then open <http://localhost:5173> and pick a persona under
  **Exploring the demo?**.
- **Hosted:** open the portal listed in HANDOVER §12. On a self-serve build, **Try the
  demo** signs a persona in and requests the tour on every arrival — ×/Esc closes it and
  **Tour** above Settings restarts it. Without self-serve, use **Sign in as a demo
  student** with the operator-provided `DEMO_PASSWORD`, then **Open my workspace** and
  sign in on that engine.

## Personas

| Login | Stage | Sky |
| --- | --- | --- |
| `ananya@saintelms.local` | Semester 1, week 6 | Early course concepts, open misconceptions |
| `brinda@saintelms.local` | End of Semester 3 | Dense sky, student-made connections |
| `chetna@saintelms.local` | Semester 5, thesis prep | Advanced concepts, syntheses, research trails |

Same programme, three points in time; each hosted persona is one persistent, shared
workspace. Show Ananya first, Chetna last.

## Walk it

1. **Sky** — one constellation per course; amber marks open misconceptions, gold solid
   ones. Show Next up, a concept sheet and star search.
2. **Brain** — the full-screen map of the student's wiki, separate from the Sky. Pan,
   zoom, replay growth, search; switch to **Ask** and ask about something already in the
   wiki — cited pages light up. Scroll for **What your brain learned**, **Your brain
   disagrees with itself**, and a page's **Built from** provenance row.
3. **Guide** — ask "why does a moving thing need a force to keep moving?"; open a source
   chip, the exact lesson section and the verification panel.
4. **Philosopher** — anchor on a committed, course-linked wiki page. The app enables web
   search on every turn (no checkbox; the anchor bar shows the topic query). Point out the
   `[course]`/`[web]` tags and the `Trailhead:` question; without SearXNG it answers from
   course evidence only.
5. **Friend** — ask for a classmate's phone number: the refusal runs before the model. A
   notice photo proposes logistics; confirm it in **Logistics** before the Friend asserts
   it.
6. **Add to my wiki** — paste a note, or upload an image, PDF, audio or video file.
   Audio/video reads run in the background; video combines audio transcription with
   sampled slide/board frames. Review or correct the extraction, compile, inspect the
   proposal diff, accept.
7. **Quiz** — a course-backed concept offers a quiz; generation is a background job with
   a visible waiting state. A restart loses pending jobs — retry generation.
8. **Peers** — needs the Postgres account layer and two admitted students in the *same*
   cohort; the three demo personas sit in different cohorts and never share a feed.
9. **Hosted sign-out** — requests a final vault flush and workspace end. Ordinary
   workspaces are retired; pinned demo workspaces are configured to survive it, though a
   staff end, idle reap or lease expiry still retires them. Engine logout revokes the
   calling device; the last device's logout also clears the profile's uni credential and
   offline entitlement.

## Boundaries to respect

- Offline study is local-only — see the local drill in HANDOVER §6; hosted workspaces
  need the network.
- Prefer an uploaded audio/video file over a YouTube link: the external site can block
  datacenter IPs. Don't quote live counts or timings — seeded workspaces change with use.
- A student can hold four open wiki jobs; compile or cancel sources between runs.
- Trouble? HANDOVER §9. The hosted liveness/readiness endpoints in HANDOVER §12 report
  reachability of configured entry points, not deployed versions.
