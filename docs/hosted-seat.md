# Hosted seat: running the engine on a public URL

A hosted seat is one student's engine running on a cloud box that the student owns. The box publishes the engine port through a TLS edge (for example Instabox's `https://4100-<id>.instabox.tech`). The engine was built for loopback, so this page covers what changes when it is reachable from the internet, which knobs control that, and what the setup does and does not protect.

Provisioning the box is a later PR (PR-38). This page covers the engine side only (PR-37).

## Shape

```
browser / Tauri app ──HTTPS──▶ provider edge (TLS ends here) ──HTTP, loopback──▶ engine :4100 ──▶ Ollama, uni server
```

What the Instabox edge sends to the box, measured on a real machine:

| Header / fact | Value seen by the engine |
| --- | --- |
| TCP peer | `127.0.0.1`, because the edge connects over loopback |
| `Host` | `127.0.0.1:4100`, **not** the public name |
| `X-Forwarded-Host` | `4100-<id>.instabox.tech` |
| `X-Forwarded-For` | the client's public IP |
| `X-Forwarded-Proto` | `https` |
| `Origin` | passed through untouched (`https://4100-<id>.instabox.tech` for the served UI) |
| CORS | the edge neither adds nor strips CORS headers, so the engine's own CORS is what applies |
| SSE | streams incrementally with no buffering |

## Environment

| Variable | Default | On a seat | What it does |
| --- | --- | --- | --- |
| `ENGINE_HOST` | `127.0.0.1` | `127.0.0.1` with host networking; `0.0.0.0` inside a container with a port mapping | Bind address. The edge connects over loopback, so a seat does not need to bind every interface. |
| `ENGINE_PORT` | `4100` | the published port | Listen port. |
| `ENGINE_PUBLIC_HOST` | unset | `4100-<id>.instabox.tech` | The seat's published hostname. It marks the engine as hosted, adds `https://<host>` to the allowed origins, closes the profile picker and the password-less offline unlock, and makes device-grant polls carry the starting client's key. A bare name, `name:port` or a URL are all accepted. Loopback names and wildcards are ignored. |
| `ENGINE_TRUST_PROXY` | off | `1` | Opt-in. Honour `X-Forwarded-Host/-For/-Proto`, but only from a trusted peer. Leave it off unless a proxy you control sits in front: without it, forwarded headers are ignored entirely. |
| `ENGINE_TRUSTED_PROXIES` | `127.0.0.0/8,::1` | the default with host networking; add the bridge gateway (for example `172.17.0.1`) with a `-p` mapping | Comma-separated IPs or CIDRs whose forwarded headers count. Malformed entries are dropped. |
| `ENGINE_ALLOWED_ORIGINS` | none | usually nothing | Extra browser origins, comma-separated. The Vite dev origins and Tauri schemes are always allowed, and the public origin is derived from `ENGINE_PUBLIC_HOST`, so you don't need to repeat it here. `*` and `null` are ignored. |
| `ENGINE_STATIC_DIR` | unset | the built `apps/desktop/dist` | Serves the student UI from the engine's own origin (see below). The engine's loopback origin is then allowed as well. |
| `UNI_SERVER_URL` | `http://localhost:4200` | the university's HTTPS URL | First-run default for the uni server. Settings can change it later. |
| `OLLAMA_URL` | `http://localhost:11434` | `http://ollama:11434` (compose) or loopback | Model runtime on the box. |

### Running the engine in Docker

Plain background processes do not survive a stop/start of the box. Containers started with `--restart unless-stopped` do, so a seat runs the engine as a container. That affects which peer address the engine sees:

- **`network_mode: host`** (recommended): the engine binds `127.0.0.1:4100` on the box, the edge's peer stays `127.0.0.1`, and the default `ENGINE_TRUSTED_PROXIES` is right.
- **A `-p 127.0.0.1:4100:4100` port mapping**: the engine binds `0.0.0.0` inside the container and sees the Docker bridge gateway (for example `172.17.0.1`) as the peer. Add that address to `ENGINE_TRUSTED_PROXIES`. If you don't, forwarded headers are ignored, every request appears to come from one address, and the sign-in rate limit becomes a single shared bucket.

