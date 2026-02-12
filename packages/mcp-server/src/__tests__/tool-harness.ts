import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
}>;

interface RegisteredTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: ToolHandler;
}

/**
 * Creates a stub McpServer that records tool registrations.
 * Allows direct invocation of tool handlers without MCP transport.
 */
export function createMcpStub(): {
  server: McpServer;
  getTools: () => Map<string, RegisteredTool>;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
} {
  const tools = new Map<string, RegisteredTool>();

  const server = {
    tool: (name: string, ...rest: unknown[]) => {
      // Handle: tool(name, description, schema, handler)
      // Also:   tool(name, description, handler)  — no schema
      let description: string;
      let schema: Record<string, unknown>;
      let handler: ToolHandler;

      if (rest.length === 3) {
        description = rest[0] as string;
        schema = rest[1] as Record<string, unknown>;
        handler = rest[2] as ToolHandler;
      } else if (rest.length === 2) {
        description = rest[0] as string;
        schema = {};
        handler = rest[1] as ToolHandler;
      } else {
        description = '';
        schema = {};
        handler = rest[0] as ToolHandler;
      }

      tools.set(name, { name, description, schema, handler });
    },
  } as unknown as McpServer;

  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool "${name}" not registered`);
    const result = await tool.handler(args);
    const text = result.content[0].text;
    return JSON.parse(text);
  }

  return { server, getTools: () => tools, callTool };
}
