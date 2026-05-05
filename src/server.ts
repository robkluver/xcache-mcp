import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as crypto from "node:crypto";
import { createMcpServer } from "./mcp.js";
import { dispatchTool, type ToolCallContext } from "./tools.js";
import { canonicalUrl, getUrlCache, putUrlCache, queryFingerprint, urlCacheKey } from "./cache.js";
import { gateState, lastFetchedIso, writeGateError, writeGateSuccess } from "./gate.js";
import { redactHeaders, xapiFetch } from "./xapi.js";
import { getLogWriter, type EventLogEntry } from "./log.js";
import { type AppConfig } from "./config.js";

export function buildFastify(cfg: AppConfig): FastifyInstance {
  const app = Fastify({
    logger: {
      level: cfg.logLevel,
      stream: process.stderr,
    },
    disableRequestLogging: false,
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/", async () => {
    return (
      "xcache-mcp — read-only X API proxy with infinite cache.\n\n" +
      "Endpoints:\n" +
      "  GET  /healthz             health check\n" +
      "  GET  /2/*                 forward to api.x.com/2/* with bearer token; cached\n" +
      "  POST /mcp                 MCP Streamable HTTP transport (stateless)\n"
    );
  });

  // REST proxy: forward GET /2/* → api.x.com/2/*
  app.get<{ Params: { "*": string } }>("/2/*", async (req, reply) => {
    const subpath = (req.params as { "*": string })["*"] ?? "";
    const path = "/2/" + subpath;
    // Forward query string (parsed by Fastify)
    const params = (req.query ?? {}) as Record<string, string | number | boolean | undefined>;
    const operation = "raw_get";
    const sortedParams = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const account_id = crypto
      .createHash("sha256")
      .update(path + " " + sortedParams)
      .digest("hex")
      .slice(0, 16);

    const canonical = canonicalUrl(cfg.xApiBase, path, params);
    const key = urlCacheKey("GET", canonical);
    const cached = getUrlCache(key);
    const gate = gateState(operation, account_id);
    const writer = getLogWriter();
    const fp = queryFingerprint(path, params);

    const baseLog: Pick<
      EventLogEntry,
      | "ts"
      | "client_kind"
      | "method"
      | "url"
      | "endpoint_template"
      | "query_fingerprint"
      | "requested_fields"
      | "is_paginated"
      | "pagination_chain_id"
      | "pagination_depth"
      | "operation"
      | "account_id"
      | "agent_session_id"
    > = {
      ts: new Date().toISOString(),
      client_kind: "rest",
      method: "GET",
      url: canonical,
      endpoint_template: path,
      query_fingerprint: fp,
      requested_fields: Object.keys(params)
        .filter((k) => k.endsWith(".fields") || k === "expansions")
        .map((k) => `${k}=${params[k]}`),
      is_paginated: false,
      pagination_chain_id: null,
      pagination_depth: null,
      operation,
      account_id,
      agent_session_id: (req.headers["x-agent-session"] as string | undefined) ?? null,
    };

    if (!gate.open) {
      if (cached) {
        writer.enqueueEvent({
          ...baseLog,
          request_id: crypto.randomUUID(),
          status: cached.status,
          source: "cache",
          cache_outcome: "hit",
          gate_state: { open: false, last_fetched_at: lastFetchedIso(operation, account_id) },
          duration_ms: 0,
          response_bytes: cached.body.length,
          result_count: null,
          next_token_present: null,
          rate_limit_limit: null,
          rate_limit_remaining: null,
          rate_limit_reset: null,
          error_class: null,
          error_message: null,
          body_truncated: false,
          body_ref: null,
        });
        reply.code(cached.status);
        reply.header("content-type", "application/json");
        reply.header("x-xcache-source", "cache");
        return cached.body;
      }
      // Gate closed and no cache → previous error within retry window. Don't hit upstream.
      writer.enqueueEvent({
        ...baseLog,
        request_id: crypto.randomUUID(),
        status: 0,
        source: "gate_blocked",
        cache_outcome: "gate_blocked",
        gate_state: { open: false, last_fetched_at: lastFetchedIso(operation, account_id) },
        duration_ms: 0,
        response_bytes: 0,
        result_count: null,
        next_token_present: null,
        rate_limit_limit: null,
        rate_limit_remaining: null,
        rate_limit_reset: null,
        error_class: null,
        error_message: null,
        body_truncated: false,
        body_ref: null,
      });
      reply.code(429);
      reply.header("content-type", "application/json");
      reply.header("x-xcache-source", "gate_blocked");
      return JSON.stringify({
        error: "gate_blocked",
        message:
          "Throttle gate is closed (likely a recent upstream error) and no cached response exists.",
      });
    }

    const res = await xapiFetch(
      { bearerToken: cfg.bearerToken, apiBase: cfg.xApiBase },
      { path, params },
    );
    const headers = redactHeaders(res.headers);
    const dayFile = bodyDayFile();
    if (!res.ok) {
      writeGateError({
        operation,
        account_id,
        status: res.status || null,
        error: res.errorMessage ?? `http_${res.status}`,
      });
      writer.enqueueEvent({
        ...baseLog,
        request_id: res.requestId,
        status: res.status,
        source: "error",
        cache_outcome: "miss",
        gate_state: { open: false, last_fetched_at: new Date().toISOString() },
        duration_ms: res.durationMs,
        response_bytes: res.body.length,
        result_count: null,
        next_token_present: null,
        rate_limit_limit: res.rateLimit.limit,
        rate_limit_remaining: res.rateLimit.remaining,
        rate_limit_reset: res.rateLimit.reset,
        error_class: res.errorClass,
        error_message: res.errorMessage,
        body_truncated: false,
        body_ref: cfg.logBodies ? "bodies/" + dayFile : null,
      });
      writer.enqueueBody({ request_id: res.requestId, body: res.body });
      if (cached) {
        reply.code(cached.status);
        reply.header("content-type", "application/json");
        reply.header("x-xcache-source", "stale_cache");
        return cached.body;
      }
      reply.code(res.status || 502);
      reply.header("content-type", "application/json");
      return res.body || JSON.stringify({ error: res.errorMessage ?? "upstream_error" });
    }

    putUrlCache({
      key,
      method: "GET",
      url: canonical,
      status: res.status,
      headers,
      body: res.body,
    });
    writeGateSuccess({ operation, account_id, status: res.status });
    writer.enqueueEvent({
      ...baseLog,
      request_id: res.requestId,
      status: res.status,
      source: "live",
      cache_outcome: "miss",
      gate_state: { open: false, last_fetched_at: new Date().toISOString() },
      duration_ms: res.durationMs,
      response_bytes: res.body.length,
      result_count: extractResultCount(res.json),
      next_token_present: extractNextTokenPresent(res.json),
      rate_limit_limit: res.rateLimit.limit,
      rate_limit_remaining: res.rateLimit.remaining,
      rate_limit_reset: res.rateLimit.reset,
      error_class: null,
      error_message: null,
      body_truncated: false,
      body_ref: cfg.logBodies ? "bodies/" + dayFile : null,
    });
    writer.enqueueBody({ request_id: res.requestId, body: res.body });
    reply.code(res.status);
    reply.header("content-type", "application/json");
    reply.header("x-xcache-source", "live");
    return res.body;
  });

  // MCP HTTP — stateless mode
  app.post("/mcp", async (req: FastifyRequest, reply: FastifyReply) => {
    // Hijack so the MCP SDK transport can write directly to the raw response.
    reply.hijack();
    const sessionHeader = req.headers["x-agent-session"];
    const agentSession =
      typeof sessionHeader === "string" ? sessionHeader : undefined;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = createMcpServer({
      client_kind: "mcp_http",
      ...(agentSession ? { agent_session_id: agentSession } : {}),
    });

    const cleanup = async () => {
      try {
        await server.close();
      } catch {
        // ignore
      }
      try {
        await transport.close();
      } catch {
        // ignore
      }
    };

    transport.onclose = () => {
      void cleanup();
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      try {
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.setHeader("content-type", "application/json");
          reply.raw.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32603,
                message: err instanceof Error ? err.message : String(err),
              },
              id: null,
            }),
          );
        } else {
          reply.raw.end();
        }
      } catch {
        // best effort
      }
      await cleanup();
    }
  });

  app.get("/mcp", async (_req, reply) => {
    reply.code(405).header("Allow", "POST");
    return { error: "method_not_allowed", message: "Stateless MCP only supports POST." };
  });

  app.delete("/mcp", async (_req, reply) => {
    reply.code(405).header("Allow", "POST");
    return { error: "method_not_allowed", message: "Stateless MCP only supports POST." };
  });

  return app;
}

function bodyDayFile(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}.jsonl`;
}

function extractResultCount(json: unknown): number | null {
  if (!json || typeof json !== "object") return null;
  const meta = (json as { meta?: { result_count?: number } }).meta;
  if (meta && typeof meta.result_count === "number") return meta.result_count;
  const data = (json as { data?: unknown }).data;
  if (Array.isArray(data)) return data.length;
  return null;
}

function extractNextTokenPresent(json: unknown): boolean | null {
  if (!json || typeof json !== "object") return null;
  const meta = (json as { meta?: { next_token?: string } }).meta;
  if (meta && typeof meta === "object") {
    return typeof meta.next_token === "string" && meta.next_token.length > 0;
  }
  return null;
}

// Re-exports — used by tests if any
export { dispatchTool };
export type { ToolCallContext };
