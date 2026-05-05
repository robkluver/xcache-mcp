import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------- File-config schema (app.config.json) ----------
//
// Only TWO env vars are honored at runtime:
//   X_BEARER_TOKEN   — secret, REQUIRED for upstream calls
//   XCACHE_CONFIG    — bootstrap path to the JSON file (default ./app.config.json)
//
// Everything else lives in the JSON file. SIGHUP reloads the file in place.

export type ServerConfig = {
  host: string;
  port: number;
  http: { enabled: boolean };
  stdio: { enabled: boolean };
};

export type StorageConfig = {
  root: string;
};

export type XApiConfig = {
  base: string;
};

export type LoggingConfig = {
  level: string;
  events: boolean;
  bodies: boolean;
};

export type ToolsConfig = {
  /** Enabled tool names. Either an explicit list or the literal "*" (all).
   *  Optional — if absent, the default starred set is used. */
  enabled?: string[] | "*";
};

export type ThrottleConfig = {
  default_min_interval: string;
  operations: Record<string, string>;
  error_retry_intervals: Record<string, string>;
};

export type AppFileConfig = {
  version: number;
  server?: Partial<ServerConfig>;
  storage?: Partial<StorageConfig>;
  x_api?: Partial<XApiConfig>;
  logging?: Partial<LoggingConfig>;
  tools?: ToolsConfig;
  throttle: ThrottleConfig;
};

/** The resolved, all-defaults-applied config used by the running process. */
export type AppConfig = {
  bearerToken: string;
  configPath: string;
  host: string;
  port: number;
  httpEnabled: boolean;
  stdioEnabled: boolean;
  root: string;
  xApiBase: string;
  logLevel: string;
  logEvents: boolean;
  logBodies: boolean;
  enabledTools: Set<string>;
  dbPath: string;
  logsDir: string;
};

// ---------- Tool catalog ----------

export const ALL_TOOL_NAMES: readonly string[] = [
  "x_get_user_by_username",
  "x_get_user_by_id",
  "x_get_tweet",
  "x_raw_get",
  "x_posts_since",
  "x_follows_changes_since",
  "x_verify_posts",
];

/** Default-enabled tool set: only the two ★ monitoring tools.
 *  Override via app.config.json's tools.enabled. */
export const DEFAULT_ENABLED_TOOLS: readonly string[] = [
  "x_posts_since",
  "x_follows_changes_since",
];

// ---------- Defaults ----------

const DEFAULT_SERVER: ServerConfig = {
  host: "127.0.0.1",
  port: 8787,
  http: { enabled: true },
  stdio: { enabled: true },
};

const DEFAULT_STORAGE: StorageConfig = {
  root: "~/.openclaw/xcache-mcp",
};

const DEFAULT_X_API: XApiConfig = {
  base: "https://api.x.com",
};

const DEFAULT_LOGGING: LoggingConfig = {
  level: "info",
  events: true,
  bodies: true,
};

// ---------- Helpers ----------

