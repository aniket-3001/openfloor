#!/usr/bin/env node
/**
 * Focused probe: what does executeTool actually want, and does `fromOrigins`
 * really cross origins?
 *
 * The first probe found `document.modelContext` present and all nine tools
 * registered, but `executeTool` rejected with "Failed to parse input
 * arguments", and cross-origin `getTools({fromOrigins})` returned the calling
 * page's OWN tools rather than the remote origin's. Both need pinning down —
 * together they decide whether the project runs at L1 or L2.
 *
 *   node scripts/probe-execute.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FLOOR = process.env.PROBE_FLOOR ?? "http://localhost:5173";
const BIDDER = process.env.PROBE_BIDDER ?? "http://localhost:5174";
const PORT = Number(process.env.PROBE_CDP_PORT ?? 9223);

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && existsSync(p));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  #ws; #id = 0; #pending = new Map();
  static async attach(url) {
    const c = new CDP();
    c.#ws = new WebSocket(url);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("connect timeout")), 10000);
      c.#ws.onopen = () => { clearTimeout(t); res(); };
      c.#ws.onerror = () => { clearTimeout(t); rej(new Error("socket error")); };
    });
    c.#ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = c.#pending.get(m.id);
      if (p) { c.#pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.#pending.has(id)) { this.#pending.delete(id); reject(new Error(`${method} timeout`)); } }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
    return r.result?.value;
  }
  async goto(url) { await this.send("Page.enable"); await this.send("Page.navigate", { url }); await wait(3500); }
  close() { try { this.#ws.close(); } catch {} }
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "openfloor-exec-"));
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check",
    "--enable-features=WebMCP,WebModelContext,ModelContext",
    "--enable-blink-features=WebMCP,ModelContext",
    "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  const cleanup = () => {
    try { cdp?.close(); } catch {}
    try { proc.kill(); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };

  try {
    let ver = null;
    for (let i = 0; i < 40 && !ver; i++) {
      await wait(500);
      try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
    }
    if (!ver) throw new Error("no debugging port");

    const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(FLOOR)}`, { method: "PUT" })).json();
    cdp = await CDP.attach(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.goto(FLOOR);

    console.log("=== 1. Shape of a RegisteredTool from getTools() ===");
    console.log(JSON.stringify(await cdp.eval(`(async () => {
      const mc = document.modelContext;
      const tools = await mc.getTools();
      const t = tools.find(x => x.name === 'get_auction_state') ?? tools[0];
      const proto = Object.getPrototypeOf(t) ?? {};
      return {
        ctor: t?.constructor?.name,
        ownKeys: Object.keys(t),
        protoKeys: Object.getOwnPropertyNames(proto),
        json: JSON.parse(JSON.stringify(t ?? {})),
        executeToolArity: mc.executeTool.length,
        getToolsArity: mc.getTools.length,
      };
    })()`), null, 2));

    console.log("\n=== 2. executeTool call-signature variants ===");
    console.log(JSON.stringify(await cdp.eval(`(async () => {
      const mc = document.modelContext;
      const tools = await mc.getTools();
      const t = tools.find(x => x.name === 'get_auction_state');
      const out = {};
      const attempt = async (label, fn) => {
        try { const r = await fn(); out[label] = { ok: true, result: String(r).slice(0, 120) }; }
        catch (e) { out[label] = { ok: false, error: String(e).slice(0, 160) }; }
      };
      await attempt('executeTool(toolObj, {})',        () => mc.executeTool(t, {}));
      await attempt('executeTool(toolObj)',            () => mc.executeTool(t));
      await attempt('executeTool(toolObj, undefined)', () => mc.executeTool(t, undefined));
      await attempt('executeTool(name, {})',           () => mc.executeTool('get_auction_state', {}));
      await attempt('executeTool({name}, {})',         () => mc.executeTool({ name: 'get_auction_state' }, {}));
      await attempt('executeTool(toolObj, "{}")',      () => mc.executeTool(t, "{}"));
      await attempt('executeTool(toolObj, null)',      () => mc.executeTool(t, null));
      return out;
    })()`), null, 2));

    console.log("\n=== 3. A tool WITH required params (check_bid) ===");
    console.log(JSON.stringify(await cdp.eval(`(async () => {
      const mc = document.modelContext;
      const tools = await mc.getTools();
      const t = tools.find(x => x.name === 'check_bid');
      const out = {};
      const attempt = async (label, fn) => {
        try { const r = await fn(); out[label] = { ok: true, result: String(r).slice(0, 140) }; }
        catch (e) { out[label] = { ok: false, error: String(e).slice(0, 160) }; }
      };
      await attempt('check_bid({amount_cents:5000})', () => mc.executeTool(t, { amount_cents: 5000 }));
      await attempt('check_bid(JSON string)',         () => mc.executeTool(t, JSON.stringify({ amount_cents: 5000 })));
      return out;
    })()`), null, 2));

    console.log("\n=== 4. getTools({fromOrigins}) semantics on the BIDDER origin ===");
    await cdp.goto(BIDDER);
    console.log(JSON.stringify(await cdp.eval(`(async () => {
      const mc = document.modelContext;
      const shape = async (label, arg) => {
        try {
          const tools = await mc.getTools(arg);
          return { label, ok: true, names: (tools ?? []).map(t => t.name).sort() };
        } catch (e) { return { label, ok: false, error: String(e).slice(0, 160) }; }
      };
      return {
        here: location.origin,
        noArgs:        await shape('getTools()'),
        floorOnly:     await shape('fromOrigins:[floor]', { fromOrigins: ['${FLOOR}'] }),
        selfOnly:      await shape('fromOrigins:[self]',  { fromOrigins: [location.origin] }),
        bogusOrigin:   await shape('fromOrigins:[bogus]', { fromOrigins: ['https://nope.example'] }),
        emptyArray:    await shape('fromOrigins:[]',      { fromOrigins: [] }),
      };
    })()`), null, 2));

    console.log("\n=== 5. Does an iframe of the floor expose its tools to the parent? ===");
    console.log(JSON.stringify(await cdp.eval(`(async () => {
      const mc = document.modelContext;
      const before = (await mc.getTools()).map(t => t.name).sort();
      const f = document.createElement('iframe');
      f.setAttribute('allow', 'tools');
      f.src = '${FLOOR}';
      document.body.appendChild(f);
      await new Promise(r => { f.onload = r; setTimeout(r, 6000); });
      await new Promise(r => setTimeout(r, 3000));
      const after = (await mc.getTools()).map(t => t.name).sort();
      let cross = null;
      try {
        const t = await mc.getTools({ fromOrigins: ['${FLOOR}'] });
        cross = (t ?? []).map(x => x.name).sort();
      } catch (e) { cross = 'ERR: ' + String(e).slice(0, 120); }
      return { before, after, gained: after.filter(n => !before.includes(n)), crossAfterIframe: cross };
    })()`), null, 2));
  } finally {
    cleanup();
  }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
