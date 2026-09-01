/**
 * Server-side rival bidders.
 *
 * WHY THIS EXISTS
 * ---------------
 * The bidding agents originally lived only in a bidder console's browser, which
 * meant a visitor who opened the deployed auction floor saw an auction where
 * nobody bid. The bid war, and the confirmation card that fires *because* a
 * rival outbid you, both depend on rivals existing. Without them the live demo
 * is inert.
 *
 * These rivals run in the API process, driven by the same four-stage policy the
 * browser agents use (`plan` / `decide` / `replan` from @openfloor/shared) with
 * the same heterogeneous personas.
 *
 * THEY GET NO PRIVILEGED PATH. A rival bids by issuing an ordinary HTTP request
 * to the engine, exactly as a browser agent does — same mandate check, same
 * ceiling, same rate limit, same audit trail. A house bot that could bypass
 * enforcement would quietly invalidate every guarantee the project claims, so
 * the only bidding route is the public one.
 */

import {
  decide,
  fmt,
  getPersona,
  plan,
  replan,
  type AgentObservation,
  type AgentPlan,
  type Persona,
} from "@openfloor/shared";

export interface RivalOptions {
  /** Persona ids to run, e.g. ["ada", "rex", "nia"]. */
  personas: string[];
  /** Origin the rivals call, i.e. this server. */
  apiBase: string;
  /** How often each rival reconsiders, in ms. */
  tickMs?: number;
  /** Ceiling given to each rival, in cents. */
  ceilingCents?: number;
}

interface RivalState {
  persona: Persona;
  bidderId: string;
  plan: AgentPlan | null;
  lotId: string | null;
  joined: boolean;
  lastActedAt: number;
  lastActedPrice: number;
}

export function startRivals(opts: RivalOptions): () => void {
  const tickMs = opts.tickMs ?? 2500;
  const ceiling = opts.ceilingCents ?? 25_000;
  const room = process.env.PUBLIC_ROOM ?? "main";

  const rivals: RivalState[] = opts.personas
    .map((id) => getPersona(id))
    .filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i)
    .map((persona) => ({
      persona,
      bidderId: `rival_${persona.id}`,
      plan: null,
      lotId: null,
      joined: false,
      lastActedAt: 0,
      lastActedPrice: -1,
    }));

  if (!rivals.length) return () => {};

  const url = (path: string, params: Record<string, string | number> = {}) => {
    const u = new URL(`${opts.apiBase}/api${path}`);
    u.searchParams.set("room", room);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u.toString();
  };

  const post = async (path: string, body: unknown) => {
    const res = await fetch(url(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json() as Promise<Record<string, unknown>>;
  };
  const get = async (path: string, params?: Record<string, string | number>) =>
    (await fetch(url(path, params))).json() as Promise<Record<string, any>>;

  let stopped = false;

  async function ensureSeated(r: RivalState): Promise<void> {
    if (r.joined) return;
    await post("/join", { bidder_id: r.bidderId, alias: r.persona.alias });
    await post("/mandate", {
      bidder_id: r.bidderId,
      ceiling_cents: ceiling,
      // Rivals have no human to ask, so their notify threshold IS their ceiling:
      // they operate entirely inside the autonomous band and simply stop at the
      // wall. They never raise a confirmation card nobody could answer.
      notify_above_cents: ceiling,
      strategy_note: r.persona.temperament,
      auto_bid_enabled: true,
    });
    r.joined = true;
    console.log(`[rival] ${r.persona.alias} seated with a ${fmt(ceiling)} ceiling`);
  }

  async function tick(): Promise<void> {
    if (stopped) return;

    const [{ state }, { lot }] = await Promise.all([
      get("/state") as Promise<{ state: any }>,
      get("/lot") as Promise<{ lot: any }>,
    ]);
    if (!state?.lot || !lot) return;
    if (state.lot.status !== "open" || state.seconds_remaining <= 0) return;

    for (const r of rivals) {
      if (stopped) return;
      try {
        await ensureSeated(r);

        // Plan once per lot; replan carries reduced appetite into the next one.
        if (r.lotId !== state.lot.id) {
          const seedObs = observe(r, state, lot, ceiling);
          r.plan = r.plan ? replan(r.plan, seedObs, r.persona) : plan(seedObs, r.persona);
          r.lotId = state.lot.id;
          r.lastActedPrice = -1;
        }
        if (!r.plan) continue;

        if (state.high_bidder_id === r.bidderId) continue;

        // Pace them. Rivals that fire on every tick produce a metronomic bid
        // pattern that reads as a script rather than a contest.
        const now = Date.now();
        if (state.current_price_cents === r.lastActedPrice && now - r.lastActedAt < 8000) continue;
        if (now - r.lastActedAt < tickMs) continue;

        const obs = observe(r, state, lot, ceiling);
        const decision = decide(obs, r.plan, r.persona);
        r.lastActedPrice = state.current_price_cents;
        r.lastActedAt = now;

        if (decision.action === "bid") {
          const out = await post("/bid", {
            bidder_id: r.bidderId,
            lot_id: state.lot.id,
            amount_cents: decision.amount_cents,
            rationale: decision.rationale,
            placed_by: "agent",
          });
          if (out.status === "accepted") {
            console.log(`[rival] ${r.persona.alias} bid ${fmt(decision.amount_cents)}`);
          }
        } else if (decision.action === "out") {
          await post("/withdraw", {
            bidder_id: r.bidderId,
            lot_id: state.lot.id,
            reason: decision.rationale,
          });
        }
        // `hold` does nothing, and `request_raise` is meaningless without a
        // human to ask — a rival simply stops at its ceiling.
      } catch (err) {
        console.error(`[rival] ${r.persona.alias} tick failed`, err);
      }
    }
  }

  const timer = setInterval(() => {
    void tick().catch((e) => console.error("[rival] tick error", e));
  }, tickMs);
  timer.unref?.();

  console.log(`[rival] driving ${rivals.map((r) => r.persona.alias).join(", ")} every ${tickMs}ms`);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Build the agent's view. Every figure comes from the server, as it must. */
function observe(r: RivalState, state: any, lot: any, ceiling: number): AgentObservation {
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
    am_i_high_bidder: state.high_bidder_id === r.bidderId,
    ceiling_cents: ceiling,
    notify_above_cents: ceiling,
    headroom_to_ceiling_cents: Math.max(0, ceiling - state.current_price_cents),
    in_supervised_band: false,
    recent_bidders: state.high_bidder_alias ? [state.high_bidder_alias] : [],
    strategy_note: r.persona.temperament,
  };
}
