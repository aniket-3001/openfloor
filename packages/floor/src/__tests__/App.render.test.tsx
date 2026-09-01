// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App } from "../App";

/**
 * Rendering tests for the auction floor.
 *
 * The property under test is the L3 promise: a visitor whose browser has no
 * WebMCP at all must still get a working auction, never a blank page or a
 * crash. That is what a judge on Safari — or anyone who did not enable the
 * Chrome flag — will actually see, so it cannot be left to assumption.
 */

const STATE = {
  room_id: "test-room",
  lot: { id: "lot-leica", title: "Leica M3 Rangefinder (1957)", status: "open" },
  current_price_cents: 4200,
  min_increment_cents: 100,
  high_bidder_alias: "Rex",
  high_bidder_id: "rex",
  reserve_met: false,
  seconds_remaining: 42,
  round: 1,
  bid_count: 3,
  clock_extended: false,
};

const LOT = {
  id: "lot-leica",
  title: "Leica M3 Rangefinder (1957)",
  description: "Double-stroke body, shutter accurate across all speeds.",
  condition: "Excellent",
  estimate_low_cents: 6000,
  estimate_high_cents: 9000,
  starting_price_cents: 3000,
  min_increment_cents: 100,
  image_ref: "leica",
  status: "open",
};

function mockApi(over: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const u = String(input);
      const body = (() => {
        if (u.includes("/state")) return { state: STATE };
        if (u.includes("/lot")) return { lot: LOT };
        if (u.includes("/history"))
          return {
            bids: [
              { alias: "Rex", amount_cents: 4200, placed_by: "agent", human_confirmed: false, at: new Date().toISOString() },
              { alias: "Ada", amount_cents: 4100, placed_by: "human", human_confirmed: true, at: new Date().toISOString() },
            ],
          };
        if (u.includes("/audit")) return { entries: [] };
        if (u.includes("/mandate")) return { mandate: null };
        return {};
      })();
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...body, ...over }),
      } as unknown as Response;
    }),
  );
}

beforeEach(() => {
  // Deliberately NO document.modelContext — this is the unsupported browser.
  vi.stubGlobal("WebSocket", class {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    close() {}
  });
  mockApi();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("floor renders without WebMCP (the L3 fallback)", () => {
  it("mounts without crashing", async () => {
    render(<App />);
    // The tagline is unique; the brand mark appears in several places.
    expect(await screen.findByText(/Your agent bids\. You set the limits\./)).toBeTruthy();
  });

  it("shows the lot and the live price", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByText(/Leica M3 Rangefinder/).length).toBeGreaterThan(0));
    // The price shows in the headline figure and again in the bid list.
    expect(screen.getAllByText("$42.00").length).toBeGreaterThan(0);
  });

  it("tells the visitor WebMCP is unavailable rather than failing silently", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Manual mode/i)).toBeTruthy());
    expect(screen.getByText(/enable-webmcp-testing/)).toBeTruthy();
  });

  it("offers manual bidding so the auction is still usable", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Bid by hand/i)).toBeTruthy());
    expect(screen.getByText(/Take a seat/i)).toBeTruthy();
  });

  it("renders the bid history including who placed each bid", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("$41.00")).toBeTruthy());
    expect(screen.getAllByText(/agent|human/i).length).toBeGreaterThan(0);
  });

  it("shows the countdown", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("0:42")).toBeTruthy());
  });

  it("shows reserve status without ever revealing the reserve amount", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/reserve not met/i)).toBeTruthy());
    // The reserve figure must never reach the DOM.
    expect(document.body.textContent).not.toMatch(/55\.00|reserve_cents/);
  });

  it("prompts for a mandate when none is set", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/No mandate set/i)).toBeTruthy());
    expect(screen.getByText(/set_bid_mandate/)).toBeTruthy();
  });
});

describe("floor detects WebMCP when present", () => {
  it("reports the same-origin layer and registers tools", async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("document", Object.assign(document, { modelContext: { registerTool } }));

    render(<App />);
    await waitFor(() => expect(screen.getByText(/Same-origin WebMCP/i)).toBeTruthy());
    // Seven auction tools plus three private mandate tools.
    await waitFor(() => expect(registerTool.mock.calls.length).toBe(10));

    const names = registerTool.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toContain("place_bid");
    expect(names).toContain("check_bid");
    expect(names).toContain("get_my_activity");
    expect(names).toContain("set_bid_mandate");

    // The auction tools are published to bidder origins; the mandate tools are
    // not published at all. This is the trust asymmetry, asserted at runtime.
    const exposedFor = (n: string) =>
      registerTool.mock.calls.find((c) => (c[0] as { name: string }).name === n)?.[1] as
        | { exposedTo?: string[] }
        | undefined;
    expect(exposedFor("place_bid")?.exposedTo?.length).toBeGreaterThan(0);
    expect(exposedFor("set_bid_mandate")?.exposedTo).toBeUndefined();

    delete (document as unknown as { modelContext?: unknown }).modelContext;
  });
});
