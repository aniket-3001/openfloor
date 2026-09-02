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
  onActed: () => void;
}) {
  const { bidderId, state, lot, mandate, onActed } = params;
  const [lastLine, setLastLine] = useState<string | null>(null);
  const planRef = useRef<AgentPlan | null>(null);
  const lotIdRef = useRef<string | null>(null);
  const lastActedAt = useRef(0);
  const busy = useRef(false);

  // A calm persona: it bids the minimum and stops without drama, which reads
  // as deliberate next to Rex's jumps rather than as another bot in the pile.
  const persona = PERSONAS.ada;

  const enabled = !!mandate?.auto_bid_enabled && !!bidderId;

  const tick = useCallback(async () => {
    if (!enabled || busy.current) return;
    if (!state?.lot || !lot || !mandate) return;
    if (state.lot.status !== "open" || state.seconds_remaining <= 0) return;
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
        setLastLine(decision.rationale);
      } else if (decision.action === "hold") {
        setLastLine(decision.rationale);
      } else if (decision.action === "request_raise") {
        setLastLine(`Wants a higher limit: ${decision.rationale}`);
      }
    } catch {
      /* transient; the next tick retries */
    } finally {
      busy.current = false;
    }
  }, [enabled, state, lot, mandate, bidderId, persona, onActed]);

  useEffect(() => {
    if (!enabled) {
      setLastLine(null);
      return;
    }
    const t = setInterval(() => void tick(), 2500);
    return () => clearInterval(t);
  }, [enabled, tick]);

  return { agentLine: lastLine, agentRunning: enabled };
}

/**
 * Limits calibrated so the ask actually happens while someone is watching.
 *
 * A demo whose supervised band sits far above the current price is a demo
 * where the agent bids quietly and nothing interesting occurs. These are
 * relative to the live price: a couple of free bids, then a question.
 */
export function suggestedLimits(currentCents: number, incrementCents: number) {
  const inc = Math.max(incrementCents, 50);
  // Wide enough that the rivals cannot run the price past the ceiling before
  // the supervised band is ever reached — which turns the ask into a request
  // for a higher limit and loses the moment entirely.
  const ceiling = currentCents + inc * 30;
  return {
    notify_above_cents: currentCents + inc * 2,
    ceiling_cents: ceiling,
    total_budget_cents: ceiling * 3,
  };
}
