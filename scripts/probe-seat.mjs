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

const URL_ARG = process.argv[2] ?? "http://127.0.0.1:8140";
const PORT = Number(process.env.PORT_CDP ?? 9487);
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
  const profile = mkdtempSync(join(tmpdir(), "of-seat-"));
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
    "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    let ver = null;
    for (let i = 0; i < 40 && !ver; i++) {
      await wait(500);
      try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
    }
    const page = await (await fetch(
      `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_ARG)}`, { method: "PUT" },
    )).json();
    cdp = await CDP.attach(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: URL_ARG });
    await wait(5000);

    console.log(`\nSeat-claim probe · ${URL_ARG}\n`);

    const before = await cdp.eval(`document.querySelector('.who-button')?.textContent?.trim() ?? null`);
    check("the seat control is on the page at all", !!before, before ?? "not found");

    // Open the panel and fill it the way a person would: React listens for
    // input events, so setting .value alone would leave state untouched.
    const handle = "probe" + Math.random().toString(36).slice(2, 8);
    const filled = await cdp.eval(`(async () => {
      const set = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      document.querySelector('.who-button').click();
      await new Promise(r => setTimeout(r, 300));
      const h = document.getElementById('seat-handle');
      const p = document.getElementById('seat-pass');
      if (!h || !p) return { ok: false, why: 'form did not open' };
      set(h, ${JSON.stringify(handle)});
      set(p, 'a-good-passphrase');
      await new Promise(r => setTimeout(r, 150));
      const btn = document.querySelector('.seat-submit');
      return { ok: !btn.disabled, why: btn.disabled ? 'submit stayed disabled' : '' };
    })()`);
    check("the form opens and accepts input", filled?.ok === true, filled?.why || "");

    await cdp.eval(`document.querySelector('.seat-submit').click()`);
    await wait(2500);

    const after = await cdp.eval(`document.querySelector('.who')?.textContent?.trim() ?? null`);
    check("the header shows the claimed name", after === handle, `showed "${after}"`);

    const popGone = await cdp.eval(`!document.querySelector('.seat-pop')`);
    check("the panel closes on success", popGone === true);

    // The real question: does it survive a reload? That is the whole point.
    await cdp.send("Page.navigate", { url: URL_ARG });
    await wait(5000);
    const afterReload = await cdp.eval(`document.querySelector('.who')?.textContent?.trim() ?? null`);
    check("the seat survives a reload", afterReload === handle, `showed "${afterReload}"`);

    const sess = await cdp.eval(
      `fetch(${JSON.stringify(new URL("/api/session", process.env.PROBE_API ?? URL_ARG).toString())},` +
      `{credentials:'include'}).then(r=>r.json()).then(j=>j.session?.handle ?? null)`,
    );
    check("the server agrees who we are", sess === handle, `server said "${sess}"`);

    // A second seat must not be able to steal the name with a wrong passphrase.
    const stolen = await cdp.eval(
      `fetch(${JSON.stringify(new URL("/api/session", process.env.PROBE_API ?? URL_ARG).toString())},` +
      `{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},` +
      `body:JSON.stringify({handle:${JSON.stringify(handle)},passphrase:'wrong-passphrase'})})` +
      `.then(r=>r.json()).then(j=>j.error ?? null)`,
    );
    check("a wrong passphrase cannot take the name", !!stolen, stolen ?? "it was allowed!");

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
  } finally {
    cdp?.close();
    proc.kill();
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
