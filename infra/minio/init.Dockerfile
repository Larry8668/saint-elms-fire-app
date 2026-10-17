# One-shot bucket bootstrap for the compose `minio-init` service (docs/object-store.md).
# The mc image ships no shell, so mc is copied onto the server image, which has bash.
# Both are pinned by multi-arch index digest; bump them together with the `minio` service.
FROM cgr.dev/chainguard/minio-client:latest@sha256:d8a93c5d335509ff353774eefec8f82fa2a2a975e800139702232d8be3dbe6b9 AS mc

FROM cgr.dev/chainguard/minio:latest@sha256:c93745c56fccdaf0e5dcb88999a96a65a136428beb045ef5d546255a80d747a7
COPY --from=mc /usr/bin/mc /usr/bin/mc
COPY init.sh engine-policy.json /init/
ENV MC_CONFIG_DIR=/tmp/.mc
ENTRYPOINT ["bash", "/init/init.sh"]
