#!/usr/bin/env bash
# Preflight for a demo machine: tools, models and services. Exits non-zero if anything required is missing.
set -uo pipefail

OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
UNI_URL="${UNI_SERVER_URL:-http://localhost:4200}"
ENGINE_URL="${VITE_ENGINE_URL:-http://127.0.0.1:4100}"
SEARXNG_URL="${SEARXNG_URL:-http://localhost:8888}"
MODELS=("${TUTOR_MODEL:-gemma4:e4b}" "embeddinggemma")

failed=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; failed=1; }

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

need_cmd() {
  if command -v "$1" >/dev/null 2>&1; then ok "$1 $($1 --version 2>/dev/null | head -1)"; else "$2" "$1 not found${3:+ — $3}"; fi
}

probe() {
  if curl -fsS --max-time 3 "$2" >/dev/null 2>&1; then ok "$1 ($2)"; else "$3" "$1 not reachable at $2${4:+ — $4}"; fi
}

section "Tools"
need_cmd node bad "install Node 22+"
need_cmd pnpm bad "corepack enable"
need_cmd ollama bad "https://ollama.com/download"
need_cmd docker warn "only needed for docker compose"
need_cmd cargo warn "only needed for the Tauri desktop build"
need_cmd "${FFMPEG_PATH:-ffmpeg}" warn "only needed for audio and video source ingestion"
# yt-dlp resolves env → PATH → the vendored youtube-dl-exec package at runtime.
if command -v "${YTDLP_PATH:-yt-dlp}" >/dev/null 2>&1 || [ -x engine/node_modules/youtube-dl-exec/bin/yt-dlp ]; then
  ok "yt-dlp"
else
  warn "yt-dlp not found — only needed for YouTube video ingestion (brew install yt-dlp)"
fi

section "Models"
if tags=$(curl -fsS --max-time 3 "$OLLAMA_URL/api/tags" 2>/dev/null); then
  for m in "${MODELS[@]}"; do
    if grep -q "\"$m" <<<"$tags"; then ok "$m"; else bad "$m missing — run: ollama pull $m"; fi
  done
else
  bad "Ollama not reachable at $OLLAMA_URL — run: ollama serve"
fi

section "Services"
# /ready, not /health: liveness answers while the database is dead; readiness fails then.
probe "University server" "$UNI_URL/ready" bad "pnpm dev:uni or docker compose up -d uni"
probe "Local engine" "$ENGINE_URL/api/health" bad "pnpm dev:engine"
probe "Web search (SearXNG)" "$SEARXNG_URL/healthz" warn "run: pnpm search:up (the Philosopher falls back to course-only)"

echo
if [ "$failed" -eq 0 ]; then printf '\033[32mReady for the demo.\033[0m\n'; else printf '\033[31mFix the items above.\033[0m\n'; fi
exit "$failed"
