import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callTool,
  describeLayer,
  detectCapability,
  mountToolBridge,
  registerTool,
  resolveModelContext,
} from "../webmcp.js";

/** Install a fake `document`/`navigator` with an optional modelContext. */
function stubHost(modelContext: unknown, on: "document" | "navigator" = "document") {
  vi.stubGlobal("document", on === "document" ? { modelContext } : {});
  vi.stubGlobal("navigator", on === "navigator" ? { modelContext } : {});
}

afterEach(() => vi.unstubAllGlobals());

describe("resolveModelContext", () => {
  it("returns null when the browser has no WebMCP", () => {
    stubHost(undefined);
    expect(resolveModelContext()).toBeNull();
  });

  it("finds document.modelContext", () => {
    const ctx = { registerTool: vi.fn() };
    stubHost(ctx);
    expect(resolveModelContext()).toBe(ctx);
  });

  it("falls back to navigator.modelContext", () => {
    const ctx = { registerTool: vi.fn() };
    stubHost(ctx, "navigator");
    expect(resolveModelContext()).toBe(ctx);
  });

  it("rejects an object without registerTool rather than trusting the name", () => {
    stubHost({ somethingElse: true });
    expect(resolveModelContext()).toBeNull();
  });
});

describe("detectCapability", () => {
  it("reports L3 when WebMCP is absent — the manual-UI path", async () => {
    stubHost(undefined);
    const cap = await detectCapability(["https://floor.example"]);
    expect(cap.layer).toBe("L3_no_webmcp");
    expect(cap.context).toBeNull();
    expect(cap.hasRegisterTool).toBe(false);
  });

  it("reports L2 when WebMCP exists but no cross-origin check is requested", async () => {
    stubHost({ registerTool: vi.fn(), getTools: vi.fn(), executeTool: vi.fn() });
    const cap = await detectCapability([]);
    expect(cap.layer).toBe("L2_same_origin");
    expect(cap.crossOriginProbe).toBeUndefined();
  });

  it("reports L1 only when tools appear that the local listing does not have", async () => {
    const getTools = vi.fn(async (opts?: { fromOrigins?: string[] }) =>
      opts?.fromOrigins
        ? [{ name: "get_my_mandate" }, { name: "place_bid" }, { name: "get_auction_state" }]
        : [{ name: "get_my_mandate" }],
    );
    stubHost({ registerTool: vi.fn(), getTools, executeTool: vi.fn() });
    const cap = await detectCapability(["https://floor.example"]);
    expect(cap.layer).toBe("L1_cross_origin");
    expect(cap.crossOriginProbe?.detail).toMatch(/place_bid/);
  });

  it("does NOT claim L1 when getTools ignores fromOrigins and echoes local tools", async () => {
    // Measured behavior in Chrome 151: getTools returns this document's own
    // tools whatever fromOrigins says — a bogus origin still yields the local
    // set. An earlier version keyed off "returned something" and reported L1
    // for every WebMCP browser, so the UI claimed a boundary never crossed.
    const local = [{ name: "get_my_mandate" }, { name: "set_bid_mandate" }];
    stubHost({
      registerTool: vi.fn(),
      getTools: vi.fn().mockResolvedValue(local),
      executeTool: vi.fn(),
    });
    const cap = await detectCapability(["https://floor.example"]);
    expect(cap.layer).toBe("L2_same_origin");
    expect(cap.crossOriginProbe?.succeeded).toBe(false);
    expect(cap.crossOriginProbe?.detail).toMatch(/frame tree/i);
  });

  it("degrades to L2 when cross-origin discovery returns nothing", async () => {
    stubHost({
      registerTool: vi.fn(),
      getTools: vi.fn().mockResolvedValue([]),
      executeTool: vi.fn(),
    });
    const cap = await detectCapability(["https://floor.example"]);
    expect(cap.layer).toBe("L2_same_origin");
    expect(cap.crossOriginProbe?.succeeded).toBe(false);
  });

  it("degrades to L2 — never throws — when cross-origin discovery is blocked", async () => {
    // The likeliest real-world outcome if the shipped browser refuses
    // cross-origin invocation. It must degrade, not break the page.
    stubHost({
      registerTool: vi.fn(),
      getTools: vi.fn().mockRejectedValue(new Error("blocked by permissions policy")),
      executeTool: vi.fn(),
    });
    const cap = await detectCapability(["https://floor.example"]);
    expect(cap.layer).toBe("L2_same_origin");
    expect(cap.crossOriginProbe?.detail).toMatch(/blocked by permissions policy/);
  });

  it("stays at L2 when getTools is missing entirely", async () => {
    stubHost({ registerTool: vi.fn() });
    const cap = await detectCapability(["https://floor.example"]);
    expect(cap.layer).toBe("L2_same_origin");
    expect(cap.hasGetTools).toBe(false);
  });
});