## What the engine enforces

**Host gate (DNS rebinding).** On every path, including the served UI, `Host` must be loopback or `ENGINE_PUBLIC_HOST`. When the proxy is trusted and the peer is a trusted proxy, `X-Forwarded-Host` must also be absent (a local caller on the box) or equal `ENGINE_PUBLIC_HOST`. A mismatch is a `403 forbidden_host`. From an untrusted peer, forwarded headers are ignored and only the `Host` rule applies. With `ENGINE_PUBLIC_HOST` unset, the gate behaves exactly as it does on a local engine.

**Origin check.** Mutating requests with a foreign `Origin` get `403 forbidden_origin`. CORS is limited to the same allowlist, and OPTIONS preflights are answered by the engine.

**Sign-in rate limit.** `POST /api/auth/login` and `/api/auth/offline-login` share one budget of 5 attempts per minute per client, in a sliding window. A successful sign-in refunds its attempt, so only guessing is throttled. `/api/auth/device/poll` carries no secret and is capped at 30 per minute, which sits above the client's 2-second poll floor. Over the limit the engine returns `429 { code: 'rate_limited', retryAfter }` with a `Retry-After` header.

Trusting `X-Forwarded-For` assumes the edge **appends or overwrites** it with the address it saw. An edge that passed a client's own header through unchanged would let the client choose its rate-limit key, so keep `ENGINE_TRUST_PROXY` off for any proxy whose behaviour you have not checked.

The client is identified by the socket peer. Through a trusted proxy, it is the right-most `X-Forwarded-For` entry that is not itself a trusted proxy. The left-most entry is whatever the client chose to send, so it is never used. The limiter lives in memory and tracks at most 10,000 clients, dropping idle clients first and then the least recently seen. Two limits remain:
- Memory is bounded per client, not across the whole engine.
- A client that can rotate through very many source addresses (for example a large IPv6 range) still gets 5 guesses per address per minute.

**Bad sign-ins** are logged as `auth_failed` with the route, the failure code and the client address. Passwords, tokens and emails are never logged.

**Health.** `GET /api/health` is unauthenticated and returns only `{ ok, engine, uni: { reachable } }`, for docker healthchecks, preflight, e2e and the sign-in screen. `uni.reachable` is a bare boolean: no URL, version, model, hostname or error text. It is cached for 20 seconds with one shared in-flight probe (bounded by the 2.5 s uni timeout), so public hits cannot make the engine hammer the university. `GET /api/health/detail` needs a session and returns the full uni, model and web report. Before sign-in the desktop UI uses that boolean for the "university unreachable" banner and to disable Continue.

