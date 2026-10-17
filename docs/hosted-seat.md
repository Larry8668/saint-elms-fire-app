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
