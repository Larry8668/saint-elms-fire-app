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
| `ENGINE_HOST` | `127.0.0.1` | `127.0.0.1` with host networking; `0.0.0.0` inside a container with a port mapping | Bind address. The edge connects over loopback, so a seat does not need to bind every interface. A non-loopback bind without `ENGINE_PUBLIC_HOST` refuses to start (see [Fail-closed startup](#fail-closed-startup)). |
| `ENGINE_PORT` | `4100` | the published port | Listen port. |
| `ENGINE_PUBLIC_HOST` | unset | `4100-<id>.instabox.tech` (**required**) | **Required for any public deployment.** The seat's published hostname. It marks the engine as hosted, adds `https://<host>` to the allowed origins, closes the profile picker and the password-less offline unlock, and makes device-grant polls carry the starting client's key. A bare name, `name:port` or a URL are all accepted. A value that is set but unusable (a loopback name, a wildcard) refuses to start rather than silently running in device mode. |
| `ENGINE_TRUST_PROXY` | off | `1` | Opt-in. Honour `X-Forwarded-Host/-For/-Proto`, but only from a trusted peer. Leave it off unless a proxy you control sits in front: without it, forwarded headers are ignored entirely. |
| `ENGINE_TRUSTED_PROXIES` | `127.0.0.0/8,::1` | the default with host networking; add the bridge gateway (for example `172.17.0.1`) with a `-p` mapping | Comma-separated IPs or CIDRs whose forwarded headers count. A prefix must be 1–3 digits within the family's range (`/0`–`/32`, `/0`–`/128`): `172.17.0.1/`, `::1/`, `x/abc`, `x/33` are dropped, never read as `/0`, and each dropped entry is named in an `edge_config_warning` at startup. |
| `ENGINE_ALLOWED_ORIGINS` | none | usually nothing | Extra browser origins, comma-separated. The Vite dev origins and Tauri schemes are always allowed, and the public origin is derived from `ENGINE_PUBLIC_HOST`, so you don't need to repeat it here. `*` and `null` are ignored. A non-loopback `https://` origin here without `ENGINE_PUBLIC_HOST` refuses to start. |
| `ENGINE_DEVICE_PEERS` | unset (loopback only) | leave unset | Not for seats. CIDRs whose *direct* connections count as "this device" (picker, offline unlock, keyless polls), for a local container whose port is published on host loopback only; `docker-compose.yml` sets it to the bridge ranges. A forwarded request is never the device, and on a seat (`ENGINE_PUBLIC_HOST` set) nothing is. |
| `ENGINE_SEAT_OWNER` | unset | the owner's uni user id, set by whatever provisions the box | The uni account id allowed to sign in to this seat (several may be comma-separated). Unset, the first uni-verified sign-in pins itself (see [Seat owner](#seat-owner)). Ignored without `ENGINE_PUBLIC_HOST`. |
| `ENGINE_STATIC_DIR` | unset | the built `apps/desktop/dist` | Serves the student UI from the engine's own origin (see below). The engine's loopback origin is then allowed as well. |
| `UNI_SERVER_URL` | `http://localhost:4200` | the university's HTTPS URL | First-run default for the uni server. Settings can change it later. |
| `OLLAMA_URL` | `http://localhost:11434` | `http://ollama:11434` (compose) or loopback | Model runtime on the box. |

### Running the engine in Docker

Plain background processes do not survive a stop/start of the box. Containers started with `--restart unless-stopped` do, so a seat runs the engine as a container. That affects which peer address the engine sees:

- **`network_mode: host`** (recommended): the engine binds `127.0.0.1:4100` on the box, the edge's peer stays `127.0.0.1`, and the default `ENGINE_TRUSTED_PROXIES` is right.
- **A `-p 127.0.0.1:4100:4100` port mapping**: the engine binds `0.0.0.0` inside the container and sees the Docker bridge gateway (for example `172.17.0.1`) as the peer. Add that address to `ENGINE_TRUSTED_PROXIES`, and set `ENGINE_PUBLIC_HOST`, without which a `0.0.0.0` bind refuses to start. If you don't add it, forwarded headers are ignored, every request appears to come from one address, and the sign-in rate limit becomes a single shared bucket.

## Fail-closed startup

Without `ENGINE_PUBLIC_HOST` the engine runs in device mode, where the person at the keyboard is trusted with the profile picker and the password-less offline unlock. A deployment that is in fact reachable from elsewhere must not land in that mode by omission, so the engine logs `edge_config_refused` and exits at boot when `ENGINE_PUBLIC_HOST` is unset and any of these holds:

- `ENGINE_HOST` is not loopback (for example `0.0.0.0`), unless `ENGINE_DEVICE_PEERS` declares a loopback-published container (it then warns instead);
- `ENGINE_ALLOWED_ORIGINS` contains a non-loopback `https://` origin;
- `ENGINE_PUBLIC_HOST` is set but unusable.

A non-loopback `http://` origin and every dropped proxy/peer entry are logged as `edge_config_warning`. **`ENGINE_PUBLIC_HOST` is required for any public deployment.**

## What the engine enforces

**Host gate (DNS rebinding).** On every path, including the served UI, `Host` must be loopback or `ENGINE_PUBLIC_HOST`. When the proxy is trusted and the peer is a trusted proxy, `X-Forwarded-Host` must also be absent (a local caller on the box) or equal `ENGINE_PUBLIC_HOST`. A mismatch is a `403 forbidden_host`. From an untrusted peer, forwarded headers are ignored and only the `Host` rule applies. With `ENGINE_PUBLIC_HOST` unset, the gate behaves exactly as it does on a local engine.

**Origin check.** Mutating requests with a foreign `Origin` get `403 forbidden_origin`. CORS is limited to the same allowlist, and OPTIONS preflights are answered by the engine.

**Sign-in rate limit.** All limits are sliding one-minute windows; over a limit the engine returns `429 { code: 'rate_limited', retryAfter }` with a `Retry-After` header.

| Route | Per client | Engine-wide | Refunded on success |
| --- | --- | --- | --- |
| `POST /api/auth/login` + `/api/auth/offline-login` (one shared budget) | 5 | — | yes |
| `POST /api/auth/login` (forwarded to the uni) | — | 8 | yes |
| `POST /api/auth/device/start` (each one is an upstream `/v1/auth/device/code` call) | 5 | 20 | no |
| `POST /api/auth/device/poll` (no secret; above the client's 2-second poll floor) | 30 | — | no |

The engine-wide login cap exists because the uni limits `/v1/auth/login` to 10 per minute per socket peer, which for a seat is the box's egress address: without it, two attacker addresses at 5 a minute each would keep the uni refusing every student on the seat. The engine-wide cap trips first and answers 429 without calling the uni. Since successes refund it, students signing in normally do not use it up; a guessing burst from many addresses can still make password sign-in wait for up to a minute, while device sign-in is unaffected.

Trusting `X-Forwarded-For` assumes the edge **appends or overwrites** it with the address it saw. An edge that passed a client's own header through unchanged would let the client choose its rate-limit key, so keep `ENGINE_TRUST_PROXY` off for any proxy whose behaviour you have not checked.

The client is identified by the socket peer. Through a trusted proxy, it is the right-most `X-Forwarded-For` entry that is not itself a trusted proxy. The left-most entry is whatever the client chose to send, so it is never used. An IPv6 client is keyed by its `/64`, so one subscriber's prefix is one bucket. The limiter lives in memory and tracks at most 10,000 clients, dropping idle clients first and then the least recently seen. Two limits remain:
- Memory is bounded per client, not across the whole engine.
- A client that can rotate through very many IPv4 addresses or IPv6 `/64`s still gets 5 guesses per key per minute, up to the engine-wide caps above.

**Bad sign-ins** are logged as `auth_failed` with the route, the failure code and the client address. Passwords, tokens and emails are never logged.

**Health.** `GET /api/health` is unauthenticated and returns only `{ ok, engine, uni: { reachable } }`, for docker healthchecks, preflight, e2e and the sign-in screen. `uni.reachable` is a bare boolean: no URL, version, model, hostname or error text. It is cached for 20 seconds with one shared in-flight probe (bounded by the 2.5 s uni timeout), so public hits cannot make the engine hammer the university. `GET /api/health/detail` needs a session and returns the full uni, model and web report. Before sign-in the desktop UI uses that boolean for the "university unreachable" banner and to disable Continue.

**Sessions.** Each engine session records an id, a device label (the client's `deviceLabel` field on login, otherwise a coarse "Browser on OS" hint from the User-Agent), `createdAt` and `lastSeenAt`. `lastSeenAt` is written at most every 5 minutes. `GET /api/auth/sessions` lists the caller's own sessions and marks the current one. It never includes a token or a token hash. `DELETE /api/auth/sessions/:id` revokes one of the caller's own sessions; another profile's id returns 404. Sessions issued before this change keep working: they get a stable id on first load, and their unknown `createdAt` is reported as `null`.

**Closed for remote callers.** A request is remote when `ENGINE_PUBLIC_HOST` is set (always, on a seat), when it carries any `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` or `Forwarded` header, or when its socket peer is not loopback (nor in `ENGINE_DEVICE_PEERS`). This holds even if `ENGINE_PUBLIC_HOST` was forgotten. For a remote caller:
- `GET /api/auth/profiles` returns `[]`.
- `POST /api/auth/offline-login` returns `403 offline_unavailable`. Offline unlock proves possession of the device, and on a public URL anyone has that.
- Device-grant polls must carry the `flowKey` that `device/start` returned, so another visitor cannot collect the session the student approves.

**Device grants are per flow.** Each `device/start` gets its own pending grant, keyed by the SHA-256 of its `flowKey` (matched with a timing-safe compare), so a visitor starting a grant cannot cancel a student's. The engine holds at most 32 at once (the oldest is dropped first), and each is evicted two minutes after the uni's expiry (capped at 30 minutes), so a poll just after expiry still reads `expired`. A keyless poll is allowed only from the device itself, and finds the most recent grant that was also started there.

### Seat owner

A seat belongs to one student. Without this, any account the uni recognises could sign in to someone else's seat: their profile would be separate, but it would run on the owner's compute and its files would land on the owner's disk.

- **Who owns it.** `ENGINE_SEAT_OWNER`, when set, names the owner by uni account id: the `account.id` a password sign-in returns, or the `user.id` from `/v1/me` after a device sign-in. These are the same ids the engine uses as profile ids. Emails are not used, since they can change. When it is unset, the first sign-in the uni verifies (password or device) pins its account id to `seat-owner.json` in the engine data dir (written once, never overwritten) and logs `seat_owner_pinned`.
- **What is refused.** Every other account gets `403 { code: 'seat_not_yours' }` ("This seat belongs to another student.") on password sign-in and on device-grant completion. The check runs right after the uni answers, before any profile, password verifier, uni credential or workspace of theirs is written. The offline paths (cached-verifier password sign-in, entitlement unlock) never pin: on a seat nobody has claimed yet they are refused until a sign-in reaches the uni.
- **Existing sessions.** At startup, with an owner known, sessions held by any other profile are revoked (`seat_owner_enforced` logs how many). Once a pin exists, session lookup also refuses any other profile's session.
- **Fail closed.** A `seat-owner.json` that cannot be read or has no `accountId` is logged as `seat_owner_unreadable` and `seat_owner_fail_closed`. Every sign-in is then refused and no session is honoured until the file is fixed. It is never overwritten automatically.
- **Local engines** (no `ENGINE_PUBLIC_HOST`) have no owner: several profiles share the device as before.

**Resetting the owner.** On the box, stop the engine, then either delete `seat-owner.json` from the engine data dir (`ENGINE_DATA_DIR`, `/data` in the compose container), so the next uni-verified sign-in pins again, or set `ENGINE_SEAT_OWNER` to the right id, which takes precedence over the file. Start the engine again. The pin is only read at startup.

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
