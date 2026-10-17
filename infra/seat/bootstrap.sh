#!/usr/bin/env bash
# Turns a fresh Instabox `universal` box into a hosted seat: engine + vault + Ollama, or (in
# golden mode) into the image that per-login session VMs are created from.
#
# The desktop app's "Claim your seat" flow sends this file over exec and starts it detached
# (exec is blocking, capped at 600 s, and not idempotent), then polls $SEAT_HOME/state and
# $SEAT_HOME/status with short execs. For operator-hosted sessions, golden/build-snapshot runs it
# in golden mode on a builder box and snapshots the result (golden/README.md).
#
# Inputs (environment; saved to $SEAT_HOME/bootstrap.inputs on first use, so a bare re-run
# repeats the last configuration and a re-run with new values reconfigures):
#   SEAT_REF          git ref or commit of the app repo to run (required)
#   SEAT_MODE         seat (default) or golden: build everything, start nothing, keep no per-session
#                     value, and scrub. session-start.sh then supplies those values per session.
#   SEAT_MODEL_MODE   local (default: Ollama and models on the box) or central: no Ollama, the
#                     model gateway URL and token come from session.env (session-start.sh).
#                     Golden mode is always central.
#   SEAT_PUBLIC_HOST  the published hostname, 4100-<id>.instabox.tech (required for a seat)
#   SEAT_UNI_URL      the university server's URL (required for a seat)
#   SEAT_CHAT_MODEL   default gemma4:e2b; SEAT_EMBED_MODEL default embeddinggemma
#   SEAT_HOME         default /data/home/sef-seat
#   SEAT_DRY_RUN=1    write every file but run no git, docker or network command (tests);
#                     SEAT_SRC_DIR then names a local checkout to read the templates from.
#
# `bootstrap.sh scrub` only runs the pre-snapshot scrub (see scrub below).
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
# Variables that belong to one session: never in a golden image's seat.env.
SESSION_KEYS_RE='^(ENGINE_PUBLIC_HOST|ENGINE_SEAT_OWNER|UNI_SERVER_URL|MODEL_GATEWAY_[A-Z_]+|OBJECT_STORE_[A-Z_]+|VAULT_SYNC_ACCOUNT|SYNC_FLUSH_TOKEN)='

