import {
  canonicalUrl,
  getDb,
  getFollowUserDetails,
  getPost,
  getPostCursor,
  getUrlCache,
  insertFollowSnapshot,
  latestSnapshotForUser,
  liveTweetIdsSince,
  markPostDeleted,
  postsSince,
  putUrlCache,
  queryFingerprint,
  shaFingerprint,
  snapshotAtOrBefore,
  snapshotMemberIds,
  upsertPost,
  upsertPostCursor,
  urlCacheKey,
  type FollowUserDetailRow,
  type PostRow,
} from "./cache.js";
import {
  gateState,
  intervalForOperation,
  lastFetchedIso,
  nextEligibleIso,
  writeGateError,
  writeGateSuccess,
} from "./gate.js";
import { redactHeaders, xapiFetch, type XApiResponse } from "./xapi.js";
import { getLogWriter, type EventLogEntry } from "./log.js";
import { intervalForError, type AppConfig } from "./config.js";
import * as crypto from "node:crypto";

/** Shared call context (token, base URL, log flags). Set once at startup. */
let appCtx: {
  bearerToken: string;
  apiBase: string;
  logBodies: boolean;
} | null = null;

export function initToolContext(cfg: AppConfig): void {
  appCtx = {
    bearerToken: cfg.bearerToken,
    apiBase: cfg.xApiBase,
    logBodies: cfg.logBodies,
  };
}

function ctx(): { bearerToken: string; apiBase: string; logBodies: boolean } {
  if (!appCtx) throw new Error("Tool context not initialized");
  return appCtx;
}

function bodyRef(): string | null {
  if (!appCtx?.logBodies) return null;
  return "bodies/" + currentBodyFile();
}

// ---------- Tool definitions for MCP listing ----------

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

export const TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "x_get_user_by_username",
    description:
      "Fetch a single X (Twitter) user record by @username. Use this for one-off lookups when the agent needs profile details for a specific user. " +
      "For repeated monitoring of a user's posts over time, use x_posts_since instead — it caches incrementally and returns at near-zero API cost when called frequently. " +
      "For monitoring a user's follow list over time, use x_follows_changes_since instead.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "X username (with or without leading @)" },
        "user.fields": {
          type: "string",
          description: "Comma-separated user.fields (X API v2 expansion fields).",
        },
      },
      required: ["username"],
      additionalProperties: false,
    },
  },
  {
    name: "x_get_user_by_id",
    description:
      "Fetch a single X user record by numeric user_id. Use this for one-off lookups when the user_id is already known. " +
      "For repeated monitoring of a user's posts over time, use x_posts_since instead — it caches incrementally and returns at near-zero API cost when called frequently. " +
      "For monitoring a user's follow list over time, use x_follows_changes_since instead.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        "user.fields": { type: "string" },
      },
      required: ["user_id"],
      additionalProperties: false,
    },
  },
  {
    name: "x_get_tweet",
    description:
      "Fetch a single tweet by ID or full x.com/.../status/<id> URL. Returns the cached version with deleted=true and a populated deleted_at if X has removed the tweet upstream — historical text and metrics from the most recent successful fetch are preserved indefinitely. " +
      "For repeated monitoring of a user's posts over time, use x_posts_since instead — that tool caches incrementally and is far cheaper for ongoing monitoring.",
    inputSchema: {
      type: "object",
      properties: {
        id_or_url: { type: "string" },
        "tweet.fields": { type: "string" },
        expansions: { type: "string" },
        "user.fields": { type: "string" },
      },
      required: ["id_or_url"],
      additionalProperties: false,
    },
  },
  {
    name: "x_raw_get",
    description:
      "Escape hatch: forward an arbitrary GET to /2/* on api.x.com with the configured bearer token, caching the response forever. Path must start with /2/. " +
      "Prefer the higher-level tools (x_posts_since, x_follows_changes_since, x_get_user_by_username, x_get_user_by_id, x_get_tweet) for any operation they cover — they cache more intelligently and provide structured deletion tracking.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path beginning with /2/" },
        params: {
          type: "object",
          additionalProperties: true,
          description: "Query string parameters (string/number/boolean values).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "x_posts_since",
    description:
      "★ Preferred tool for monitoring a user's posts over time. Returns all cached posts by the given username with created_at >= since_iso. Caches incrementally using a since_id cursor, so repeated calls cost roughly one /2/users/:id/tweets request per throttle interval (default 1h for this operation). " +
      "Returns touched_upstream so the caller can see whether the call hit the X API. Posts are kept in the local cache forever; the deleted boolean indicates whether X has removed a post upstream (only updated by x_get_tweet 404s or x_verify_posts). " +
      "Do NOT use x_raw_get or x_get_tweet repeatedly to monitor recent posts — use this tool, which deduplicates upstream calls via the throttle gate.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        since_iso: { type: "string", description: "ISO 8601 timestamp; only posts created at or after this time are returned." },
        force_refresh: { type: "boolean" },
        max_pages: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Cap pagination depth for this call. Default 5.",
        },
      },
      required: ["username", "since_iso"],
      additionalProperties: false,
    },
  },
  {
    name: "x_follows_changes_since",
    description:
      "★ Preferred tool for monitoring follow-list changes over time. Compares the current /2/users/:id/following list against the most recent snapshot taken on or before since_iso, returning new_follows and unfollows. Snapshots are taken append-only and stored forever. Throttled per the get_user_following operation (default 24h). " +
      "Do NOT use x_raw_get to walk /2/users/:id/following directly — use this tool, which snapshots and diffs efficiently. " +
      "Note: precision is bounded by snapshot cadence (the baseline may be slightly older than since_iso); see precision_note in the response.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        since_iso: { type: "string" },
        force_refresh: { type: "boolean" },
      },
      required: ["username", "since_iso"],
      additionalProperties: false,
    },
  },
  {
    name: "x_verify_posts",
    description:
      "EXPENSIVE: re-fetch every cached post for the given user with created_at >= since_iso, in batches of 100 IDs, to detect deletions upstream. Use only when the agent specifically needs to know which previously-cached posts are still live on X right now (for example, before quoting a post in user-facing output). " +
      "Throttled aggressively (default 7d for this operation) because each call can issue many /2/tweets?ids=... requests. " +
      "For routine monitoring, x_posts_since is far cheaper and only misses deletions that happen to older posts.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        since_iso: { type: "string" },
      },
      required: ["username", "since_iso"],
      additionalProperties: false,
    },
  },
];

