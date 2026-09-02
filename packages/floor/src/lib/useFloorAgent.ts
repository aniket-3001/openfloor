import { useCallback, useEffect, useRef, useState } from "react";
import type { AuctionState, BidMandate } from "@openfloor/shared";
import { decide, fmt, plan, replan, PERSONAS, type AgentPlan } from "@openfloor/shared";
import { api, type PublicLot } from "./api";

/**
 * An agent that bids for the visitor, on the floor itself.
 *
 * WHY THIS IS HERE RATHER THAN ONLY IN THE CONSOLE
 * ------------------------------------------------
 * The single most important moment in this project is an agent stopping
 * mid-auction to ask its human for permission. It was, until now, four steps
 * deep: open a second site, fill in three limits, submit, then wait. Almost
 * nobody arriving at the floor would ever see it, so the page showed bidding
 * bots and kept the actual idea out of sight.
 *
 * The loop is the same four-stage policy the rival agents use, with the same
 * server-side enforcement — nothing here is privileged, and nothing here
 * decides what is allowed. It proposes; the server disposes.
 */
export function useFloorAgent(params: {
  bidderId: string;
  state: AuctionState | null;
  lot: PublicLot | null;
  mandate: BidMandate | null;
  /** The lot the human actually delegated on. */
  delegatedLotId: string | null;
  onActed: () => void;
}) {
  const { bidderId, state, lot, mandate, delegatedLotId, onActed } = params;
  const [lastLine, setLastLine] = useState<string | null>(null);
  const planRef = useRef<AgentPlan | null>(null);
  const lotIdRef = useRef<string | null>(null);
  const lastActedAt = useRef(0);
  const busy = useRef(false);
  const askedRaiseFor = useRef<string | null>(null);

  // A calm persona: it bids the minimum and stops without drama, which reads
  // as deliberate next to Rex's jumps rather than as another bot in the pile.
  const persona = PERSONAS.ada;

  const enabled = !!mandate?.auto_bid_enabled && !!bidderId;

  const tick = useCallback(async () => {
    if (!enabled || busy.current) return;
    if (!state?.lot || !lot || !mandate) return;
    if (state.lot.status !== "open" || state.seconds_remaining <= 0) return;

    // Consent is per item, not blanket. You handed over the bidding on the lot
    // in front of you; a different lot is a different decision, with a
    // different value and a different limit. So the agent stops at the
    // boundary and waits to be sent in again. This is also the honest reading
    // of what "bid for me" meant when you pressed it.
    if (delegatedLotId && state.lot.id !== delegatedLotId) {
      setLastLine(`The sale moved to ${lot.title}. Waiting for you to send it in again.`);
      return;
    }
    if (state.high_bidder_id === bidderId) {
      setLastLine("Holding the high bid — nothing to do.");
      return;
    }
    const now = Date.now();
    if (now - lastActedAt.current < 3000) return;

    busy.current = true;
    try {
      const obs = {
        lot_title: lot.title,
        lot_condition: lot.condition,
        estimate_low_cents: lot.estimate_low_cents,
        estimate_high_cents: lot.estimate_high_cents,
        current_price_cents: state.current_price_cents,
        min_increment_cents: state.min_increment_cents,
        seconds_remaining: state.seconds_remaining,
        bid_count: state.bid_count,
        reserve_met: state.reserve_met,
        am_i_high_bidder: false,
        ceiling_cents: mandate.ceiling_cents,
        notify_above_cents: mandate.notify_above_cents,
        headroom_to_ceiling_cents: Math.max(0, mandate.ceiling_cents - state.current_price_cents),
        in_supervised_band: state.current_price_cents >= mandate.notify_above_cents,
        recent_bidders: state.high_bidder_alias ? [state.high_bidder_alias] : [],
        strategy_note: mandate.strategy_note ?? "",
      };

      if (lotIdRef.current !== state.lot.id) {
        const fresh = planRef.current ? replan(planRef.current, obs, persona) : plan(obs, persona);
        // A delegated agent defers to its human's limit, not its own opinion of
        // what the lot is worth. Left to its own valuation it walks away at
        // roughly the estimate — often below the line its human drew — and the
        // supervised band is then never reached, so it never asks. You said
        // this much; it bids up to this much, and asks on the way.
        planRef.current = { ...fresh, walk_away_cents: mandate.ceiling_cents };
        lotIdRef.current = state.lot.id;
      }
      if (!planRef.current) return;

      const decision = decide(obs, planRef.current, persona);
      lastActedAt.current = Date.now();

      if (decision.action === "bid") {
        const out = await api.bid({
          bidder_id: bidderId,
          lot_id: state.lot.id,
          amount_cents: decision.amount_cents,
          rationale: decision.rationale,
          placed_by: "agent",
        });
        if (out.status === "accepted") {
          setLastLine(`Bid ${fmt(decision.amount_cents)}. ${decision.rationale}`);
        } else if (out.status === "awaiting_confirmation") {
          // The moment this whole feature exists for.
          setLastLine(`Asked you about ${fmt(decision.amount_cents)} — waiting on your answer.`);
        } else {
          setLastLine(out.message);
        }
        onActed();
      } else if (decision.action === "out") {
        // Priced out. If the wall it hit is the human's ceiling rather than its
        // own judgement, quitting silently is the wrong move: a new lot opens
        // above the ceiling that was set against the previous one, and the
        // agent would simply go dead with nothing on screen to say why. It
        // cannot lift its own ceiling — so it asks.
        const next = state.current_price_cents + state.min_increment_cents;
        if (next > mandate.ceiling_cents && askedRaiseFor.current !== state.lot.id) {
          askedRaiseFor.current = state.lot.id;
          const wanted = state.current_price_cents + state.min_increment_cents * 10;
          await api.requestCeilingRaise({
            bidder_id: bidderId,
            requested_ceiling_cents: wanted,
            justification: `${lot.title} opened above the limit you set on the last lot.`,
          });
          setLastLine(`Asked you to raise the limit to ${fmt(wanted)} — it cannot do that itself.`);
          onActed();
        } else {
          setLastLine(decision.rationale);
        }
      } else if (decision.action === "hold") {
        setLastLine(decision.rationale);
      } else if (decision.action === "request_raise") {
        if (askedRaiseFor.current !== state.lot.id) {
          askedRaiseFor.current = state.lot.id;
          await api.requestCeilingRaise({
            bidder_id: bidderId,
            requested_ceiling_cents: decision.requested_ceiling_cents,
            justification: decision.rationale,
          });
          onActed();
        }
        setLastLine(`Asked you to raise the limit — it cannot do that itself.`);
      }
    } catch {
      /* transient; the next tick retries */
    } finally {
      busy.current = false;
    }
  }, [enabled, state, lot, mandate, bidderId, persona, delegatedLotId, onActed]);

  useEffect(() => {
    if (!enabled) {
      setLastLine(null);
      return;
    }
    const t = setInterval(() => void tick(), 2500);
    return () => clearInterval(t);
  }, [enabled, tick]);

  const needsNewLotConsent =
    enabled && !!delegatedLotId && !!state?.lot && state.lot.id !== delegatedLotId;

  return { agentLine: lastLine, agentRunning: enabled, needsNewLotConsent };
}

/**
 * Sensible opening limits.
 *
 * The ask line is set just above the current price rather than at the lot's
 * estimate. Two failures drove that. Anchored to an estimate, the agent bid
 * autonomously for thirty increments before reaching the line, so on a fast
 * lot the question never came — and a mandate covers the whole catalogue, so
 * a line drawn against a $280 watch left the agent bidding freely on a $30
 * camera afterwards.
 *
 * Erring low means the agent asks more often than strictly necessary. That is
 * the right direction to err in: asking is the safe behaviour and it is the
 * behaviour worth seeing. The ceiling stays generous, from the lot's own
 * estimate, so it is not immediately priced out when the sale moves on.
 */
export function suggestedLimits(
  currentCents: number,
  incrementCents: number,
  estimateHighCents?: number,
) {
  const inc = Math.max(incrementCents, 50);
  const notify = currentCents + inc * 2;
  const ceiling = Math.max(Math.round((estimateHighCents ?? currentCents * 3) * 1.5), notify + inc * 10);
  return {
    notify_above_cents: notify,
    ceiling_cents: ceiling,
    total_budget_cents: ceiling * 3,
  };
}
