import { loadConfig } from "@openfloor/shared";
import type {
  AuctionState,
  AuditEntry,
  BidResult,
  BidMandate,
  Lot,
} from "@openfloor/shared";

/**
 * API client for the auction house.
 *
 * `VITE_API_BASE` lets the bidder consoles point at the floor's origin, which
 * is what makes the cross-origin path real rather than simulated. Left unset,
 * calls are same-origin and go through the Vite dev proxy.
 */
const CONFIG = loadConfig();
const BASE = CONFIG.apiBase;
const ROOM = CONFIG.room;

function url(path: string, params: Record<string, string | number> = {}): string {
  const u = new URL(`${BASE}/api${path}`, BASE || window.location.origin);
  u.searchParams.set("room", ROOM);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

async function get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const res = await fetch(url(path, params), { credentials: "omit" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(url(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
  });
  // A non-2xx still carries a structured body for bid outcomes — parse it
  // rather than throwing, so an agent gets the real reason instead of "500".
  //
  // But an UNPARSEABLE body is a different thing entirely and must not be
  // swallowed into `{}`. A real-browser probe caught exactly that: a failed
  // call produced an empty object, and the tool cheerfully reported
  // "If you bid $50.00: undefined" to the agent. Silent empties become
  // confident nonsense in an agent's context, so this throws instead.
  const text = await res.text();
  if (!text) {
    throw new Error(`${path} returned an empty response (HTTP ${res.status})`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} returned a non-JSON response (HTTP ${res.status})`);
  }
}

/** Safe lot shape — the server strips `reserve_cents` before it ever leaves. */
export type PublicLot = Omit<Lot, "reserve_cents">;

export const api = {
  state: () => get<{ state: AuctionState }>("/state"),
  lot: () => get<{ lot: PublicLot | null }>("/lot"),
  history: (limit = 10) =>
    get<{
      bids: {
        alias: string;
        amount_cents: number;
        placed_by: "human" | "agent";
        human_confirmed: boolean;
        at: string;
      }[];
    }>("/history", { limit }),
  audit: () => get<{ entries: AuditEntry[] }>("/audit"),

  join: (body: { bidder_id: string; alias: string }) =>
    post<{ alias: string; flagged: boolean }>("/join", body),

  setMandate: (body: {
    bidder_id: string;
    ceiling_cents: number;
    notify_above_cents: number;
    strategy_note?: string;
    auto_bid_enabled?: boolean;
  }) => post<{ mandate: BidMandate }>("/mandate", body),

  getMandate: (bidder_id: string) =>
    get<{
      mandate: BidMandate | null;
      headroom?: {
        ceiling_cents: number;
        notify_above_cents: number;
        headroom_to_ceiling_cents: number;
        headroom_to_notify_cents: number;
        in_supervised_band: boolean;
      };
    }>("/mandate", { bidder_id }),

  bid: (body: {
    bidder_id: string;
    lot_id: string;
    amount_cents: number;
    rationale?: string;
    placed_by: "human" | "agent";
    confirmation_id?: string;
  }) => post<BidResult>("/bid", body),

  checkBid: (body: { bidder_id: string; amount_cents: number }) =>
    post<{
      would: string;
      message: string;
      current_price_cents: number;
      min_increment_cents: number;
      ceiling_cents?: number;
      notify_above_cents?: number;
      headroom_to_ceiling_cents?: number;
      in_supervised_band?: boolean;
    }>("/check-bid", body),

  withdraw: (body: { bidder_id: string; lot_id: string; reason?: string }) =>
    post<{ ok: boolean }>("/withdraw", body),

  confirm: (body: { confirmation_id: string; approved: boolean }) =>
    post<{ ok: boolean; placed: boolean }>("/confirm", body),

  requestCeilingRaise: (body: {
    bidder_id: string;
    requested_ceiling_cents: number;
    justification: string;
  }) => post<{ request: unknown }>("/ceiling-raise", body),

  resolveCeilingRaise: (body: { request_id: string; approved: boolean }) =>
    post<{ ok: boolean }>("/ceiling-raise/resolve", body),

  start: () => post<{ state: AuctionState }>("/start", {}),
  next: () => post<{ state: AuctionState }>("/next", {}),
  reset: () => post<{ ok: boolean }>("/reset", {}),

  /** WebSocket URL for live events. */
  wsUrl(): string {
    const base = BASE || window.location.origin;
    const u = new URL(`${base}/api/ws`);
    u.protocol = u.protocol.replace("http", "ws");
    u.searchParams.set("room", ROOM);
    return u.toString();
  },
};
