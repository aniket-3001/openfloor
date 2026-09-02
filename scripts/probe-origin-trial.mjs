#!/usr/bin/env node
/**
 * Does the origin trial actually turn WebMCP on for an ordinary visitor?
 *
 * This is the only question that matters about the token, and it cannot be
 * answered by checking that the meta tag is present — a token can be served
 * and still be rejected for the wrong origin, the wrong feature, or an expiry
 * that has passed. So this launches Chrome with a CLEAN PROFILE AND NO
 * FEATURE FLAGS, exactly as a judge would have it, and asks the page whether
 * the API exists.
 *
 *   node scripts/probe-origin-trial.mjs <url> [...more urls]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URLS = process.argv.slice(2);
const PORT = Number(process.env.PORT_CDP ?? 9491);
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
  const profile = mkdtempSync(join(tmpdir(), "of-ot-"));

  // No --enable-features. A clean profile, a stock browser. If the API shows
  // up here it is the token doing it and nothing else.
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    let ver = null;
    for (let i = 0; i < 40 && !ver; i++) {
      await wait(500);
      try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
    }
    console.log(`\nOrigin-trial probe · stock Chrome, no flags`);
    console.log(`${ver?.Browser ?? "unknown build"}\n`);

    const page = await (await fetch(
      `http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" },
    )).json();
    cdp = await CDP.attach(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    for (const url of URLS) {
      console.log(`  ${url}`);
      await cdp.send("Page.navigate", { url });
      await wait(6000);

      // getTools() resolves rather than returning — measured, not assumed.
      const r = await cdp.eval(`(async () => {
        const ctx = document.modelContext ?? navigator.modelContext;
        let toolCount = -1, shape = 'none';
        try {
          const t = ctx?.getTools?.();
          shape = t && typeof t.then === 'function' ? 'promise' : Array.isArray(t) ? 'array' : typeof t;
          const list = await t;
          toolCount = Array.isArray(list) ? list.length : -1;
        } catch (e) { shape = 'threw: ' + e.message; }
        return {
          tag: !!document.querySelector('meta[http-equiv="origin-trial"]'),
          onDocument: typeof document.modelContext !== 'undefined',
          onNavigator: typeof navigator.modelContext !== 'undefined',
          toolCount, shape,
        };
      })()`);

      check("    the token tag is on the page", r?.tag === true);
      check(
        "    WebMCP is available with no flag set",
        r?.onDocument === true || r?.onNavigator === true,
        r?.onDocument || r?.onNavigator ? "" : "API absent — token not accepted",
      );
      if (r?.onDocument || r?.onNavigator) {
        check(
          "    the page registered its tools",
          (r?.toolCount ?? -1) > 0,
          `${r?.toolCount} tools (getTools returns ${r?.shape})`,
        );
      }
      console.log("");
    }

    console.log(`  ${pass} passed, ${fail} failed\n`);
  } finally {
    cdp?.close();
    proc.kill();
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
