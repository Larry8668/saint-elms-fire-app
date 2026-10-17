# Shared by build-snapshot and smoke-session: a small Instabox client in bash, curl and jq.
#
# The key is read only from INSTABOX_API_KEY and reaches curl through a here-string header
# file (`-H @-`), so it never appears in argv, in a log or in the output. Resumable state
# (machine ids, Idempotency-Keys, the snapshot name) lives in $GOLDEN_STATE_DIR, so a run that
# dies is resumed by running the same command again.
set -Eeuo pipefail

: "${INSTABOX_API_KEY:?set INSTABOX_API_KEY in the environment}"
API=${INSTABOX_API:-https://api.instabox.sh}
STATE_DIR=${GOLDEN_STATE_DIR:-$HOME/.local/state/sef-golden}
SEAT_HOME=/data/home/sef-seat
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
for tool in curl jq uuidgen; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }; done

RESP=$(mktemp)
trap 'rm -f "$RESP"' EXIT
STATUS=000

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() {
  log "error: $*"
  exit 1
}
now() { date +%s; }

# state FILE KEY [VALUE]: read (prints "" when unset) or write one key of a key=value file.
state() {
  local file=$STATE_DIR/$1 key=$2
  if (($# == 3)); then
    { grep -v "^$key=" "$file" 2>/dev/null || true; printf '%s=%s\n' "$key" "$3"; } >"$file.tmp"
    mv -f "$file.tmp" "$file"
  else
    sed -n "s/^$key=//p" "$file" 2>/dev/null | tail -n 1
  fi
}

# api METHOD PATH [JSON] [IDEMPOTENCY-KEY]: body in $RESP, HTTP status in $STATUS (000 = no answer).
api() {
  local method=$1 path=$2 body=${3:-} key=${4:-} extra=()
  [[ -z $key ]] || extra+=(-H "Idempotency-Key: $key")
  [[ -z $body ]] || extra+=(-H 'Content-Type: application/json' --data-binary @"$RESP.body")
  [[ -z $body ]] || printf '%s' "$body" >"$RESP.body"
  STATUS=$(curl -sS -o "$RESP" -w '%{http_code}' --max-time 90 -X "$method" ${extra[@]+"${extra[@]}"} \
    -H @- "$API$path" <<<"X-API-Key: $INSTABOX_API_KEY" 2>/dev/null) || STATUS=000
  rm -f "$RESP.body"
}
err_code() { jq -r '.error.code? // .code? // "unknown"' "$RESP" 2>/dev/null || echo unknown; }
err_text() { jq -r '[.error.code?, .error.message?] | map(select(.)) | join(": ")' "$RESP" 2>/dev/null || head -c 300 "$RESP"; }

# wait_op ID: 0 on succeeded, 1 on failed (code in OP_ERROR).
wait_op() {
  local id=$1 deadline=$(($(now) + 600)) op_state
  OP_ERROR=""
  while (($(now) < deadline)); do
    api GET "/v1/operations/$id?wait=25s"
    op_state=$(jq -r '.state // empty' "$RESP" 2>/dev/null || true)
    case $op_state in
      succeeded) return 0 ;;
      failed)
        OP_ERROR=$(jq -r '.error.code // "unknown"' "$RESP")
        return 1
        ;;
    esac
    [[ $STATUS == 200 ]] || sleep 3
  done
  die "operation $id did not finish in 10 minutes"
}

