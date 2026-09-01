/**
 * WebMCP capability detection and a thin typed wrapper over the raw API.
 *
 * WHY THIS EXISTS
 * ---------------
 * The spec describes cross-origin tool access (`exposedTo` + `getTools({fromOrigins})`
 * + `executeTool`), but we could not verify that cross-origin invocation is
 * actually functional in the shipped Chrome build, and ChatGPT's in-app browser
 * is a separate implementation whose support is unknown. Rather than assume,
 * OpenFloor PROBES at runtime and degrades through three layers:
 *
 *   L1 full     — cross-origin executeTool works. Rival agents run on their own
 *                 origin and call the floor across a real `exposedTo` boundary.
 *   L2 degraded — cross-origin blocked, same-origin WebMCP works. Rivals run
 *                 same-origin through the IDENTICAL getTools/executeTool code
 *                 path. Genuinely WebMCP-driven, just not cross-origin.
 *   L3 fallback — no WebMCP at all. Plain manual-bidding UI. A judge opening
 *                 the URL in an unsupported browser must still see a working
 *                 auction, never a blank page.
 *
 * The detected layer is surfaced in the UI rather than hidden, because claiming
 * L1 while silently running L2 would misrepresent what the demo proves.
 */

/** The subset of the WebMCP surface OpenFloor uses. */
export interface ModelContextLike {
  registerTool(tool: unknown, options?: { signal?: AbortSignal; exposedTo?: string[] }): Promise<void>;
  getTools?(options?: { fromOrigins?: string[] }): Promise<RegisteredToolLike[]>;
  executeTool?(tool: RegisteredToolLike, input?: unknown, options?: { signal?: AbortSignal }): Promise<string>;
  addEventListener?(type: string, listener: EventListener): void;
}

export interface RegisteredToolLike {
  name: string;
  description?: string;
  [key: string]: unknown;
}

export type WebMcpLayer = "L1_cross_origin" | "L2_same_origin" | "L3_no_webmcp";

export interface WebMcpCapability {
  layer: WebMcpLayer;
  /** `document.modelContext`, or the `navigator.modelContext` fallback. */
  context: ModelContextLike | null;
  hasRegisterTool: boolean;
  hasGetTools: boolean;
  hasExecuteTool: boolean;
  /** Populated when a cross-origin probe was attempted. */
  crossOriginProbe?: { attempted: boolean; succeeded: boolean; detail: string };
}

/**
 * Resolve the model context.
 *
 * The spec settled on `document.modelContext`, but `navigator.modelContext`
 * appears in some builds and in the official Netlify starter's own snippet, so
 * both are checked. Deprecated surfaces (`provideContext`, `clearContext`,
 * `unregisterTool`) are deliberately NOT probed — they were removed from the
 * spec and reaching for them would be a correctness bug, not a compatibility win.
 */
export function resolveModelContext(): ModelContextLike | null {
  if (typeof document === "undefined") return null;
  const anyDoc = document as unknown as { modelContext?: ModelContextLike };
  const anyNav =
    typeof navigator !== "undefined"
      ? (navigator as unknown as { modelContext?: ModelContextLike })
      : undefined;
  const ctx = anyDoc.modelContext ?? anyNav?.modelContext ?? null;
  if (!ctx || typeof ctx.registerTool !== "function") return null;
  return ctx;
}

/**
 * Detect the operating layer.
 *
 * `crossOriginOrigins` is the list of origins whose tools we would need to
 * reach. Pass an empty array on pages that only register (the floor) rather
 * than consume (the bidder consoles).
 */
