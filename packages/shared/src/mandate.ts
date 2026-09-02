/**
 * Mandate signing, verification, and enforcement.
 *
 * The mandate is the trust boundary of the whole system. An agent operates
 * inside a band its human set, and CANNOT leave it:
 *
 *   $0 ───── notify_above ───── ceiling ─────► ∞
 *      autonomous      supervised       IMPOSSIBLE
 *      (agent bids)    (human confirms) (hard wall)
 *
 * Enforcement lives here and is called SERVER-SIDE ONLY. Client-side checks
 * exist for UX responsiveness; they are never the authority. An agent that
 * hallucinates a number, or a tampered client that lies, changes nothing.
 */

import type { BidMandate, BidStatus } from "./types.js";

/**
 * Canonical serialization for signing.
 *
 * Field order is fixed and explicit — relying on JSON.stringify key ordering
 * would make signatures depend on object construction order, which is a subtle
 * way to end up with valid mandates that fail verification.
 */
export function canonicalMandate(m: Omit<BidMandate, "signature">): string {
  return [
    m.mandate_id,
    m.bidder_id,
    [...m.lot_ids].sort().join(","),
    String(m.ceiling_cents),
    String(m.notify_above_cents),
    String(m.total_budget_cents ?? ""),
    String(m.auto_bid_enabled),
    m.strategy_note,
    m.expires_at,
    m.created_at,
  ].join("|");
}

/** HMAC-SHA256 over the canonical form. Uses WebCrypto (available in Workers and browsers). */
export async function signMandate(
  mandate: Omit<BidMandate, "signature">,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonicalMandate(mandate)),
  );
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time-ish comparison. Avoids leaking signature bytes via early exit. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyMandate(mandate: BidMandate, secret: string): Promise<boolean> {
  const { signature, ...rest } = mandate;
  const expected = await signMandate(rest, secret);
  return safeEqual(signature, expected);
}

export interface EnforcementInput {
  mandate: BidMandate;
  lot_id: string;
  amount_cents: number;
  current_price_cents: number;
  min_increment_cents: number;
  lot_open: boolean;
  /** True if this bidder already holds the high bid — bidding against yourself is rejected. */
  is_high_bidder: boolean;
  now: Date;
  /** Set when a human already approved this exact amount via a confirmation card. */
  human_confirmed?: boolean;
  /**
   * Total already committed across the session, in cents — winning bids on
   * closed lots plus any lot where this bidder currently holds the high bid.
   * Server-computed, like every other figure the agent is given.
   */
  committed_cents?: number;
}

export interface EnforcementOutcome {
  status: BidStatus;
  message: string;
}

/**
 * The single decision point for whether a bid may proceed.
 *
 * Ordering matters and is deliberate: mandate validity is checked BEFORE
 * auction mechanics, so an expired or forged mandate never gets a message that
 * leaks live auction state.
 */
export function enforceMandate(input: EnforcementInput): EnforcementOutcome {
  const {
    mandate,
    lot_id,
    amount_cents,
    current_price_cents,
    min_increment_cents,
    lot_open,
    is_high_bidder,
    now,
    human_confirmed = false,
    committed_cents = 0,
  } = input;

  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    return { status: "rejected_increment", message: "Bid must be a positive whole number of cents." };
  }

  if (new Date(mandate.expires_at).getTime() <= now.getTime()) {
    return {
      status: "rejected_mandate_expired",
      message: "Your bidding mandate has expired. Ask your human to issue a new one.",
    };
  }

  if (!mandate.auto_bid_enabled && !human_confirmed) {
    return {
      status: "rejected_not_authorized",
      message: "Automatic bidding is switched off for this mandate.",
    };
  }

  if (!mandate.lot_ids.includes(lot_id)) {
    return {
      status: "rejected_not_authorized",
      message: "Your mandate does not cover this lot.",
    };
  }

  // THE HARD WALL. No path exists past this check — there is no tool that
  // raises a ceiling, only `request_ceiling_raise`, which asks a human.
  if (amount_cents > mandate.ceiling_cents) {
    return {
      status: "rejected_ceiling",
      message:
        `Blocked: ${fmt(amount_cents)} exceeds your mandate ceiling of ` +
        `${fmt(mandate.ceiling_cents)}. You cannot raise this yourself — ` +
        `call request_ceiling_raise to ask your human.`,
    };
  }

  // THE SESSION WALL. The per-bid ceiling above bounds one bid; this bounds the
  // whole session. Without it a mandate covering three lots at an $80 ceiling
  // permits $240 of spend, which is not what a person means by "up to $80".
  if (mandate.total_budget_cents !== undefined) {
    const wouldCommit = committed_cents + amount_cents;
    if (wouldCommit > mandate.total_budget_cents) {
      return {
        status: "rejected_budget",
        message:
          `Blocked: ${fmt(amount_cents)} would take your total commitment to ` +
          `${fmt(wouldCommit)}, past the session budget of ` +
          `${fmt(mandate.total_budget_cents)}. You have ` +
          `${fmt(Math.max(0, mandate.total_budget_cents - committed_cents))} left across all lots. ` +
          `You cannot raise this yourself.`,
      };
    }
  }

  if (!lot_open) {
    return { status: "rejected_closed", message: "This lot is closed. No further bids." };
  }

  if (is_high_bidder) {
    return {
      status: "rejected_self_bid",
      message: "You already hold the high bid. Bidding against yourself is not allowed.",
    };
  }

  const minimum = current_price_cents + min_increment_cents;
  if (amount_cents < minimum) {
    return {
      status: "rejected_increment",
      message: `Too low. Minimum acceptable bid is ${fmt(minimum)}.`,
    };
  }

  // Supervised band: valid, but needs a human. The bid is NOT placed here.
  if (amount_cents > mandate.notify_above_cents && !human_confirmed) {
    return {
      status: "awaiting_confirmation",
      message:
        `${fmt(amount_cents)} is above your notify threshold of ` +
        `${fmt(mandate.notify_above_cents)}. Waiting for your human to approve. ` +
        `The bid has NOT been placed.`,
    };
  }

  return { status: "accepted", message: `Bid of ${fmt(amount_cents)} accepted.` };
}

/**
 * Remaining headroom, computed SERVER-SIDE and injected into the agent's context.
 *
 * Agents never compute money themselves — this is the AucArena "auctioneer
 * corrects the bidder's arithmetic" insight (arXiv 2310.05746), taken further:
 * the agent decides strategy, the server owns every number.
 */
export function headroom(mandate: BidMandate, current_price_cents: number, committed_cents = 0) {
  const budget = mandate.total_budget_cents;
  return {
    ceiling_cents: mandate.ceiling_cents,
    notify_above_cents: mandate.notify_above_cents,
    headroom_to_ceiling_cents: Math.max(0, mandate.ceiling_cents - current_price_cents),
    headroom_to_notify_cents: Math.max(0, mandate.notify_above_cents - current_price_cents),
    in_supervised_band: current_price_cents >= mandate.notify_above_cents,
    total_budget_cents: budget,
    committed_cents,
    budget_remaining_cents: budget === undefined ? undefined : Math.max(0, budget - committed_cents),
  };
}

export function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
