import { describe, expect, it } from "vitest";
import {
  BIDDER_TOOLS,
  BUDGETS,
  FLOOR_TOOLS,
  assertToolBudgets,
  type ToolSpec,
} from "../index.js";

const ALL = [...FLOOR_TOOLS, ...BIDDER_TOOLS];

describe("tool budgets", () => {
  it("every shipped tool is inside Chrome's provisional budgets", () => {
    expect(() => assertToolBudgets(ALL)).not.toThrow();
  });

  it("throws on an over-long tool name", () => {
    const bad: ToolSpec = {
      ...FLOOR_TOOLS[0],
      name: "a".repeat(BUDGETS.toolName + 1),
    };
    expect(() => assertToolBudgets([bad])).toThrow(/tool name/);
  });

  it("throws on an over-long description", () => {
    const bad: ToolSpec = {
      ...FLOOR_TOOLS[0],
      description: "d".repeat(BUDGETS.toolDescription + 1),
    };
    expect(() => assertToolBudgets([bad])).toThrow(/description/);
  });

  it("throws on an over-long parameter description", () => {
    const bad: ToolSpec = {
      ...FLOOR_TOOLS[0],
      inputSchema: {
        type: "object",
        properties: { q: { type: "string", description: "p".repeat(BUDGETS.paramDescription + 1) } },
      },
    };
    expect(() => assertToolBudgets([bad])).toThrow(/param description/);
  });

  it("rejects tool names outside the spec's allowed character set", () => {
    const bad: ToolSpec = { ...FLOOR_TOOLS[0], name: "place bid!" };
    expect(() => assertToolBudgets([bad])).toThrow(/characters outside/);
  });
});

describe("tool catalogue invariants", () => {
  it("exposes exactly the expected tools", () => {
    expect(FLOOR_TOOLS.map((t) => t.name)).toEqual([
      "get_auction_state",
      "get_lot_details",
      "get_bid_history",
      "check_bid",
      "place_bid",
      "withdraw_from_lot",
    ]);
    expect(BIDDER_TOOLS.map((t) => t.name)).toEqual([
      "get_my_mandate",
      "set_bid_mandate",
      "request_ceiling_raise",
    ]);
  });

  it("tool names are unique across both domains", () => {
    const names = ALL.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks get_bid_history as untrusted — it carries attacker-controlled names", () => {
    const h = FLOOR_TOOLS.find((t) => t.name === "get_bid_history")!;
    expect(h.untrustedContentHint).toBe(true);
    expect(h.readOnlyHint).toBe(true);
  });

  it("marks every read-only tool as such, and every mutating tool as not", () => {
    // check_bid is a dry run: it runs the full enforcement path but commits
    // nothing, so it belongs with the readers.
    const readOnly = [
      "get_auction_state",
      "get_lot_details",
      "get_bid_history",
      "check_bid",
      "get_my_mandate",
    ];
    for (const t of ALL) {
      expect(t.readOnlyHint).toBe(readOnly.includes(t.name));
    }
  });

  it("NO tool anywhere can raise a ceiling directly", () => {
    // The core safety property of the whole project, asserted mechanically so a
    // future edit that adds such a tool fails the suite rather than shipping.
    for (const t of ALL) {
      const params = Object.keys(t.inputSchema.properties);
      const setsCeilingDirectly =
        params.includes("ceiling_cents") && t.name !== "set_bid_mandate";
      expect(setsCeilingDirectly).toBe(false);
    }
    const raise = BIDDER_TOOLS.find((t) => t.name === "request_ceiling_raise")!;
    expect(raise.description).toMatch(/only ASKS|never grants/i);
  });

  it("place_bid requires a lot id and an integer amount", () => {
    const bid = FLOOR_TOOLS.find((t) => t.name === "place_bid")!;
    expect(bid.inputSchema.required).toEqual(["lot_id", "amount_cents"]);
    expect(bid.inputSchema.properties.amount_cents.type).toBe("integer");
  });
});
