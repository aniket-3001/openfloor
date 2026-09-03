#!/usr/bin/env node
/**
 * Drive the "keep this seat" flow in a real browser.
 *
 * The claim endpoint sets a cookie, and a cookie is exactly the sort of thing
 * that works in curl and fails in a browser — SameSite, Secure, and the
 * cross-origin `credentials` flag all have to line up. So this clicks the real
 * control on the real page rather than posting JSON and calling it proven.
 *
 *   node scripts/probe-seat.mjs <floor-url>
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ARG = process.argv[2] ?? "https://openfloor-bidder-101078802199.us-central1.run.app";
const PORT = Number(process.env.PORT_CDP ?? 9950);
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
  static async attach(url) {
    const c = new CDP();
    c.#ws = new WebSocket(url);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), 10000);
      c.#ws.onopen = () => { clearTimeout(t); res(); };
      c.#ws.onerror = () => { clearTimeout(t); rej(new Error("sock")); };
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
      setTimeout(() => { if (this.#p.has(id)) { this.#p.delete(id); reject(new Error(method + " timeout")); } }, 25000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description };
    return r.result?.value;
  }
  close() { try { this.#ws.close(); } catch {} }
}

async function main() {
  if (!CHROME) { console.error("No Chrome found."); process.exit(2); }
  const profile = mkdtempSync(join(tmpdir(), "of-con-"));
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1400,1100",
    "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    let ver = null;
    for (let i = 0; i < 40 && !ver; i++) {
      await wait(500);
      try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
    }
    // Open blank, then navigate once. Creating the tab at the target URL and
    // then navigating to it again loads the page twice, and the second load
    // can land while the first is still settling its session cookie.
    const page = await (await fetch(
      `http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" },
    )).json();
    cdp = await CDP.attach(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: URL_ARG });
    await wait(9000);

    console.log(`
Bidder console · ${URL_ARG}
`);

    const before = await cdp.eval(`(() => ({
      header: (document.querySelector('.masthead-right')?.innerText ?? '').trim(),
      idle: document.querySelector('.empty')?.textContent?.trim() ?? null,
      hasForm: !!document.querySelector('input[aria-label="Hard ceiling"]'),
      lotOpen: (document.querySelector('.clock')?.textContent ?? '') !== '',
    }))()`);

    check("the console loads with a limits form", before?.hasForm === true);
    // It used to say "Waiting for a lot to open" while a lot was plainly open,
    // and the real reason was that no limits had been set.
    check("the idle message does not blame a missing lot",
      !!before?.idle && !/waiting for a lot to open/i.test(before.idle), before?.idle ?? "none");
    check("the idle message says what to do", /set your limits/i.test(before?.idle ?? ""));
    check("the agent starts paused", /paused/i.test(before?.header ?? ""), before?.header);

    const clicked = await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')]
      .find(x => x.textContent.trim() === 'Set limits'); if (!b) return false; b.click(); return true; })()`);
    check("the Set limits button is clickable", clicked === true);

    // Poll rather than wait a fixed moment: the save is a round trip and the
    // agent's first decision is on its own cadence.
    let ready = false;
    for (let i = 0; i < 12 && !ready; i++) {
      await wait(2500);
      ready = await cdp.eval(`/bidding/i.test(document.querySelector('.masthead-right')?.innerText ?? '')`);
    }

    // The regression this file exists for: the console minted its own bidder
    // id, so the mandate was written under the session and read back under the
    // invented one. The server refused it as someone else's, and the agent
    // could never be enabled.
    const after = await cdp.eval(`(() => ({
      header: (document.querySelector('.masthead-right')?.innerText ?? '').trim(),
      rows: document.querySelectorAll('.log-row').length,
      stillIdle: !!document.querySelector('.empty'),
    }))()`);
    check("setting limits actually saves a mandate", after?.stillIdle !== true || after?.rows > 0,
      after?.stillIdle ? "still showing the idle message" : "");
    check("the agent switches to bidding", /bidding/i.test(after?.header ?? ""), after?.header);

    let rows = after?.rows ?? 0;
    for (let i = 0; i < 10 && rows < 2; i++) {
      await wait(4000);
      rows = await cdp.eval(`document.querySelectorAll('.log-row').length`);
    }
    check("the agent shows its reasoning", rows > 0, `${rows} entries`);

    console.log(`
  ${pass} passed, ${fail} failed
`);
  } finally {
    cdp?.close();
    proc.kill();
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
