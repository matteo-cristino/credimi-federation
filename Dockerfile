# syntax=docker/dockerfile:1
#
# credimi-federation — OpenID Federation 1.0 Trust Anchor.
#
# The image never creates keys. Provision the signing key once into the /data
# volume with `node dist/cli.js init` (see README), then start normally.

ARG NODE_IMAGE=node:26.13.1-alpine
ARG PNPM_VERSION=12.21.0

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
WORKDIR /app
RUN npm install --global "pnpm@${PNPM_VERSION}"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM ${NODE_IMAGE} AS production-deps
ARG PNPM_VERSION
WORKDIR /app
RUN npm install --global "pnpm@${PNPM_VERSION}"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    FEDERATION_SIGNING_KEY_PATH=/data/keys/federation.jwk \
    FEDERATION_SUBORDINATES_PATH=/data/subordinates.json
WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY openapi ./openapi
# The non-root `node` user (uid 1000) owns the data volume; keys live in a
# directory only it can enter. A fresh named volume inherits this ownership.
RUN mkdir -p /data/keys \
    && chown -R node:node /data \
    && chmod 700 /data/keys
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.js"]
