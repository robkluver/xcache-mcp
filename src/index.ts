#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  loadAppFileConfig,
  reloadAppFileConfig,
  resolveAppConfig,
  getFileEnabledTools,
} from "./config.js";
import { closeDb, openDb } from "./cache.js";
import { initLogWriter, getLogWriter } from "./log.js";
import { initToolContext } from "./tools.js";
import { buildFastify } from "./server.js";
import { createMcpServer } from "./mcp.js";

/** Replace the contents of `target` with `source`, preserving the Set reference
 *  so consumers holding a reference (e.g. the long-lived stdio MCP server) see
 *  the change without being re-wired. Used by SIGHUP. */
function applyEnabledToolsInPlace(target: Set<string>, source: Set<string>): void {
  target.clear();
  for (const name of source) target.add(name);
}

async function main(): Promise<void> {
  // CLI-style subcommand dispatch (e.g. `xcache-mcp consolidate ...`).
  const cmd = process.argv[2];
  if (cmd === "consolidate") {
    const mod = await import("../bin/consolidate.js");
    await mod.runConsolidate(process.argv.slice(3));
    return;
  }

  const configPath = process.env.XCACHE_CONFIG ?? "./app.config.json";
  loadAppFileConfig(configPath);
  const cfg = resolveAppConfig();

  openDb(cfg.dbPath);
  initLogWriter(cfg.logsDir, cfg.logBodies, cfg.logEvents);
  initToolContext(cfg);

  // SIGHUP → reload app config file (no-op if file unreadable, just logs to stderr).
  // tools.enabled changes propagate to in-flight servers because we mutate
  // cfg.enabledTools in place. Other resolved fields (host, port, log levels) do
  // NOT live-reload — restart the process to pick those up.
  process.on("SIGHUP", () => {
    try {
      reloadAppFileConfig();
      applyEnabledToolsInPlace(cfg.enabledTools, getFileEnabledTools());
      process.stderr.write("[xcache-mcp] reloaded app config\n");
    } catch (err) {
      process.stderr.write(`[xcache-mcp] reload app config failed: ${(err as Error).message}\n`);
    }
  });

  process.stderr.write(
    `[xcache-mcp] enabled tools (${cfg.enabledTools.size}): ${
      cfg.enabledTools.size === 0 ? "<none>" : Array.from(cfg.enabledTools).sort().join(", ")
    }\n`,
  );

  let httpClose: (() => Promise<void>) | null = null;
  if (cfg.httpEnabled) {
    const app = buildFastify(cfg);
    await app.listen({ host: cfg.host, port: cfg.port });
    process.stderr.write(`[xcache-mcp] HTTP listening on ${cfg.host}:${cfg.port}\n`);
    httpClose = async () => {
      await app.close();
    };
  }

  let stdioClose: (() => Promise<void>) | null = null;
  if (cfg.stdioEnabled) {
    const server = createMcpServer({
      client_kind: "mcp_stdio",
      enabledTools: cfg.enabledTools,
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("[xcache-mcp] MCP stdio transport connected\n");
    stdioClose = async () => {
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
  }

  const shutdown = async (sig: string) => {
    process.stderr.write(`[xcache-mcp] received ${sig}, shutting down\n`);
    try {
      if (httpClose) await httpClose();
    } catch {
      // ignore
    }
    try {
      if (stdioClose) await stdioClose();
    } catch {
      // ignore
    }
    try {
      await getLogWriter().drainWithDeadline(5000);
      getLogWriter().stop();
    } catch {
      // ignore
    }
    try {
      closeDb();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[xcache-mcp] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
