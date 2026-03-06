# ============================================================
# RuntimeScope Standalone Collector
# Multi-stage build for better-sqlite3 native compilation
# ============================================================

# Stage 1: Build
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace root package files
COPY package.json package-lock.json ./

# Copy only the packages needed for the standalone collector
COPY packages/collector/package.json packages/collector/
COPY packages/sdk/package.json packages/sdk/

# Install dependencies (builds better-sqlite3 native addon)
RUN npm ci --workspace=packages/collector --workspace=packages/sdk

# Copy source code
COPY tsconfig.base.json ./
COPY packages/collector/ packages/collector/
COPY packages/sdk/ packages/sdk/

# Build the collector (includes standalone.ts entry point)
RUN npm run build -w packages/collector
# Build the SDK (needed for serving /runtimescope.js)
RUN npm run build -w packages/sdk

# Stage 2: Runtime (non-root)
FROM node:20-slim

RUN useradd -r -m -s /bin/false runtimescope

WORKDIR /app

# Copy built artifacts and dependencies
COPY --from=builder /app/packages/collector/dist/ packages/collector/dist/
COPY --from=builder /app/packages/collector/package.json packages/collector/
COPY --from=builder /app/packages/sdk/dist/ packages/sdk/dist/
COPY --from=builder /app/packages/sdk/package.json packages/sdk/
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/package.json ./

# Create data directory owned by non-root user
RUN mkdir -p /home/runtimescope/.runtimescope && \
    chown -R runtimescope:runtimescope /home/runtimescope/.runtimescope

USER runtimescope

# Default environment — bind to all interfaces for Docker networking
ENV RUNTIMESCOPE_HOST=0.0.0.0
ENV RUNTIMESCOPE_PORT=9090
ENV RUNTIMESCOPE_HTTP_PORT=9091
ENV HOME=/home/runtimescope

EXPOSE 9090 9091

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9091/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "packages/collector/dist/standalone.js"]
