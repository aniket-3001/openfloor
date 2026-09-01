import { loadConfig } from "@openfloor/shared";
import type { AuctionState, AuditEntry, BidMandate, BidResult, Lot } from "@openfloor/shared";

/**
 * API client for the bidder console.
 *
 * `VITE_API_BASE` points at the auction house's Worker — a DIFFERENT origin
 * from this console. That separation is the point: it is what makes the
 * cross-origin trust boundary real rather than a same-page simulation.
 */
const CONFIG = loadConfig();
// Empty means same-origin, which is what `vite dev` uses via its proxy.
const BASE = CONFIG.apiBase || "http://localhost:8787";
const ROOM = CONFIG.room;

function url(path: string, params: Record<string, string | number> = {}): string {
  const u = new URL(`${BASE}/api${path}`, typeof window !== "undefined" ? window.location.origin : undefined);
  u.searchParams.set("room", ROOM);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

async function get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const res = await fetch(url(path, params), { credentials: "include" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(url(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  return (await res.json().catch(() => ({}))) as T;
}

export type PublicLot = Omit<Lot, "reserve_cents">;

export interface Headroom {
  ceiling_cents: number;
  notify_above_cents: number;
  headroom_to_ceiling_cents: number;
  headroom_to_notify_cents: number;
  in_supervised_band: boolean;
  /** Present only when the human set a session budget. */
  total_budget_cents?: number;
  committed_cents?: number;
  budget_remaining_cents?: number;
}

export const API_BASE = BASE;

export const api = {
  state: () => get<{ state: AuctionState }>("/state"),
  lot: () => get<{ lot: PublicLot | null }>("/lot"),
  history: (limit = 10) =>
    get<{
      bids: { alias: string; amount_cents: number; placed_by: "human" | "agent"; human_confirmed: boolean; at: string }[];
    }>("/history", { limit }),
  audit: () => get<{ entries: AuditEntry[] }>("/audit"),
  join: (body: { bidder_id: string; alias: string }) =>
    post<{ alias: string; flagged: boolean }>("/join", body),
  setMandate: (body: {
    bidder_id: string;
    ceiling_cents: number;
    notify_above_cents: number;
    total_budget_cents?: number;
    strategy_note?: string;
    auto_bid_enabled?: boolean;
  }) => post<{ mandate: BidMandate }>("/mandate", body),
  getMandate: (bidder_id: string) =>
    get<{ mandate: BidMandate | null; headroom?: Headroom }>("/mandate", { bidder_id }),
  bid: (body: {
    bidder_id: string;
    lot_id: string;
    amount_cents: number;
    rationale?: string;
    placed_by: "human" | "agent";
    confirmation_id?: string;
  }) => post<BidResult>("/bid", body),
  withdraw: (body: { bidder_id: string; lot_id: string; reason?: string }) =>
    post<{ ok: boolean }>("/withdraw", body),
  confirm: (body: { confirmation_id: string; approved: boolean }) =>
    post<{ ok: boolean; placed: boolean }>("/confirm", body),
  requestCeilingRaise: (body: {
    bidder_id: string;
    requested_ceiling_cents: number;
    justification: string;
  }) => post<{ request: { id: string } }>("/ceiling-raise", body),
  resolveCeilingRaise: (body: { request_id: string; approved: boolean }) =>
    post<{ ok: boolean }>("/ceiling-raise/resolve", body),

  wsUrl(): string {
    const u = new URL(`${BASE}/api/ws`, typeof window !== "undefined" ? window.location.origin : undefined);
    u.protocol = u.protocol.replace("http", "ws");
    u.searchParams.set("room", ROOM);
    return u.toString();
  },
};