// ---------- Generic logging helper ----------

export type ToolCallContext = {
  client_kind: "mcp_http" | "mcp_stdio" | "rest";
  mcp_tool?: string;
  mcp_jsonrpc_id?: string;
  agent_session_id?: string;
};

function logEvent(args: {
  call: ToolCallContext;
  request_id: string;
  url: string;
  endpoint_template: string | null;
  query_fingerprint: string | null;
  requested_fields: string[];
  is_paginated: boolean;
  pagination_chain_id: string | null;
  pagination_depth: number | null;
  operation: string | null;
  account_id: string | null;
  status: number;
  source: "live" | "cache" | "gate_blocked" | "error";
  cache_outcome: "hit" | "miss" | "gate_blocked" | "not_cacheable";
  gate_state: { open: boolean; last_fetched_at: string | null } | null;
  duration_ms: number;
  response_bytes: number;
  result_count: number | null;
  next_token_present: boolean | null;
  rate_limit_limit: number | null;
  rate_limit_remaining: number | null;
  rate_limit_reset: number | null;
  error_class: string | null;
  error_message: string | null;
  body_truncated: boolean;
  body_ref: string | null;
  body?: string | null;
}): void {
  const writer = getLogWriter();
  const entry: EventLogEntry = {
    ts: new Date().toISOString(),
    request_id: args.request_id,
    client_kind: args.call.client_kind,
    mcp_tool: args.call.mcp_tool ?? null,
    mcp_jsonrpc_id: args.call.mcp_jsonrpc_id ?? null,
    agent_session_id: args.call.agent_session_id ?? null,
    method: "GET",
    url: args.url,
    endpoint_template: args.endpoint_template,
    query_fingerprint: args.query_fingerprint,
    requested_fields: args.requested_fields,
    is_paginated: args.is_paginated,
    pagination_chain_id: args.pagination_chain_id,
    pagination_depth: args.pagination_depth,
    operation: args.operation,
    account_id: args.account_id,
    status: args.status,
    source: args.source,
    cache_outcome: args.cache_outcome,
    gate_state: args.gate_state,
    duration_ms: args.duration_ms,
    response_bytes: args.response_bytes,
    result_count: args.result_count,
    next_token_present: args.next_token_present,
    rate_limit_limit: args.rate_limit_limit,
    rate_limit_remaining: args.rate_limit_remaining,
    rate_limit_reset: args.rate_limit_reset,
    error_class: args.error_class,
    error_message: args.error_message,
    body_truncated: args.body_truncated,
    body_ref: args.body_ref,
  };
  writer.enqueueEvent(entry);
  if (args.body && args.source === "live" && args.body_ref) {
    writer.enqueueBody({ request_id: args.request_id, body: args.body });
  }
}

// ---------- Helpers ----------

