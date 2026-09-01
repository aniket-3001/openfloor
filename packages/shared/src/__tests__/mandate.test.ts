import { describe, expect, it } from "vitest";
import {
  canonicalMandate,
  enforceMandate,
  headroom,
  signMandate,
  verifyMandate,
  type BidMandate,
} from "../index.js";

const SECRET = "test-secret";

function makeMandate(over: Partial<BidMandate> = {}): BidMandate {
  return {
    mandate_id: "m1",
    bidder_id: "b1",
    lot_ids: ["lot-1"],
    ceiling_cents: 8000,
    notify_above_cents: 6500,
    auto_bid_enabled: true,
    strategy_note: "",
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    created_at: new Date().toISOString(),
    signature: "unused-in-enforcement",
    ...over,
  };
}

function baseInput(over: Partial<Parameters<typeof enforceMandate>[0]> = {}) {
  return {
    mandate: makeMandate(),
    lot_id: "lot-1",
    amount_cents: 3000,
    current_price_cents: 2000,
    min_increment_cents: 100,
    lot_open: true,
    is_high_bidder: false,
    now: new Date(),
    ...over,
  };
}

describe("enforceMandate — the three bands", () => {
  it("accepts a bid in the autonomous band", () => {
    const r = enforceMandate(baseInput({ amount_cents: 3100 }));
    expect(r.status).toBe("accepted");
  });

  it("requires confirmation above the notify threshold and does NOT accept", () => {
    const r = enforceMandate(baseInput({ amount_cents: 6600, current_price_cents: 6400 }));
    expect(r.status).toBe("awaiting_confirmation");
    expect(r.message).toMatch(/NOT been placed/i);
  });

  it("accepts a supervised-band bid once a human has confirmed it", () => {
    const r = enforceMandate(
      baseInput({ amount_cents: 6600, current_price_cents: 6400, human_confirmed: true }),
    );
    expect(r.status).toBe("accepted");
  });

  it("REFUSES anything above the ceiling — the hard wall", () => {
    const r = enforceMandate(baseInput({ amount_cents: 9000, current_price_cents: 6400 }));
    expect(r.status).toBe("rejected_ceiling");
  });

  it("refuses above the ceiling EVEN WITH human_confirmed set", () => {
    // A confirmation card is for the supervised band. It must never be a path
    // through the wall — otherwise a replayed/forged confirmation id becomes an
    // unbounded spend.
    const r = enforceMandate(
      baseInput({ amount_cents: 9000, current_price_cents: 6400, human_confirmed: true }),
    );
    expect(r.status).toBe("rejected_ceiling");
  });

  it("refuses a bid exactly one cent over the ceiling", () => {
    const r = enforceMandate(baseInput({ amount_cents: 8001, current_price_cents: 7000 }));
    expect(r.status).toBe("rejected_ceiling");
  });

  it("allows a bid exactly AT the ceiling when confirmed", () => {
    const r = enforceMandate(
      baseInput({ amount_cents: 8000, current_price_cents: 7900, human_confirmed: true }),
    );
    expect(r.status).toBe("accepted");
  });
});

describe("enforceMandate — validity gates", () => {
  it("rejects an expired mandate", () => {
    const r = enforceMandate(
      baseInput({ mandate: makeMandate({ expires_at: new Date(Date.now() - 1000).toISOString() }) }),
    );
    expect(r.status).toBe("rejected_mandate_expired");
  });

  it("rejects when auto-bidding is switched off", () => {
    const r = enforceMandate(
      baseInput({ mandate: makeMandate({ auto_bid_enabled: false }) }),
    );
    expect(r.status).toBe("rejected_not_authorized");
  });

  it("rejects a lot the mandate does not cover", () => {
    const r = enforceMandate(baseInput({ lot_id: "lot-other" }));
    expect(r.status).toBe("rejected_not_authorized");
  });

  it("checks mandate validity BEFORE auction mechanics, so a dead mandate leaks no state", () => {
    // Expired AND below increment AND lot closed. Expiry must win, so the reply
    // cannot be used to probe live auction state with a stale mandate.
    const r = enforceMandate(
      baseInput({
        mandate: makeMandate({ expires_at: new Date(Date.now() - 1000).toISOString() }),
        amount_cents: 1,
        lot_open: false,
      }),
    );
    expect(r.status).toBe("rejected_mandate_expired");
  });

  it("rejects bidding against yourself", () => {
    const r = enforceMandate(baseInput({ is_high_bidder: true }));
    expect(r.status).toBe("rejected_not_authorized");
  });

  it("rejects a closed lot", () => {
    const r = enforceMandate(baseInput({ lot_open: false }));
    expect(r.status).toBe("rejected_closed");
  });

  it("rejects below the minimum increment", () => {
    const r = enforceMandate(baseInput({ amount_cents: 2050, current_price_cents: 2000 }));
    expect(r.status).toBe("rejected_increment");
  });

  it("rejects non-integer and non-positive amounts", () => {
    expect(enforceMandate(baseInput({ amount_cents: 30.5 })).status).toBe("rejected_increment");
    expect(enforceMandate(baseInput({ amount_cents: 0 })).status).toBe("rejected_increment");
    expect(enforceMandate(baseInput({ amount_cents: -500 })).status).toBe("rejected_increment");
  });
});

