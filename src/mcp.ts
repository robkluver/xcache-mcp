import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  dispatchTool,
  TOOL_DEFINITIONS,
  type ToolCallContext,
} from "./tools.js";

export type McpServerCtx = {
  client_kind: "mcp_http" | "mcp_stdio";
  agent_session_id?: string;
};

export function createMcpServer(ctx: McpServerCtx): Server {
  const server = new Server(
    {
      name: "xcache-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_DEFINITIONS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    const name = req.params.name as string;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const callCtx: ToolCallContext = {
      client_kind: ctx.client_kind,
      mcp_tool: name,
      ...(ctx.agent_session_id ? { agent_session_id: ctx.agent_session_id } : {}),
    };
    try {
      const result = await dispatchTool(callCtx, name, args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "tool_error", message }),
          },
        ],
      };
    }
  });

  return server;
}
