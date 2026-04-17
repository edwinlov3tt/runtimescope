# ============================================================
# RuntimeScope Standalone Collector
# Multi-stage build — optimized for small image size
# ============================================================

# ---------- Stage 1: Build native modules + TypeScript ----------
FROM node:20-alpine AS builder

# better-sqlite3 needs these to compile its native addon
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy workspace root files
COPY package.json package-lock.json ./

# Copy only the workspace packages needed for the standalone collector
COPY packages/collector/package.json packages/collector/
COPY packages/sdk/package.json packages/sdk/

# Install ALL dependencies (including dev) to build
RUN npm ci --workspace=packages/collector --workspace=packages/sdk

# Copy source
COPY tsconfig.base.json ./
COPY packages/collector/ packages/collector/
COPY packages/sdk/ packages/sdk/

# Build both packages
RUN npm run build -w packages/collector \
 && npm run build -w packages/sdk

# ---------- Stage 2: Prune to production dependencies only ----------
FROM node:20-alpine AS deps

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/collector/package.json packages/collector/
COPY packages/sdk/package.json packages/sdk/

# Production deps only — drops typescript, tsup, esbuild, rollup, @types, vitest, etc.
RUN npm ci --workspace=packages/collector --workspace=packages/sdk --omit=dev \
 && npm cache clean --force

# ---------- Stage 3: Minimal runtime ----------
FROM node:20-alpine

# Non-root user
RUN addgroup -S runtimescope && adduser -S runtimescope -G runtimescope

WORKDIR /app

# Built JS + production-only deps (no TypeScript, no build tools)
COPY --from=builder  /app/packages/collector/dist/     packages/collector/dist/
COPY --from=builder  /app/packages/collector/package.json packages/collector/
COPY --from=builder  /app/packages/sdk/dist/           packages/sdk/dist/
COPY --from=builder  /app/packages/sdk/package.json    packages/sdk/
COPY --from=deps     /app/node_modules/                node_modules/
COPY --from=deps     /app/package.json                 ./

# Persistent data dir owned by non-root user
RUN mkdir -p /home/runtimescope/.runtimescope \
 && chown -R runtimescope:runtimescope /home/runtimescope/.runtimescope /app

USER runtimescope

# Bind to all interfaces for Docker networking
ENV RUNTIMESCOPE_HOST=0.0.0.0 \
    RUNTIMESCOPE_PORT=6767 \
    RUNTIMESCOPE_HTTP_PORT=6768 \
    HOME=/home/runtimescope \
    NODE_ENV=production

EXPOSE 6767 6768

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:6768/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "packages/collector/dist/standalone.js"]
