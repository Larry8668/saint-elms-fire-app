#!/usr/bin/env bash
# Turns a fresh Instabox `universal` box into a hosted seat: engine + vault + Ollama.
#
# The desktop app's "Claim your seat" flow sends this file over exec and starts it detached
# (exec is blocking, capped at 600 s, and not idempotent), then polls $SEAT_HOME/state and
# $SEAT_HOME/status with short execs. Snapshots cannot cross accounts, so this script is the
# golden image.
#
# Inputs (environment; saved to $SEAT_HOME/bootstrap.inputs on first use, so a bare re-run
# repeats the last configuration and a re-run with new values reconfigures):
#   SEAT_REF          git ref or commit of the app repo to run (required)
#   SEAT_PUBLIC_HOST  the published hostname, 4100-<id>.instabox.tech (required)
#   SEAT_UNI_URL      the university server's URL (required)
#   SEAT_CHAT_MODEL   default gemma4:e2b; SEAT_EMBED_MODEL default embeddinggemma
#   SEAT_HOME         default /data/home/sef-seat
#   SEAT_DRY_RUN=1    write every file but run no git, docker or network command (tests);
#                     SEAT_SRC_DIR then names a local checkout to read the templates from.
#
# Re-runnable: every step converges (fetch instead of clone, `compose up -d`, pulls that are
# no-ops when present, a build skipped when the checkout has not changed). One run at a time.
#
# Upgrade path: v1 builds on the box from a pinned git ref. Once the repo publishes an engine
# image to ghcr.io, the build step becomes `docker compose pull` with the image pinned in
# docker-compose.seat.yml, and SEAT_REF selects the tag instead of a commit.
set -Eeuo pipefail
umask 027

REPO_URL=https://github.com/Larry8668/saint-elms-fire-app
SEAT_HOME=${SEAT_HOME:-/data/home/sef-seat}
DRY_RUN=${SEAT_DRY_RUN:-0}

mkdir -p "$SEAT_HOME"
cd "$SEAT_HOME"

# One run at a time. A second launch while one is running exits cleanly instead of racing it.
exec 9>"$SEAT_HOME/lock"
# A dry run on a workstation without util-linux (macOS) has nothing to race.
if command -v flock >/dev/null || [[ $DRY_RUN != 1 ]]; then
  if ! flock -n 9; then
    echo "bootstrap: another run holds $SEAT_HOME/lock; leaving it alone"
    exit 0
  fi
fi

STATUS="$SEAT_HOME/status"
STATE="$SEAT_HOME/state"
INPUTS="$SEAT_HOME/bootstrap.inputs"
SRC="$SEAT_HOME/src"

now() { date -u +%s; }
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
mark() { printf '%s %s\n' "$(now)" "$*" >>"$STATUS"; }
set_state() { printf '%s\n' "$1" >"$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"; }
die() {
  log "error: $*"
  exit 1
}

# In a dry run, commands with side effects outside $SEAT_HOME are logged, not run.
run() {
  if [[ $DRY_RUN == 1 ]]; then
    log "dry-run: $*"
  else
    "$@"
  fi
}

CURRENT_STEP=""
# `die` and `set -e` both end in exit, so the failure is recorded on the way out.
on_exit() {
  local code=$1
  ((code != 0)) || return 0
  local failed=${CURRENT_STEP:-bootstrap}
  mark "$failed fail exit=$code"
  set_state "failed:$failed"
  log "step $failed failed (exit $code). Fix the cause, then run bootstrap again: finished steps converge or are skipped."
}
trap 'on_exit $?' EXIT

step() {
  CURRENT_STEP=$1
  shift
  log "== $CURRENT_STEP =="
  mark "$CURRENT_STEP start"
  local started
  started=$(now)
  "$@"
  mark "$CURRENT_STEP done seconds=$(($(now) - started))"
  CURRENT_STEP=""
}

# ---------------------------------------------------------------------------------------
# Inputs: validated against narrow patterns before they reach a file or a command line.
# ---------------------------------------------------------------------------------------
REF_RE='^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$'
HOST_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
URL_RE='^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'
MODEL_RE='^[a-z0-9][a-z0-9._:/-]{0,99}$'

