# ============================================================
# RuntimeScope Standalone Collector — Rust (post-M7)
# Multi-stage: build the dashboard SPA, build the Rust collector
# (build.rs embeds the SPA), ship a single static-ish binary.
# ============================================================

# ---------- Stage 1: build the dashboard SPA → packages/dashboard/dist ----------
FROM node:20-alpine AS dashboard
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/dashboard/package.json packages/dashboard/
RUN npm ci --workspace=packages/dashboard
COPY tsconfig.base.json ./
COPY packages/dashboard/ packages/dashboard/
RUN npm run build -w packages/dashboard

# ---------- Stage 2: build the Rust collector-server ----------
# rusqlite is `bundled` (compiles sqlite3.c), so a C compiler is required.
FROM rust:1.95-slim-bookworm AS rust
WORKDIR /build
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates/ crates/
# The built SPA must be present BEFORE cargo build so collector-core/build.rs
# mirrors it into the crate and rust-embed bakes the real UI into the binary.
COPY --from=dashboard /app/packages/dashboard/dist/ packages/dashboard/dist/
# Only the standalone daemon is needed in the image (no MCP/stdio here).
RUN cargo build --release -p runtimescope --bin collector-server

# ---------- Stage 3: minimal runtime ----------
FROM debian:bookworm-slim
# curl: HEALTHCHECK probe.  ca-certificates: outbound TLS (infra connectors).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -r -u 10001 -m -d /home/runtimescope runtimescope \
 && mkdir -p /home/runtimescope/.runtimescope \
 && chown -R runtimescope:runtimescope /home/runtimescope

COPY --from=rust /build/target/release/collector-server /usr/local/bin/collector-server

USER runtimescope
ENV HOME=/home/runtimescope \
    RUNTIMESCOPE_HOST=0.0.0.0 \
    RUNTIMESCOPE_PORT=6767 \
    RUNTIMESCOPE_HTTP_PORT=6768

EXPOSE 6767 6768

# /readyz returns 2xx only when the collector is serving (see lib.rs probe).
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:6768/readyz >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/collector-server"]
