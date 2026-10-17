# Model gateway

The model gateway (`server/gateway`, PR-43) is one authenticated proxy that every
operator-hosted engine uses for inference. Per-login VMs (PR-42) have no GPU, and a
CPU-only VM generates about 6 tok/s (`docs/internal/CLOUD_SEAT_NOTES.md`). So the VMs
run no model at all: they call the gateway, and the gateway spreads requests over a pool
of GPU workers running Ollama or vLLM. Ollama has no authentication, so it is never
exposed directly. The gateway is its only front door.

Laptop installs are unaffected: a local engine keeps talking to its local Ollama.

```
 student VM (engine)  ──┐  Bearer <per-VM token>
 student VM (engine)  ──┼──▶  gateway :4300 ──▶ least-in-flight ──▶ GPU worker 1 (Ollama)
 student VM (engine)  ──┘   auth · allowlist ·                  ──▶ GPU worker 2 (Ollama)
                            limits · metering                   ──▶ GPU worker N (vLLM, /v1 only)
```

## Protocol: the Ollama native API, passed through

The engine already speaks the Ollama native API for every role: chat and vision through
`ollama-ai-provider-v2` (`/api/chat`), structured brain output (`/api/chat` with a
`format` grammar), embeddings (`/api/embed`), the shieldgemma safety screen
(`/api/chat`) and health (`/api/tags`). It also sends Ollama-only options such as
`num_ctx`, which the OpenAI-compatible `/v1` surface ignores. Without `num_ctx`, Ollama
falls back to a 4K context and silently truncates brain prompts. So the gateway passes
the native API through unchanged, and an engine is pointed at it purely through config:

```sh
OLLAMA_URL=https://gateway.example.edu     # or http://127.0.0.1:4300 locally
OLLAMA_API_KEY=<gateway token>             # PR-43b: sent as Authorization: Bearer
```

`OLLAMA_API_KEY` is read from the environment only, so it is never written to
`settings.json`. It is sent only when a provider's base URL is exactly `OLLAMA_URL`, so a
student-configured Ollama somewhere else never receives it. The OpenAI-compatible routes
are also served, for `openai-compatible` providers and vLLM workers: the provider's
`baseUrl` is `<gateway>/v1` and its API key is the token.

### Allowed endpoints

| Ollama native (Ollama workers only) | OpenAI-compatible (any worker) |
|---|---|
| `POST /api/chat`, `/api/generate` | `POST /v1/chat/completions`, `/v1/completions` |
| `POST /api/embed`, `/api/embeddings` | `POST /v1/embeddings` |
| `POST /api/show`, `GET /api/version` | `GET /v1/models` (filtered) |
| `GET /api/tags` (filtered to the allowlist) | |

Everything else answers 404, including pull, push, create, copy, delete, ps and blobs.
POST bodies must name a model from `GATEWAY_MODELS` (`name` also matches `name:latest`).
Any other model answers 403. The caller's token is never forwarded to a worker; a worker
that needs its own key gets `GATEWAY_UPSTREAM_TOKEN`.

## Running it

```sh
# local dev, in front of the Ollama on this machine
GATEWAY_DEV_TOKENS=<16+ char token>:dev-student pnpm dev:gateway        # :4300
curl -H "authorization: Bearer <token>" http://127.0.0.1:4300/api/tags

# compose (opt-in profile; the engine service still talks to Ollama directly by default)
docker compose --profile gateway up -d gateway
docker compose --profile gateway --profile ollama up -d   # with GATEWAY_UPSTREAMS=http://ollama:11434
```