**Sessions.** Each engine session records an id, a device label (the client's `deviceLabel` field on login, otherwise a coarse "Browser on OS" hint from the User-Agent), `createdAt` and `lastSeenAt`. `lastSeenAt` is written at most every 5 minutes. `GET /api/auth/sessions` lists the caller's own sessions and marks the current one. It never includes a token or a token hash. `DELETE /api/auth/sessions/:id` revokes one of the caller's own sessions; another profile's id returns 404. Sessions issued before this change keep working: they get a stable id on first load, and their unknown `createdAt` is reported as `null`.

**Closed on a seat.** With `ENGINE_PUBLIC_HOST` set:
- `GET /api/auth/profiles` returns `[]`.
- `POST /api/auth/offline-login` returns `403 offline_unavailable`. Offline unlock proves possession of the device, and on a public URL anyone has that.
- Device-grant polls must carry the `flowKey` that `device/start` returned, so another visitor cannot collect the session the student approves.

A seat student whose box cannot reach the uni signs in with a password, which uses the cached verifier. Device-profile students wait until the uni is reachable again.

## Serving the UI from the engine

Build the UI so that it calls the origin it was loaded from, without demo helpers:

```bash
VITE_ENGINE_URL=same-origin VITE_DEMO_MODE=false pnpm --filter @sef/desktop build
ENGINE_STATIC_DIR=apps/desktop/dist pnpm --filter @sef/engine start
```

The static handler follows the same rules as the uni's `/admin` portal and uses the same resolver (`@sef/shared/node` `resolveAsset`):
- Paths resolve inside the root only. `..` and encoded traversal are rejected, and symlinks that lead outside the root are refused.
- Hashed `assets/*` are cached as immutable, and the shell is revalidated.
- Extension-less paths fall back to `index.html`. A missing file stays a 404.
- Nothing under `/api` is ever answered by the UI.

Responses carry a CSP limited to the engine's own origin (`default-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, no inline scripts), plus `nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. HSTS is added only when a trusted proxy reports `X-Forwarded-Proto: https`.

## Threat notes

- **TLS ends at the provider's edge.** Between the browser and the edge, traffic is HTTPS (a Let's Encrypt wildcard for `*.instabox.tech`). Between the edge and the engine, it is plain HTTP over the box's loopback. The edge sees request and response bodies in clear: sign-in passwords, session tokens, chat turns and vault exports.
- **The disk is private to the box, not "encrypted at rest" in any sense we control.** `/data` persists across stops and is visible only to the account that owns the machine. The engine's files (`auth-sessions.json`, profile workspaces, the vault) are ordinary files on that disk. Session tokens are stored hashed, but nothing else is encrypted by the engine. Credentials normally kept in the OS credential store fall back to memory on a box without a keyring (`secret-tool`), so a restart then signs device profiles out.
- **The provider has hypervisor access.** Whoever runs the hosting infrastructure can, technically, read the box's memory and disk. Sovereignty here means *no other student, and not the university*, can reach the box. It does not mean the hosting provider cannot.
- **The university cannot reach the seat.** The box lives in the student's own account. The uni server still sees what it always saw: sign-ins, catalogue sync and shares.
- **Anyone with the URL can reach the sign-in surface.** The protections above (host and origin gates, rate limiting, closed offline unlock, bound device polls, minimal public health) are what stand between the URL and the vault. Bearer sessions last `ENGINE_SESSION_HOURS` (14 days by default). A lost device should be revoked from the session list.
- **No offline mode.** A hosted seat needs the network. Vault export remains the continuity path.

## Claiming a seat from the desktop app

The sign-in screen has a **Claim your hosted seat** link. It opens a checklist that takes a student from an Instabox API key to a running seat, without a terminal:

