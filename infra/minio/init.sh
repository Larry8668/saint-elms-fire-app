#!/usr/bin/env bash
# Idempotent: safe on every `compose up`. Creates the vault bucket with versioning on, and an
# engine user whose policy reaches only that bucket (no admin, no other buckets, and no
# DeleteObjectVersion, so a sync bug can never purge history).
set -euo pipefail

: "${MINIO_ROOT_USER:?}" "${MINIO_ROOT_PASSWORD:?}"
: "${OBJECT_STORE_BUCKET:?}" "${OBJECT_STORE_ACCESS_KEY:?}" "${OBJECT_STORE_SECRET_KEY:?}"
endpoint="${MINIO_INTERNAL_URL:-http://minio:9000}"
bucket="$OBJECT_STORE_BUCKET"
policy_name="sef-engine-${bucket}"

if [[ "$OBJECT_STORE_ACCESS_KEY" == "$MINIO_ROOT_USER" ]]; then
  echo "minio-init: OBJECT_STORE_ACCESS_KEY must differ from MINIO_ROOT_USER (the engine never gets root)" >&2
  exit 1
fi

mc alias set sef "$endpoint" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing "sef/${bucket}"
mc version enable "sef/${bucket}"

template="$(</init/engine-policy.json)"
printf '%s\n' "${template//__BUCKET__/$bucket}" >/tmp/engine-policy.json
mc admin policy create sef "$policy_name" /tmp/engine-policy.json
mc admin user add sef "$OBJECT_STORE_ACCESS_KEY" "$OBJECT_STORE_SECRET_KEY"
if ! out="$(mc admin policy attach sef "$policy_name" --user "$OBJECT_STORE_ACCESS_KEY" 2>&1)"; then
  [[ "$out" == *"already in effect"* ]] || { echo "$out" >&2; exit 1; }
fi

echo "minio-init: bucket ${bucket} ready (versioning on); engine key ${OBJECT_STORE_ACCESS_KEY} scoped to it"
