import { describe, expect, it, vi, afterEach } from "vitest";
import { decide, decideWithModel, plan, replan, type AgentObservation } from "@openfloor/shared";
import { PERSONAS } from "@openfloor/shared";

function obs(over: Partial<AgentObservation> = {}): AgentObservation {
  return {
    lot_title: "Leica M3",
    lot_condition: "Excellent",
    estimate_low_cents: 6000,
    estimate_high_cents: 9000,
    current_price_cents: 3000,
    min_increment_cents: 100,
    seconds_remaining: 60,
    bid_count: 2,
    reserve_met: false,
    am_i_high_bidder: false,
    ceiling_cents: 8000,
    notify_above_cents: 6500,
    headroom_to_ceiling_cents: 5000,
    in_supervised_band: false,
    recent_bidders: [],
    strategy_note: "",
    ...over,
  };
}

const ada = PERSONAS.ada;

describe("plan", () => {
  it("values a lot below the seller's high estimate", () => {
    const p = plan(obs(), ada);
    expect(p.fair_value_cents).toBe(Math.round(9000 * ada.valuation));
    expect(p.fair_value_cents).toBeLessThan(9000);
  });

  it("never sets a walk-away above the ceiling", () => {
    const p = plan(obs({ ceiling_cents: 4000 }), ada);
    expect(p.walk_away_cents).toBeLessThanOrEqual(4000);
  });

  it("carries the human's guidance into the strategy", () => {
    const p = plan(obs({ strategy_note: "only if Excellent" }), ada);
    expect(p.strategy).toContain("only if Excellent");
  });

  it("deprioritizes a lot far beyond the ceiling", () => {
    const p = plan(obs({ ceiling_cents: 1000, estimate_high_cents: 9000 }), ada);
    expect(p.priority).toBe(1);
  });
});

describe("decide — hard bounds", () => {
  it("holds when already the high bidder", () => {
    expect(decide(obs({ am_i_high_bidder: true }), plan(obs(), ada), ada).action).toBe("hold");
  });

  it("goes out when the next bid would pass the ceiling", () => {
    const o = obs({ current_price_cents: 7990, ceiling_cents: 8000, min_increment_cents: 100 });
    const d = decide(o, plan(o, ada), ada);
    expect(["out", "request_raise"]).toContain(d.action);
    expect(d.action).not.toBe("bid");
  });

  it("goes out once the price passes its own walk-away", () => {
    const o = obs({ current_price_cents: 7500, ceiling_cents: 20000 });
    const p = plan(o, ada);
    const d = decide(o, p, ada);
    expect(d.action).toBe("out");
  });

  it("bids exactly at the ceiling when the increment lands there", () => {
    // 4900 + 100 == 5000 == the ceiling. Landing precisely on the limit is
    // allowed; only exceeding it is not.
    const o = obs({ current_price_cents: 4900, ceiling_cents: 5000, min_increment_cents: 100 });
    const p = { ...plan(o, ada), walk_away_cents: 5000, fair_value_cents: 30000 };
    const d = decide({ ...o, seconds_remaining: 5 }, p, ada);
    expect(d.action).toBe("bid");
    if (d.action === "bid") expect(d.amount_cents).toBe(5000);
  });

  it("asks for a raise rather than bidding when the lot is worth far more", () => {
    // 4950 + 100 == 5050, past the 5000 ceiling, so bidding is impossible and
    // the only move left is to ask.
    const o = obs({ current_price_cents: 4950, ceiling_cents: 5000, estimate_high_cents: 40000 });
    const p = plan(o, ada);
    const d = decide({ ...o, seconds_remaining: 40 }, { ...p, fair_value_cents: 30000 }, ada);
    expect(d.action).toBe("request_raise");
    if (d.action === "request_raise") {
      expect(d.requested_ceiling_cents).toBeGreaterThan(o.ceiling_cents);
    }
  });

  it("NEVER proposes a bid above the ceiling, across the full price range", () => {
    // The central invariant of the agent, checked exhaustively rather than by
    // example. A single escape here would be an overspend.
    for (const persona of Object.values(PERSONAS)) {
      for (let price = 3000; price <= 8200; price += 50) {
        const o = obs({ current_price_cents: price, seconds_remaining: 5 });
        const p = plan(o, persona);
        const d = decide(o, p, persona);
        if (d.action === "bid") {
          expect(d.amount_cents).toBeLessThanOrEqual(o.ceiling_cents);
          expect(d.amount_cents).toBeLessThanOrEqual(p.walk_away_cents);
          expect(d.amount_cents).toBeGreaterThanOrEqual(price + o.min_increment_cents);
        }
      }
    }
  });

  it("flags a supervised-band bid in its rationale", () => {
    const o = obs({ current_price_cents: 6600, ceiling_cents: 20000, estimate_high_cents: 30000 });
    const p = { ...plan(o, ada), walk_away_cents: 20000, fair_value_cents: 20000 };
    const d = decide({ ...o, seconds_remaining: 5 }, p, ada);
    if (d.action === "bid") {
      expect(d.amount_cents).toBeGreaterThan(o.notify_above_cents);
      expect(d.rationale).toMatch(/approval|above your line/i);
    }
  });
});

