/**
 * Conformance harness barrel.
 *
 * The collector seam (spawnCollector / RUNTIMESCOPE_COLLECTOR_CMD) and the
 * SDK driver are SHARED with the stress + bench suites — one seam, one driver,
 * three consumers. We re-export them here so conformance specs import from a
 * single place and the Rust port only has to satisfy one launch contract.
 *
 *   - WS + HTTP wire surface  → spawnCollector (RUNTIMESCOPE_COLLECTOR_CMD)
 *   - MCP stdio surface        → McpDriver     (RUNTIMESCOPE_MCP_CMD)
 */

export { spawnCollector, resolveCollectorCmd, type SpawnedCollector } from '../../../stress/utils/spawn-collector.js';
export { SdkDriver, makeNetEvent, type DriverConfig } from '../../../stress/utils/sdk-driver.js';
export { McpDriver, type McpToolResult } from './mcp-driver.js';