describe("registerTool", () => {
  it("passes exposedTo through when origins are given", async () => {
    const registerToolSpy = vi.fn().mockResolvedValue(undefined);
    const ctx = { registerTool: registerToolSpy };
    await registerTool(ctx, { name: "t" }, { exposedTo: ["https://bidder.example"] });
    const [, options] = registerToolSpy.mock.calls[0];
    expect(options.exposedTo).toEqual(["https://bidder.example"]);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("OMITS exposedTo entirely when no origins are given — tools stay private", async () => {
    // Passing an empty array instead of omitting the key could be read as an
    // explicit empty allowlist. Private-by-default must mean the key is absent.
    const registerToolSpy = vi.fn().mockResolvedValue(undefined);
    await registerTool({ registerTool: registerToolSpy }, { name: "t" });
    const [, options] = registerToolSpy.mock.calls[0];
    expect("exposedTo" in options).toBe(false);
  });

  it("returns a disposer that aborts the registration signal", async () => {
    // The spec has no unregisterTool; aborting is the only removal path.
    let captured: AbortSignal | undefined;
    const dispose = await registerTool(
      {
        registerTool: vi.fn(async (_t: unknown, o: { signal?: AbortSignal }) => {
          captured = o.signal;
        }),
      },
      { name: "t" },
    );
    expect(captured?.aborted).toBe(false);
    dispose();
    expect(captured?.aborted).toBe(true);
  });
});

describe("describeLayer", () => {
  it("gives every layer a human-readable label and detail", () => {
    for (const l of ["L1_cross_origin", "L2_same_origin", "L3_no_webmcp"] as const) {
      const d = describeLayer(l);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.detail.length).toBeGreaterThan(0);
    }
  });

  it("tells an unsupported browser how to enable WebMCP", () => {
    expect(describeLayer("L3_no_webmcp").detail).toMatch(/enable-webmcp-testing/);
  });
});

describe("callTool — measured Chrome 151 contract", () => {
  it("passes input as a JSON STRING, not an object", async () => {
    // Chrome 151 rejects an object with "Failed to parse input arguments",
    // which reads like a schema error but is a serialization one. The spec IDL
    // says `optional object inputObject`, so shipped behavior differs here.
    const executeTool = vi.fn().mockResolvedValue("ok");
    const tool = { name: "check_bid" };
    await callTool({ registerTool: vi.fn(), executeTool }, tool, { amount_cents: 5000 });
    const [passedTool, passedInput] = executeTool.mock.calls[0];
    expect(passedTool).toBe(tool);
    expect(typeof passedInput).toBe("string");
    expect(JSON.parse(passedInput as string)).toEqual({ amount_cents: 5000 });
  });

  it("serializes an empty object rather than omitting the argument", async () => {
    // Chrome requires two arguments: omitting the second throws
    // "2 arguments required, but only 1 present".
    const executeTool = vi.fn().mockResolvedValue("ok");
    await callTool({ registerTool: vi.fn(), executeTool }, { name: "get_auction_state" });
    expect(executeTool.mock.calls[0][1]).toBe("{}");
  });

  it("throws a clear error when executeTool is unavailable", async () => {
    await expect(callTool({ registerTool: vi.fn() }, { name: "x" })).rejects.toThrow(
      /executeTool is not available/,
    );
  });
});

describe("mountToolBridge", () => {
  it("creates a hidden iframe carrying allow=tools", () => {
    const el: Record<string, unknown> = { style: {}, setAttribute: vi.fn(), remove: vi.fn() };
    const doc = {
      createElement: vi.fn(() => el),
      body: { appendChild: vi.fn() },
    } as unknown as Document;

    const dispose = mountToolBridge("https://floor.example", doc);
    expect(el.setAttribute).toHaveBeenCalledWith("allow", "tools");
    expect(el.src).toBe("https://floor.example");
    expect(doc.body.appendChild).toHaveBeenCalledWith(el);
    dispose();
    expect(el.remove).toHaveBeenCalled();
  });
});
