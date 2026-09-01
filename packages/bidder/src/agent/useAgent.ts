import { useCallback, useEffect, useRef, useState } from "react";
import type { AuctionState, BidMandate } from "@openfloor/shared";
import { fmt } from "@openfloor/shared";
import { api, API_BASE, type Headroom, type PublicLot } from "../lib/api";
import {
  decideWithModel,
  plan,
  replan,
  type AgentDecision,
  type AgentObservation,
  type AgentPlan,
  type Persona,
} from "@openfloor/shared";


export interface AgentLogEntry {
  id: string;
  at: string;
  stage: "plan" | "bid" | "belief" | "replan";
  text: string;
  outcome?: string;
}

/**
 * Drives the four-stage loop against live auction state.
 *
 * Cadence is deliberately throttled. An agent that re-decides on every socket
 * frame would hammer the room, burn tokens, and — more importantly — produce a
 * metronomic bid pattern that reads as a script rather than a participant.
 */
export function useAgent(params: {
  bidderId: string;
  persona: Persona;
  state: AuctionState | null;
  lot: PublicLot | null;
  mandate: BidMandate | null;
  headroom: Headroom | null;
  enabled: boolean;
  onNeedsRefresh: () => void;
}) {
  const { bidderId, persona, state, lot, mandate, headroom, enabled, onNeedsRefresh } = params;
  const [log, setLog] = useState<AgentLogEntry[]>([]);
  const [thinking, setThinking] = useState(false);
  const planRef = useRef<AgentPlan | null>(null);
  const lastActedPrice = useRef<number>(-1);
  const lastActedAt = useRef<number>(0);
  const lotIdRef = useRef<string | null>(null);
  const busy = useRef(false);

  const push = useCallback((entry: Omit<AgentLogEntry, "id" | "at">) => {
    setLog((prev) => [
      ...prev.slice(-40),
      { ...entry, id: crypto.randomUUID(), at: new Date().toISOString() },
    ]);
  }, []);

  const observe = useCallback((): AgentObservation | null => {
    if (!state?.lot || !lot || !mandate || !headroom) return null;
    return {
      lot_title: lot.title,
      lot_condition: lot.condition,
      estimate_low_cents: lot.estimate_low_cents,
      estimate_high_cents: lot.estimate_high_cents,
      current_price_cents: state.current_price_cents,
      min_increment_cents: state.min_increment_cents,
      seconds_remaining: state.seconds_remaining,
      bid_count: state.bid_count,
      reserve_met: state.reserve_met,
      am_i_high_bidder: state.high_bidder_id === bidderId,
      // Every figure below is server-computed. Stage 3 of the loop: the agent
      // takes these as given rather than deriving them.
      ceiling_cents: headroom.ceiling_cents,
      notify_above_cents: headroom.notify_above_cents,
      headroom_to_ceiling_cents: headroom.headroom_to_ceiling_cents,
      in_supervised_band: headroom.in_supervised_band,
      recent_bidders: state.high_bidder_alias ? [state.high_bidder_alias] : [],
      strategy_note: mandate.strategy_note,
    };
  }, [state, lot, mandate, headroom, bidderId]);

  /* Stage 1 / 4 — plan on a new lot, replan when the lot changes. */
  useEffect(() => {
    const obs = observe();
    if (!obs || !state?.lot) return;
    if (lotIdRef.current === state.lot.id) return;

    const previous = planRef.current;
    const next = previous ? replan(previous, obs, persona) : plan(obs, persona);
    planRef.current = next;
    lotIdRef.current = state.lot.id;
    lastActedPrice.current = -1;

    push({
      stage: previous ? "replan" : "plan",
      text: next.strategy,
      outcome: `fair value ${fmt(next.fair_value_cents)} · walk away ${fmt(next.walk_away_cents)} · priority ${next.priority}`,
    });
  }, [state?.lot?.id, observe, persona, push, state?.lot]);

  /* Stage 2 / 3 — decide, act, then take the server's corrected view. */
  useEffect(() => {
    if (!enabled || busy.current) return;
    const obs = observe();
    const p = planRef.current;
    if (!obs || !p || !state?.lot) return;
    if (state.lot.status !== "open" || state.seconds_remaining <= 0) return;
    if (obs.am_i_high_bidder) return;

    // Throttle: act at most once per price change, and never faster than 1.8s.
    const now = Date.now();
    if (obs.current_price_cents === lastActedPrice.current && now - lastActedAt.current < 6000) return;
    if (now - lastActedAt.current < 1800) return;

    busy.current = true;
    setThinking(true);

    void (async () => {
      try {
        const decision: AgentDecision = await decideWithModel(obs, p, persona, API_BASE);
        lastActedPrice.current = obs.current_price_cents;
        lastActedAt.current = Date.now();

        if (decision.action === "hold") {
          push({ stage: "bid", text: decision.rationale, outcome: "held" });
          return;
        }

        if (decision.action === "out") {
          await api.withdraw({ bidder_id: bidderId, lot_id: state.lot!.id, reason: decision.rationale });
          push({ stage: "bid", text: decision.rationale, outcome: "withdrew" });
          onNeedsRefresh();
          return;
        }

        if (decision.action === "request_raise") {
          await api.requestCeilingRaise({
            bidder_id: bidderId,
            requested_ceiling_cents: decision.requested_ceiling_cents,
            justification: decision.rationale,
          });
          push({
            stage: "bid",
            text: decision.rationale,
            outcome: `asked to raise ceiling to ${fmt(decision.requested_ceiling_cents)} — awaiting you`,
          });
          onNeedsRefresh();
          return;
        }

        const result = await api.bid({
          bidder_id: bidderId,
          lot_id: state.lot!.id,
          amount_cents: decision.amount_cents,
          rationale: decision.rationale,
          placed_by: "agent",
        });

        push({ stage: "bid", text: decision.rationale, outcome: `${fmt(decision.amount_cents)} → ${result.status}` });

        // Stage 3: belief update. The server's numbers replace whatever the
        // agent believed — this is where arithmetic drift gets corrected before
        // it can compound into a bad bid.
        push({
          stage: "belief",
          text: `Server says price is ${fmt(result.current_price_cents)}, minimum next ${fmt(
            result.current_price_cents + result.min_increment_cents,
          )}.`,
        });

        onNeedsRefresh();
      } catch (err) {
        push({
          stage: "bid",
          text: "Could not reach the auction house.",
          outcome: err instanceof Error ? err.message.slice(0, 60) : "network error",
        });
      } finally {
        busy.current = false;
        setThinking(false);
      }
    })();
  }, [
    enabled,
    state?.current_price_cents,
    state?.seconds_remaining,
    state?.lot?.status,
    observe,
    persona,
    bidderId,
    push,
    onNeedsRefresh,
    state,
  ]);

  return { log, thinking, plan: planRef.current };
}
