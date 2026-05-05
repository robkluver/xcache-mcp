#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAppConfig, loadThrottleConfig, reloadThrottleConfig } from "./config.js";
import { closeDb, openDb } from "./cache.js";
import { initLogWriter, getLogWriter } from "./log.js";
import { initToolContext } from "./tools.js";
import { buildFastify } from "./server.js";
import { createMcpServer } from "./mcp.js";

async function main(): Promise<void> {
  // If invoked as a CLI (e.g. `xcache-mcp consolidate ...`), forward to the
  // consolidator. We avoid re-introducing an extra bin script that imports a
  // separate file at runtime; we just dispatch on argv[2].
  const cmd = process.argv[2];
  if (cmd === "consolidate") {
    const mod = await import("../bin/consolidate.js");
    await mod.runConsolidate(process.argv.slice(3));
    return;
  }

  const cfg = loadAppConfig();
  loadThrottleConfig(cfg.throttleConfigPath);
  openDb(cfg.dbPath);
  initLogWriter(cfg.logsDir, cfg.logBodies);
  initToolContext(cfg);

  // SIGHUP → reload throttle config (no-op if file unreadable, just logs to stderr).
  process.on("SIGHUP", () => {
    try {
      reloadThrottleConfig();
      process.stderr.write("[xcache-mcp] reloaded throttle config\n");
    } catch (err) {
      process.stderr.write(
        `[xcache-mcp] reload throttle config failed: ${(err as Error).message}\n`,
      );
    }
  });

  let httpClose: (() => Promise<void>) | null = null;
  if (!cfg.noHttp) {
    const app = buildFastify(cfg);
    await app.listen({ host: cfg.host, port: cfg.port });
    process.stderr.write(`[xcache-mcp] HTTP listening on ${cfg.host}:${cfg.port}\n`);
    httpClose = async () => {
      await app.close();
    };
  }

  let stdioClose: (() => Promise<void>) | null = null;
  if (!cfg.noStdio) {
    const server = createMcpServer({ client_kind: "mcp_stdio" });
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
    `[xcache-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
