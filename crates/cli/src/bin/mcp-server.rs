//! `mcp-server` binary — a thin wrapper that provides the tokio runtime and
//! drives `runtimescope_mcp::run()` (the embedded-collector MCP server, ADR-0008).
//! The implementation lives in the `runtimescope-mcp` library crate so it is also
//! reusable on crates.io; this binary is what `cargo install runtimescope` ships.

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    runtimescope_mcp::run().await
}
