import { getDb } from "./cache.js";
import type { BillingConfig, BillingRates } from "./config.js";
import { xapiFetch } from "./xapi.js";

// ---------- Resource classification ----------

export type ResourceKind =
  | "post_read"
  | "user_read"
  | "following_read"
  | "list_read"
  | "default_read";

/** Map an /2/* endpoint template to a billing resource kind. */
export function classifyEndpoint(endpointTemplate: string | null): ResourceKind {
  if (!endpointTemplate) return "default_read";
  const t = endpointTemplate;
  if (/\/2\/users\/[^/]+\/(following|followers)\b/.test(t)) return "following_read";
  if (/\/2\/users\/[^/]+\/(tweets|mentions|liked_tweets|bookmarks)\b/.test(t)) return "post_read";
  if (/\/2\/tweets(\/[^/]+)?(\/(retweeted_by|liking_users|quote_tweets))?$/.test(t))
    return "post_read";
  if (/\/2\/users\/[^/]+\/(owned_lists|followed_lists|list_memberships|pinned_lists)\b/.test(t))
    return "list_read";
  if (/\/2\/lists\b/.test(t)) return "list_read";
  if (/\/2\/users(\/[^/]*|\/by(\/username\/[^/]+)?|\/me)?$/.test(t)) return "user_read";
  return "default_read";
}

/** Determine whether the upstream call is an "owned read" (against the
 *  developer account's own data). Returns true only when account_id matches
 *  the configured/auto-detected owner_user_id. */
export function isOwned(
  accountId: string | null | undefined,
  ownerUserId: string | null | undefined,
): boolean {
  return !!ownerUserId && !!accountId && accountId === ownerUserId;
}

/** Per-resource USD rate for a given (endpoint, account, owner) triple. */
export function ratePerResourceUsd(args: {
  endpointTemplate: string | null;
  accountId: string | null | undefined;
  ownerUserId: string | null | undefined;
  rates: BillingRates;
}): number {
  if (isOwned(args.accountId, args.ownerUserId)) return args.rates.owned_read;
  const kind = classifyEndpoint(args.endpointTemplate);
  return args.rates[kind];
}

/** Compute the USD cost of a single upstream call. Returns 0 for non-billable
 *  events (cache hits, gate-blocked, errors). */
export function computeCostUsd(args: {
  source: "live" | "cache" | "gate_blocked" | "error";
  status: number;
  resultCount: number | null;
  endpointTemplate: string | null;
  accountId: string | null | undefined;
  ownerUserId: string | null | undefined;
  rates: BillingRates;
}): number {
  if (args.source !== "live") return 0;
  if (args.status < 200 || args.status >= 300) return 0;
  if (args.resultCount == null || args.resultCount <= 0) return 0;
  return args.resultCount * ratePerResourceUsd(args);
}

// ---------- Billing-period start computation ----------

/** Compute the most recent billing-period start at-or-before `now`.
 *  - Anchor day is clamped: 29-31 floor to the actual last day of the month.
 *  - Time is HH:MM in UTC.
 *  - If `now` is before this month's anchor, roll back to last month's anchor. */
export function currentPeriodStart(now: Date, day: number, time: string): Date {
  const hm = parseHHMM(time);
  const anchorThisMonth = anchorFor(now.getUTCFullYear(), now.getUTCMonth(), day, hm.h, hm.m);
  if (anchorThisMonth.getTime() <= now.getTime()) return anchorThisMonth;
  // Roll back one month.
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() - 1;
  if (m < 0) {
    m = 11;
    y -= 1;
  }
  return anchorFor(y, m, day, hm.h, hm.m);
}

function anchorFor(
  year: number,
  monthIdx: number,
  desiredDay: number,
  hh: number,
  mm: number,
): Date {
  const lastDay = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  const day = Math.min(Math.max(1, desiredDay), lastDay);
  return new Date(Date.UTC(year, monthIdx, day, hh, mm, 0, 0));
}

