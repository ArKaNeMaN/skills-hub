# syntax=docker/dockerfile:1

# --- build -----------------------------------------------------------------
# Build the server from the monorepo. Only the root lockfile, the workspace
# manifests, the protocol source, and the server sources are copied in; the
# plugin and unrelated files stay out of the context (see .dockerignore).
FROM node:22-bookworm-slim AS build

WORKDIR /app

ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

# npm ci needs the root lockfile and every workspace manifest.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/plugin/package.json apps/plugin/

RUN npm ci --include=dev

# Only the inputs the server build reads: root tsconfig, the private protocol
# workspace it bundles, and the server package (tsup config, asset script,
# source, and static files).
COPY tsconfig.json ./
COPY packages/protocol/src packages/protocol/src
COPY apps/server/tsup.config.ts apps/server/
COPY apps/server/scripts apps/server/scripts
COPY apps/server/src apps/server/src
COPY apps/server/public apps/server/public

RUN npm run build --workspace @skills-hub/server \
    && rm -f apps/server/dist/*.map \
    && npm prune --omit=dev

# --- runtime ---------------------------------------------------------------
# Small runtime image: production node_modules plus the built dist and public
# assets. The server shells out to git and needs CA roots for HTTPS remotes.
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788 \
    DATA_DIR=/data

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./package.json
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/public ./public

# Data lives on a volume owned by the unprivileged node user (UID 1000).
RUN mkdir -p /data && chown node:node /data && chmod 700 /data

USER node

VOLUME ["/data"]

EXPOSE 8788

# No curl/wget in the slim image: use the bundled fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8788/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Exec form so SIGTERM reaches Node and the graceful shutdown handler runs.
CMD ["node", "dist/main.js"]
