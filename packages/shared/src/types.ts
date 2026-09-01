/**
 * Core domain types for OpenFloor.
 *
 * Money is ALWAYS integer cents. Never floats — a rounding error in an auction
 * is a real bug, and agents are notoriously bad at decimal arithmetic. See
 * `docs/ARCHITECTURE.md` §"Agents never do money math".
 */

export type LotStatus = "pending" | "open" | "closing" | "sold" | "passed";

export interface Lot {
  id: string;
  title: string;
  description: string;
  condition: "Mint" | "Excellent" | "Good" | "Fair";
  /** Seller's public estimate range. The true value is never disclosed. */
  estimate_low_cents: number;
  estimate_high_cents: number;
  starting_price_cents: number;
  min_increment_cents: number;
  /**
   * Hidden reserve. NEVER leaves the server — `get_auction_state` exposes only
   * the boolean `reserve_met`, so an agent cannot snipe the reserve exactly.
   */
  reserve_cents: number;
  image_ref: string;
  status: LotStatus;
}

export interface Bid {
  id: string;
  lot_id: string;
  bidder_id: string;
  /** Display name chosen by the bidder — UNTRUSTED, attacker-controlled text. */
  bidder_alias: string;
  amount_cents: number;
  /** Whether a human typed this bid or an agent placed it. */
  placed_by: "human" | "agent";
  /** Agent's one-line reason, shown in the audit trail. Untrusted. */
  rationale?: string;
  /** True when a human explicitly approved this bid via a confirmation card. */
  human_confirmed: boolean;
  created_at: string;
}

/**
 * A signed, time-bounded statement of the constraints an agent must bid within.
 *
 * Design lineage: this is an IntentMandate-SHAPED pattern borrowed from Google's
 * AP2 (Agent Payments Protocol). We implement the shape — signed, expiring,
 * human-confirmed constraints — NOT the protocol. No AP2 conformance is claimed.
 */
export interface BidMandate {
  mandate_id: string;
  bidder_id: string;
  /** Which lots this mandate authorizes bidding on. */
  lot_ids: string[];
  /**
   * HARD cap. Server-enforced. No tool anywhere allows an agent to raise this —
   * the most an agent can do is call `request_ceiling_raise` and ask its human.
   */
  ceiling_cents: number;
  /** Soft threshold: above this, every bid needs explicit human approval. */
  notify_above_cents: number;
  /**
   * Optional cap on TOTAL exposure across every lot in the session.
   *
   * `ceiling_cents` bounds a single bid. Without this, a mandate covering three
   * lots at an $80 ceiling permits $240 of spend — honest about each bid and
   * silent about the total, which is not what "up to $80" means to a person.
   * Undefined leaves the per-bid ceiling as the only bound.
   */
  total_budget_cents?: number;
  /** Master switch. Flipping to false halts all agent bidding immediately. */
  auto_bid_enabled: boolean;
  /** Free-text guidance, e.g. "only if condition is Excellent or better". */
  strategy_note: string;
  /** ISO 8601. Analogous to AP2's `intent_expiry`. */
  expires_at: string;
  created_at: string;
  /** HMAC over the canonical serialization. Verified server-side on every bid. */
  signature: string;
}

/** Every distinct outcome of a bid attempt. There is no silent failure. */
export type BidStatus =
  | "accepted"
  | "outbid_in_flight"
  | "awaiting_confirmation"
  | "rejected_ceiling"
  | "rejected_budget"
  | "rejected_increment"
  | "rejected_closed"
  | "rejected_mandate_expired"
  | "rejected_not_authorized"
  | "rejected_rate_limited"
  | "indeterminate";

export interface BidResult {
  status: BidStatus;
  message: string;
  current_price_cents: number;
  min_increment_cents: number;
  /** Present when status is `awaiting_confirmation`. */
  pending_confirmation_id?: string;
  /**
   * True only for `indeterminate`. Signals the agent MUST NOT retry — the
   * server outcome is unknown and a retry could double-bid.
   * (Pattern borrowed from vercel/shop PR #498.)
   */
  unsafe_to_retry?: boolean;
}

/**
 * Public auction state. This is what agents see.
 *
 * Deliberately absent: the hidden reserve amount, any other bidder's mandate or
 * ceiling, and raw server errors. See `docs/SECURITY.md` §"Output redaction".
 */
export interface AuctionState {
  room_id: string;
  lot: {
    id: string;
    title: string;
    status: LotStatus;
  } | null;
  current_price_cents: number;
  min_increment_cents: number;
  /** Untrusted (bidder-chosen) — rendered inside an untrusted envelope. */
  high_bidder_alias: string | null;
  high_bidder_id: string | null;
  /** Boolean only. The reserve AMOUNT never leaves the server. */
  reserve_met: boolean;
  seconds_remaining: number;
  round: number;
  bid_count: number;
  /** True while an anti-snipe extension is in effect. */
  clock_extended: boolean;
}

/** A pending human approval raised when an agent wants to bid above its notify threshold. */
export interface PendingConfirmation {
  id: string;
  bidder_id: string;
  lot_id: string;
  amount_cents: number;
  rationale: string;
  /** What the price was when the agent asked — lets the human see if it moved. */
  price_at_request_cents: number;
  created_at: string;
  expires_at: string;
}

/** An agent's request to raise its own ceiling. Requires human approval; never auto-granted. */
export interface CeilingRaiseRequest {
  id: string;
  bidder_id: string;
  mandate_id: string;
  current_ceiling_cents: number;
  requested_ceiling_cents: number;
  justification: string;
  created_at: string;
  status: "pending" | "approved" | "declined";
}

/** One immutable line in the public audit trail. */
export interface AuditEntry {
  id: string;
  seq: number;
  at: string;
  /** Which origin initiated this — makes the cross-origin trust boundary visible. */
  origin: string;
  /** Display name at the time. User-chosen and NOT unique — never filter on it. */
  actor: string;
  /**
   * Stable bidder id behind the action. Present for bidder-initiated entries.
   *
   * Filtering by alias leaked: two bidders may choose the same display name,
   * and an attacker could pick a victim's name deliberately to read their
   * activity. Identity filtering must use this.
   */
  actor_id?: string;
  actor_kind: "human" | "agent" | "system";
  action: string;
  detail: string;
  /** Set when a sanitizer flagged the input as a probable injection attempt. */
  flagged?: "injection_attempt" | "rate_limited" | "ceiling_blocked";
}

export type ServerEvent =
  | { type: "state"; state: AuctionState }
  | { type: "bid"; bid: Bid; state: AuctionState }
  | { type: "audit"; entry: AuditEntry }
  | { type: "confirmation_required"; confirmation: PendingConfirmation }
  | { type: "confirmation_resolved"; id: string; approved: boolean }
  | { type: "ceiling_raise_requested"; request: CeilingRaiseRequest }
  | { type: "lot_closed"; lot_id: string; winner_alias: string | null; final_price_cents: number }
  | { type: "error"; message: string };
