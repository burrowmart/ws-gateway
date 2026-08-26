# ── Build stage ────────────────────────────────────────────────────────────────
# Build context: backend repo root  →  docker build -f ws-gateway/Dockerfile .
FROM node:20-alpine AS build

WORKDIR /workspace

# 1. Build the contracts package so the file: dep has a dist/ to resolve
COPY contracts/package*.json contracts/
RUN cd contracts && npm install --ignore-scripts

COPY contracts/src contracts/src
COPY contracts/scripts contracts/scripts
COPY contracts/openapi contracts/openapi
COPY contracts/tsconfig*.json contracts/
RUN cd contracts && npm run build

# 2. Install service deps (npm ci respects the symlink created by file: ref)
COPY ws-gateway/package*.json ws-gateway/
RUN cd ws-gateway && npm ci --ignore-scripts

# 3. Compile the service
COPY ws-gateway/src          ws-gateway/src
COPY ws-gateway/tsconfig*.json ws-gateway/
COPY ws-gateway/nest-cli.json  ws-gateway/
RUN cd ws-gateway && npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Create a non-root user before copying files
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY --from=build --chown=appuser:appgroup /workspace/ws-gateway/dist        ./dist
COPY --from=build --chown=appuser:appgroup /workspace/ws-gateway/node_modules ./node_modules
COPY --from=build --chown=appuser:appgroup /workspace/ws-gateway/package.json ./

# node_modules/@demo/contracts is a `file:` symlink (../../../contracts,
# resolving to /contracts here) — unlike every other service, ws-gateway
# imports runtime values from @demo/contracts/clients (not just types that
# TypeScript erases at compile time), so the symlink target must actually
# exist in the runtime image or every request that touches
# createChatServiceClient/createNotificationServiceClient crashes on boot.
COPY --from=build --chown=appuser:appgroup /workspace/contracts/dist         /contracts/dist
COPY --from=build --chown=appuser:appgroup /workspace/contracts/package.json /contracts/package.json

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/main"]
