#!/usr/bin/env node
/**
 * Look at the deployed page the way a visitor does.
 *
 * Loads a real Chrome over CDP and reports computed layout facts — whether an
 * element actually scrolls, how tall rows are, whether text overflows — rather
 * than trusting that a CSS change had the intended effect.
 *
 *   node scripts/inspect-ui.mjs <url>
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ARG = process.argv[2] ?? "https://openfloor-floor-101078802199.us-central1.run.app";
const PORT = Number(process.env.PORT_CDP ?? 9480);
const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && existsSync(p));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const profile = mkdtempSync(join(tmpdir(), "of-ui-"));
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
    const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_ARG)}`, { method: "PUT" })).json();
    cdp = await CDP.attach(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: URL_ARG });
    await wait(6000);

    console.log(`\n${URL_ARG}\n`);

    const report = await cdp.eval(`(() => {
      const out = { scrollers: [], sections: [], overflow: [] };

      // Anything that scrolls INSIDE the page is chrome the design should not need.
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        const scrollsY = /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2;
        if (scrollsY && el !== document.documentElement && el !== document.body) {
          out.scrollers.push({
            sel: el.className || el.tagName,
            clientH: el.clientHeight,
            scrollH: el.scrollHeight,
            maxH: cs.maxHeight,
          });
        }
      }

      for (const h of document.querySelectorAll('.section-head h2')) {
        out.sections.push(h.textContent.trim());
      }

      // Rows that wrap to more than one line read as a stack, not a ledger.
      const rows = [...document.querySelectorAll('.feed-row')];
      out.feed = {
        count: rows.length,
        heights: rows.slice(0, 6).map(r => Math.round(r.getBoundingClientRect().height)),
        sample: rows.slice(0, 3).map(r => r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 72)),
      };

      // Horizontal overflow anywhere is a layout bug.
      out.docScrollW = document.documentElement.scrollWidth;
      out.viewportW = window.innerWidth;
      return out;
    })()`);

    console.log("sections:", (report.sections || []).join(" · ") || "none");
    console.log(`\nActivity feed: ${report.feed?.count ?? 0} rows, heights ${JSON.stringify(report.feed?.heights ?? [])}px`);
    for (const s of report.feed?.sample ?? []) console.log("  " + s);

    console.log(`\ninner scrollers: ${report.scrollers.length}`);
    for (const s of report.scrollers) {
      console.log(`  ${s.sel} — ${s.clientH}px visible of ${s.scrollH}px (max-height: ${s.maxH})`);
    }

    const hOverflow = report.docScrollW > report.viewportW + 1;
    console.log(`\nhorizontal overflow: ${hOverflow ? `YES (${report.docScrollW} > ${report.viewportW})` : "none"}`);
  } finally {
    try { cdp?.close(); } catch {}
    try { proc.kill(); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