# create_machine STATEFILE JSON: prints the new machine id. The Idempotency-Key is stored before
# the call and reused while the outcome is unknown. A create whose operation FAILED (no_capacity
# is common) is retried once with the same key; if Instabox replays the same failed operation,
# the key is rotated, since a replay can only ever return that refusal. Bounded attempts.
create_machine() {
  local file=$1 body=$2 attempt=0 key op mid failed_op="" wait=20
  while ((attempt < ${GOLDEN_CREATE_ATTEMPTS:-5})); do
    attempt=$((attempt + 1))
    key=$(state "$file" CREATE_KEY)
    [[ -n $key ]] || { key=$(uuidgen | tr 'A-Z' 'a-z'); state "$file" CREATE_KEY "$key"; }
    api POST /v1/machines "$body" "$key"
    case $STATUS in
      200 | 201 | 202)
        op=$(jq -r .id "$RESP")
        mid=$(jq -r .machineId "$RESP")
        if [[ $op == "$failed_op" ]]; then
          log "create replayed the failed operation $op; rotating the Idempotency-Key"
          state "$file" CREATE_KEY "$(uuidgen | tr 'A-Z' 'a-z')"
          continue
        fi
        log "create accepted: machine $mid, operation $op"
        if wait_op "$op"; then
          printf '%s\n' "$mid"
          return 0
        fi
        [[ $OP_ERROR == no_capacity ]] || die "create failed: $OP_ERROR"
        failed_op=$op
        log "create failed no_capacity (attempt $attempt); retrying in ${wait}s"
        ;;
      000 | 500 | 502 | 503 | 504) log "create: HTTP $STATUS $(err_text); retrying the same key in ${wait}s" ;;
      *) die "create refused: HTTP $STATUS $(err_text)" ;;
    esac
    sleep "$wait"
    wait=$((wait * 2))
  done
  die "no machine after $attempt attempts; run again later (the key is kept)"
}

# machine_op ID ACTION STATEFILE: start/stop/resume with a stored key, waiting for the operation.
machine_op() {
  local mid=$1 action=$2 file=$3 key name
  name=$(printf '%s_KEY' "$action" | tr 'a-z' 'A-Z')
  key=$(state "$file" "$name")
  [[ -n $key ]] || { key=$(uuidgen | tr 'A-Z' 'a-z'); state "$file" "$name" "$key"; }
  api POST "/v1/machines/$mid/$action" '{}' "$key"
  [[ $STATUS == 202 || $STATUS == 200 ]] || die "$action refused: HTTP $STATUS $(err_text)"
  wait_op "$(jq -r .id "$RESP")" || die "$action failed: $OP_ERROR"
  state "$file" "$name" ""
}

delete_machine() {
  local mid=$1 file=$2 key
  key=$(state "$file" DELETE_KEY)
  [[ -n $key ]] || { key=$(uuidgen | tr 'A-Z' 'a-z'); state "$file" DELETE_KEY "$key"; }
  api DELETE "/v1/machines/$mid" "" "$key"
  case $STATUS in
    404) log "machine $mid is already gone" ;;
    200 | 202) wait_op "$(jq -r .id "$RESP")" || die "delete failed: $OP_ERROR" ;;
    *) die "delete refused: HTTP $STATUS $(err_text)" ;;
  esac
}

machine_state() {
  api GET "/v1/machines/$1"
  [[ $STATUS == 200 ]] || die "machine $1: HTTP $STATUS $(err_text)"
  jq -r .state "$RESP"
}

# box_exec ID CMD [STDIN] [ENVS-JSON] [TIMEOUT]: prints stdout, returns the command's exit code.
# Exec is not idempotent, so callers only send commands that are safe to repeat.
box_exec() {
  local body envs=${4:-}
  [[ -n $envs ]] || envs='{}'
  body=$(jq -nc --arg cmd "$2" --arg stdin "${3:-}" --argjson envs "$envs" --argjson t "${5:-50}" \
    '{cmd: $cmd, envs: $envs, timeoutSeconds: $t} + (if $stdin == "" then {} else {stdin: $stdin} end)')
  api POST "/v1/machines/$1/exec" "$body"
  [[ $STATUS == 200 ]] || die "exec: HTTP $STATUS $(err_text)"
  jq -r .stdout "$RESP"
  jq -r '.stderr | select(length > 0)' "$RESP" >&2
  return "$(jq -r .exitCode "$RESP")"
}

# list_by_app APP: machine ids carrying metadata app=APP.
list_by_app() {
  api GET "/v1/machines?metadata=app:$1"
  [[ $STATUS == 200 ]] || die "list machines: HTTP $STATUS $(err_text)"
  jq -r '.machines[].id' "$RESP"
}

# wait_running ID STATEFILE: start or resume as needed, then wait for exec to answer.
wait_running() {
  local mid=$1 file=$2 s deadline=$(($(now) + 180))
  s=$(machine_state "$mid")
  case $s in
    stopped) machine_op "$mid" start "$file" ;;
    suspended) machine_op "$mid" resume "$file" ;;
  esac
  until box_exec "$mid" true >/dev/null 2>&1; do
    (($(now) < deadline)) || die "machine $mid is not answering exec"
    sleep 2
  done
}