describe("mandate signing", () => {
  it("verifies a correctly signed mandate", async () => {
    const { signature: _drop, ...unsigned } = makeMandate();
    const signature = await signMandate(unsigned, SECRET);
    expect(await verifyMandate({ ...unsigned, signature }, SECRET)).toBe(true);
  });

  it("rejects a mandate whose ceiling was tampered with", async () => {
    const { signature: _drop, ...unsigned } = makeMandate();
    const signature = await signMandate(unsigned, SECRET);
    const tampered = { ...unsigned, ceiling_cents: 999999, signature };
    expect(await verifyMandate(tampered, SECRET)).toBe(false);
  });

  it("rejects a signature made with a different secret", async () => {
    const { signature: _drop, ...unsigned } = makeMandate();
    const signature = await signMandate(unsigned, "other-secret");
    expect(await verifyMandate({ ...unsigned, signature }, SECRET)).toBe(false);
  });

  it("produces a canonical form independent of object key order", () => {
    const a = makeMandate();
    // Same data, different construction order.
    const b: BidMandate = {
      signature: a.signature,
      created_at: a.created_at,
      expires_at: a.expires_at,
      strategy_note: a.strategy_note,
      auto_bid_enabled: a.auto_bid_enabled,
      notify_above_cents: a.notify_above_cents,
      ceiling_cents: a.ceiling_cents,
      lot_ids: [...a.lot_ids],
      bidder_id: a.bidder_id,
      mandate_id: a.mandate_id,
    };
    expect(canonicalMandate(a)).toBe(canonicalMandate(b));
  });

  it("sorts lot_ids so ordering cannot change the signature", () => {
    const a = makeMandate({ lot_ids: ["lot-a", "lot-b"] });
    const b = makeMandate({ lot_ids: ["lot-b", "lot-a"] });
    expect(canonicalMandate(a)).toBe(canonicalMandate(b));
  });
});

describe("headroom — server-computed figures", () => {
  it("computes remaining room to the ceiling", () => {
    const h = headroom(makeMandate(), 5000);
    expect(h.headroom_to_ceiling_cents).toBe(3000);
    expect(h.in_supervised_band).toBe(false);
  });

  it("flags the supervised band once price reaches the notify threshold", () => {
    const h = headroom(makeMandate(), 6500);
    expect(h.in_supervised_band).toBe(true);
  });

  it("never reports negative headroom past the ceiling", () => {
    const h = headroom(makeMandate(), 12000);
    expect(h.headroom_to_ceiling_cents).toBe(0);
  });
});

describe("session budget — the per-bid ceiling is not a spend cap", () => {
  const budgeted = (over: Partial<BidMandate> = {}) =>
    makeMandate({ ceiling_cents: 8000, notify_above_cents: 8000, total_budget_cents: 10000, ...over });

  it("allows a bid that fits inside the remaining budget", () => {
    const r = enforceMandate(baseInput({ mandate: budgeted(), amount_cents: 4000, committed_cents: 5000 }));
    expect(r.status).toBe("accepted");
  });

  it("REFUSES a bid that would take total commitment past the budget", () => {
    // Each bid is inside the $80 ceiling, but together they exceed $100.
    const r = enforceMandate(baseInput({ mandate: budgeted(), amount_cents: 6000, committed_cents: 5000 }));
    expect(r.status).toBe("rejected_budget");
    expect(r.message).toMatch(/total commitment/i);
  });

  it("tells the agent how much is actually left", () => {
    // Inside the $80 per-bid ceiling, so the budget is what refuses it:
    // $70 committed + $60 bid = $130 against a $100 budget, $30 remaining.
    const r = enforceMandate(baseInput({ mandate: budgeted(), amount_cents: 6000, committed_cents: 7000 }));
    expect(r.status).toBe("rejected_budget");
    expect(r.message).toMatch(/\$30\.00 left/);
  });

  it("allows spending the budget exactly to the last cent", () => {
    const r = enforceMandate(baseInput({ mandate: budgeted(), amount_cents: 5000, committed_cents: 5000 }));
    expect(r.status).toBe("accepted");
  });

  it("refuses one cent past it", () => {
    const r = enforceMandate(baseInput({ mandate: budgeted(), amount_cents: 5001, committed_cents: 5000 }));
    expect(r.status).toBe("rejected_budget");
  });

  it("checks the per-bid ceiling BEFORE the budget", () => {
    // Both are violated; the ceiling message is the more specific guidance
    // because it points at request_ceiling_raise.
    const r = enforceMandate(baseInput({ mandate: budgeted(), amount_cents: 9999, committed_cents: 9000 }));
    expect(r.status).toBe("rejected_ceiling");
  });

  it("leaves the per-bid ceiling as the only bound when no budget is set", () => {
    const r = enforceMandate(baseInput({ amount_cents: 3100, committed_cents: 999999 }));
    expect(r.status).toBe("accepted");
  });

  it("cannot be stripped from a signed mandate without breaking the signature", async () => {
    const { signature: _drop, ...unsigned } = budgeted();
    const signature = await signMandate(unsigned, SECRET);
    const stripped = { ...unsigned, total_budget_cents: undefined, signature };
    expect(await verifyMandate(stripped as BidMandate, SECRET)).toBe(false);
  });

  it("reports budget headroom for the agent", () => {
    const h = headroom(budgeted(), 2000, 6000);
    expect(h.budget_remaining_cents).toBe(4000);
    expect(h.committed_cents).toBe(6000);
  });
});