To send the compose engine through the gateway, set `OLLAMA_URL=http://gateway:4300` and
`OLLAMA_API_KEY=<token>` in `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_PORT` / `GATEWAY_HOST` | `4300` / `127.0.0.1` | Listen address (compose: `0.0.0.0`, published on loopback). |
| `GATEWAY_UPSTREAMS` | `http://127.0.0.1:11434` | Comma list of workers. A `vllm:` prefix marks an OpenAI-only worker; `#max=N` sets its concurrency. |
| `GATEWAY_UPSTREAM_MAX_INFLIGHT` | `4` | Default concurrent requests per worker. |
| `GATEWAY_UPSTREAM_TOKEN` | unset | A bearer sent to workers (e.g. vLLM `--api-key`). |
| `GATEWAY_TOKEN_SECRET` | unset | The HMAC secret for signed tokens, at least 32 characters. |
| `GATEWAY_DEV_TOKENS` | unset | `token[:subject]` list for local dev. Never set it in production. |
| `GATEWAY_METRICS_TOKEN` | unset | The bearer for `/metrics`. When unset, `/metrics` always answers 401. |
| `GATEWAY_MODELS` | `gemma4:e4b,gemma4:e2b,embeddinggemma,shieldgemma:2b` | The model allowlist. |
| `GATEWAY_RATE_PER_MINUTE` | `60` | Requests per subject per minute. |
| `GATEWAY_MAX_CONCURRENT_PER_SUBJECT` | `4` | Requests or streams in flight per subject. |
| `GATEWAY_DAILY_TOKEN_BUDGET` | `300000` | Tokens per subject per UTC day. |
| `GATEWAY_QUEUE_TIMEOUT_MS` | `30000` | How long a request waits for a free worker slot before 503. |
| `GATEWAY_HEALTH_INTERVAL_MS` | `10000` | The health-probe period. |
| `GATEWAY_FAILURE_THRESHOLD` / `GATEWAY_COOLDOWN_MS` | `3` / `15000` | Circuit breaker settings. |
| `GATEWAY_MAX_BODY_BYTES` | 32 MiB | The request cap; vision turns carry base64 images. |

Boot fails if neither `GATEWAY_TOKEN_SECRET` nor `GATEWAY_DEV_TOKENS` is set: the gateway
never runs open.

## Tokens (for the PR-42 orchestrator)

The format and helpers live in `packages/shared/src/node/gateway-token.ts`
(`@sef/shared/node`), so the minter and the verifier share one implementation:

```
token  = "sefgw1." + base64url(claimsJson) + "." + base64url(mac)      (unpadded base64url)
claims = {"sub": accountId, "vm"?: machineId, "exp": unixSeconds}
mac    = HMAC-SHA256(key = GATEWAY_TOKEN_SECRET, data = "sefgw1." + base64url(claimsJson))
```

The orchestrator mints one token per session VM with
`mintGatewayToken(secret, { sub, vm, ttlSeconds })` and hands it to the VM's engine (see
"Pointing an engine at the gateway"). The gateway checks it with `verifyGatewayToken`. A
known-answer test vector in `gateway-token.test.ts` pins the exact bytes.

- Lifetime: match the lease, e.g. the maximum session length. The ceiling is 7 days, and
  a token claiming a later `exp` is refused even when correctly signed.
- Verification is timing-safe. Expired, malformed, tampered and wrong-secret tokens all
  get 401.
- Revocation in v1 is by expiry, plus deleting the VM. Rotating `GATEWAY_TOKEN_SECRET`
  revokes every token at once. A short TTL with refresh, or a deny list, is a follow-up.
- Locally: `GATEWAY_TOKEN_SECRET=… pnpm --filter @sef/gateway token -- --sub ananya --vm m_x --ttl 3600`.

## Scaling: add GPU workers, list them, done

Each worker is any host running Ollama (or vLLM) that the gateway can reach, such as a
RunPod or other GPU-cloud pod, a university GPU box, or a second container. For exam
week, start more workers, pull the allowlisted models on each, and add them to
`GATEWAY_UPSTREAMS`:

```sh
GATEWAY_UPSTREAMS=https://gpu-1.internal:11434#max=8,https://gpu-2.internal:11434#max=8,vllm:https://gpu-3.internal:8000#max=32
```

then restart the gateway, which takes about a second and is stateless apart from the
limit counters.

- **Selection:** least in-flight among the workers whose circuit admits traffic and that
  are under their `max`. Ties rotate between workers.
- **Queueing:** when every worker is full, a request waits up to
  `GATEWAY_QUEUE_TIMEOUT_MS` for a slot, then gets 503 with `Retry-After`.