load_inputs() {
  local saved_ref="" saved_host="" saved_uni="" saved_chat="" saved_embed=""
  if [[ -f $INPUTS ]]; then
    # Written by this script from validated values only; still parsed, never sourced.
    while IFS='=' read -r key value; do
      case $key in
        SEAT_REF) saved_ref=$value ;;
        SEAT_PUBLIC_HOST) saved_host=$value ;;
        SEAT_UNI_URL) saved_uni=$value ;;
        SEAT_CHAT_MODEL) saved_chat=$value ;;
        SEAT_EMBED_MODEL) saved_embed=$value ;;
      esac
    done <"$INPUTS"
  fi
  SEAT_REF=${SEAT_REF:-$saved_ref}
  SEAT_PUBLIC_HOST=${SEAT_PUBLIC_HOST:-$saved_host}
  SEAT_UNI_URL=${SEAT_UNI_URL:-$saved_uni}
  SEAT_CHAT_MODEL=${SEAT_CHAT_MODEL:-${saved_chat:-gemma4:e2b}}
  SEAT_EMBED_MODEL=${SEAT_EMBED_MODEL:-${saved_embed:-embeddinggemma}}
  SEAT_UNI_URL=${SEAT_UNI_URL%/}

  [[ $SEAT_REF =~ $REF_RE && $SEAT_REF != *..* ]] || die "SEAT_REF is missing or not a plain git ref"
  [[ $SEAT_PUBLIC_HOST =~ $HOST_RE ]] || die "SEAT_PUBLIC_HOST is missing or not a hostname"
  [[ $SEAT_UNI_URL =~ $URL_RE ]] || die "SEAT_UNI_URL is missing or not an http(s) URL"
  [[ $SEAT_CHAT_MODEL =~ $MODEL_RE ]] || die "SEAT_CHAT_MODEL is not a model name"
  [[ $SEAT_EMBED_MODEL =~ $MODEL_RE ]] || die "SEAT_EMBED_MODEL is not a model name"

  printf 'SEAT_REF=%s\nSEAT_PUBLIC_HOST=%s\nSEAT_UNI_URL=%s\nSEAT_CHAT_MODEL=%s\nSEAT_EMBED_MODEL=%s\n' \
    "$SEAT_REF" "$SEAT_PUBLIC_HOST" "$SEAT_UNI_URL" "$SEAT_CHAT_MODEL" "$SEAT_EMBED_MODEL" >"$INPUTS.tmp"
  mv -f "$INPUTS.tmp" "$INPUTS"
}

# ---------------------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------------------
preflight() {
  if [[ $DRY_RUN == 1 ]]; then
    log "dry-run: skipping tool and disk checks"
    return
  fi
  local tool
  for tool in git docker curl flock; do
    command -v "$tool" >/dev/null || die "$tool is not installed"
  done
  docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable as $(id -un)"
  docker compose version >/dev/null || die "docker compose is not available"
  local free_gb
  free_gb=$(df -BG --output=avail "$SEAT_HOME" | tail -n 1 | tr -dc '0-9')
  ((free_gb >= 12)) || die "only ${free_gb} GB free under $SEAT_HOME; the models and build need about 12 GB"
  log "docker $(docker version --format '{{.Server.Version}}'), ${free_gb} GB free"
}

checkout() {
  if [[ $DRY_RUN == 1 ]]; then
    [[ -n ${SEAT_SRC_DIR:-} && -f $SEAT_SRC_DIR/infra/seat/docker-compose.seat.yml ]] || die "a dry run needs SEAT_SRC_DIR pointing at a checkout"
    log "dry-run: git fetch --depth 1 $REPO_URL $SEAT_REF into $SRC"
    SRC=$SEAT_SRC_DIR
    return
  fi
  if [[ ! -d $SRC/.git ]]; then
    rm -rf "$SRC"
    git init -q "$SRC"
    git -C "$SRC" remote add origin "$REPO_URL"
  fi
  git -C "$SRC" fetch -q --depth 1 origin "$SEAT_REF"
  git -C "$SRC" checkout -q --force FETCH_HEAD
  git -C "$SRC" clean -q -fdx -e node_modules -e apps/desktop/dist
  log "checked out $(git -C "$SRC" rev-parse HEAD) ($SEAT_REF)"
}

