# One image recipe for every Node service in the workspace.
# Build with:  --build-arg SERVICE=@sef/uni-server  (or @sef/engine, @sef/gateway)
# The `uni` target additionally carries the hosted portal/admin builds into the
# university image; compose builds it with `target: uni`.
FROM node:24-slim AS base
# youtube-dl-exec's preinstall refuses without Python, which the slim image lacks; the
# engine's video lane already degrades without yt-dlp (same fix as infra/seat/bootstrap.sh).
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true YOUTUBE_DL_SKIP_PYTHON_CHECK=1
RUN corepack enable
WORKDIR /app

FROM base AS deps
ARG SERVICE
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY server/uni/package.json server/uni/
COPY server/gateway/package.json server/gateway/
COPY engine/package.json engine/
COPY apps/desktop/package.json apps/desktop/
COPY apps/admin/package.json apps/admin/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "${SERVICE}..."

# The two surfaces the uni itself serves: the onboarding shell (/app, from
# apps/desktop's portal config) and the staff portal (/admin, from apps/admin).
# Built here so the image does not depend on host build output that .dockerignore drops.
FROM base AS web-assets
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/desktop/package.json apps/desktop/
COPY apps/admin/package.json apps/admin/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @sef/shared... --filter @sef/desktop... --filter @sef/admin...
COPY packages/shared packages/shared
COPY apps/desktop apps/desktop
COPY apps/admin apps/admin
RUN pnpm --filter @sef/desktop build:portal && pnpm --filter @sef/admin build

FROM deps AS runtime
ARG SERVICE
ENV SERVICE=${SERVICE} NODE_ENV=production
COPY packages/shared packages/shared
COPY server/uni server/uni
COPY server/gateway server/gateway
COPY engine engine
RUN rm -rf server/uni/keys && mkdir -p /data && chown -R node:node /data /app/server/uni /app/engine
USER node
CMD ["sh", "-c", "pnpm --filter \"$SERVICE\" start"]

FROM runtime AS uni
COPY --from=web-assets --chown=node:node /app/apps/desktop/dist-portal /portal
COPY --from=web-assets --chown=node:node /app/apps/admin/dist /admin
# Baked in so a host without the compose bind mount (Render) still has the catalogue;
# compose keeps mounting ./courseware over COURSEWARE_DIR=/courseware.
COPY --chown=node:node courseware /app/courseware
ENV UNI_PORTAL_DIR=/portal UNI_ADMIN_DIR=/admin
USER node
