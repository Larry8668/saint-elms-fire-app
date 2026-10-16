#!/usr/bin/env bash
# Restores a db:backup file into UNI_DATABASE_URL. Restore into a FRESH database — the dump
# has no --clean pass, so objects that already exist fail loudly instead of being merged —
# then verify with `pnpm --filter @sef/uni-server db:check` before starting the server.
#
#   UNI_DATABASE_URL=postgres://… pnpm --filter @sef/uni-server db:restore -- path/to/file.dump
set -euo pipefail

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Give the db:backup file to restore from." >&2
  exit 1
fi
if [ -z "${UNI_DATABASE_URL:-}" ]; then
  echo "UNI_DATABASE_URL is not set — point it at the fresh database to restore into." >&2
  exit 1
fi

pg_restore --no-owner --no-privileges --dbname="$UNI_DATABASE_URL" "$FILE"
echo "Restored $FILE — run pnpm --filter @sef/uni-server db:check before starting the server."
