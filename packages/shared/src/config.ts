/**
 * Runtime configuration for the browser apps.
 *
 * WHY NOT BUILD-TIME ENV
 * ----------------------
 * Vite inlines `import.meta.env.VITE_*` at build time, which means a bundle is
 * pinned to whatever origins it was compiled against. That broke on the first
 * Cloud Run deploy: `gcloud run deploy --set-build-env-vars` feeds buildpacks,
 * NOT Docker `--build-arg`, so every VITE_* value compiled to `""`. The floor
 * then fell back to its own origin and talked to itself, `exposedTo` still
 * listed localhost, and cross-origin discovery quietly failed.
 *
 * So configuration is read at RUNTIME from a tiny `/config.js` the server
 * generates from its own environment. One image runs anywhere, and the origins
 * a page trusts are a deployment decision rather than a compile-time one.
 *
 * `import.meta.env` remains the fallback so local `vite dev` keeps working.
 */

export interface OpenFloorConfig {
  /** Origin of the auction API. Empty means same-origin. */
  apiBase: string;
  /** Auction room to join. */
  room: string;
  /** Bidder origins the floor exposes its tools to (floor only). */
  bidderOrigins: string[];
  /** Origin of the auction floor, bridged into the frame tree (bidder only). */
  floorOrigin: string;
  /** Which bidder persona this console runs as. */
  persona: string;
}

interface RawConfig {
  apiBase?: string;
  room?: string;
  bidderOrigins?: string | string[];
  floorOrigin?: string;
  persona?: string;
}

function fromWindow(): RawConfig {
  if (typeof window === "undefined") return {};
  return (window as unknown as { __OPENFLOOR_CONFIG__?: RawConfig }).__OPENFLOOR_CONFIG__ ?? {};
}

function fromBuild(): RawConfig {
  // Guarded: `import.meta.env` does not exist outside a bundler.
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
    return {
      apiBase: env.VITE_API_BASE,
      room: env.VITE_ROOM,
      bidderOrigins: env.VITE_BIDDER_ORIGINS,
      floorOrigin: env.VITE_FLOOR_ORIGIN,
      persona: env.VITE_PERSONA,
    };
  } catch {
    return {};
  }
}

function toList(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v.filter(Boolean);
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve config: runtime first, build-time second, defaults last.
 *
 * Runtime wins deliberately — a deployed page must be able to point at the
 * right origins without being rebuilt.
 */
export function loadConfig(): OpenFloorConfig {
  const win = fromWindow();
  const build = fromBuild();

  // An empty string is a real value here ("same origin"), so `||` would wrongly
  // fall through it. Only undefined should defer to the next source.
  const pick = (a: string | undefined, b: string | undefined, fallback: string) =>
    a !== undefined ? a : b !== undefined ? b : fallback;

  const bidderOrigins = win.bidderOrigins !== undefined ? win.bidderOrigins : build.bidderOrigins;

  return {
    apiBase: pick(win.apiBase, build.apiBase, ""),
    room: pick(win.room, build.room, "main"),
    bidderOrigins: toList(bidderOrigins),
    floorOrigin: pick(win.floorOrigin, build.floorOrigin, ""),
    persona: pick(win.persona, build.persona, "you"),
  };
}
