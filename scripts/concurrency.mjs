#!/usr/bin/env node
/**
 * Does the serialization mutex actually hold?
 *
 * A Durable Object runs one request at a time per instance, so bid ordering was
 * correct for free. Node does not: its event loop switches at every `await`,
 * and the bid path awaits inside mandate signature verification — precisely
 * between reading the current price and committing a bid. Without a mutex, two
 * agents bidding in the same tick can both observe the pre-bid price and both
 * be accepted, and the auction silently loses money.
 *
 * The engine restores that guarantee with an explicit promise chain. This
 * script tries to break it, firing genuinely simultaneous requests with no
 * pacing at all.
 *
 *   node scripts/concurrency.mjs
 */

const BASE = process.env.OPENFLOOR_API ?? "http://127.0.0.1:8140/api";
const ROOM = `conc-${Date.now()}`;

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const url = (p, q = {}) => {
  const u = new URL(BASE + p);
  u.searchParams.set("room", ROOM);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
  return u.toString();
};
const get = async (p, q) => (await fetch(url(p, q))).json();
const post = async (p, body) =>
  (
    await fetch(url(p), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    })
  ).json();

async function main() {
  console.log(`OpenFloor — concurrency / serialization\nroom: ${ROOM}\napi:  ${BASE}\n`);

  const BIDDERS = 10;
  for (let i = 0; i < BIDDERS; i++) {
    await post("/join", { bidder_id: `c${i}`, alias: `Racer${i}` });
    await post("/mandate", { bidder_id: `c${i}`, ceiling_cents: 5_000_000, notify_above_cents: 4_999_000 });
  }
  await post("/start");

  const s0 = await get("/state");
  const price0 = s0.state.current_price_cents;
  const inc = s0.state.min_increment_cents;

  /* ── 1. Ten identical bids fired simultaneously ─────────────── */
  console.log("\x1b[1m1. Ten bidders, identical amount, zero pacing\x1b[0m");
  const target = price0 + inc;
  const wave = await Promise.all(
    Array.from({ length: BIDDERS }, (_, i) =>
      post("/bid", {
        bidder_id: `c${i}`,
        lot_id: "lot-leica",
        amount_cents: target,
        placed_by: "agent",
        rationale: "race",
      }),
    ),
  );

  const accepted = wave.filter((r) => r.status === "accepted");
  check(
    "exactly one bid wins at a given price",
    accepted.length === 1,
    `${accepted.length} accepted of ${BIDDERS}`,
  );
  check(
    "the losers are told why, never silently dropped",
    wave.every((r) => typeof r.status === "string" && r.status.length > 0),
  );

  const after = await get("/state");
  check(
    "the price advanced exactly one increment",
    after.state.current_price_cents === target,
    `${price0} → ${after.state.current_price_cents}`,
  );
  check("exactly one bid was recorded", after.state.bid_count === 1, `bid_count=${after.state.bid_count}`);

  /* ── 2. Sustained interleaving ──────────────────────────────── */
  console.log("\n\x1b[1m2. Five waves of ten, back to back\x1b[0m");
  for (let w = 0; w < 5; w++) {
    const cur = (await get("/state")).state;
    await Promise.all(
      Array.from({ length: BIDDERS }, (_, i) =>
        post("/bid", {
          bidder_id: `c${i}`,
          lot_id: "lot-leica",
          amount_cents: cur.current_price_cents + cur.min_increment_cents,
          placed_by: "agent",
          rationale: `wave ${w}`,
        }),
      ),
    );
  }

  const end = await get("/state");
  const hist = await get("/history", { limit: 25 });
  const amounts = hist.bids.map((b) => b.amount_cents);

  check(
    "no two bids share a price",
    new Set(amounts).size === amounts.length,
    `${amounts.length} bids, ${new Set(amounts).size} distinct`,
  );
  check(
    "bid history is strictly descending (newest first)",
    amounts.every((a, i) => i === 0 || amounts[i - 1] > a),
  );
  check(
    "the final price matches the highest recorded bid",
    end.state.current_price_cents === Math.max(...amounts),
    `state=${end.state.current_price_cents} max=${Math.max(...amounts)}`,
  );
  check(
    "every accepted bid cleared the minimum increment",
    amounts.every((a, i) => i === amounts.length - 1 || a - amounts[i + 1] >= end.state.min_increment_cents),
  );

  /* ── 3. Nobody can outrun the ceiling ───────────────────────── */
  console.log("\n\x1b[1m3. A concurrent stampede past a hard ceiling\x1b[0m");
  await post("/join", { bidder_id: "capped", alias: "Capped" });
  const cur = (await get("/state")).state;
  const ceiling = cur.current_price_cents + cur.min_increment_cents * 2;
  await post("/mandate", {
    bidder_id: "capped",
    ceiling_cents: ceiling,
    notify_above_cents: ceiling,
  });

  const stampede = await Promise.all(
    Array.from({ length: 8 }, () =>
      post("/bid", {
        bidder_id: "capped",
        lot_id: "lot-leica",
        amount_cents: ceiling + 100_000,
        placed_by: "agent",
        rationale: "over the wall",
      }),
    ),
  );
  check(
    "not one racing bid gets past the ceiling",
    stampede.every((r) => r.status !== "accepted"),
    `statuses: ${[...new Set(stampede.map((r) => r.status))].join(", ")}`,
  );

  console.log(`\n${"─".repeat(52)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${"─".repeat(52)}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("crashed:", e);
  process.exit(1);
});
