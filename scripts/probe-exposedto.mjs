#!/usr/bin/env node
/**
 * Does `exposedTo` actually enforce?
 *
 * The entire security story rests on one claim: the floor's tools are reachable
 * by ALLOWLISTED bidder origins and by nobody else. Everything so far has only
 * shown the allowlisted case works. That proves exposure, not restriction — and
 * a permissive `exposedTo` would mean any site could drive the auction.
 *
 * Controlled experiment: the floor allowlists ports 5174 and 5175 only. The
 * IDENTICAL bidder app is also served on 5176, which is a different origin and
 * outside the allowlist. Same code, same machine, same browser — the only
 * variable is whether the origin is on the list.
 *
 * The denied page MUST actually load, or an empty result would merely mean
 * "no page" rather than "blocked". The probe asserts that first.
 *
 * Also checks whether a MUTATING tool works cross-origin, and whether the
 * private mandate tools stay private.
 *
 *   node scripts/probe-exposedto.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FLOOR = "http://localhost:5173";
const ALLOWED = "http://localhost:5174"; // in the floor's exposedTo list
const DENIED = "http://localhost:5176"; // SAME app, served on a port outside the allowlist
const PORT = 9224;

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && existsSync(p));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, value, note = "") => {
  results.push({ name, value, note });
  const m = value === true ? "\x1b[32mYES\x1b[0m" : value === false ? "\x1b[31mNO \x1b[0m" : "\x1b[36m ? \x1b[0m";
  console.log(`  ${m}  ${name}${note ? `\n         ${note}` : ""}`);
};

class CDP {
  #ws; #id = 0; #p = new Map();
  static async attach(url) {
    const c = new CDP();
    c.#ws = new WebSocket(url);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), 10000);
      c.#ws.onopen = () => { clearTimeout(t); res(); };
      c.#ws.onerror = () => { clearTimeout(t); rej(new Error("sock err")); };
    });
    c.#ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = c.#p.get(m.id);
      if (p) { c.#p.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#p.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.#p.has(id)) { this.#p.delete(id); reject(new Error(`${method} timeout`)); } }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
    return r.result?.value;
  }
  async goto(url) { await this.send("Page.enable"); await this.send("Page.navigate", { url }); await wait(4500); }
  close() { try { this.#ws.close(); } catch {} }
}

/** In the page: mount a bridge frame to `origin`, then list what is reachable. */
const reachExpr = (target) => `(async () => {
  const mc = document.modelContext ?? navigator.modelContext;
  if (!mc) return { present: false };
  const f = document.createElement('iframe');
  f.setAttribute('allow', 'tools');
  f.src = '${target}';
  document.body.appendChild(f);
  await new Promise(r => { f.onload = r; setTimeout(r, 7000); });
  await new Promise(r => setTimeout(r, 3000));
  const local = (await mc.getTools()).map(t => t.name);
  let cross = [];
  try { cross = (await mc.getTools({ fromOrigins: ['${target}'] })).map(t => t.name); }
  catch (e) { return { present: true, here: location.origin, local, error: String(e).slice(0,200) }; }
  const remoteOnly = cross.filter(n => !local.includes(n));
  return { present: true, here: location.origin, local: local.sort(), remoteOnly: remoteOnly.sort() };
})()`;