function fieldsListFromParams(
  params: Record<string, string | number | boolean | undefined>,
): string[] {
  const out: string[] = [];
  for (const k of Object.keys(params)) {
    if (k.endsWith(".fields") || k === "expansions") {
      out.push(`${k}=${params[k]}`);
    }
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clientKindFromCtx(c: ToolCallContext): ToolCallContext["client_kind"] {
  return c.client_kind;
}

// ---------- Tool 1: x_get_user_by_username ----------

export async function tool_x_get_user_by_username(
  call: ToolCallContext,
  input: { username: string; "user.fields"?: string },
): Promise<unknown> {
  const username = input.username.replace(/^@/, "").toLowerCase();
  const operation = "get_user_by_username";
  const account_id = username;

  const params: Record<string, string | number | boolean | undefined> = {};
  if (input["user.fields"]) params["user.fields"] = input["user.fields"];

  const path = `/2/users/by/username/${encodeURIComponent(username)}`;
  return await genericLookup({
    call,
    operation,
    account_id,
    path,
    endpointTemplate: "/2/users/by/username/{username}",
    params,
  });
}

// ---------- Tool 2: x_get_user_by_id ----------

export async function tool_x_get_user_by_id(
  call: ToolCallContext,
  input: { user_id: string; "user.fields"?: string },
): Promise<unknown> {
  const operation = "get_user_by_id";
  const account_id = input.user_id;
  const params: Record<string, string | number | boolean | undefined> = {};
  if (input["user.fields"]) params["user.fields"] = input["user.fields"];

  const path = `/2/users/${encodeURIComponent(input.user_id)}`;
  return await genericLookup({
    call,
    operation,
    account_id,
    path,
    endpointTemplate: "/2/users/{id}",
    params,
  });
}

// ---------- Tool 3: x_get_tweet ----------

export async function tool_x_get_tweet(
  call: ToolCallContext,
  input: {
    id_or_url: string;
    "tweet.fields"?: string;
    expansions?: string;
    "user.fields"?: string;
  },
): Promise<unknown> {
  const id = extractTweetId(input.id_or_url);
  if (!id) {
    return { error: "invalid_id_or_url", message: "Could not extract tweet ID." };
  }
  const operation = "get_tweet";
  const account_id = id;
  const params: Record<string, string | number | boolean | undefined> = {};
  if (input["tweet.fields"]) params["tweet.fields"] = input["tweet.fields"];
  if (input.expansions) params["expansions"] = input.expansions;
  if (input["user.fields"]) params["user.fields"] = input["user.fields"];

  const path = `/2/tweets/${encodeURIComponent(id)}`;
  const endpointTemplate = "/2/tweets/{id}";

  // First check the cache.
  const canonical = canonicalUrl(ctx().apiBase, path, params);
  const key = urlCacheKey("GET", canonical);
  const cached = getUrlCache(key);
  const gate = gateState(operation, account_id);

  // Decide: use cache, or hit upstream?
  // Default for get_tweet operation is "never" — once cached, never refresh.
  // If gate is closed (because we previously cached), serve from cache.
  // If we don't have it cached, we must hit upstream (gate is open from "first_call").
  if (!gate.open) {
    if (cached) {
      const post = getPost(id);
      logEvent({
        call,
        request_id: crypto.randomUUID(),
        url: canonical,
        endpoint_template: endpointTemplate,
        query_fingerprint: queryFingerprint(endpointTemplate, params),
        requested_fields: fieldsListFromParams(params),
        is_paginated: false,
        pagination_chain_id: null,
        pagination_depth: null,
        operation,
        account_id,
        status: cached.status,
        source: "cache",
        cache_outcome: "hit",
        gate_state: { open: gate.open, last_fetched_at: lastFetchedIso(operation, account_id) },
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
      return shapeTweetResponse(cached.body, post);
    }
    // Gate closed and no cache → previous error within retry window. Don't hit upstream.
    logEvent({
      call,
      request_id: crypto.randomUUID(),
      url: canonical,
      endpoint_template: endpointTemplate,
      query_fingerprint: queryFingerprint(endpointTemplate, params),
      requested_fields: fieldsListFromParams(params),
      is_paginated: false,
      pagination_chain_id: null,
      pagination_depth: null,
      operation,
      account_id,
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
    return {
      error: "gate_blocked",
      reason: gate.reason,
      message:
        "Throttle gate is closed (likely a recent upstream error). No cached version exists for this tweet.",
      next_eligible_at: nextEligibleIso(operation, account_id),
      last_status: gate.last_status,
    };
  }

  // Gate open: hit upstream.
  const res = await xapiFetch(ctx(), { path, params });
  const headers = redactHeaders(res.headers);
  // 404 → mark deleted if cached
  if (res.status === 404) {
    const existing = getPost(id);
    if (existing) {
      markPostDeleted(id, Date.now());
    }
    writeGateError({
      operation,
      account_id,
      status: 404,
      error: res.errorMessage ?? "not_found",
    });
    logEvent({
      call,
      request_id: res.requestId,
      url: res.url,
      endpoint_template: endpointTemplate,
      query_fingerprint: queryFingerprint(endpointTemplate, params),
      requested_fields: fieldsListFromParams(params),
      is_paginated: false,
      pagination_chain_id: null,
      pagination_depth: null,
      operation,
      account_id,
      status: res.status,
      source: "live",
      cache_outcome: "miss",
      gate_state: { open: false, last_fetched_at: nowIso() },
      duration_ms: res.durationMs,
      response_bytes: res.body.length,
      result_count: null,
      next_token_present: null,
      rate_limit_limit: res.rateLimit.limit,
      rate_limit_remaining: res.rateLimit.remaining,
      rate_limit_reset: res.rateLimit.reset,
      error_class: null,
      error_message: null,
      body_truncated: false,
      body_ref: bodyRef(),
      body: res.body,
    });
    if (existing) {
      const refreshed = getPost(id);
      const rec = refreshed
        ? (rowToPostRecord(refreshed) as Record<string, unknown>)
        : {};
      return { ...rec, deleted: true };
    }
    return { error: "not_found", message: "Tweet does not exist or is unavailable upstream." };
  }
  if (!res.ok) {
    writeGateError({
      operation,
      account_id,
      status: res.status || null,
      error: res.errorMessage ?? `http_${res.status}`,
    });
    logEvent({
      call,
      request_id: res.requestId,
      url: res.url,
      endpoint_template: endpointTemplate,
      query_fingerprint: queryFingerprint(endpointTemplate, params),
      requested_fields: fieldsListFromParams(params),
      is_paginated: false,
      pagination_chain_id: null,
      pagination_depth: null,
      operation,
      account_id,
      status: res.status,
      source: "error",
      cache_outcome: "miss",
      gate_state: { open: false, last_fetched_at: nowIso() },
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
      body_ref: bodyRef(),
      body: res.body,
    });
    if (cached) {
      const post = getPost(id);
      return shapeTweetResponse(cached.body, post);
    }
    return {
      error: "upstream_error",
      status: res.status,
      message: res.errorMessage ?? `HTTP ${res.status}`,
    };
  }

  putUrlCache({
    key,
    method: "GET",
    url: canonical,
    status: res.status,
    headers,
    body: res.body,
  });

  // Persist tweet into posts table for deletion-tracking semantics.
  if (res.json && typeof res.json === "object" && (res.json as { data?: unknown }).data) {
    const data = (res.json as { data: any }).data;
    persistTweet(data);
  }

  writeGateSuccess({ operation, account_id, status: res.status });
  logEvent({
    call,
    request_id: res.requestId,
    url: res.url,
    endpoint_template: endpointTemplate,
    query_fingerprint: queryFingerprint(endpointTemplate, params),
    requested_fields: fieldsListFromParams(params),
    is_paginated: false,
    pagination_chain_id: null,
    pagination_depth: null,
    operation,
    account_id,
    status: res.status,
    source: "live",
    cache_outcome: "miss",
    gate_state: { open: false, last_fetched_at: nowIso() },
    duration_ms: res.durationMs,
    response_bytes: res.body.length,
    result_count: 1,
    next_token_present: false,
    rate_limit_limit: res.rateLimit.limit,
    rate_limit_remaining: res.rateLimit.remaining,
    rate_limit_reset: res.rateLimit.reset,
    error_class: null,
    error_message: null,
    body_truncated: false,
    body_ref: bodyRef(),
    body: res.body,
  });

  const post = getPost(id);
  return shapeTweetResponse(res.body, post);
}

export function extractTweetId(idOrUrl: string): string | null {
  const trimmed = idOrUrl.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const m = /(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/i.exec(trimmed);
  if (m) return m[1] ?? null;
  return null;
}

function shapeTweetResponse(rawBody: string, post: PostRow | undefined): unknown {
  let parsed: any = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }
  const deleted = !!(post && post.deleted_at);
  const deleted_at = post?.deleted_at ? new Date(post.deleted_at).toISOString() : null;
  return {
    raw: parsed,
    deleted,
    deleted_at,
    ...(post ? { cached_record: rowToPostRecord(post) } : {}),
  };
}

// ---------- Tool 4: x_raw_get ----------

export async function tool_x_raw_get(
  call: ToolCallContext,
  input: {
    path: string;
    params?: Record<string, string | number | boolean | undefined>;
  },
): Promise<unknown> {
  if (!input.path.startsWith("/2/")) {
    return { error: "invalid_path", message: "path must start with /2/" };
  }
  const operation = "raw_get";
  const params = input.params ?? {};
  // Account ID is a stable fingerprint of (path, sorted params).
  const sortedParams = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const account_id = shaFingerprint(input.path, sortedParams).slice(0, 16);

  return await genericLookup({
    call,
    operation,
    account_id,
    path: input.path,
    endpointTemplate: input.path, // raw_get has no template
    params,
  });
}

// ---------- Generic ad-hoc lookup helper (used by tools 1, 2, 4) ----------

async function genericLookup(args: {
  call: ToolCallContext;
  operation: string;
  account_id: string;
  path: string;
  endpointTemplate: string;
  params: Record<string, string | number | boolean | undefined>;
}): Promise<unknown> {
  const { call, operation, account_id, path, endpointTemplate, params } = args;
  const canonical = canonicalUrl(ctx().apiBase, path, params);
  const key = urlCacheKey("GET", canonical);
  const cached = getUrlCache(key);
  const gate = gateState(operation, account_id);

  const fp = queryFingerprint(endpointTemplate, params);
  const fields = fieldsListFromParams(params);

  if (!gate.open) {
    if (cached) {
      logEvent({
        call,
        request_id: crypto.randomUUID(),
        url: canonical,
        endpoint_template: endpointTemplate,
        query_fingerprint: fp,
        requested_fields: fields,
        is_paginated: false,
        pagination_chain_id: null,
        pagination_depth: null,
        operation,
        account_id,
        status: cached.status,
        source: "cache",
        cache_outcome: "hit",
        gate_state: { open: gate.open, last_fetched_at: lastFetchedIso(operation, account_id) },
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
      return safeParse(cached.body);
    }
    // Gate closed and no cache → previous error within retry window. Don't hit upstream.
    logEvent({
      call,
      request_id: crypto.randomUUID(),
      url: canonical,
      endpoint_template: endpointTemplate,
      query_fingerprint: fp,
      requested_fields: fields,
      is_paginated: false,
      pagination_chain_id: null,
      pagination_depth: null,
      operation,
      account_id,
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
    return {
      error: "gate_blocked",
      reason: gate.reason,
      message:
        "Throttle gate is closed (likely a recent upstream error) and no cached response exists.",
      next_eligible_at: nextEligibleIso(operation, account_id),
      last_status: gate.last_status,
    };
  }

  // Hit upstream.
  const res = await xapiFetch(ctx(), { path, params });
  const headers = redactHeaders(res.headers);

  if (!res.ok) {
    writeGateError({
      operation,
      account_id,
      status: res.status || null,
      error: res.errorMessage ?? `http_${res.status}`,
    });
    logEvent({
      call,
      request_id: res.requestId,
      url: res.url,
      endpoint_template: endpointTemplate,
      query_fingerprint: fp,
      requested_fields: fields,
      is_paginated: false,
      pagination_chain_id: null,
      pagination_depth: null,
      operation,
      account_id,
      status: res.status,
      source: "error",
      cache_outcome: "miss",
      gate_state: { open: false, last_fetched_at: nowIso() },
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
      body_ref: bodyRef(),
      body: res.body,
    });
    if (cached) return safeParse(cached.body);
    return {
      error: "upstream_error",
      status: res.status,
      message: res.errorMessage ?? `HTTP ${res.status}`,
    };
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
  logEvent({
    call,
    request_id: res.requestId,
    url: res.url,
    endpoint_template: endpointTemplate,
    query_fingerprint: fp,
    requested_fields: fields,
    is_paginated: false,
    pagination_chain_id: null,
    pagination_depth: null,
    operation,
    account_id,
    status: res.status,
    source: "live",
    cache_outcome: "miss",
    gate_state: { open: false, last_fetched_at: nowIso() },
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
    body_ref: bodyRef(),
    body: res.body,
  });
  return safeParse(res.body);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
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

function currentBodyFile(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}.jsonl`;
}

// ---------- Resolve username → user_id (cached) ----------

async function resolveUserId(
  call: ToolCallContext,
  username: string,
): Promise<{ user_id: string; touched_upstream: boolean } | { error: string; message: string }> {
  const uname = username.replace(/^@/, "").toLowerCase();
  // Look in url_cache directly for /2/users/by/username/<u>
  const path = `/2/users/by/username/${encodeURIComponent(uname)}`;
  const canonical = canonicalUrl(ctx().apiBase, path, {});
  const key = urlCacheKey("GET", canonical);
  const cached = getUrlCache(key);
  if (cached) {
    try {
      const obj = JSON.parse(cached.body) as { data?: { id?: string } };
      if (obj?.data?.id) return { user_id: obj.data.id, touched_upstream: false };
    } catch {
      // fall through and re-fetch
    }
  }
  const result = await tool_x_get_user_by_username(call, { username: uname });
  if (
    result &&
    typeof result === "object" &&
    (result as { data?: { id?: string } })?.data?.id
  ) {
    return {
      user_id: (result as { data: { id: string } }).data.id,
      touched_upstream: true,
    };
  }
  return {
    error: "user_not_found",
    message: `Could not resolve username @${uname} to a user_id.`,
  };
}

// ---------- Tool 5: x_posts_since ----------

export async function tool_x_posts_since(
  call: ToolCallContext,
  input: {
    username: string;
    since_iso: string;
    force_refresh?: boolean;
    max_pages?: number;
  },
): Promise<unknown> {
  const sinceMs = Date.parse(input.since_iso);
  if (!Number.isFinite(sinceMs)) {
    return { error: "invalid_since_iso", message: "since_iso must be ISO 8601" };
  }
  const resolved = await resolveUserId(call, input.username);
  if ("error" in resolved) return resolved;
  const user_id = resolved.user_id;

  const operation = "get_latest_posts";
  const account_id = user_id;
  const gate = gateState(operation, account_id);
  const cursor = getPostCursor(user_id);
  const shouldFetch = gate.open || input.force_refresh === true || !cursor;

  let touched_upstream = false;
  let truncated = false;
  const maxPages = input.max_pages ?? 5;
  const endpointTemplate = "/2/users/{id}/tweets";
  const userPath = `/2/users/${encodeURIComponent(user_id)}/tweets`;
  const paginationChainId = crypto.randomUUID();

  if (shouldFetch) {
    touched_upstream = true;
    const baseParams: Record<string, string | number | boolean | undefined> = {
      max_results: 100,
      "tweet.fields":
        "created_at,public_metrics,conversation_id,in_reply_to_user_id,lang,possibly_sensitive",
    };
    if (cursor?.latest_tweet_id_seen) {
      baseParams.since_id = cursor.latest_tweet_id_seen;
    } else {
      baseParams.start_time = new Date(sinceMs).toISOString();
    }

    let nextToken: string | undefined = undefined;
    let depth = 0;
    let lastErrorRecorded = false;
    while (depth < maxPages) {
      const pageParams = { ...baseParams } as Record<string, string | number | boolean | undefined>;
      if (nextToken) pageParams["pagination_token"] = nextToken;
      const fp = queryFingerprint(endpointTemplate, pageParams);
      const fields = fieldsListFromParams(pageParams);
      const res = await xapiFetch(ctx(), { path: userPath, params: pageParams });
      if (!res.ok) {
        writeGateError({
          operation,
          account_id,
          status: res.status || null,
          error: res.errorMessage ?? `http_${res.status}`,
        });
        logEvent({
          call,
          request_id: res.requestId,
          url: res.url,
          endpoint_template: endpointTemplate,
          query_fingerprint: fp,
          requested_fields: fields,
          is_paginated: true,
          pagination_chain_id: paginationChainId,
          pagination_depth: depth,
          operation,
          account_id,
          status: res.status,
          source: "error",
          cache_outcome: "miss",
          gate_state: { open: false, last_fetched_at: nowIso() },
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
          body_ref: bodyRef(),
          body: res.body,
        });
        lastErrorRecorded = true;
        break;
      }

      const json = res.json as
        | {
            data?: any[];
            meta?: { result_count?: number; next_token?: string; newest_id?: string; oldest_id?: string };
          }
        | null;
      const data = json?.data ?? [];
      const observedAt = Date.now();
      let newestInPageId: string | null = null;
      let newestInPageTs: number | null = null;
      let oldestInPageId: string | null = null;
      let oldestInPageTs: number | null = null;
      const persist = getDb().transaction((tweets: any[]) => {
        for (const t of tweets) {
          persistTweetForUser(t, user_id, observedAt);
          const ts = Date.parse(t.created_at);
          if (Number.isFinite(ts)) {
            if (newestInPageTs == null || ts > newestInPageTs) {
              newestInPageTs = ts;
              newestInPageId = String(t.id);
            }
            if (oldestInPageTs == null || ts < oldestInPageTs) {
              oldestInPageTs = ts;
              oldestInPageId = String(t.id);
            }
          }
        }
      });
      persist(data);
      if (data.length > 0) {
        upsertPostCursor({
          user_id,
          latest_tweet_id: newestInPageId,
          latest_tweet_created_at: newestInPageTs,
          oldest_tweet_id: oldestInPageId,
          oldest_tweet_created_at: oldestInPageTs,
          added_observations: data.length,
        });
      }
      writeGateSuccess({ operation, account_id, status: res.status });
      logEvent({
        call,
        request_id: res.requestId,
        url: res.url,
        endpoint_template: endpointTemplate,
        query_fingerprint: fp,
        requested_fields: fields,
        is_paginated: true,
        pagination_chain_id: paginationChainId,
        pagination_depth: depth,
        operation,
        account_id,
        status: res.status,
        source: "live",
        cache_outcome: "miss",
        gate_state: { open: false, last_fetched_at: nowIso() },
        duration_ms: res.durationMs,
        response_bytes: res.body.length,
        result_count: json?.meta?.result_count ?? data.length,
        next_token_present: !!json?.meta?.next_token,
        rate_limit_limit: res.rateLimit.limit,
        rate_limit_remaining: res.rateLimit.remaining,
        rate_limit_reset: res.rateLimit.reset,
        error_class: null,
        error_message: null,
        body_truncated: false,
        body_ref: bodyRef(),
        body: res.body,
      });

      if (json?.meta?.next_token) {
        nextToken = json.meta.next_token;
        depth += 1;
        if (depth >= maxPages) {
          truncated = true;
          break;
        }
      } else {
        break;
      }
    }

    if (lastErrorRecorded) {
      // gate is closed via error path
    }
  } else {
    // Gate closed and not forcing — log a gate_blocked event so downstream tools see it.
    logEvent({
      call,
      request_id: crypto.randomUUID(),
      url: canonicalUrl(ctx().apiBase, userPath, {}),
      endpoint_template: endpointTemplate,
      query_fingerprint: queryFingerprint(endpointTemplate, {}),
      requested_fields: [],
      is_paginated: true,
      pagination_chain_id: paginationChainId,
      pagination_depth: 0,
      operation,
      account_id,
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
  }

  const rows = postsSince(user_id, sinceMs);
  const records = rows.map(rowToPostRecord);
  const latestObservedAt =
    rows.length > 0 ? new Date(rows[0]!.created_at).toISOString() : new Date(0).toISOString();
  return {
    posts: records,
    latest_observed_at: latestObservedAt,
    touched_upstream,
    truncated,
    gate: {
      last_fetched_at: lastFetchedIso(operation, account_id) ?? "",
      next_eligible_at: nextEligibleIso(operation, account_id) ?? "",
    },
  };
}

function persistTweet(t: any): void {
  if (!t || typeof t !== "object" || !t.id) return;
  const created_ms = Date.parse(t.created_at ?? "");
  const observedAt = Date.now();
  const author_id =
    typeof t.author_id === "string"
      ? t.author_id
      : typeof t.user_id === "string"
        ? t.user_id
        : "";
  const pm = t.public_metrics ?? {};
  upsertPost({
    tweet_id: String(t.id),
    user_id: author_id,
    text: String(t.text ?? ""),
    created_at: Number.isFinite(created_ms) ? created_ms : observedAt,
    conversation_id: t.conversation_id ?? null,
    in_reply_to_user_id: t.in_reply_to_user_id ?? null,
    lang: t.lang ?? null,
    possibly_sensitive: typeof t.possibly_sensitive === "boolean" ? (t.possibly_sensitive ? 1 : 0) : null,
    retweet_count: typeof pm.retweet_count === "number" ? pm.retweet_count : null,
    reply_count: typeof pm.reply_count === "number" ? pm.reply_count : null,
    like_count: typeof pm.like_count === "number" ? pm.like_count : null,
    quote_count: typeof pm.quote_count === "number" ? pm.quote_count : null,
    bookmark_count: typeof pm.bookmark_count === "number" ? pm.bookmark_count : null,
    impression_count: typeof pm.impression_count === "number" ? pm.impression_count : null,
    deleted_at: null,
    raw_json: JSON.stringify(t),
    observed_at: observedAt,
  });
}

function persistTweetForUser(t: any, user_id: string, observedAt: number): void {
  if (!t || typeof t !== "object" || !t.id) return;
  const created_ms = Date.parse(t.created_at ?? "");
  const pm = t.public_metrics ?? {};
  upsertPost({
    tweet_id: String(t.id),
    user_id,
    text: String(t.text ?? ""),
    created_at: Number.isFinite(created_ms) ? created_ms : observedAt,
    conversation_id: t.conversation_id ?? null,
    in_reply_to_user_id: t.in_reply_to_user_id ?? null,
    lang: t.lang ?? null,
    possibly_sensitive: typeof t.possibly_sensitive === "boolean" ? (t.possibly_sensitive ? 1 : 0) : null,
    retweet_count: typeof pm.retweet_count === "number" ? pm.retweet_count : null,
    reply_count: typeof pm.reply_count === "number" ? pm.reply_count : null,
    like_count: typeof pm.like_count === "number" ? pm.like_count : null,
    quote_count: typeof pm.quote_count === "number" ? pm.quote_count : null,
    bookmark_count: typeof pm.bookmark_count === "number" ? pm.bookmark_count : null,
    impression_count: typeof pm.impression_count === "number" ? pm.impression_count : null,
    deleted_at: null,
    raw_json: JSON.stringify(t),
    observed_at: observedAt,
  });
}

export function rowToPostRecord(p: PostRow): unknown {
  const pm: Record<string, number> = {};
  if (p.retweet_count != null) pm.retweet_count = p.retweet_count;
  if (p.reply_count != null) pm.reply_count = p.reply_count;
  if (p.like_count != null) pm.like_count = p.like_count;
  if (p.quote_count != null) pm.quote_count = p.quote_count;
  if (p.bookmark_count != null) pm.bookmark_count = p.bookmark_count;
  if (p.impression_count != null) pm.impression_count = p.impression_count;
  let raw: unknown = null;
  try {
    raw = JSON.parse(p.raw_json);
  } catch {
    raw = null;
  }
  const out: Record<string, unknown> = {
    tweet_id: p.tweet_id,
    user_id: p.user_id,
    text: p.text,
    created_at: new Date(p.created_at).toISOString(),
    first_observed_at: new Date(p.first_observed_at).toISOString(),
    last_observed_at: new Date(p.last_observed_at).toISOString(),
    deleted: p.deleted_at != null,
    deleted_at: p.deleted_at != null ? new Date(p.deleted_at).toISOString() : null,
    raw,
  };
  if (p.conversation_id != null) out.conversation_id = p.conversation_id;
  if (p.in_reply_to_user_id != null) out.in_reply_to_user_id = p.in_reply_to_user_id;
  if (p.lang != null) out.lang = p.lang;
  if (Object.keys(pm).length > 0) out.public_metrics = pm;
  return out;
}

// ---------- Tool 6: x_follows_changes_since ----------

export async function tool_x_follows_changes_since(
  call: ToolCallContext,
  input: { username: string; since_iso: string; force_refresh?: boolean },
): Promise<unknown> {
  const sinceMs = Date.parse(input.since_iso);
  if (!Number.isFinite(sinceMs)) {
    return { error: "invalid_since_iso", message: "since_iso must be ISO 8601" };
  }
  const resolved = await resolveUserId(call, input.username);
  if ("error" in resolved) return resolved;
  const user_id = resolved.user_id;

  const operation = "get_user_following";
  const account_id = user_id;
  const gate = gateState(operation, account_id);
  const existingLatest = latestSnapshotForUser(user_id);
  const shouldFetch = gate.open || input.force_refresh === true || !existingLatest;

  let touched_upstream = false;
  const endpointTemplate = "/2/users/{id}/following";
  const followingPath = `/2/users/${encodeURIComponent(user_id)}/following`;
  const paginationChainId = crypto.randomUUID();

  if (shouldFetch) {
    touched_upstream = true;
    const t0 = Date.now();
    let nextToken: string | undefined = undefined;
    const members: string[] = [];
    const details: Array<{
      user_id: string;
      username?: string | null;
      name?: string | null;
      description?: string | null;
      raw: object;
    }> = [];
    let api_calls = 0;
    let depth = 0;
    const MAX_PAGES = 100;
    let errored = false;
    while (depth < MAX_PAGES) {
      const params: Record<string, string | number | boolean | undefined> = {
        max_results: 1000,
        "user.fields": "username,name,description,created_at,public_metrics",
      };
      if (nextToken) params["pagination_token"] = nextToken;
      const fp = queryFingerprint(endpointTemplate, params);
      const fields = fieldsListFromParams(params);
      const res = await xapiFetch(ctx(), { path: followingPath, params });
      api_calls += 1;
      if (!res.ok) {
        writeGateError({
          operation,
          account_id,
          status: res.status || null,
          error: res.errorMessage ?? `http_${res.status}`,
        });
        logEvent({
          call,
          request_id: res.requestId,
          url: res.url,
          endpoint_template: endpointTemplate,
          query_fingerprint: fp,
          requested_fields: fields,
          is_paginated: true,
          pagination_chain_id: paginationChainId,
          pagination_depth: depth,
          operation,
          account_id,
          status: res.status,
          source: "error",
          cache_outcome: "miss",
          gate_state: { open: false, last_fetched_at: nowIso() },
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
          body_ref: bodyRef(),
          body: res.body,
        });
        errored = true;
        break;
      }
      const json = res.json as
        | {
            data?: Array<{ id: string; username?: string; name?: string; description?: string }>;
            meta?: { result_count?: number; next_token?: string };
          }
        | null;
      const data = json?.data ?? [];
      for (const u of data) {
        members.push(String(u.id));
        details.push({
          user_id: String(u.id),
          username: u.username ?? null,
          name: u.name ?? null,
          description: u.description ?? null,
          raw: u,
        });
      }
      logEvent({
        call,
        request_id: res.requestId,
        url: res.url,
        endpoint_template: endpointTemplate,
        query_fingerprint: fp,
        requested_fields: fields,
        is_paginated: true,
        pagination_chain_id: paginationChainId,
        pagination_depth: depth,
        operation,
        account_id,
        status: res.status,
        source: "live",
        cache_outcome: "miss",
        gate_state: { open: false, last_fetched_at: nowIso() },
        duration_ms: res.durationMs,
        response_bytes: res.body.length,
        result_count: json?.meta?.result_count ?? data.length,
        next_token_present: !!json?.meta?.next_token,
        rate_limit_limit: res.rateLimit.limit,
        rate_limit_remaining: res.rateLimit.remaining,
        rate_limit_reset: res.rateLimit.reset,
        error_class: null,
        error_message: null,
        body_truncated: false,
        body_ref: bodyRef(),
        body: res.body,
      });
      if (json?.meta?.next_token) {
        nextToken = json.meta.next_token;
        depth += 1;
      } else {
        break;
      }
    }
    if (!errored) {
      const taken_at = Date.now();
      insertFollowSnapshot({
        user_id,
        taken_at,
        members,
        api_calls,
        api_duration_ms: Date.now() - t0,
        details,
      });
      writeGateSuccess({ operation, account_id, status: 200 });
    }
  } else {
    logEvent({
      call,
      request_id: crypto.randomUUID(),
      url: canonicalUrl(ctx().apiBase, followingPath, {}),
      endpoint_template: endpointTemplate,
      query_fingerprint: queryFingerprint(endpointTemplate, {}),
      requested_fields: [],
      is_paginated: true,
      pagination_chain_id: paginationChainId,
      pagination_depth: 0,
      operation,
      account_id,
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
  }

  // Now compute baseline and latest snapshots.
  const latest = latestSnapshotForUser(user_id);
  if (!latest) {
    return {
      new_follows: [],
      unfollows: [],
      baseline_snapshot_at: null,
      latest_snapshot_at: null,
      since_iso_requested: input.since_iso,
      first_observation: true,
      touched_upstream,
      precision_note:
        "No snapshots exist yet for this user. Subsequent calls will compare against the latest cached snapshot.",
      gate: {
        last_fetched_at: lastFetchedIso(operation, account_id) ?? "",
        next_eligible_at: nextEligibleIso(operation, account_id) ?? "",
      },
    };
  }
  const baseline = snapshotAtOrBefore(user_id, sinceMs);
  const latestMembers = new Set(snapshotMemberIds(latest.id));
  let baselineMembers: Set<string> | null = null;
  if (baseline) {
    baselineMembers = new Set(snapshotMemberIds(baseline.id));
  }

  const newFollowIds: string[] =
    baselineMembers === null
      ? Array.from(latestMembers)
      : Array.from(latestMembers).filter((id) => !baselineMembers!.has(id));
  const unfollowIds: string[] =
    baselineMembers === null ? [] : Array.from(baselineMembers).filter((id) => !latestMembers.has(id));

  const allIds = Array.from(new Set([...newFollowIds, ...unfollowIds]));
  const detailRows = getFollowUserDetails(allIds);
  const detailMap = new Map(detailRows.map((d: FollowUserDetailRow) => [d.user_id, d]));
  const toFollowDetail = (id: string) => {
    const d = detailMap.get(id);
    return {
      user_id: id,
      username: d?.username ?? null,
      name: d?.name ?? null,
    };
  };

  return {
    new_follows: newFollowIds.map(toFollowDetail),
    unfollows: unfollowIds.map(toFollowDetail),
    baseline_snapshot_at: baseline ? new Date(baseline.taken_at).toISOString() : null,
    latest_snapshot_at: new Date(latest.taken_at).toISOString(),
    since_iso_requested: input.since_iso,
    first_observation: !baseline,
    touched_upstream,
    precision_note:
      "Snapshots are taken on the get_user_following throttle cadence, not at arbitrary moments. The baseline snapshot may be from before since_iso, so new_follows can include accounts followed slightly before the requested cutoff. This over-inclusion is by design.",
    gate: {
      last_fetched_at: lastFetchedIso(operation, account_id) ?? "",
      next_eligible_at: nextEligibleIso(operation, account_id) ?? "",
    },
  };
}

// ---------- Tool 7: x_verify_posts ----------

export async function tool_x_verify_posts(
  call: ToolCallContext,
  input: { username: string; since_iso: string },
): Promise<unknown> {
  const sinceMs = Date.parse(input.since_iso);
  if (!Number.isFinite(sinceMs)) {
    return { error: "invalid_since_iso", message: "since_iso must be ISO 8601" };
  }
  const resolved = await resolveUserId(call, input.username);
  if ("error" in resolved) return resolved;
  const user_id = resolved.user_id;
  const operation = "verify_posts";
  const account_id = user_id;
  const gate = gateState(operation, account_id);
  if (!gate.open) {
    return {
      verified: false,
      reason: "gate_closed",
      next_eligible_at: nextEligibleIso(operation, account_id),
    };
  }

  const ids = liveTweetIdsSince(user_id, sinceMs);
  if (ids.length === 0) {
    writeGateSuccess({ operation, account_id, status: 200 });
    return { verified: true, checked: 0, newly_deleted: 0, refreshed: 0, batches: 0 };
  }

  const endpointTemplate = "/2/tweets";
  const paginationChainId = crypto.randomUUID();
  let newlyDeleted = 0;
  let refreshed = 0;
  let batches = 0;
  let lastError: { status: number | null; message: string } | null = null;
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const params: Record<string, string | number | boolean | undefined> = {
      ids: slice.join(","),
      "tweet.fields":
        "created_at,public_metrics,conversation_id,in_reply_to_user_id,lang,possibly_sensitive,author_id",
    };
    const fp = queryFingerprint(endpointTemplate, { ids: "<batch>" });
    const fields = fieldsListFromParams(params);
    const res = await xapiFetch(ctx(), { path: "/2/tweets", params });
    batches += 1;
    if (!res.ok) {
      lastError = { status: res.status || null, message: res.errorMessage ?? `http_${res.status}` };
      logEvent({
        call,
        request_id: res.requestId,
        url: res.url,
        endpoint_template: endpointTemplate,
        query_fingerprint: fp,
        requested_fields: fields,
        is_paginated: true,
        pagination_chain_id: paginationChainId,
        pagination_depth: batches - 1,
        operation,
        account_id,
        status: res.status,
        source: "error",
        cache_outcome: "miss",
        gate_state: { open: false, last_fetched_at: nowIso() },
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
        body_ref: bodyRef(),
        body: res.body,
      });
      break;
    }
    const json = res.json as
      | {
          data?: any[];
          errors?: Array<{ resource_type?: string; resource_id?: string; value?: string; type?: string; title?: string }>;
        }
      | null;
    const liveSet = new Set<string>();
    const observedAt = Date.now();
    for (const t of json?.data ?? []) {
      if (!t || !t.id) continue;
      liveSet.add(String(t.id));
      const author_id = String(t.author_id ?? user_id);
      persistTweetForUser({ ...t, author_id }, author_id, observedAt);
      refreshed += 1;
    }
    for (const e of json?.errors ?? []) {
      if (e.resource_type !== "tweet") continue;
      const id = String(e.resource_id ?? e.value ?? "");
      if (!id) continue;
      if (liveSet.has(id)) continue;
      // Treat as deletion if not present in data.
      if (markPostDeleted(id, observedAt)) {
        newlyDeleted += 1;
      }
    }
    // Some IDs may be missing from data without an error entry — treat those as deleted too.
    for (const id of slice) {
      if (!liveSet.has(id)) {
        if (markPostDeleted(id, observedAt)) {
          newlyDeleted += 1;
        }
      }
    }
    logEvent({
      call,
      request_id: res.requestId,
      url: res.url,
      endpoint_template: endpointTemplate,
      query_fingerprint: fp,
      requested_fields: fields,
      is_paginated: true,
      pagination_chain_id: paginationChainId,
      pagination_depth: batches - 1,
      operation,
      account_id,
      status: res.status,
      source: "live",
      cache_outcome: "miss",
      gate_state: { open: false, last_fetched_at: nowIso() },
      duration_ms: res.durationMs,
      response_bytes: res.body.length,
      result_count: (json?.data ?? []).length,
      next_token_present: false,
      rate_limit_limit: res.rateLimit.limit,
      rate_limit_remaining: res.rateLimit.remaining,
      rate_limit_reset: res.rateLimit.reset,
      error_class: null,
      error_message: null,
      body_truncated: false,
      body_ref: bodyRef(),
      body: res.body,
    });
  }
  if (lastError) {
    writeGateError({
      operation,
      account_id,
      status: lastError.status,
      error: lastError.message,
    });
  } else {
    writeGateSuccess({ operation, account_id, status: 200 });
  }
  return {
    verified: !lastError,
    checked: ids.length,
    newly_deleted: newlyDeleted,
    refreshed,
    batches,
    ...(lastError ? { error: lastError } : {}),
  };
}

// ---------- Dispatcher ----------

export async function dispatchTool(
  call: ToolCallContext,
  name: string,
  args: unknown,
): Promise<unknown> {
  switch (name) {
    case "x_get_user_by_username":
      return await tool_x_get_user_by_username(call, args as any);
    case "x_get_user_by_id":
      return await tool_x_get_user_by_id(call, args as any);
    case "x_get_tweet":
      return await tool_x_get_tweet(call, args as any);
    case "x_raw_get":
      return await tool_x_raw_get(call, args as any);
    case "x_posts_since":
      return await tool_x_posts_since(call, args as any);
    case "x_follows_changes_since":
      return await tool_x_follows_changes_since(call, args as any);
    case "x_verify_posts":
      return await tool_x_verify_posts(call, args as any);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Exports for REST passthrough
export { intervalForOperation, intervalForError };