configure() {
  mkdir -p "$SEAT_HOME/engine-data" "$SEAT_HOME/ollama" "$SEAT_HOME/cache/home"
  cp "$SRC/infra/seat/docker-compose.seat.yml" "$SEAT_HOME/docker-compose.yml.tmp"
  mv -f "$SEAT_HOME/docker-compose.yml.tmp" "$SEAT_HOME/docker-compose.yml"
  # Values passed the patterns above, so none of them contains `|`, `&` or a newline.
  sed -e "s|@@PUBLIC_HOST@@|$SEAT_PUBLIC_HOST|g" \
    -e "s|@@UNI_SERVER_URL@@|$SEAT_UNI_URL|g" \
    -e "s|@@CHAT_MODEL@@|$SEAT_CHAT_MODEL|g" \
    -e "s|@@EMBED_MODEL@@|$SEAT_EMBED_MODEL|g" \
    "$SRC/infra/seat/seat.env.template" >"$SEAT_HOME/seat.env.tmp"
  if grep -q '@@' "$SEAT_HOME/seat.env.tmp"; then die "seat.env.template has a placeholder this script does not fill"; fi
  mv -f "$SEAT_HOME/seat.env.tmp" "$SEAT_HOME/seat.env"
  log "wrote docker-compose.yml and seat.env for $SEAT_PUBLIC_HOST"
}

wait_http() {
  local label=$1 url=$2 seconds=$3
  if [[ $DRY_RUN == 1 ]]; then
    log "dry-run: wait for $label at $url"
    return
  fi
  local deadline=$(($(now) + seconds))
  until curl -fsS -o /dev/null --max-time 5 "$url"; do
    (($(now) < deadline)) || die "$label did not answer at $url within ${seconds}s"
    sleep 2
  done
  log "$label is up"
}

compose() { run docker compose --project-directory "$SEAT_HOME" -f "$SEAT_HOME/docker-compose.yml" "$@"; }

start_ollama() {
  compose up -d ollama
  wait_http ollama http://127.0.0.1:11434/api/version 180
}

pull_models() {
  local model
  for model in "$SEAT_CHAT_MODEL" "$SEAT_EMBED_MODEL"; do
    log "pulling $model (progress in models.log)"
    compose exec -T ollama ollama pull "$model" >>"$SEAT_HOME/models.log" 2>&1
  done
  compose exec -T ollama ollama list
}

build_app() {
  local head
  head=$(if [[ $DRY_RUN == 1 ]]; then echo dry-run; else git -C "$SRC" rev-parse HEAD; fi)
  if [[ -f $SEAT_HOME/built && $(cat "$SEAT_HOME/built") == "$head" && -f $SRC/apps/desktop/dist/index.html ]]; then
    log "build for $head is current"
    return
  fi
  compose --profile build run --rm build
  printf '%s\n' "$head" >"$SEAT_HOME/built"
}

start_engine() {
  # Recreate on every run: the env file or the checked-out code may have changed.
  compose up -d --force-recreate engine
  wait_http engine http://127.0.0.1:4100/api/health 240
}

# Models download while the app builds; both are mostly waiting on the network.
models_and_build() {
  local models_pid models_ok=0
  (
    trap - EXIT
    step models pull_models
  ) &
  models_pid=$!
  step build build_app
  wait "$models_pid" || models_ok=$?
  ((models_ok == 0)) || {
    CURRENT_STEP=models
    die "pulling models failed; see models.log"
  }
}

main() {
  log "bootstrap starting (pid $$, dry run: $DRY_RUN)"
  set_state running
  # Pollers read this run's markers only; the previous run's stay in status.prev.
  if [[ -f $STATUS ]]; then mv -f "$STATUS" "$STATUS.prev"; fi
  mark "bootstrap start"
  step inputs load_inputs
  step preflight preflight
  step checkout checkout
  step configure configure
  step ollama start_ollama
  models_and_build
  step engine start_engine
  mark "bootstrap done"
  set_state "done"
  log "seat is ready at https://$SEAT_PUBLIC_HOST"
}

main "$@"
