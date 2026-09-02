/**
 * Keeps the demo room perpetually live.
 *
 * A lot runs for 75 seconds and then the hammer falls. That is correct auction
 * behaviour, but it means a visitor who arrives two minutes after a deploy
 * finds a closed lot and an empty room — the deployed demo only demonstrates
 * itself during a narrow window nobody can predict.
 *
 * This advances to the next lot shortly after one closes, and cycles back to
 * the start when the catalogue is exhausted, so the auction is always running
 * whenever someone opens the URL.
 *
 * It drives the room through the ordinary HTTP surface, like everything else
 * here, and is opt-in via OPENFLOOR_CONTINUOUS so tests that assert a lot
 * closes and STAYS closed are unaffected.
 */

const PAUSE_AFTER_CLOSE_MS = 8000;

/** Programmatic actors present a credential rather than relying on anonymity. */
function internalHeaders(): Record<string, string> {
  const t = process.env.OPENFLOOR_INTERNAL_TOKEN || process.env.MANDATE_SECRET || "";
  return t ? { "x-openfloor-internal": t } : {};
}

export function startContinuousAuction(opts: {
  apiBase: string;
  room: string;
  pollMs?: number;
}): () => void {
  const pollMs = opts.pollMs ?? 4000;
  let stopped = false;
  let closedAt: number | null = null;

  const url = (path: string) => {
    const u = new URL(`${opts.apiBase}/api${path}`);
    u.searchParams.set("room", opts.room);
    return u.toString();
  };
  const post = (path: string) =>
    fetch(url(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalHeaders() },
      body: "{}",
    });

  async function tick(): Promise<void> {
    if (stopped) return;
    const res = await fetch(url("/state"), { headers: internalHeaders() });
    const { state } = (await res.json()) as { state: any };

    // Nothing has ever been opened in this room — start the first lot.
    if (!state?.lot) return;
    if (state.lot.status === "open" && state.seconds_remaining > 0) {
      closedAt = null;
      return;
    }
    if (state.lot.status === "pending") {
      await post("/start");
      return;
    }

    // A brief pause after the hammer so the result is legible to anyone
    // watching, rather than the next lot snapping open instantly.
    const now = Date.now();
    if (closedAt === null) {
      closedAt = now;
      return;
    }
    if (now - closedAt < PAUSE_AFTER_CLOSE_MS) return;
    closedAt = null;

    const advanced = await post("/next");
    const { state: after } = (await advanced.json()) as { state: any };

    // `/next` is a no-op on the final lot, so the catalogue has run out and the
    // room needs recycling to keep the demo alive.
    if (after?.lot?.status !== "open") {
      // `/recycle`, not `/reset`: rewinding the catalogue must not evict the
      // people in the room. A full reset clears every mandate, which silently
      // de-authorized every seated bidder each time the demo looped.
      await post("/recycle");
      await post("/start");
      console.log("[auction] catalogue exhausted — recycled");
    } else {
      console.log(`[auction] advanced to ${after.lot.title}`);
    }
  }

  const timer = setInterval(() => {
    void tick().catch((e) => console.error("[auction] tick failed", e));
  }, pollMs);
  timer.unref?.();

  console.log(`[auction] continuous mode on, polling every ${pollMs}ms`);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
