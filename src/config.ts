import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type ThrottleConfig = {
  version: number;
  default_min_interval: string;
  operations: Record<string, string>;
  error_retry_intervals: Record<string, string>;
};

export type AppConfig = {
  bearerToken: string;
  port: number;
  host: string;
  root: string;
  throttleConfigPath: string;
  noHttp: boolean;
  noStdio: boolean;
  logBodies: boolean;
  logLevel: string;
  xApiBase: string;
  dbPath: string;
  logsDir: string;
};

export function expandHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export function loadAppConfig(): AppConfig {
  const bearerToken = process.env.X_BEARER_TOKEN ?? "";
  if (!bearerToken) {
    // We allow startup to proceed but every upstream call will fail; this lets the
    // user run `--help`-style introspection. The README requires the token to do
    // anything useful. Tests can use a placeholder token with a stub X_API_BASE.
    process.stderr.write(
      "[xcache-mcp] WARNING: X_BEARER_TOKEN is not set; upstream calls will fail.\n",
    );
  }

  const root = expandHome(process.env.XCACHE_ROOT ?? "~/.openclaw/xcache-mcp");
  fs.mkdirSync(root, { recursive: true });

  const logsDir = path.join(root, "logs");
  fs.mkdirSync(path.join(logsDir, "events"), { recursive: true });
  fs.mkdirSync(path.join(logsDir, "bodies"), { recursive: true });

  return {
    bearerToken,
    port: Number(process.env.XCACHE_PORT ?? 8787),
    host: process.env.XCACHE_HOST ?? "127.0.0.1",
    root,
    throttleConfigPath: process.env.XCACHE_THROTTLE_CONFIG ?? "./throttle.config.json",
    noHttp: process.env.XCACHE_NO_HTTP === "1",
    noStdio: process.env.XCACHE_NO_STDIO === "1",
    logBodies: (process.env.XCACHE_LOG_BODIES ?? "1") !== "0",
    logLevel: process.env.LOG_LEVEL ?? "info",
    xApiBase: (process.env.X_API_BASE ?? "https://api.x.com").replace(/\/+$/, ""),
    dbPath: path.join(root, "data.db"),
    logsDir,
  };
}

export function parseInterval(spec: string): number | "never" | "always" {
  const s = spec.trim().toLowerCase();
  if (s === "never") return "never";
  if (s === "always") return "always";
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(s);
  if (!m) {
    throw new Error(`Invalid interval string: "${spec}"`);
  }
  const n = Number(m[1]);
  const unit = m[2] as "s" | "m" | "h" | "d";
  const mult: Record<"s" | "m" | "h" | "d", number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return n * mult[unit];
}

let cachedThrottleConfig: ThrottleConfig | null = null;
let cachedThrottlePath: string | null = null;

export function loadThrottleConfig(configPath: string): ThrottleConfig {
  const resolved = path.resolve(expandHome(configPath));
  const txt = fs.readFileSync(resolved, "utf8");
  const parsed = JSON.parse(txt) as ThrottleConfig;
  if (typeof parsed.default_min_interval !== "string") {
    throw new Error("throttle config: default_min_interval missing");
  }
  // Validate all intervals parse.
  parseInterval(parsed.default_min_interval);
  for (const [op, v] of Object.entries(parsed.operations ?? {})) {
    parseInterval(v);
    void op;
  }
  for (const [code, v] of Object.entries(parsed.error_retry_intervals ?? {})) {
    parseInterval(v);
    void code;
  }
  cachedThrottleConfig = parsed;
  cachedThrottlePath = resolved;
  return parsed;
}

export function getThrottleConfig(): ThrottleConfig {
  if (!cachedThrottleConfig) {
    throw new Error("Throttle config not loaded yet");
  }
  return cachedThrottleConfig;
}

export function reloadThrottleConfig(): ThrottleConfig {
  if (!cachedThrottlePath) {
    throw new Error("No throttle config path remembered for reload");
  }
  return loadThrottleConfig(cachedThrottlePath);
}

export function intervalForOperation(op: string): number | "never" | "always" {
  const cfg = getThrottleConfig();
  const raw = cfg.operations[op] ?? cfg.default_min_interval;
  return parseInterval(raw);
}

export function intervalForError(status: number | "network"): number | "never" | "always" {
  const cfg = getThrottleConfig();
  const map = cfg.error_retry_intervals ?? {};
  if (status === "network") {
    return parseInterval(map.network ?? "1m");
  }
  const exact = map[String(status)];
  if (exact) return parseInterval(exact);
  if (status >= 500 && status < 600 && map["5xx"]) {
    return parseInterval(map["5xx"]);
  }
  if (status >= 400 && status < 500 && map["4xx"]) {
    return parseInterval(map["4xx"]);
  }
  return parseInterval("5m");
}