async function main() {
  console.log("OpenFloor — does exposedTo actually enforce?\n");
  console.log(`Floor allowlists: ${ALLOWED}`);
  console.log(`Testing denied:   ${DENIED}  (same app, different origin)\n`);

  const profile = mkdtempSync(join(tmpdir(), "openfloor-xo-"));
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check",
    "--enable-features=WebMCP,WebModelContext,ModelContext",
    "--enable-blink-features=WebMCP,ModelContext",
    "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    let ver = null;
    for (let i = 0; i < 40 && !ver; i++) {
      await wait(500);
      try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
    }
    if (!ver) throw new Error("no debugging port");

    const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(ALLOWED)}`, { method: "PUT" })).json();
    cdp = await CDP.attach(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");

    /* ── 1. Allowlisted origin ───────────────────────────────── */
    console.log("\x1b[1m1. Allowlisted origin — should reach the floor\x1b[0m");
    await cdp.goto(ALLOWED);
    const allowed = await cdp.eval(reachExpr(FLOOR));
    const allowedTools = allowed?.remoteOnly ?? [];
    record("reaches the floor's tools", allowedTools.length > 0, `${allowedTools.length}: ${allowedTools.join(", ") || allowed?.error || "none"}`);
    record("  includes the mutating place_bid", allowedTools.includes("place_bid"));

    /* ── 2. Non-allowlisted origin ───────────────────────────── */
    console.log("\n\x1b[1m2. Non-allowlisted origin — must NOT reach the floor\x1b[0m");
    await cdp.goto(DENIED);
    const denied = await cdp.eval(reachExpr(FLOOR));
    const deniedTools = denied?.remoteOnly ?? [];
    // Guard against a false positive: an unreachable page reaches no tools for
    // a trivial reason. The denied origin must genuinely be running the app.
    record(
      "the denied page actually loaded and has its own tools",
      (denied?.local ?? []).length > 0,
      `origin ${denied?.here ?? "?"} · local tools: ${(denied?.local ?? []).join(", ") || "NONE — result below is meaningless"}`,
    );
    const enforced = deniedTools.length === 0;
    record(
      "exposedTo BLOCKS the unlisted origin",
      enforced,
      enforced
        ? "no floor tools reachable — the allowlist is enforced"
        : `LEAK: reached ${deniedTools.length} tool(s): ${deniedTools.join(", ")}`,
    );
    record("  place_bid NOT reachable", !deniedTools.includes("place_bid"));

    /* ── 3. Cross-origin mutation from the allowlisted origin ── */
    console.log("\n\x1b[1m3. Cross-origin MUTATION (place_bid) from the allowlisted origin\x1b[0m");
    await cdp.goto(ALLOWED);
    const mutate = await cdp.eval(`(async () => {
      const mc = document.modelContext ?? navigator.modelContext;
      const f = document.createElement('iframe');
      f.setAttribute('allow','tools'); f.src = '${FLOOR}';
      document.body.appendChild(f);
      await new Promise(r => { f.onload = r; setTimeout(r, 7000); });
      await new Promise(r => setTimeout(r, 3000));
      const tools = await mc.getTools({ fromOrigins: ['${FLOOR}'] });
      const bid = tools.find(t => t.name === 'place_bid');
      if (!bid) return { found: false };
      try {
        const out = await mc.executeTool(bid, JSON.stringify({
          lot_id: 'lot-leica', amount_cents: 999999, rationale: 'cross-origin probe'
        }));
        return { found: true, ok: true, out: String(out).slice(0, 300) };
      } catch (e) { return { found: true, ok: false, error: String(e).slice(0, 220) }; }
    })()`);
    if (mutate?.found && mutate?.ok) {
      record("a mutating tool invokes cross-origin", true, mutate.out);
      // 999999 cents is far above any mandate ceiling: the server must refuse it.
      const refused = /ceiling|not_authorized|No mandate|exceeds/i.test(mutate.out ?? "");
      record(
        "  server still enforces the mandate on a cross-origin bid",
        refused,
        refused ? "refused server-side, as designed" : "NOT refused — check enforcement",
      );
    } else {
      record("a mutating tool invokes cross-origin", false, mutate?.error ?? "place_bid not found");
    }

    /* ── Verdict ─────────────────────────────────────────────── */
    const ok = (n) => results.find((r) => r.name === n)?.value === true;
    console.log(`\n${"─".repeat(60)}`);
    console.log(
      `  exposedTo enforced: ${ok("exposedTo BLOCKS the unlisted origin") ? "\x1b[32mYES\x1b[0m" : "\x1b[31mNO\x1b[0m"}`,
    );
    console.log(`  ${results.filter((r) => r.value === true).length} confirmed, ${results.filter((r) => r.value === false).length} negative`);
    console.log(`${"─".repeat(60)}\n`);
  } finally {
    try { cdp?.close(); } catch {}
    try { proc.kill(); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
