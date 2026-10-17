#!/usr/bin/env bash
# Ends one session's sync: asks the engine on this box for its final vault flush and prints the
# engine's JSON answer, e.g. {"ok":true,"pushed":3,"version":42}. The orchestrator runs it with
# one exec before deleting the machine (PR-42); on a failure it logs loudly and retries once.
#
# The flush endpoint (POST /api/internal/sync/flush, PR-41b) answers loopback callers only,
# refuses anything carrying X-Forwarded-* / Forwarded, and needs Authorization: Bearer
# $SYNC_FLUSH_TOKEN. The token is read, never sourced, from the first of:
#   1. $SYNC_FLUSH_TOKEN in this script's environment (the exec's `envs`);
#   2. $SEAT_ENV_FILE, if set;
#   3. $SEAT_HOME/session.env, then $SEAT_HOME/seat.env (SEAT_HOME defaults to /data/home/sef-seat);
#   4. .env at the repository root (a compose-run engine on a dev machine).
# The token goes to curl on stdin, so it never shows up in a process listing.
#
# Inputs: ENGINE_PORT (default 4100), SESSION_STOP_TIMEOUT seconds (default 55, under the
# ~60 s exec ceiling; the engine itself gives up at 50 s).
# Exit status: 0 when the engine says ok, 1 otherwise. Self-contained: needs bash and curl.
set -Eeuo pipefail
umask 077

PORT=${ENGINE_PORT:-4100}
TIMEOUT=${SESSION_STOP_TIMEOUT:-55}
SEAT_HOME=${SEAT_HOME:-/data/home/sef-seat}
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
log() { printf '%s session-stop: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
fail() {
  log "error: $1"
  printf '{"ok":false,"error":"%s"}\n' "$2"
  exit 1
}

[[ $PORT =~ ^[0-9]{1,5}$ ]] || fail "ENGINE_PORT is not a port" "bad_port"
[[ $TIMEOUT =~ ^[0-9]{1,3}$ ]] || fail "SESSION_STOP_TIMEOUT is not a number of seconds" "bad_timeout"
command -v curl >/dev/null || fail "curl is not installed" "no_curl"

# The last SYNC_FLUSH_TOKEN= line of an env file, without quotes. Read as data, never executed.
token_from() {
  [[ -r $1 ]] || return 1
  local line value
  line=$(grep -E '^[[:space:]]*(export[[:space:]]+)?SYNC_FLUSH_TOKEN=' "$1" | tail -n 1) || return 1
  value=${line#*=}
  value=${value%$'\r'}
  value=${value#\"}; value=${value%\"}
  value=${value#\'}; value=${value%\'}
  [[ -n $value ]] || return 1
  printf '%s' "$value"
}

token=${SYNC_FLUSH_TOKEN:-}
source_name=environment
if [[ -z $token ]]; then
  for file in ${SEAT_ENV_FILE:+"$SEAT_ENV_FILE"} "$SEAT_HOME/session.env" "$SEAT_HOME/seat.env" "$REPO_ROOT/.env"; do
    if token=$(token_from "$file"); then
      source_name=$file
      break
    fi
    token=
  done
fi
[[ -n $token ]] || fail "SYNC_FLUSH_TOKEN not found in the environment or any env file" "no_token"
# Header-safe: the engine's tokens are base64url/hex; anything else would corrupt the request.
[[ $token =~ ^[A-Za-z0-9._~+/=-]+$ ]] || fail "SYNC_FLUSH_TOKEN has characters a header cannot carry" "bad_token"
log "flushing via 127.0.0.1:$PORT (token from $source_name)"

started=$(date +%s)
body_file=$(mktemp)
trap 'rm -f "$body_file"' EXIT
status=$(printf 'Authorization: Bearer %s\n' "$token" |
  curl -sS -o "$body_file" -w '%{http_code}' --max-time "$TIMEOUT" \
    -X POST -H @- -H 'content-type: application/json' --data '{}' \
    "http://127.0.0.1:$PORT/api/internal/sync/flush") || status=000
body=$(cat "$body_file")
log "HTTP $status after $(($(date +%s) - started))s"
if [[ $status == 000 || -z $body ]]; then
  fail "the engine did not answer on 127.0.0.1:$PORT" "unreachable"
fi
printf '%s\n' "$body"
[[ $status == 200 && $body == *'"ok":true'* ]]
