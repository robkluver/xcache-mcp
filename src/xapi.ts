import * as crypto from "node:crypto";

export type XApiRequest = {
  path: string; // must start with /2/
  params?: Record<string, string | number | boolean | undefined>;
  endpointTemplate?: string; // e.g., /2/users/{id}/tweets
  // For logging:
  operation?: string;
  account_id?: string;
  paginationChainId?: string;
  paginationDepth?: number;
};

export type XApiResponse = {
  ok: boolean;
  status: number;
  url: string;
  headers: Record<string, string>; // already redacted (we never set Authorization here for response, but normalize keys)
  body: string; // raw text
  json: unknown | null; // parsed JSON if Content-Type was JSON
  durationMs: number;
  errorClass: string | null;
  errorMessage: string | null;
  rateLimit: {
    limit: number | null;
    remaining: number | null;
    reset: number | null;
  };
  requestId: string;
};

export const REDACTED = "<redacted>";

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "authorization") {
      out[k] = REDACTED;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function newRequestId(): string {
  // ULID-ish: ts in ms (base32) + random tail. Keeping it dependency-free.
  const ts = Date.now().toString(36).toUpperCase().padStart(10, "0");
  const tail = crypto.randomBytes(8).toString("hex").toUpperCase();
  return `01J${ts}${tail}`;
}

export function buildUrl(
  base: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  if (!path.startsWith("/")) path = "/" + path;
  const u = new URL(base + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, String(v));
    }
  }
  // Sort search params for canonical URL
  const entries = Array.from(u.searchParams.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  u.search = "";
  for (const [k, v] of entries) u.searchParams.append(k, v);
  return u.toString();
}

export type XApiCallContext = {
  bearerToken: string;
  apiBase: string;
  timeoutMs?: number;
};

export async function xapiFetch(
  ctx: XApiCallContext,
  req: XApiRequest,
): Promise<XApiResponse> {
  const requestId = newRequestId();
  const url = buildUrl(ctx.apiBase, req.path, req.params);
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ctx.bearerToken}`,
        Accept: "application/json",
        "User-Agent": "xcache-mcp/0.1",
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = (err as Error)?.name === "AbortError";
    return {
      ok: false,
      status: 0,
      url,
      headers: {},
      body: "",
      json: null,
      durationMs: Date.now() - t0,
      errorClass: isAbort ? "timeout" : classifyNetworkError(err),
      errorMessage: (err as Error)?.message ?? String(err),
      rateLimit: { limit: null, remaining: null, reset: null },
      requestId,
    };
  }
  clearTimeout(timer);
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });

  let json: unknown = null;
  const ct = headers["content-type"] ?? "";
  if (ct.includes("application/json") || (text.length > 0 && text.trim().startsWith("{"))) {
    try {
      json = JSON.parse(text);
    } catch {
      // leave as text
    }
  }

  return {
    ok: res.ok,
    status: res.status,
    url,
    headers,
    body: text,
    json,
    durationMs: Date.now() - t0,
    errorClass: res.ok ? null : null,
    errorMessage: null,
    rateLimit: extractRateLimit(headers),
    requestId,
  };
}

function classifyNetworkError(err: unknown): string {
  const msg = (err as Error)?.message ?? "";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return "dns";
  if (/ECONNRESET|ECONNREFUSED|EPIPE/i.test(msg)) return "network";
  if (/CERT|TLS|SSL/i.test(msg)) return "tls";
  if (/AbortError|aborted/i.test(msg)) return "aborted";
  return "network";
}

function extractRateLimit(headers: Record<string, string>): {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
} {
  const num = (s: string | undefined) =>
    s === undefined ? null : Number.isFinite(Number(s)) ? Number(s) : null;
  return {
    limit: num(headers["x-rate-limit-limit"]),
    remaining: num(headers["x-rate-limit-remaining"]),
    reset: num(headers["x-rate-limit-reset"]),
  };
}