function parseHHMM(s: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Invalid HH:MM time string: "${s}"`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || h < 0 || h > 23) throw new Error(`Invalid hour in "${s}"`);
  if (!Number.isFinite(mi) || mi < 0 || mi > 59) throw new Error(`Invalid minute in "${s}"`);
  return { h, m: mi };
}

// ---------- proxy_meta-backed state ----------

const KEY_TOTAL_MICROS = "billing_period_total_micros";
const KEY_PERIOD_START = "billing_period_started_at";
const KEY_OWNER = "owner_user_id";

/** Write a billable cost into the running period total, with auto-rollover. */
export function recordUpstreamBilling(
  costUsd: number,
  cfg: BillingConfig,
  nowMs: number = Date.now(),
): { period_total_usd: number; period_started_iso: string } {
  if (!cfg.enabled) {
    return getPeriodSnapshot(cfg, nowMs);
  }
  const costMicros = Math.round(costUsd * 1_000_000);
  const currentStart = currentPeriodStart(
    new Date(nowMs),
    cfg.period_start_day,
    cfg.period_start_time,
  ).getTime();

  const d = getDb();
  const txn = d.transaction(() => {
    const startedRow = d
      .prepare("SELECT value FROM proxy_meta WHERE key = ?")
      .get(KEY_PERIOD_START) as { value: string } | undefined;
    const totalRow = d
      .prepare("SELECT value FROM proxy_meta WHERE key = ?")
      .get(KEY_TOTAL_MICROS) as { value: string } | undefined;
    let storedStart = startedRow ? Number(startedRow.value) : 0;
    let storedTotal = totalRow ? Number(totalRow.value) : 0;
    if (!Number.isFinite(storedStart) || storedStart < currentStart) {
      // Rollover (or first-time init).
      storedStart = currentStart;
      storedTotal = 0;
    }
    storedTotal += costMicros;
    upsertMeta(KEY_PERIOD_START, String(storedStart), nowMs);
    upsertMeta(KEY_TOTAL_MICROS, String(storedTotal), nowMs);
    return { storedStart, storedTotal };
  });
  const out = txn();
  return {
    period_total_usd: microsToUsd(out.storedTotal),
    period_started_iso: new Date(out.storedStart).toISOString(),
  };
}

/** Read the current period state without modifying it. Performs a rollover if
 *  the stored period_started_at is older than the current period start (so
 *  callers always see consistent values even on the first read of a new period). */
export function getPeriodSnapshot(
  cfg: BillingConfig,
  nowMs: number = Date.now(),
): { period_total_usd: number; period_started_iso: string } {
  if (!cfg.enabled) {
    return { period_total_usd: 0, period_started_iso: new Date(0).toISOString() };
  }
  const currentStart = currentPeriodStart(
    new Date(nowMs),
    cfg.period_start_day,
    cfg.period_start_time,
  ).getTime();
  const d = getDb();
  const startedRow = d
    .prepare("SELECT value FROM proxy_meta WHERE key = ?")
    .get(KEY_PERIOD_START) as { value: string } | undefined;
  const totalRow = d.prepare("SELECT value FROM proxy_meta WHERE key = ?").get(KEY_TOTAL_MICROS) as
    | { value: string }
    | undefined;
  let storedStart = startedRow ? Number(startedRow.value) : 0;
  let storedTotal = totalRow ? Number(totalRow.value) : 0;
  if (!Number.isFinite(storedStart) || storedStart < currentStart) {
    storedStart = currentStart;
    storedTotal = 0;
    upsertMeta(KEY_PERIOD_START, String(storedStart), nowMs);
    upsertMeta(KEY_TOTAL_MICROS, "0", nowMs);
  }
  return {
    period_total_usd: microsToUsd(storedTotal),
    period_started_iso: new Date(storedStart).toISOString(),
  };
}

export function getOwnerUserId(): string | null {
  const row = getDb().prepare("SELECT value FROM proxy_meta WHERE key = ?").get(KEY_OWNER) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setOwnerUserId(userId: string, nowMs: number = Date.now()): void {
  upsertMeta(KEY_OWNER, userId, nowMs);
}

/** Resolve the owner_user_id for billing. Resolution order:
 *  1. Configured override (cfg.billing.owner_user_id) — wins, persisted.
 *  2. Previously stored value in proxy_meta — returned without network.
 *  3. Live GET /2/users/me, persisted on success.
 *  Returns null on failure (caller should log and continue; non-owned rates
 *  will apply until the next attempt). */
export async function resolveOwnerUserId(args: {
  cfg: BillingConfig;
  bearerToken: string;
  apiBase: string;
}): Promise<string | null> {
  if (args.cfg.owner_user_id && args.cfg.owner_user_id.length > 0) {
    setOwnerUserId(args.cfg.owner_user_id);
    return args.cfg.owner_user_id;
  }
  const stored = getOwnerUserId();
  if (stored) return stored;
  const res = await xapiFetch(
    { bearerToken: args.bearerToken, apiBase: args.apiBase },
    { path: "/2/users/me", params: {} },
  );
  if (!res.ok || !res.json) return null;
  const id = (res.json as { data?: { id?: string } }).data?.id;
  if (typeof id === "string" && id.length > 0) {
    setOwnerUserId(id);
    return id;
  }
  return null;
}

function upsertMeta(key: string, value: string, nowMs: number): void {
  getDb()
    .prepare(
      `INSERT INTO proxy_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, nowMs);
}

function microsToUsd(micros: number): number {
  // Truncate to 6 decimals for display; we already store integer micros so
  // the number is exact at this precision.
  return Math.round(micros) / 1_000_000;
}

// ---------- Convenience: log-event-shaped helper ----------

/** Compute and record cost for one upstream event. Safe to call for cache /
 *  gate_blocked / error events — those return cost=0 and don't increment the
 *  period total. */
export function recordCostForEvent(args: {
  source: "live" | "cache" | "gate_blocked" | "error";
  status: number;
  resultCount: number | null;
  endpointTemplate: string | null;
  accountId: string | null | undefined;
  cfg: BillingConfig;
  ownerUserId: string | null | undefined;
}): { cost_usd: number; period_total_usd: number; period_started_iso: string } {
  const cost = computeCostUsd({
    source: args.source,
    status: args.status,
    resultCount: args.resultCount,
    endpointTemplate: args.endpointTemplate,
    accountId: args.accountId,
    ownerUserId: args.ownerUserId,
    rates: args.cfg.rates,
  });
  if (cost <= 0) {
    const snap = getPeriodSnapshot(args.cfg);
    return { cost_usd: 0, ...snap };
  }
  const after = recordUpstreamBilling(cost, args.cfg);
  return { cost_usd: cost, ...after };
}
