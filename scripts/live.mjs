#!/usr/bin/env node
/**
 * Live-behaviour suite: the things neither unit nor REST tests can reach.
 *
 * WebSocket fan-out, the auction clock, anti-snipe extension, lot closing via
 * the Durable Object alarm, CORS headers, and the LLM proxy.
 *
 *   npx wrangler dev --port 8123
 *   node scripts/live.mjs
 *
 * Takes ~2 minutes: the clock tests wait on real elapsed time rather than
 * mocking it, because the alarm path is exactly what mocking would skip.
 */

const BASE = process.env.OPENFLOOR_API ?? "http://127.0.0.1:8123/api";
const ROOM = `live-${Date.now()}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const url = (p, q = {}) => {
  const u = new URL(BASE + p);
  u.searchParams.set("room", ROOM);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
  return u.toString();
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p, q) => {
  await wait(120);
  return (await fetch(url(p, q))).json();
};
const post = async (p, body) => {
  await wait(120);
  const r = await fetch(url(p), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function main() {
  console.log(`OpenFloor live-behaviour suite\nroom: ${ROOM}\napi:  ${BASE}`);

  /* ── CORS ─────────────────────────────────────────────────── */
  section("CORS — the HTTP mirror of the exposedTo allowlist");
  // Must be an origin the server actually allowlists, which differs between
  // local dev and a deployment.
  const allowed = process.env.OPENFLOOR_ALLOWED_ORIGIN ?? "http://localhost:5174";
  const pre = await fetch(url("/state"), {
    method: "OPTIONS",
    headers: { Origin: allowed, "Access-Control-Request-Method": "POST" },
  });
  check("preflight succeeds", pre.status === 204, String(pre.status));
  check(
    "an allowlisted bidder origin is echoed back",
    pre.headers.get("access-control-allow-origin") === allowed,
    pre.headers.get("access-control-allow-origin") ?? "none",
  );
  check("Vary: Origin is set so caches do not cross origins", /origin/i.test(pre.headers.get("vary") ?? ""));

  const eviln = await fetch(url("/state"), {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
  });
  check(
    "an unlisted origin is NOT echoed back",
    eviln.headers.get("access-control-allow-origin") !== "https://evil.example",
    eviln.headers.get("access-control-allow-origin") ?? "none",
  );

  /* ── LLM proxy ────────────────────────────────────────────── */
  section("LLM proxy");
  const llm = await fetch(new URL("/api/llm", BASE).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system: "x", messages: [{ role: "user", content: "hi" }] }),
  });
  const llmBody = await llm.json().catch(() => ({}));
  const keyless = llm.status === 503 && llmBody.error === "no_api_key";
  check(
    keyless ? "reports a missing key clearly (agents fall back)" : "proxies to the model",
    keyless || llm.status === 200,
    `status ${llm.status}`,
  );
  if (keyless) {
    check("says agents will use the heuristic policy", /heuristic/i.test(llmBody.message ?? ""));
  }
  const llmGet = await fetch(new URL("/api/llm", BASE).toString());
  check("rejects non-POST", llmGet.status === 405, String(llmGet.status));

  /* ── WebSocket ────────────────────────────────────────────── */
  section("WebSocket live events");
  const wsUrl = url("/ws").replace(/^http/, "ws");
  const events = [];
  let ws;
  let opened = false;

  try {
    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("open timeout")), 8000);
      ws.onopen = () => {
        opened = true;
        clearTimeout(t);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("socket error"));
      };
    });
    ws.onmessage = (e) => {
      try {
        events.push(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
  } catch (err) {
    check("websocket connects", false, err.message);
  }
  check("websocket connects", opened);

  if (opened) {
    await wait(400);
    check(
      "sends the current state on connect",
      events.some((e) => e.type === "state"),
      `got: ${events.map((e) => e.type).join(",") || "nothing"}`,
    );

    await post("/join", { bidder_id: "w1", alias: "Watcher" });
    await post("/mandate", { bidder_id: "w1", ceiling_cents: 500000, notify_above_cents: 499000 });
    await post("/start");
    await wait(600);
    check(
      "broadcasts an audit entry when a lot opens",
      events.some((e) => e.type === "audit" && e.entry?.action === "lot_opened"),
    );

    await post("/bid", { bidder_id: "w1", lot_id: "lot-leica", amount_cents: 3100, placed_by: "human" });
    await wait(600);
    const bidEvt = events.find((e) => e.type === "bid");
    check("broadcasts a bid to connected clients", !!bidEvt);
    check("the bid event carries fresh state", bidEvt?.state?.current_price_cents === 3100);

    await post("/join", { bidder_id: "w2", alias: "Second" });
    await post("/mandate", { bidder_id: "w2", ceiling_cents: 500000, notify_above_cents: 3000 });
    await post("/bid", {
      bidder_id: "w2",
      lot_id: "lot-leica",
      amount_cents: 3500,
      placed_by: "agent",
      rationale: "testing",
    });
    await wait(600);
    check(
      "broadcasts a confirmation request",
      events.some((e) => e.type === "confirmation_required"),
    );
  }

  /* ── Clock, anti-snipe, and the alarm ─────────────────────── */
  section("Clock, anti-snipe, and lot closing (~90s)");
  const s0 = await get("/state");
  check("clock is counting down", s0.state.seconds_remaining > 0 && s0.state.seconds_remaining <= 75);

  console.log(`  … waiting for the clock to reach the anti-snipe window`);
  let guard = 0;
  while (guard++ < 90) {
    const s = await get("/state");
    if (s.state.seconds_remaining <= 8) break;
    await wait(1000);
  }

  const beforeSnipe = await get("/state");
  check("reached the closing seconds", beforeSnipe.state.seconds_remaining <= 10, String(beforeSnipe.state.seconds_remaining));

  // A distinct bidder, deliberately: w1 holds the high bid by this point and
  // self-bidding is refused, which would mask whether the extension fired.
  await post("/join", { bidder_id: "sniper", alias: "Sniper" });
  const snipe = await post("/bid", {
    bidder_id: "sniper",
    lot_id: "lot-leica",
    amount_cents: beforeSnipe.state.current_price_cents + beforeSnipe.state.min_increment_cents,
    placed_by: "human",
  });
  check("a last-second bid is accepted", snipe.status === "accepted", snipe.status);

  const afterSnipe = await get("/state");
  check(
    "the clock is extended by the late bid",
    afterSnipe.state.clock_extended === true && afterSnipe.state.seconds_remaining > beforeSnipe.state.seconds_remaining,
    `extended=${afterSnipe.state.clock_extended} secs ${beforeSnipe.state.seconds_remaining}→${afterSnipe.state.seconds_remaining}`,
  );
  check(
    "sniping cannot win on timing alone",
    afterSnipe.state.seconds_remaining >= 8,
    String(afterSnipe.state.seconds_remaining),
  );

  console.log(`  … waiting for the hammer to fall`);
  guard = 0;
  let closed = null;
  while (guard++ < 40) {
    await wait(2000);
    const s = await get("/state");
    if (s.state.lot && s.state.lot.status !== "open") {
      closed = s.state;
      break;
    }
  }
  check("the alarm closes the lot", !!closed, closed ? closed.lot.status : "still open after 80s");

  if (closed) {
    const reserveMet = closed.reserve_met;
    check(
      `lot resolved consistently with the reserve (${closed.lot.status})`,
      reserveMet ? closed.lot.status === "sold" : closed.lot.status === "passed",
      `reserve_met=${reserveMet} status=${closed.lot.status}`,
    );
    check("the clock reads zero once closed", closed.seconds_remaining === 0);

    const bidAfter = await post("/bid", {
      bidder_id: "w1",
      lot_id: "lot-leica",
      amount_cents: 999999,
      placed_by: "human",
    });
    check("no bids are accepted after closing", bidAfter.status !== "accepted", bidAfter.status);

    const audit = await get("/audit");
    check(
      "closing is recorded in the audit trail",
      audit.entries.some((e) => e.action === "lot_sold" || e.action === "lot_passed"),
    );
    check(
      "the clock extension is recorded",
      audit.entries.some((e) => e.action === "clock_extended"),
    );
  }

  if (opened) {
    check(
      "a lot_closed event reached connected clients",
      events.some((e) => e.type === "lot_closed"),
    );
    ws.close();
  }

  /* ── Summary ──────────────────────────────────────────────── */
  console.log(`\n${"─".repeat(52)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    - ${f}`);
  }
  console.log(`${"─".repeat(52)}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("\nSuite crashed:", err);
  process.exit(1);
});
