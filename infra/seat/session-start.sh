#!/usr/bin/env bash
# Starts one session on a box made from the golden snapshot (bootstrap.sh SEAT_MODE=golden):
# writes the per-session half of the engine env to $SEAT_HOME/session.env, (re)creates the
# engine container and waits until /api/health answers on loopback. The orchestrator runs it
# with one exec (passing the values in the exec's `envs`); it finishes well inside the ~60 s
# exec ceiling because the image, the dependencies and the UI build are already on the box.
#
# Inputs (environment):
#   ENGINE_PUBLIC_HOST   the published hostname, 4100-<id>.instabox.tech (required)
#   ENGINE_SEAT_OWNER    the student's uni account id (required: a session VM is never unpinned)
#   UNI_SERVER_URL       the university server's URL (required)
#   MODEL_GATEWAY_URL    the central model gateway (required when the image has no local model)
#   MODEL_GATEWAY_TOKEN  the session's gateway token (optional)
#   OBJECT_STORE_*       vault sync store (PR-41): ENDPOINT, BUCKET, ACCESS_KEY, SECRET_KEY,
#                        REGION, FORCE_PATH_STYLE; all optional, passed through when set
#   SESSION_WAIT_SECONDS how long to wait for health (default 45)
#   SEAT_HOME, SEAT_DRY_RUN as in bootstrap.sh
#
# Re-runnable: a second run rewrites session.env and recreates the engine. Prints only names,
# never values, so the exec result is safe to log.
set -Eeuo pipefail
umask 077

SEAT_HOME=${SEAT_HOME:-/data/home/sef-seat}
DRY_RUN=${SEAT_DRY_RUN:-0}
WAIT=${SESSION_WAIT_SECONDS:-45}
cd "$SEAT_HOME"
log() { printf '%s session-start: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() {
  log "error: $*"
  printf 'failed %s\n' "$*" >"$SEAT_HOME/session.state"
  exit 1
}

[[ -f seat.env && -f docker-compose.yml ]] || die "not a prepared image: run bootstrap.sh first"

HOST_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
URL_RE='^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'
ID_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(,[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,7}$'
TOKEN_RE='^[A-Za-z0-9._~+/=-]+$'

# name, pattern, required. Values go to an env file compose reads, so the patterns also keep
# out quotes, `$`, spaces and newlines.
check() {
  local name=$1 pattern=$2 required=$3 value=${!1:-}
  if [[ -z $value ]]; then
    [[ $required == 0 ]] || die "$name is missing"
    return 0
  fi
  [[ $value =~ $pattern && ${#value} -le 4096 ]] || die "$name is not valid"
  printf '%s=%s\n' "$name" "$value" >>"$SEAT_HOME/session.env.tmp"
}

central=0
grep -q '^OLLAMA_URL=' seat.env || central=1
UNI_SERVER_URL=${UNI_SERVER_URL:-}
UNI_SERVER_URL=${UNI_SERVER_URL%/}
rm -f "$SEAT_HOME/session.env.tmp"
check ENGINE_PUBLIC_HOST "$HOST_RE" 1
check ENGINE_SEAT_OWNER "$ID_RE" 1
check UNI_SERVER_URL "$URL_RE" 1
check MODEL_GATEWAY_URL "$URL_RE" "$central"
check MODEL_GATEWAY_TOKEN "$TOKEN_RE" 0
check OBJECT_STORE_ENDPOINT "$URL_RE" 0
check OBJECT_STORE_BUCKET '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' 0
check OBJECT_STORE_ACCESS_KEY "$TOKEN_RE" 0
check OBJECT_STORE_SECRET_KEY "$TOKEN_RE" 0
check OBJECT_STORE_REGION '^[a-z0-9-]{1,40}$' 0
check OBJECT_STORE_FORCE_PATH_STYLE '^(true|false)$' 0
mv -f "$SEAT_HOME/session.env.tmp" "$SEAT_HOME/session.env"
log "wrote session.env: $(cut -d= -f1 session.env | tr '\n' ' ')"

if [[ $DRY_RUN == 1 ]]; then
  log "dry-run: docker compose up -d --pull never --force-recreate engine"
else
  # --pull never: the image is part of the snapshot; a missing one is a broken image, not a
  # reason to wait on a registry.
  docker compose --project-directory "$SEAT_HOME" -f docker-compose.yml up -d --pull never --force-recreate engine
  started=$(date +%s)
  until curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:4100/api/health 2>/dev/null; do
    (($(date +%s) - started < WAIT)) || die "engine did not answer /api/health within ${WAIT}s"
    sleep 1
  done
  log "engine healthy after $(($(date +%s) - started))s"
fi
printf 'ready %s\n' "$(date -u +%s)" >"$SEAT_HOME/session.state"