export async function detectCapability(crossOriginOrigins: string[] = []): Promise<WebMcpCapability> {
  const context = resolveModelContext();

  if (!context) {
    return {
      layer: "L3_no_webmcp",
      context: null,
      hasRegisterTool: false,
      hasGetTools: false,
      hasExecuteTool: false,
    };
  }

  const hasGetTools = typeof context.getTools === "function";
  const hasExecuteTool = typeof context.executeTool === "function";

  const base: WebMcpCapability = {
    layer: "L2_same_origin",
    context,
    hasRegisterTool: true,
    hasGetTools,
    hasExecuteTool,
  };

  if (!crossOriginOrigins.length || !hasGetTools) return base;

  // Probe: can we actually see another origin's tools?
  //
  // MEASURED IN CHROME 151 (see scripts/probe-execute.mjs): `getTools` ALWAYS
  // returns this document's own tools, whatever `fromOrigins` says — passing a
  // bogus origin still returns the local set. So "the call returned something"
  // proves nothing, and an earlier version of this function reported L1 on that
  // basis for every browser with WebMCP at all. The UI would have claimed a
  // cross-origin boundary that was never crossed.
  //
  // The sound test is a set comparison: cross-origin discovery only succeeded
  // if it returned tools that the local listing does NOT contain.
  try {
    const [local, combined] = await Promise.all([
      context.getTools!(),
      context.getTools!({ fromOrigins: crossOriginOrigins }),
    ]);
    const localNames = new Set((local ?? []).map((t) => t.name));
    const remoteOnly = (combined ?? []).filter((t) => !localNames.has(t.name));
    const found = remoteOnly.length > 0;

    return {
      ...base,
      layer: found ? "L1_cross_origin" : "L2_same_origin",
      crossOriginProbe: {
        attempted: true,
        succeeded: found,
        detail: found
          ? `Reached ${remoteOnly.length} remote tool(s) on ${crossOriginOrigins.join(", ")}: ` +
            remoteOnly.map((t) => t.name).join(", ")
          : `Only this origin's own ${localNames.size} tool(s) were visible. The remote origin ` +
            `must be present in the frame tree — see mountToolBridge().`,
      },
    };
  } catch (err) {
    return {
      ...base,
      layer: "L2_same_origin",
      crossOriginProbe: {
        attempted: true,
        succeeded: false,
        detail: `Cross-origin discovery threw: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * Bring a cross-origin document into the frame tree so its tools become
 * reachable.
 *
 * MEASURED IN CHROME 151: `getTools({fromOrigins})` returns a remote origin's
 * tools ONLY when that origin is loaded in a descendant navigable — an iframe
 * carrying `allow="tools"`. With no such frame, the call returns the local set
 * and cross-origin invocation is impossible. This matches the spec's
 * non-normative "observation" walk over descendant navigables.
 *
 * The frame is hidden and inert: it exists to make the origin present, not to
 * be seen. Returns a disposer that removes it.
 */
export function mountToolBridge(origin: string, doc: Document = document): () => void {
  const frame = doc.createElement("iframe");
  frame.setAttribute("allow", "tools"); // the `tools` Permissions-Policy feature
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("tabindex", "-1");
  frame.setAttribute("title", "WebMCP tool bridge");
  frame.src = origin;
  Object.assign(frame.style, {
    position: "absolute",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
    border: "0",
    left: "-9999px",
  });
  doc.body.appendChild(frame);
  return () => frame.remove();
}

/**
 * Invoke a tool.
 *
 * MEASURED IN CHROME 151: the second argument must be a JSON **string**, not an
 * object. Passing an object fails with "Failed to parse input arguments", which
 * is easy to misread as a schema problem. The spec's IDL says `optional object
 * inputObject`, so the shipped behavior differs from the written spec here.
 */
export async function callTool(
  context: ModelContextLike,
  tool: RegisteredToolLike,
  input: Record<string, unknown> = {},
): Promise<string> {
  if (typeof context.executeTool !== "function") {
    throw new Error("executeTool is not available in this browser");
  }
  return context.executeTool(tool, JSON.stringify(input) as unknown as object);
}

/**
 * Register a tool, returning a disposer.
 *
 * There is no `unregisterTool` in the spec — the entire lifecycle is
 * AbortSignal-driven, so the disposer aborts the controller we registered with.
 * Getting this wrong is the classic WebMCP bug: tools outliving the component
 * that owns them and going stale.
 */
export async function registerTool(
  context: ModelContextLike,
  tool: unknown,
  options: { exposedTo?: string[] } = {},
): Promise<() => void> {
  const controller = new AbortController();
  await context.registerTool(tool, {
    signal: controller.signal,
    ...(options.exposedTo?.length ? { exposedTo: options.exposedTo } : {}),
  });
  return () => controller.abort();
}

export function describeLayer(layer: WebMcpLayer): { label: string; detail: string } {
  switch (layer) {
    case "L1_cross_origin":
      return {
        label: "Cross-origin WebMCP",
        detail: "Bidder agents are calling the auction house across a real exposedTo trust boundary.",
      };
    case "L2_same_origin":
      return {
        label: "Same-origin WebMCP",
        detail:
          "WebMCP tools are live, but cross-origin invocation is unavailable in this browser. " +
          "Agents use the identical getTools/executeTool path, same-origin.",
      };
    case "L3_no_webmcp":
      return {
        label: "Manual mode",
        detail:
          "No WebMCP in this browser. The auction is fully usable by hand. " +
          "For the agent demo, use Chrome 149+ with chrome://flags/#enable-webmcp-testing.",
      };
  }
}