load_inputs() {
  local saved_ref="" saved_host="" saved_uni="" saved_chat="" saved_embed="" saved_mode="" saved_model_mode=""
  if [[ -f $INPUTS ]]; then
    # Written by this script from validated values only; still parsed, never sourced.
    while IFS='=' read -r key value; do
      case $key in
        SEAT_REF) saved_ref=$value ;;
        SEAT_PUBLIC_HOST) saved_host=$value ;;
        SEAT_UNI_URL) saved_uni=$value ;;
        SEAT_CHAT_MODEL) saved_chat=$value ;;
        SEAT_EMBED_MODEL) saved_embed=$value ;;
        SEAT_MODE) saved_mode=$value ;;
        SEAT_MODEL_MODE) saved_model_mode=$value ;;
      esac
    done <"$INPUTS"
  fi
  SEAT_REF=${SEAT_REF:-$saved_ref}
  SEAT_PUBLIC_HOST=${SEAT_PUBLIC_HOST:-$saved_host}
  SEAT_UNI_URL=${SEAT_UNI_URL:-$saved_uni}
  SEAT_CHAT_MODEL=${SEAT_CHAT_MODEL:-${saved_chat:-gemma4:e2b}}
  SEAT_EMBED_MODEL=${SEAT_EMBED_MODEL:-${saved_embed:-embeddinggemma}}
  SEAT_UNI_URL=${SEAT_UNI_URL%/}
  SEAT_MODE=${SEAT_MODE:-${saved_mode:-seat}}
  SEAT_MODEL_MODE=${SEAT_MODEL_MODE:-${saved_model_mode:-$([[ $SEAT_MODE == golden ]] && echo central || echo local)}}

  [[ $SEAT_MODE == seat || $SEAT_MODE == golden ]] || die "SEAT_MODE must be seat or golden"
  [[ $SEAT_MODEL_MODE == local || $SEAT_MODEL_MODE == central ]] || die "SEAT_MODEL_MODE must be local or central"
  [[ $SEAT_REF =~ $REF_RE && $SEAT_REF != *..* ]] || die "SEAT_REF is missing or not a plain git ref"
  if [[ $SEAT_MODE == golden ]]; then
    # An image shared by every session must not carry one session's host, uni or models.
    [[ $SEAT_MODEL_MODE == central ]] || die "golden mode needs SEAT_MODEL_MODE=central: session VMs run no Ollama"
    [[ -z $SEAT_PUBLIC_HOST && -z $SEAT_UNI_URL ]] || die "golden mode takes no SEAT_PUBLIC_HOST or SEAT_UNI_URL; session-start.sh supplies them"
  else
    [[ $SEAT_PUBLIC_HOST =~ $HOST_RE ]] || die "SEAT_PUBLIC_HOST is missing or not a hostname"
    [[ $SEAT_UNI_URL =~ $URL_RE ]] || die "SEAT_UNI_URL is missing or not an http(s) URL"
  fi
  [[ $SEAT_CHAT_MODEL =~ $MODEL_RE ]] || die "SEAT_CHAT_MODEL is not a model name"
  [[ $SEAT_EMBED_MODEL =~ $MODEL_RE ]] || die "SEAT_EMBED_MODEL is not a model name"

  printf 'SEAT_REF=%s\nSEAT_PUBLIC_HOST=%s\nSEAT_UNI_URL=%s\nSEAT_CHAT_MODEL=%s\nSEAT_EMBED_MODEL=%s\nSEAT_MODE=%s\nSEAT_MODEL_MODE=%s\n' \
    "$SEAT_REF" "$SEAT_PUBLIC_HOST" "$SEAT_UNI_URL" "$SEAT_CHAT_MODEL" "$SEAT_EMBED_MODEL" "$SEAT_MODE" "$SEAT_MODEL_MODE" >"$INPUTS.tmp"
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
  mkdir -p "$SEAT_HOME/engine-data" "$SEAT_HOME/cache/home"
  [[ $SEAT_MODEL_MODE == central ]] || mkdir -p "$SEAT_HOME/ollama"
  cp "$SRC/infra/seat/docker-compose.seat.yml" "$SEAT_HOME/docker-compose.yml.tmp"
  mv -f "$SEAT_HOME/docker-compose.yml.tmp" "$SEAT_HOME/docker-compose.yml"
  cp "$SRC/infra/seat/session-start.sh" "$SEAT_HOME/session-start.sh.tmp"
  mv -f "$SEAT_HOME/session-start.sh.tmp" "$SEAT_HOME/session-start.sh"
  # Lines that do not apply are dropped: central has no Ollama (the gateway comes from
  # session.env), golden keeps no per-session value (session-start.sh writes them).
  local drop=()
  [[ $SEAT_MODEL_MODE == central ]] && drop+=(-e '/^OLLAMA_URL=/d')
  [[ $SEAT_MODE == golden ]] && drop+=(-E -e "/$SESSION_KEYS_RE/d")
  # Values passed the patterns above, so none of them contains `|`, `&` or a newline.
  sed ${drop[@]+"${drop[@]}"} -e "s|@@PUBLIC_HOST@@|$SEAT_PUBLIC_HOST|g" \
    -e "s|@@UNI_SERVER_URL@@|$SEAT_UNI_URL|g" \
    -e "s|@@CHAT_MODEL@@|$SEAT_CHAT_MODEL|g" \
    -e "s|@@EMBED_MODEL@@|$SEAT_EMBED_MODEL|g" \
    "$SRC/infra/seat/seat.env.template" >"$SEAT_HOME/seat.env.tmp"
  if grep -q '@@' "$SEAT_HOME/seat.env.tmp"; then die "seat.env.template has a placeholder this script does not fill"; fi
  mv -f "$SEAT_HOME/seat.env.tmp" "$SEAT_HOME/seat.env"
  log "wrote docker-compose.yml and seat.env (${SEAT_MODE} mode, ${SEAT_MODEL_MODE} model) ${SEAT_PUBLIC_HOST}"
}

wait_http() {
  local label=$1 url=$2 seconds=$3
  if [[ $DRY_RUN == 1 ]]; then
    log "dry-run: wait for $label at $url"
    return
  fi
  local deadline=$(($(now) + seconds))
  until curl -fsS -o /dev/null --max-time 5 "$url" 2>/dev/null; do
    (($(now) < deadline)) || die "$label did not answer at $url within ${seconds}s"
    sleep 2
  done
  log "$label is up"
}