| Step | What happens |
| --- | --- |
| Key | The student pastes an Instabox API key (Full access, or `machines:read`, `machines:write` and `machines:delete`). It goes into the **operating system's keychain** and is checked against the account. An account that has not redeemed its invite is told to do so. |
| Machine | Lists the machines labelled `app:sef-seat`. An existing seat is adopted. Otherwise the app creates one: the `universal` template, the label, a 30-minute idle suspend and **no Vault**. |
| Ready | Waits for the create to finish, and starts or resumes a machine that is stopped or paused. |
| Publish | Publishes port 4100 and records the seat URL, `https://4100-<id>.instabox.tech`. |
| Bootstrap | Starts `infra/seat/bootstrap.sh` on the box and shows its steps and log as they progress (see [Provisioning a seat](#provisioning-a-seat-on-instabox)). |
| Health | Waits until `/api/health` answers over the public URL. |
| Save | Remembers the seat URL on this device, then reloads into the normal sign-in, now talking to the seat. |

**Every step can be retried, and none of them duplicates work.** A retry re-runs the failed step and continues from there:
- A create is retried with the same idempotency key, and a list of labelled machines runs first, so a resumed flow never makes a second box.
- A bootstrap that is already running is joined, not started again.
- Closing the window keeps the progress, apart from the key, which is in the keychain.

Instabox's own errors are shown with what to do about them: `quota_exceeded` (delete a machine), `no_capacity` (nothing was created, try again later), `insufficient_scope` (use a key with machine scopes), `invite_required` (redeem the invite), and `machine_not_running` (retry starts it).

**Where the key goes.** api.instabox.sh does not accept calls from web pages (it sends no CORS headers), and its key should not sit where page scripts can read it. The desktop shell therefore makes every Instabox call itself, and the web view only asks it to run named steps:
- The key is sent only to `api.instabox.sh`.
- It is never stored in web storage or shown again, and never sent to the engine or the university.
- In a plain browser, the link explains that seat setup needs the desktop app. A seat that is already running can still be used from any browser at its own URL.

**Why no Vault.** Instabox can copy the account's Vault items into machines it creates, and code running on a box that holds a `machines:write` key could read them. A seat needs none of them, so it is created with `vault: false`. A student who wants Vault items on the seat can turn that on later in Instabox.

**Switching back.** Under the sign-in card, "Use this computer's engine instead" routes the app to the local engine (`127.0.0.1:4100`, or `VITE_ENGINE_URL`). The seat stays remembered, so "Use your seat" switches back. Each switch reloads the window, because a session belongs to one engine. The machine itself is not touched.

## Using a seat: waking and pausing

The app reads the engine address on every call (`apps/desktop/src/lib/seat.ts`), so it is never fixed at build time. The UI that an engine serves itself (`VITE_ENGINE_URL=same-origin`) calls its own origin.

A seat may be asleep, and the Instabox edge reports its state in ways the app can tell apart:

| The edge answers | Meaning | What the app does |
| --- | --- | --- |
| Normal answer after about 1 s | The box was idle-suspended, and the request woke it | Nothing visible |
| No answer (connection failure or timeout) | The network is down or the box is waking | Shows "Waking your seat…" and polls public `/api/health` with backoff (0.5 s rising to 5 s) for up to about 60 s, then sends the call again |
| `502`, plain text | The box is up, but the engine is not listening yet | Same as above, with "the engine is still starting" |
| `503` "Sandbox offline", plain text | The box was stopped or paused by hand. A request alone never wakes it. | Shows "Your seat is paused". The desktop app offers **Resume seat**, which starts or resumes the machine with the key in the keychain. A browser explains how to resume it from the desktop app or the Instabox dashboard. |

The engine's own `502` and `503` responses are JSON, for example when the university is unreachable. They are passed through as ordinary errors and never trigger a wake. After a dropped connection, only reads are sent again, because a write might already have landed. A write fails with "ready now, try that again" instead.

Chat streams over the edge. If the answer ever arrives in one piece (the first frames arrive together with the end, more than 2 s after sending), the turn is labelled as delivered all at once instead of streamed.

## Known limitations (measured on a real seat)

- **Speed.** A box has 4 vCPU, 8 GiB and no GPU. `gemma4:e2b` generates about **6 tokens per second** (prompt processing runs at 90–140 tokens per second). A 300-token answer therefore takes about a minute, and the first answer after a cold start waits about a minute more while the model loads. Answers stream as they are written. With the engine and Ollama loaded, about 2.4 GiB of memory remains free.
- **No offline mode.** A seat needs a network connection. Vault export keeps a copy on any device.
- **YouTube ingest is unavailable.** The engine container has no Python, which `yt-dlp` needs.
- **Peer-share screening model.** `shieldgemma:2b` is not pulled, so screening reports it as unavailable. Screening is advisory.
- **Long commands must run detached.** For anyone operating a box by hand: Instabox exec is blocking, and in practice a call is cut after about **60 seconds**, despite the documented 600-second limit. Anything longer must run detached, the way the bootstrap does.
- **First-time setup takes about two minutes** when Instabox has capacity: Ollama image about 60 s, models about 30 s in parallel with the build, engine start a few seconds. When the pool is full, creates fail with `no_capacity` and the checklist says so.