export function expandHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Reduce a tools-section value (array, "*", or undefined) to a concrete Set. */
export function resolveToolsFromFile(tools: ToolsConfig | undefined): Set<string> {
  if (!tools || tools.enabled === undefined) {
    return new Set(DEFAULT_ENABLED_TOOLS);
  }
  if (tools.enabled === "*") {
    return new Set(ALL_TOOL_NAMES);
  }
  if (!Array.isArray(tools.enabled)) {
    throw new Error(`app config: tools.enabled must be an array or the literal "*"`);
  }
  const out = new Set<string>();
  for (const name of tools.enabled) {
    if (typeof name !== "string") {
      throw new Error(`app config: tools.enabled entries must be strings`);
    }
    if (ALL_TOOL_NAMES.includes(name)) {
      out.add(name);
    } else {
      process.stderr.write(
        `[xcache-mcp] WARNING: app config tools.enabled includes unknown tool "${name}"; ignoring\n`,
      );
    }
  }
  return out;
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

// ---------- File loader (cached for SIGHUP reload) ----------

let cachedAppFile: AppFileConfig | null = null;
let cachedAppFilePath: string | null = null;
let cachedFileEnabledTools: Set<string> = new Set(DEFAULT_ENABLED_TOOLS);

export function loadAppFileConfig(configPath: string): AppFileConfig {
  const resolved = path.resolve(expandHome(configPath));
  const txt = fs.readFileSync(resolved, "utf8");
  const parsed = JSON.parse(txt) as AppFileConfig;

  if (typeof parsed.version !== "number") {
    throw new Error("app config: version (number) is required");
  }
  if (!parsed.throttle || typeof parsed.throttle !== "object") {
    throw new Error("app config: throttle section is required");
  }
  if (typeof parsed.throttle.default_min_interval !== "string") {
    throw new Error("app config: throttle.default_min_interval is required");
  }
  parseInterval(parsed.throttle.default_min_interval);
  for (const v of Object.values(parsed.throttle.operations ?? {})) {
    parseInterval(v);
  }
  for (const v of Object.values(parsed.throttle.error_retry_intervals ?? {})) {
    parseInterval(v);
  }

  cachedFileEnabledTools = resolveToolsFromFile(parsed.tools);
  cachedAppFile = parsed;
  cachedAppFilePath = resolved;
  return parsed;
}

export function getAppFileConfig(): AppFileConfig {
  if (!cachedAppFile) {
    throw new Error("App config not loaded yet");
  }
  return cachedAppFile;
}

export function reloadAppFileConfig(): AppFileConfig {
  if (!cachedAppFilePath) {
    throw new Error("No app config path remembered for reload");
  }
  return loadAppFileConfig(cachedAppFilePath);
}

export function getFileEnabledTools(): Set<string> {
  return new Set(cachedFileEnabledTools);
}

// ---------- Resolved config (env + file → AppConfig) ----------

/** Build the resolved AppConfig from env vars (secrets/bootstrap only) and the
 *  loaded app.config.json. Call this AFTER loadAppFileConfig(). */
export function resolveAppConfig(): AppConfig {
  const bearerToken = process.env.X_BEARER_TOKEN ?? "";
  if (!bearerToken) {
    process.stderr.write(
      "[xcache-mcp] WARNING: X_BEARER_TOKEN is not set; upstream calls will fail.\n",
    );
  }
  const configPath = path.resolve(expandHome(process.env.XCACHE_CONFIG ?? "./app.config.json"));
  const file = getAppFileConfig();

  const server: ServerConfig = {
    host: file.server?.host ?? DEFAULT_SERVER.host,
    port: file.server?.port ?? DEFAULT_SERVER.port,
    http: { enabled: file.server?.http?.enabled ?? DEFAULT_SERVER.http.enabled },
    stdio: { enabled: file.server?.stdio?.enabled ?? DEFAULT_SERVER.stdio.enabled },
  };
  const storage: StorageConfig = {
    root: expandHome(file.storage?.root ?? DEFAULT_STORAGE.root),
  };
  const xApi: XApiConfig = {
    base: (file.x_api?.base ?? DEFAULT_X_API.base).replace(/\/+$/, ""),
  };
  const logging: LoggingConfig = {
    level: file.logging?.level ?? DEFAULT_LOGGING.level,
    events: file.logging?.events ?? DEFAULT_LOGGING.events,
    bodies: file.logging?.bodies ?? DEFAULT_LOGGING.bodies,
  };

  // Ensure data directory exists.
  fs.mkdirSync(storage.root, { recursive: true });
  const logsDir = path.join(storage.root, "logs");
  fs.mkdirSync(path.join(logsDir, "events"), { recursive: true });
  fs.mkdirSync(path.join(logsDir, "bodies"), { recursive: true });

  return {
    bearerToken,
    configPath,
    host: server.host,
    port: server.port,
    httpEnabled: server.http.enabled,
    stdioEnabled: server.stdio.enabled,
    root: storage.root,
    xApiBase: xApi.base,
    logLevel: logging.level,
    logEvents: logging.events,
    logBodies: logging.bodies,
    enabledTools: getFileEnabledTools(),
    dbPath: path.join(storage.root, "data.db"),
    logsDir,
  };
}

// ---------- Throttle queries (consume cachedAppFile) ----------

export function intervalForOperation(op: string): number | "never" | "always" {
  const cfg = getAppFileConfig();
  const raw = cfg.throttle.operations[op] ?? cfg.throttle.default_min_interval;
  return parseInterval(raw);
}

export function intervalForError(status: number | "network"): number | "never" | "always" {
  const cfg = getAppFileConfig();
  const map = cfg.throttle.error_retry_intervals ?? {};
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
