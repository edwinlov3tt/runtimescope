//! `mcp-server` binary — a thin wrapper that provides the tokio runtime and
//! drives `runtimescope_mcp::run()` (the embedded-collector MCP server, ADR-0008).
//! The implementation lives in the `runtimescope-mcp` library crate so it is also
//! reusable on crates.io; this binary is what `cargo install runtimescope` ships.
//!
//! Transport: stdio by default; `--http` or `RUNTIMESCOPE_MCP_TRANSPORT=http`
//! serves Streamable HTTP for remote access (ADR-0011, bearer-gated).

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let http = std::env::args().any(|a| a == "--http")
        || std::env::var("RUNTIMESCOPE_MCP_TRANSPORT").as_deref() == Ok("http");
    if http {
        runtimescope_mcp::run_http().await
    } else {
        runtimescope_mcp::run().await
    }
}
