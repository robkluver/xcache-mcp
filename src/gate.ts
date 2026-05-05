import { getDb } from "./cache.js";
import { intervalForOperation, intervalForError } from "./config.js";

export type GateRow = {
  operation: string;
  account_id: string;
  last_fetched_at: number;
  last_status: number | null;
  last_error: string | null;
};

export type GateState = {
  open: boolean;
  reason:
    | "first_call"
    | "interval_elapsed"
    | "never_after_success"
    | "interval_not_elapsed"
    | "never_after_error";
  last_fetched_at: number | null;
  last_status: number | null;
  next_eligible_at: number | null;
};

export function readGate(operation: string, account_id: string): GateRow | undefined {
  return getDb()
    .prepare("SELECT * FROM fetch_gate WHERE operation = ? AND account_id = ?")
    .get(operation, account_id) as GateRow | undefined;
}

function effectiveInterval(operation: string, row: GateRow): number | "never" | "always" {
  if (row.last_status && row.last_status >= 400) {
    return intervalForError(row.last_status);
  }
  if (row.last_error && !row.last_status) {
    return intervalForError("network");
  }
  return intervalForOperation(operation);
}

export function gateState(
  operation: string,
  account_id: string,
  now: number = Date.now(),
): GateState {
  const row = readGate(operation, account_id);
  if (!row) {
    return {
      open: true,
      reason: "first_call",
      last_fetched_at: null,
      last_status: null,
      next_eligible_at: null,
    };
  }
  const interval = effectiveInterval(operation, row);
  if (interval === "never") {
    if (row.last_status && row.last_status >= 400) {
      return {
        open: false,
        reason: "never_after_error",
        last_fetched_at: row.last_fetched_at,
        last_status: row.last_status,
        next_eligible_at: null,
      };
    }
    return {
      open: false,
      reason: "never_after_success",
      last_fetched_at: row.last_fetched_at,
      last_status: row.last_status,
      next_eligible_at: null,
    };
  }
  if (interval === "always") {
    return {
      open: true,
      reason: "interval_elapsed",
      last_fetched_at: row.last_fetched_at,
      last_status: row.last_status,
      next_eligible_at: row.last_fetched_at,
    };
  }
  const next = row.last_fetched_at + interval;
  if (now >= next) {
    return {
      open: true,
      reason: "interval_elapsed",
      last_fetched_at: row.last_fetched_at,
      last_status: row.last_status,
      next_eligible_at: next,
    };
  }
  return {
    open: false,
    reason: "interval_not_elapsed",
    last_fetched_at: row.last_fetched_at,
    last_status: row.last_status,
    next_eligible_at: next,
  };
}

export function writeGateSuccess(args: {
  operation: string;
  account_id: string;
  status: number;
  when?: number;
}): void {
  const now = args.when ?? Date.now();
  getDb()
    .prepare(
      `INSERT INTO fetch_gate (operation, account_id, last_fetched_at, last_status, last_error)
         VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(operation, account_id) DO UPDATE SET
         last_fetched_at = excluded.last_fetched_at,
         last_status = excluded.last_status,
         last_error = NULL`,
    )
    .run(args.operation, args.account_id, now, args.status);
}

export function writeGateError(args: {
  operation: string;
  account_id: string;
  status: number | null;
  error: string;
  when?: number;
}): void {
  const now = args.when ?? Date.now();
  getDb()
    .prepare(
      `INSERT INTO fetch_gate (operation, account_id, last_fetched_at, last_status, last_error)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(operation, account_id) DO UPDATE SET
         last_fetched_at = excluded.last_fetched_at,
         last_status = excluded.last_status,
         last_error = excluded.last_error`,
    )
    .run(args.operation, args.account_id, now, args.status, args.error);
}

export function nextEligibleIso(operation: string, account_id: string): string | null {
  const s = gateState(operation, account_id);
  if (s.next_eligible_at == null) return null;
  return new Date(s.next_eligible_at).toISOString();
}

export function lastFetchedIso(operation: string, account_id: string): string | null {
  const s = gateState(operation, account_id);
  if (s.last_fetched_at == null) return null;
  return new Date(s.last_fetched_at).toISOString();
}

export { intervalForOperation };