- **Failover:** a connection error or 5xx before the response starts is retried on
  another worker. This is safe because the request body is held.
- **Circuit breaker:** after `GATEWAY_FAILURE_THRESHOLD` consecutive failures, or one
  failed health probe (`/api/version` for Ollama, `/health` for vLLM), the worker is
  skipped for `GATEWAY_COOLDOWN_MS`. Then it admits one trial request (half-open). A
  success closes the circuit; a failure re-opens it.
- **vLLM workers** serve only `/v1/*`, so the native routes go only to Ollama workers. A
  vLLM worker's model names must match the allowlist; mapping model names (e.g.
  `gemma4:e4b` to an HF id) is a follow-up.
- **Sizing:** one Ollama worker serves `OLLAMA_NUM_PARALLEL` concurrent sequences, so set
  `#max` to match. Each student turn holds one slot for its whole stream.

## Limits

Limits are applied per subject (the token's `sub`, i.e. per student, across their VMs):

- **Rate:** a fixed one-minute window. Over it: 429 with `Retry-After` set to the seconds
  left in the window.
- **Concurrency:** the number of requests or streams in flight. Over it: 429 with
  `Retry-After: 1`. A stream holds its slot until it ends or the client goes away.
- **Daily token budget:** counted from the response's usage fields (Ollama
  `prompt_eval_count + eval_count`; OpenAI `usage.total_tokens`). When none are present,
  it is estimated as one token per streamed event plus a quarter of the request bytes.
  Over it: 429 with `Retry-After` set to the seconds until UTC midnight. An admitted
  request always finishes, so a subject can overshoot by at most one response.

Errors use each client family's shape: `{error: "…", code}` on `/api/*`, and
`{error: {message, type, code}}` on `/v1/*`.

The counters live in memory, which is right for one gateway replica. To run several
replicas behind a load balancer, move the counters to Redis (`INCR` with `EXPIRE` for the
window and the day; `INCR`/`DECR` for concurrency, with a TTL so a crashed replica
cannot leak slots), or to the uni's Postgres `auth_kv` table, which already has an atomic
`increment` (`server/uni/src/rate-limit.ts`). Per-worker in-flight counts can stay local
to each replica.

## Streaming

Responses are streamed through chunk by chunk with backpressure: NDJSON from Ollama, SSE
from `/v1`. There is no buffering, and `cache-control: no-cache` and
`x-accel-buffering: no` are set so an nginx in front does not buffer either. When the
client disconnects, the upstream request is aborted, so the GPU stops generating.

Measured on a laptop (Apple Silicon, `gemma4:e4b`, warm, 131 output tokens, 3 runs each,
through the engine's own provider code):

| Path | Generation | Time to first token |
|---|---|---|
| direct to Ollama | 42.4–45.7 tok/s | 91–105 ms |
| through the gateway | 43.9–45.8 tok/s | 81–82 ms |

The gateway's overhead is within run-to-run noise.

## Privacy

The gateway logs one JSON line per request: subject, VM id, path, model, status,
latency, worker id, attempts and the token count (with whether it was estimated). It
never logs prompt or response bodies, headers or tokens, and the usage meter reads only
numeric usage fields. `/metrics` (authenticated with `GATEWAY_METRICS_TOKEN`, and never
with a student token) returns per-worker in-flight, served and failed counts, plus
per-subject requests, rejections and tokens. It contains no content.

This is an operator-hosted model. Prompts, including vault excerpts the teachers ground
on, are processed by the operator's GPU workers in plaintext. Product copy must say so
(see the MEGAPLAN's ephemeral-session product promise). Workers should be on a private
network or TLS, and should never be published without the gateway in front.

## Follow-ups

- Audio transcription (`/v1/audio/transcriptions`, multipart) is not routed yet.
- A shared limit store (Redis or Postgres) for multiple gateway replicas.
- Hot-reloading `GATEWAY_UPSTREAMS` (or registering workers through an admin API), so
  adding a worker needs no restart.
- Per-token scopes (e.g. embed-only) and a revocation list.
- Model-name mapping for vLLM workers.
