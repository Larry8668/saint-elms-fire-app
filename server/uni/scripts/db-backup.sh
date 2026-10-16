#!/usr/bin/env bash
# Backs up the university database (accounts, enrolments, shares — everything PostgreSQL
# holds) to one custom-format pg_dump file. Keep KEYS_DIR safe with it: a lost signing key
# orphans every pinned engine.
#
#   UNI_DATABASE_URL=postgres://… pnpm --filter @sef/uni-server db:backup -- path/to/file.dump
#
# With no file argument the dump lands beside the repo as a UTC-timestamped .dump file.
set -euo pipefail

if [ -z "${UNI_DATABASE_URL:-}" ]; then
  echo "UNI_DATABASE_URL is not set — point it at the database to back up." >&2
  exit 1
fi

OUT="${1:-sef-uni-backup-$(date -u +%Y%m%dT%H%M%SZ).dump}"
# Custom format, owner/privilege-free: the restore side may be a differently-named role.
pg_dump --format=custom --no-owner --no-privileges --file="$OUT" "$UNI_DATABASE_URL"
echo "Backed up UNI_DATABASE_URL to $OUT"
