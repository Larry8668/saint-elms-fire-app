# The student web app on Vercel (PR-45d)

The student app can be hosted on Vercel, apart from the workspace VM. The VM is then a pure API: the app calls it cross-origin with the session's bearer token (no cookies). The portal (sign-in, **Open my workspace**) stays on the university server.

```
portal (uni /app) ── ready ──▶ https://<app>/?workspace=https%3A%2F%2F4100-<id>.instabox.tech
app (Vercel): validate → store { engineUrl } (localStorage `sef.workspace`) → strip the parameter → sign in against that engine
app ──fetch / SSE (Authorization: Bearer …)──▶ https://4100-<id>.instabox.tech   (ENGINE_ALLOWED_ORIGINS = the app's origin)
```

## Vercel project

| Setting | Value |
|---|---|
| Root directory | `apps/desktop` (`vercel.json` there sets the rest) |
| Framework | Vite |
| Install command | default (Vercel installs the pnpm workspace from the repo root) |
| Build command | `pnpm exec vite build --config vite.config.ts` |
| Output directory | `dist` |
| Rewrites | every path to `/index.html` (SPA) |

Build environment variables:

| Variable | Value | Why |
|---|---|---|
| `VITE_UNI_URL` | the university server, e.g. `https://uni.example.edu` | Portal links (back to "Open my workspace", account pages). |
| `VITE_WORKSPACE_HOST_SUFFIX` | `.instabox.tech` (the default) | The app only accepts a `?workspace=` URL whose host ends with this, over https, with no credentials, path, query or fragment. A forged link to any other host is ignored. |

| `VITE_DEMO_MODE` | `true` (production) | Shows the one-click demo students. On a hosted build they prompt for the demo password instead of filling a known one, so the private `DEMO_PASSWORD` never ships in the bundle. Unset or `false`: plain sign-in only. |

Leave `VITE_ENGINE_URL` unset (a student without a workspace falls back to a local engine at `127.0.0.1:4100`).

Set it once and redeploy (Vite bakes it in at build time):

```bash
printf 'true' | vercel env add VITE_DEMO_MODE production --yes && vercel --prod --yes
```

## University server and portal

| Where | Variable | Value |
|---|---|---|
| uni server | `APP_PUBLIC_ORIGIN` | the app's origin, e.g. `https://sef.vercel.app` (one https origin, no path). The orchestrator passes it to each VM as `ENGINE_ALLOWED_ORIGINS`. Unset: nothing is passed and the VM allows only its own origin. |
| portal build (`pnpm --filter @sef/desktop build:portal`) | `VITE_APP_URL` | the same origin, `https://sef.vercel.app`. The hand-off then goes to the app. Unset: it goes to the VM, which serves its own UI (the PR-45 behaviour). |

The VM accepts `ENGINE_ALLOWED_ORIGINS` through `infra/seat/session-start.sh` (comma-separated https origins). **The golden snapshot must be rebuilt** after this change for the VMs to pick it up (`infra/seat/golden/README.md`); an older image ignores the value, so the VM allows only its own origin and the app's calls fail CORS.

## Self-serve demo (demo day)

A judge gets one URL (the portal) and picks a student; everything else happens by itself. Set on **both** the app build (Vercel) and the portal build:

| Variable | Value | Why |
|---|---|---|
| `VITE_DEMO_SELF_SERVE` | `true` | The portal's sign-in leads with **Try the demo** (three persona cards). A click signs the persona in and opens the workspace with no further click; the app then signs in on the workspace by itself. It implies `VITE_DEMO_MODE`. |
| `VITE_DEMO_PASSWORD` | the uni's `DEMO_PASSWORD` | Embedded in the public JavaScript. **Acceptable only for a demo deployment** whose personas hold seeded data; rotate `DEMO_PASSWORD` after the event. Without it self-serve is off. |

Self-serve stays off unless both are set; a failed automatic sign-in falls back to the existing password panel. The portal shows the section only when the uni seeds demo students (`SEED_DEMO`).

### Session replay (PostHog)

| Where | Variable | Value |
|---|---|---|
| app build and portal build | `VITE_POSTHOG_KEY` | the PostHog project key (`phc_…`). Unset: no PostHog at all; the SDK is not even downloaded. |
| app build and portal build | `VITE_POSTHOG_HOST` | optional, default `https://us.i.posthog.com` |
| uni server | `PORTAL_ANALYTICS_ORIGINS` | `https://us.i.posthog.com,https://us-assets.i.posthog.com`, added to the `/app` shell's `connect-src`. Without it the portal's CSP blocks PostHog and only the app is recorded. |

Pageviews, autocapture and session replay (text inputs masked); the recorder is bundled, so no third-party script loads. URLs are sent without their query or fragment, and a portal visit carrying a reset `?token=` is never recorded. Sessions are identified as `demo:<persona>`, never by email. Named events: `demo_self_serve_started`, `workspace_signed_in`, `tour_started`, `tour_completed`, `source_uploaded` (`kind`), `teacher_turn_sent` (`teacher`). The portal and the app are different origins, so a judge's visit is two recordings; once the persona is identified on both sides they sit under the same person.

## The app on a workspace

- The sign-in screen names the host the student signs in to, and offers **Forget workspace**, which goes back to the local engine.
- A stored workspace that is corrupt, not https (plain http only on loopback) or outside the suffix is cleared on read and the app reads as local.
- A new `?workspace=` drops a session token held for another engine.
- The engine's own static serving (`ENGINE_STATIC_DIR`) is unchanged: a VM can still serve the UI itself.

## Local check

`e2e/workspace.spec.ts` runs this split when `apps/desktop/dist-app` exists: `vite preview` serves the app on `E2E_APP_PORT`, the engine (playing the VM) allows only that origin, and the spec checks the hand-off, the device sign-in, a chat turn's SSE stream and a refused foreign origin. The build commands are in `e2e/support.ts`.