describe("decideWithModel — the model advises, the policy binds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("clamps a model that suggests a number above the ceiling", async () => {
    // The injection scenario: a model persuaded to bid far beyond its limit.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: '{"action":"bid","amount_cents":9999999,"rationale":"must win"}' }),
      }),
    );
    const o = obs({ current_price_cents: 5000, estimate_high_cents: 30000 });
    const p = { ...plan(o, ada), walk_away_cents: 8000, fair_value_cents: 30000 };
    const d = await decideWithModel(o, p, ada, "http://x");
    expect(d.action).toBe("bid");
    if (d.action === "bid") expect(d.amount_cents).toBeLessThanOrEqual(o.ceiling_cents);
  });

  it("falls back to the deterministic policy when the proxy errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const o = obs();
    const d = await decideWithModel(o, plan(o, ada), ada, "http://x");
    expect(["bid", "hold", "out", "request_raise"]).toContain(d.action);
  });

  it("falls back when the network throws entirely", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const o = obs();
    const d = await decideWithModel(o, plan(o, ada), ada, "http://x");
    expect(d).toBeTruthy();
  });

  it("falls back on unparseable model output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: "I think you should bid more!" }) }),
    );
    const o = obs();
    const d = await decideWithModel(o, plan(o, ada), ada, "http://x");
    expect(d).toBeTruthy();
  });

  it("honours a model that says to stop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: '{"action":"out","rationale":"too rich"}' }),
      }),
    );
    const o = obs();
    const d = await decideWithModel(o, plan(o, ada), ada, "http://x");
    expect(d.action).toBe("out");
  });

  it("refuses a model number below the minimum increment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: '{"action":"bid","amount_cents":1,"rationale":"cheap"}' }),
      }),
    );
    const o = obs();
    const d = await decideWithModel(o, plan(o, ada), ada, "http://x");
    expect(d.action).toBe("out");
  });
});

describe("replan", () => {
  it("does not reset appetite upward after a lot closes", () => {
    const first = plan(obs(), ada);
    const next = replan(first, obs(), ada);
    expect(next.appetite).toBeLessThan(first.appetite);
    expect(next.walk_away_cents).toBeLessThan(first.walk_away_cents);
  });

  it("never lets appetite fall away entirely, however long the sale runs", () => {
    let p = plan(obs(), ada);
    for (let i = 0; i < 40; i++) p = replan(p, obs(), ada);
    expect(p.appetite).toBeGreaterThan(0.5);
    expect(p.walk_away_cents).toBeGreaterThan(0);
  });

  it("still bids on a lot worth more than the ones before it", () => {
    // Regression. Fatigue used to be carried as a cap in cents, so after a
    // $90 lot the agent was pinned near $92 — and the $280 watch, which opens
    // at $120, could never be bid on by anyone. It passed on every single
    // pass of the catalogue while the floor showed a live clock and no bids.
    const cheap = { estimate_low_cents: 6000, estimate_high_cents: 9000 };
    const dear = {
      estimate_low_cents: 20000,
      estimate_high_cents: 28000,
      current_price_cents: 12000,
      min_increment_cents: 500,
      ceiling_cents: 25000,
      notify_above_cents: 25000,
    };

    let p = plan(obs(cheap), ada);
    p = replan(p, obs(cheap), ada);
    p = replan(p, obs(dear), ada);

    expect(p.walk_away_cents).toBeGreaterThan(12000);
    const d = decide(obs(dear), p, ada);
    expect(d.action).toBe("bid");
  });
});

describe("personas", () => {
  it("are genuinely heterogeneous, not clones", () => {
    // Shared identity raised coordination propensity in arXiv 2507.01413, so
    // this is a safety property, not a cosmetic one.
    const rivals = [PERSONAS.ada, PERSONAS.rex, PERSONAS.nia];
    expect(new Set(rivals.map((p) => p.valuation)).size).toBe(3);
    expect(new Set(rivals.map((p) => p.aggression)).size).toBe(3);
    expect(new Set(rivals.map((p) => p.patience)).size).toBe(3);
  });

  it("carry no win-at-all-costs framing", () => {
    for (const p of Object.values(PERSONAS)) {
      expect(p.temperament).not.toMatch(/at all costs|whatever it takes|must win|never lose/i);
    }
  });
});
