import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { dispatchTool, enabledToolDefinitions, type ToolCallContext } from "./tools.js";
import { getPeriodSnapshot } from "./billing.js";
import type { BillingConfig } from "./config.js";

export type McpServerCtx = {
  client_kind: "mcp_http" | "mcp_stdio";
  agent_session_id?: string;
  enabledTools: Set<string>;
  billing: BillingConfig;
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
      tools: enabledToolDefinitions(ctx.enabledTools).map((t) => ({
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
    const before = ctx.billing.enabled ? getPeriodSnapshot(ctx.billing) : null;
    try {
      const result = await dispatchTool(callCtx, name, args, ctx.enabledTools);
      const after = ctx.billing.enabled ? getPeriodSnapshot(ctx.billing) : null;
      const enriched =
        before && after && typeof result === "object" && result !== null
          ? {
              ...(result as Record<string, unknown>),
              cost: {
                this_call_usd: round6(after.period_total_usd - before.period_total_usd),
                period_total_usd: round6(after.period_total_usd),
                period_started_iso: after.period_started_iso,
                currency: "USD",
              },
            }
          : result;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(enriched, null, 2),
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

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
