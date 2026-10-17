# Hosted seat: running the engine on a public URL

A hosted seat is one student's engine running on a cloud box that the student owns. The box publishes the engine port through a TLS edge (for example Instabox's `https://4100-<id>.instabox.tech`). The engine was built for loopback, so this page covers what changes when it is reachable from the internet, which knobs control that, and what the setup does and does not protect.

The engine side is PR-37. Provisioning a seat on Instabox (the bootstrap script and the desktop app's "Claim your seat" flow) is PR-38 and is described under [Provisioning a seat](#provisioning-a-seat-on-instabox).

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
| `ENGINE_STATIC_DIR` | unset | the absolute path of the built `apps/desktop/dist` | Serves the student UI from the engine's own origin (see below). The engine's loopback origin is then allowed as well. |
| `UNI_SERVER_URL` | `http://localhost:4200` | the university's HTTPS URL | First-run default for the uni server. Settings can change it later. |
| `OLLAMA_URL` | `http://localhost:11434` | `http://ollama:11434` (compose) or loopback | Model runtime on the box. |
| `MODEL_GATEWAY_URL` | unset | the operator's model gateway (central-model and session VMs) | Set, the `uni` provider ("University model") becomes this gateway, spoken to over Ollama's native `/api/*` surface, and every role defaults to it. Give the gateway root; a trailing `/v1` (what the orchestrator passes) or `/api` is dropped. The native path keeps the tuning a local Ollama gets: `num_ctx` (`OLLAMA_NUM_CTX`), `think` (off unless a role asks for it) and the `format` grammar for structured output, and the gateway sees real token counts. The engine calls only `/api/chat`, `/api/embed` (falling back to `/api/embeddings`) and `/api/tags` (the role health probe), all on the gateway allowlist. Audio transcription has no gateway route, so a hosted session reports it as unavailable instead of calling one. The URL and token are applied on every settings read and are not stored, and roles stored on the on-box `ollama` provider read as the gateway, so the engine never calls an old gateway even if a settings file still names one. The gateway is not "on this device": verification labels say the answer came from a hosted provider, and the Settings model suggestions are the configured defaults rather than sized to the VM's RAM. |
| `MODEL_GATEWAY_TOKEN` | unset | the session's short-lived gateway token | Sent as `Authorization: Bearer` on every native call to the gateway (chat, structured output, embeddings, the health probe). Read from the environment only: never written to `settings.json` or a profile's `private-settings.json`, never logged, and absent from `/api/health/detail` (a bad token shows there as `HTTP 401`). `GET /api/settings` shows only `hasApiKey`. |

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
ENGINE_STATIC_DIR=$PWD/apps/desktop/dist pnpm --filter @sef/engine start
```

Use an absolute path: pnpm runs the engine from `engine/`, so a relative `apps/desktop/dist` would resolve to `engine/apps/desktop/dist` and the engine logs `static_ui_missing` with the resolved `root`.

The static handler follows the same rules as the uni's `/admin` portal and uses the same resolver (`@sef/shared/node` `resolveAsset`):
- Paths resolve inside the root only. `..` and encoded traversal are rejected, and symlinks that lead outside the root are refused.
- Hashed `assets/*` are cached as immutable, and the shell is revalidated.
- Extension-less paths fall back to `index.html`. A missing file stays a 404.
- Nothing under `/api` is ever answered by the UI.

Responses carry a CSP limited to the engine's own origin (`default-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, no inline scripts), plus `nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. HSTS is added only when a trusted proxy reports `X-Forwarded-Proto: https`.

## The served UI behind the edge: waking and going away

The app reads the engine address on every call (`apps/desktop/src/lib/seat.ts` `engineTarget()`), so it is never a build-time constant baked into a module. The UI that an engine serves itself (`VITE_ENGINE_URL=same-origin`) calls its own origin; outside loopback that is a hosted workspace VM (PR-42), and its sign-in screen says so: "Your workspace runs on the university's servers; your notes are saved to your university storage", never "stays on this device" or "keeps working offline". The local desktop keeps its own copy.

The Instabox edge reports a VM's state in ways the app can tell apart (`apps/desktop/src/lib/seat-wake.ts`):

| The edge answers | Meaning | What the app does |
| --- | --- | --- |
| Normal answer after about 1 s | The box was idle-suspended, and the request woke it | Nothing visible |
| No answer (connection failure or timeout) | The network is down or the box is waking | Shows "Reconnecting to your workspace…" and polls public `/api/health` with backoff (0.5 s rising to 5 s) for up to about 60 s, then sends the call again |
| `502`, plain text | The box is up, but the engine is not listening yet | Same as above, with "the study engine is still starting" |
| `503` "Sandbox offline", plain text | The box was stopped or is gone. A request alone never brings it back; for an ephemeral workspace it usually means the session ended | "Your workspace is offline", with a link back to the portal to open a new one (`seat_paused`) |

The engine's own `502` and `503` responses are JSON, for example when the university is unreachable. They are passed through as ordinary errors and never trigger a wake. After a dropped connection only reads are sent again, because a write might already have landed; a write fails with "is back now, try that again" (`seat_woke`). A window that closes with no answer is `seat_unreachable`. None of these say "the local engine is not running", which stays the local engine's message.

Chat streams over the edge. If the answer ever arrives in one piece (the first frames arrive together with the end, more than 2 s after sending), the turn is labelled as delivered all at once instead of streamed.

## Threat notes

- **TLS ends at the provider's edge.** Between the browser and the edge, traffic is HTTPS (a Let's Encrypt wildcard for `*.instabox.tech`). Between the edge and the engine, it is plain HTTP over the box's loopback. The edge sees request and response bodies in clear: sign-in passwords, session tokens, chat turns and vault exports.
- **The disk is private to the box, not "encrypted at rest" in any sense we control.** `/data` persists across stops and is visible only to the account that owns the machine. The engine's files (`auth-sessions.json`, profile workspaces, the vault) are ordinary files on that disk. Session tokens are stored hashed, but nothing else is encrypted by the engine. Credentials normally kept in the OS credential store fall back to memory on a box without a keyring (`secret-tool`), so a restart then signs device profiles out.
- **The provider has hypervisor access.** Whoever runs the hosting infrastructure can, technically, read the box's memory and disk. Sovereignty here means *no other student, and not the university*, can reach the box. It does not mean the hosting provider cannot.
- **The university cannot reach the seat.** The box lives in the student's own account. The uni server still sees what it always saw: sign-ins, catalogue sync and shares.
- **Anyone with the URL can reach the sign-in surface.** The protections above (host and origin gates, rate limiting, closed offline unlock, bound device polls, minimal public health) are what stand between the URL and the vault. Bearer sessions last `ENGINE_SESSION_HOURS` (14 days by default). A lost device should be revoked from the session list.
- **No offline mode.** A hosted seat needs the network. Vault export remains the continuity path.

## Provisioning a seat on Instabox

`infra/seat/` turns a fresh Instabox `universal` machine into a seat. Instabox snapshots cannot cross accounts, so for a student-owned box the bootstrap script is the golden image. For operator-hosted sessions, where the operator owns every VM, `infra/seat/golden/` builds one snapshot that every session VM is created from: see [infra/seat/golden/README.md](../infra/seat/golden/README.md).

| File | What it is |
| --- | --- |
| `infra/seat/bootstrap.sh` | Idempotent setup script. The desktop app sends it over exec and starts it detached. |
| `infra/seat/docker-compose.seat.yml` | Copied to the box as `docker-compose.yml`: `ollama`, a one-off `build`, and `engine`. |
| `infra/seat/seat.env.template` | Rendered to the box as `seat.env`, the engine's environment (see the table above). |
| `infra/seat/session-start.sh` | Per-session start on a golden-image box: writes `session.env` and (re)starts the engine. |

**Modes.** `SEAT_MODEL_MODE=central` skips Ollama and the models (91 of the 98 s of a first bootstrap); the engine reaches the model through `MODEL_GATEWAY_URL`/`MODEL_GATEWAY_TOKEN` in `session.env`, which `session-start.sh` writes. `SEAT_MODE=golden` (always central) builds the image without any per-session value, starts nothing and ends with a scrub. The default, a local-model seat, is unchanged.

**What runs where.** Everything lives under `/data/home/sef-seat`, on the box's persistent disk:

| Path | Contents |
| --- | --- |
| `src/` | The app repo at the pinned ref (`git fetch --depth 1` of `SEAT_REF`) |
| `engine-data/` | The engine's data dir: profiles, vaults, sessions |
| `ollama/` | Pulled models |
| `cache/` | corepack and the pnpm store |
| `bootstrap.log`, `models.log` | Everything the script printed; paste it into a support request |
| `state`, `status` | `running` / `done` / `failed:<step>`, and one line per step start and finish with its duration |

The engine and Ollama are containers with `restart: unless-stopped`. Measured on a real box: plain processes die when a machine is stopped and started, while those containers come back with the Docker daemon, which is enabled at boot. An idle suspend keeps everything running. The engine uses host networking, so it binds `127.0.0.1:4100` and the edge's peer stays loopback. Ollama listens on `127.0.0.1:11434` only.

**Inputs.** `SEAT_REF` (git ref or commit), `SEAT_PUBLIC_HOST` (`4100-<id>.instabox.tech`) and `SEAT_UNI_URL` are required. `SEAT_CHAT_MODEL` (default `gemma4:e2b`) and `SEAT_EMBED_MODEL` (default `embeddinggemma`) are optional. Every value is checked against a narrow pattern before it reaches a file or a command line. The first run saves them to `bootstrap.inputs`. A bare re-run repeats the last configuration, and a re-run with one changed value reconfigures only that value.

**Steps.** `inputs`, `preflight` (tools, Docker, 12 GB free), `checkout`, `configure`, `ollama`, then `models` and `build` in parallel, then `engine` (recreated and waited on until `/api/health` answers). A lock allows one run at a time. A launch while a run is going leaves it alone. Each step converges, so after a failure, re-running the script resumes the work. The app's "Retry" does exactly that.

**Running it by hand** on a box (as `user`):

```bash
SEAT_REF=<commit> SEAT_PUBLIC_HOST=4100-<id>.instabox.tech SEAT_UNI_URL=https://uni.example.edu \
  setsid nohup bash bootstrap.sh >> /data/home/sef-seat/bootstrap.log 2>&1 < /dev/null &
cat /data/home/sef-seat/state; cat /data/home/sef-seat/status
```

`SEAT_DRY_RUN=1 SEAT_HOME=<tmp> SEAT_SRC_DIR=<checkout>` writes every file and runs no git, Docker or network command. The fixture in `apps/desktop/src/features/seat/bootstrap-script.test.ts` uses it.

**Models.** A box has 4 vCPU and 8 GiB with no GPU, which is PR-31's lowest tier: `gemma4:e2b` for the tutor, brain and vision roles, and `embeddinggemma`. The safety model (`shieldgemma:2b`) is not pulled, so peer-share screening reports it as unavailable, and it stays advisory either way.

**Upgrades.** v1 builds on the box from a pinned git ref, so upgrading means re-running the script with a new `SEAT_REF`. When the repo starts publishing an engine image to `ghcr.io`, the `build` service becomes a `docker compose pull` of a pinned tag, and `SEAT_REF` selects that tag.

**Known gaps on a seat.** The engine container has no Python, so YouTube ingest (which shells out to `yt-dlp`) is unavailable. Without a desktop keyring, the engine's credential store falls back to memory (see the threat notes).

