# One image recipe for every Node service in the workspace.
# Build with:  --build-arg SERVICE=@sef/uni-server  (or @sef/engine)
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

FROM base AS deps
ARG SERVICE
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY server/uni/package.json server/uni/
COPY engine/package.json engine/
COPY apps/desktop/package.json apps/desktop/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "${SERVICE}..."

FROM deps AS runtime
ARG SERVICE
ENV SERVICE=${SERVICE} NODE_ENV=production
COPY packages/shared packages/shared
COPY server/uni server/uni
COPY engine engine
RUN rm -rf server/uni/keys && mkdir -p /data && chown -R node:node /data /app/server/uni /app/engine
USER node
CMD ["sh", "-c", "pnpm --filter \"$SERVICE\" start"]
