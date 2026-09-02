#!/usr/bin/env node
/**
 * The judge's path, driven end to end in a real browser.
 *
 * Two claims are checked here, and neither can be checked from the API alone
 * because both are about what a person actually sees:
 *
 *   1. One click hands the bidding to an agent, and the agent then STOPS and
 *      asks — the confirmation card is the whole point of the project, and it
 *      used to be four steps deep where nobody would find it.
 *   2. An instruction telling the agent to ignore its limit does not work.
 *      The panel is wired to the real endpoint, so this fails loudly if
 *      enforcement ever regresses.
 *
 *   node scripts/probe-delegate.mjs <floor-url>
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ARG = process.argv[2] ?? "http://localhost:5173";
const PORT = Number(process.env.PORT_CDP ?? 9503);
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && existsSync(p));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

class CDP {
  #ws; #id = 0; #p = new Map();
  static async attach(u) {
    const c = new CDP(); c.#ws = new WebSocket(u);
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout")), 10000);
      c.#ws.onopen = () => { clearTimeout(t); res(); }; c.#ws.onerror = () => rej(new Error("sock")); });
    c.#ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = c.#p.get(m.id);
      if (p) { c.#p.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => { this.#p.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.#p.has(id)) { this.#p.delete(id); reject(new Error(method + " timeout")); } }, 30000); });
  }
  async eval(e) {
    const r = await this.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description };
    return r.result?.value;
  }
  close() { try { this.#ws.close(); } catch {} }
}

const clickByText = (text) => `(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith(${JSON.stringify(text)}));
  if (!b) return false;
  b.click();
  return true;
})()`;

async function main() {
  if (!CHROME) { console.error("No Chrome found."); process.exit(2); }
  const profile = mkdtempSync(join(tmpdir(), "of-del-"));
  const proc = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });

  let cdp;
  try {
    let ver = null;
    for (let i = 0; i < 40 && !ver; i++) { await wait(500);
      try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {} }
    const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = await CDP.attach(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: URL_ARG });
    await wait(7000);

    console.log(`\nDelegation probe · ${URL_ARG}\n`);

    /* ── 1. One click hands over the bidding ─────────────────── */
    const offered = await cdp.eval(
      `!!document.querySelector('.delegate') && !!document.querySelector('.delegate button')`,
    );
    check("a first-time visitor is offered an agent", offered === true);

    const clicked = await cdp.eval(clickByText("Bid for me"));
    check("the offer is one click", clicked === true);
    await wait(4000);

    const limits = await cdp.eval(`(() => {
      const facts = [...document.querySelectorAll('.fact .k')].map(e => e.textContent.trim());
      return { hasBand: !!document.querySelector('.band, .fact'), facts };
    })()`);
    check("limits appear without the visitor typing any",
      (limits?.facts ?? []).some((f) => /Never passes/i.test(f)),
      (limits?.facts ?? []).join(" · ") || "none");

    /* ── 2. The agent acts, then asks ────────────────────────── */
    // The whole point: it must stop and ask rather than spend quietly.
    let asked = false, line = null;
    for (let i = 0; i < 22 && !asked; i++) {
      await wait(3000);
      const r = await cdp.eval(`(() => ({
        card: !!document.querySelector('.confirm, [class*="confirm"]'),
        text: document.body.innerText.includes('wants to bid') || document.body.innerText.includes('Approve'),
        line: document.querySelector('.agent-line')?.textContent?.trim() ?? null,
      }))()`);
      line = r?.line ?? line;
      asked = !!(r?.card || r?.text);
    }
    check("the agent reports what it is doing", !!line, line ?? "no line shown");
    check("the agent stops and asks permission", asked, asked ? "confirmation shown" : "no ask within ~66s");

    /* ── 3. Try to make it overspend ─────────────────────────── */
    const hasPanel = await cdp.eval(`!!document.querySelector('.break-input')`);
    check("the break-it panel is available once delegated", hasPanel === true);

    const ran = await cdp.eval(clickByText("Send it to the agent"));
    check("the attack can be sent", ran === true);
    await wait(5000);

    const res = await cdp.eval(`(() => {
      const el = document.querySelector('.break-result');
      if (!el) return null;
      return {
        held: el.classList.contains('held'),
        broke: el.classList.contains('broke'),
        text: el.innerText.replace(/\\s+/g, ' ').slice(0, 220),
      };
    })()`);
    check("a verdict is shown", !!res, res ? "" : "no result rendered");
    check("the limit HELD against the injected instruction",
      res?.held === true && res?.broke !== true, res?.text ?? "");

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
  } finally {
    cdp?.close();
    proc.kill();
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
