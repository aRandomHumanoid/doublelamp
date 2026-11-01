# syntax=docker/dockerfile:1
# DoubleLamp server image (05 §13): builds the web app, then runs the server with tsx as a non-root user.
# Build:  docker build -t doublelamp-server .
# Run:    see docker-compose.yml (server + optional cloudflared). Data lives in the /data volume.

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Toolchain for native modules (better-sqlite3, argon2) in case no prebuilt binary matches this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Install with only the manifests first, so dependency layers cache across source changes.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/effects/package.json packages/effects/
COPY server/package.json server/
COPY web/package.json web/
COPY device-ui/package.json device-ui/
COPY tools/virtual-lamp/package.json tools/virtual-lamp/
RUN npm ci --no-audit --no-fund

COPY packages packages
COPY web web
COPY server server
RUN npm run build -w web \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/package.json /app/tsconfig.base.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages packages
COPY --from=build /app/server server
COPY --from=build /app/web/package.json web/package.json
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data && chown node:node /data
# Non-root (07 §5). With a read-only root filesystem, mount a tmpfs at /tmp (tsx keeps its cache there).
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "server/src/main.ts"]