compose() {
  local profile=()
  [[ ${SEAT_MODEL_MODE:-local} == central ]] || profile=(--profile local-model)
  run docker compose --project-directory "$SEAT_HOME" -f "$SEAT_HOME/docker-compose.yml" ${profile[@]+"${profile[@]}"} "$@"
}

start_ollama() {
  compose up -d --quiet-pull ollama
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
  compose up -d --quiet-pull --force-recreate engine
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

# The engine's image must be on the box, so a session start never waits on a registry.
verify_image() {
  local image
  # The build and the engine share the one node image (the x-node anchor), so the first
  # `image: node:` line is the engine's. build_app always writes `built`.
  image=$(sed -n 's/^  image: \(node:[^ ]*\)$/\1/p' "$SEAT_HOME/docker-compose.yml" | head -n 1)
  [[ -n $image ]] || die "no node image in docker-compose.yml"
  run docker image inspect --format '{{.Id}}' "$image"
  [[ $DRY_RUN == 1 || -f $SRC/apps/desktop/dist/index.html ]] || die "the UI build is missing"
  printf '{"ref":"%s","commit":"%s","image":"%s","builtAt":"%s"}\n' "$SEAT_REF" "$(cat "$SEAT_HOME/built")" "$image" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$SEAT_HOME/golden.json"
}

# Before a snapshot: every session's data goes, and the image is checked for anything secret.
# Leaves the code, the build, the compose and env files, the package caches and the logs.
scrub() {
  [[ $SEAT_MODE == golden ]] || die "scrub is for golden images only; this box is a $SEAT_MODE"
  compose rm --stop --force engine
  rm -rf "$SEAT_HOME/engine-data" "$SEAT_HOME/cache/home"
  mkdir -p "$SEAT_HOME/engine-data" "$SEAT_HOME/cache/home"
  rm -f "$SEAT_HOME/session.env" "$SEAT_HOME/session.state" "$SEAT_HOME/status.prev"
  rm -f "$HOME/.bash_history" "$HOME/.git-credentials" "$HOME/.npmrc" "$HOME/.docker/config.json"
  local found
  [[ -z $(ls -A "$SEAT_HOME/engine-data") ]] || die "engine-data is not empty"
  # configure already dropped these; a hit means a template or a hand edit put one back.
  ! grep -Eq "$SESSION_KEYS_RE" "$SEAT_HOME/seat.env" || die "seat.env holds a per-session value"
  # src/ is the public repo (with its own .env.example) plus ignored build output, so it is
  # checked for drift instead: nothing modified or untracked, and no .env file anywhere.
  found=$(grep -rIlE 'ibk_[A-Za-z0-9]|(TOKEN|SECRET_KEY|PASSWORD)=[^[:space:]]' "$SEAT_HOME" --exclude-dir=src --exclude-dir=cache 2>/dev/null || true)
  if [[ $DRY_RUN != 1 ]]; then
    [[ -z $(git -C "$SRC" status --porcelain) ]] || die "the checkout in src/ has local changes"
    found+=$(find "$SRC" -path "$SRC/node_modules" -prune -o -name '.env*' ! -name .env.example -print -quit)
  fi
  [[ -z $found ]] || die "secret-looking values in: $found"
  log "scrub ok: $(cd "$SEAT_HOME" && ls -A | tr '\n' ' ')"
}

main() {
  if [[ ${1:-} == scrub ]]; then
    load_inputs
    step scrub scrub
    return
  fi
  log "bootstrap starting (pid $$, dry run: $DRY_RUN)"
  set_state running
  # Pollers read this run's markers only; the previous run's stay in status.prev.
  if [[ -f $STATUS ]]; then mv -f "$STATUS" "$STATUS.prev"; fi
  mark "bootstrap start"
  step inputs load_inputs
  step preflight preflight
  step checkout checkout
  step configure configure
  if [[ $SEAT_MODEL_MODE == local ]]; then
    step ollama start_ollama
    models_and_build
  else
    step build build_app
  fi
  if [[ $SEAT_MODE == golden ]]; then
    step image verify_image
    step scrub scrub
    mark "bootstrap done"
    set_state "done"
    log "golden image ready: run scrub once more, stop the box and snapshot it"
    return
  fi
  step engine start_engine
  mark "bootstrap done"
  set_state "done"
  log "seat is ready at https://$SEAT_PUBLIC_HOST"
}

main "$@"
