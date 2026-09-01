#!/usr/bin/env node
/**
 * Real-browser WebMCP probe.
 *
 * Everything else in this repo tests WebMCP against mocks. This script tests it
 * against the actual browser: it launches the installed Chrome with the WebMCP
 * testing flag and a remote-debugging port, attaches over the Chrome DevTools
 * Protocol, and interrogates `document.modelContext` on the live pages.
 *
 * It answers the questions the rest of the suite cannot:
 *   - Does `document.modelContext` exist in this build, and what is on it?
 *   - Does `registerTool` actually accept our tools, including `exposedTo`?
 *   - Does cross-origin `getTools({fromOrigins})` return another origin's tools?
 *   - Does cross-origin `executeTool` actually invoke them?
 *
 * That last question determines whether the project runs at L1 or L2, and it is
 * the single assumption the architecture rests on.
 *
 *   node scripts/browser-probe.mjs
 *
 * Uses a throwaway Chrome profile and does not touch your real one. No
 * Puppeteer or Playwright: Node 22 has a built-in WebSocket, and CDP is just
 * HTTP plus a socket.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FLOOR = process.env.PROBE_FLOOR ?? "http://localhost:5173";
const BIDDER = process.env.PROBE_BIDDER ?? "http://localhost:5174";
const PORT = Number(process.env.PROBE_CDP_PORT ?? 9222);
const HEADLESS = process.env.PROBE_HEADLESS === "1";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];

const findings = [];
const record = (name, value, note = "") => {
  findings.push({ name, value, note });
  const mark =
    value === true ? "\x1b[32mYES\x1b[0m" : value === false ? "\x1b[31mNO \x1b[0m" : "\x1b[36m ? \x1b[0m";
  console.log(`  ${mark}  ${name}${note ? `\n         ${note}` : ""}`);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Minimal CDP client ───────────────────────────────────────── */

class CDP {
  #ws;
  #id = 0;
  #pending = new Map();

  static async attach(wsUrl) {
    const c = new CDP();
    c.#ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("CDP connect timeout")), 10000);
      c.#ws.onopen = () => {
        clearTimeout(t);
        res();
      };
      c.#ws.onerror = () => {
        clearTimeout(t);
        rej(new Error("CDP socket error"));
      };
    });
    c.#ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const p = c.#pending.get(msg.id);
      if (p) {
        c.#pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    };
    return c;
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 30000);
    });
  }

  /** Evaluate an expression in the page and return its value. */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) {
      return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
    }
    return r.result?.value;
  }

  async navigate(url) {
    await this.send("Page.enable");
    await this.send("Page.navigate", { url });
    // Wait for the SPA to mount and register its tools.
    await wait(3500);
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function newPage(url) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  return res.json();
}

/* ── Main ─────────────────────────────────────────────────────── */

async function main() {
  console.log("OpenFloor — real-browser WebMCP probe\n");

  const chrome = CHROME_CANDIDATES.find((p) => p && existsSync(p));
  if (!chrome) {
    console.error("Could not find an installed Chrome. Set PROBE_CHROME.");
    process.exit(2);
  }
  console.log(`Chrome:  ${chrome}`);
  console.log(`Floor:   ${FLOOR}`);
  console.log(`Bidder:  ${BIDDER}\n`);

  const profile = mkdtempSync(join(tmpdir(), "openfloor-probe-"));

  // Candidate flag names. Chrome silently ignores ones it does not know, so
  // passing several costs nothing and avoids guessing wrong.
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-backgrounding-occluded-windows",
    "--enable-features=WebMCP,WebModelContext,ModelContext,WebMachineLearningMCP,AIModelContext",
    "--enable-blink-features=WebMCP,ModelContext,WebModelContext",
    ...(HEADLESS ? ["--headless=new"] : []),
    "about:blank",
  ];

  const proc = spawn(chrome, args, { detached: false, stdio: "ignore" });
  let cdp;

  const cleanup = () => {
    try {
      cdp?.close();
    } catch {}
    try {
      proc.kill();
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  };

  try {
    // Wait for the debugging endpoint.
    let version = null;
    for (let i = 0; i < 40; i++) {
      await wait(500);
      try {
        version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
        break;
      } catch {
        /* not up yet */
      }
    }
    if (!version) throw new Error("Chrome did not expose a debugging port");

    console.log(`\x1b[1mBrowser\x1b[0m`);
    record("debugging port reachable", true, version["Browser"]);
    const major = Number((version["Browser"] ?? "").match(/Chrome\/(\d+)/)?.[1] ?? 0);
    record("Chrome 149+ (WebMCP era)", major >= 149, `major version ${major}`);

    /* ── Probe 1: the floor origin ───────────────────────────── */
    console.log(`\n\x1b[1mFloor origin — ${FLOOR}\x1b[0m`);
    const page = await newPage(FLOOR);
    cdp = await CDP.attach(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.navigate(FLOOR);

    const href = await cdp.eval("location.href");
    record("page loaded", typeof href === "string" && href.startsWith("http"), String(href));

    const surface = await cdp.eval(`(() => {
      const mc = document.modelContext ?? navigator.modelContext;
      if (!mc) return { present: false };
      const proto = Object.getPrototypeOf(mc) ?? {};
      const names = new Set([
        ...Object.getOwnPropertyNames(mc),
        ...Object.getOwnPropertyNames(proto),
      ]);
      return {
        present: true,
        on: document.modelContext ? 'document' : 'navigator',
        methods: [...names].filter((k) => {
          try { return typeof mc[k] === 'function'; } catch { return false; }
        }).sort(),
        keys: [...names].sort(),
      };
    })()`);

    if (surface?.__error) {
      record("document.modelContext present", "?", surface.__error);
    } else if (!surface?.present) {
      record("document.modelContext present", false, "no WebMCP surface in this build/flag combination");
    } else {
      record("document.modelContext present", true, `on ${surface.on}`);
      record("API surface", "?", `methods: ${surface.methods.join(", ") || "(none enumerable)"}`);
      for (const m of ["registerTool", "getTools", "executeTool"]) {
        record(`  ${m}()`, surface.methods.includes(m));
      }
      record(
        "  no deprecated provideContext/unregisterTool",
        !surface.methods.includes("provideContext") && !surface.methods.includes("unregisterTool"),
      );
    }

    if (surface?.present) {
      // Did OUR page actually register its tools?
      const ours = await cdp.eval(`(async () => {
        const mc = document.modelContext ?? navigator.modelContext;
        if (typeof mc.getTools !== 'function') return { supported: false };
        const tools = await mc.getTools();
        return { supported: true, names: (tools ?? []).map(t => t.name).sort() };
      })()`);
      if (ours?.__error) {
        record("getTools() on our own origin", "?", ours.__error);
      } else if (ours?.supported) {
        const names = ours.names ?? [];
        record("our tools are registered", names.length > 0, `${names.length}: ${names.join(", ")}`);
        record("  place_bid registered", names.includes("place_bid"));
        record("  check_bid registered", names.includes("check_bid"));
        record("  set_bid_mandate registered (private)", names.includes("set_bid_mandate"));
      }

      // Round-trip a real tool call through the live page.
      const exec = await cdp.eval(`(async () => {
        const mc = document.modelContext ?? navigator.modelContext;
        if (typeof mc.getTools !== 'function' || typeof mc.executeTool !== 'function')
          return { supported: false };
        const tools = await mc.getTools();
        const t = (tools ?? []).find(x => x.name === 'get_auction_state');
        if (!t) return { supported: true, found: false };
        try {
          const out = await mc.executeTool(t, '{}');
          const text = String(out);
          // executeTool resolves even when the tool itself failed — the result
          // carries isError. "Did not throw" is not success.
          let failed = false;
          try { failed = JSON.parse(text)?.isError === true; }
          catch { failed = /"isError"\s*:\s*true/.test(text); }
          return failed
            ? { supported: true, found: true, ok: false, error: 'tool returned isError: ' + text.slice(0, 200) }
            : { supported: true, found: true, ok: true, sample: text.slice(0, 160) };
        } catch (e) {
          return { supported: true, found: true, ok: false, error: String(e).slice(0, 200) };
        }
      })()`);
      if (exec?.supported && exec?.found) {
        record("executeTool() invokes a real tool", exec.ok === true, exec.ok ? exec.sample : exec.error);
      } else if (exec?.supported) {
        record("executeTool() invokes a real tool", "?", "get_auction_state not visible via getTools()");
      }
    }

    /* ── Probe 2: cross-origin from the bidder ───────────────── */
    console.log(`\n\x1b[1mCross-origin — ${BIDDER} reaching ${FLOOR}\x1b[0m`);
    await cdp.navigate(BIDDER);
    await wait(4000); // the console mounts a hidden tool-bridge iframe on load
    const bidderHref = await cdp.eval("location.href");
    record("bidder console loaded", String(bidderHref).startsWith(BIDDER.slice(0, 20)), String(bidderHref));

    const cross = await cdp.eval(`(async () => {
      const mc = document.modelContext ?? navigator.modelContext;
      if (!mc) return { present: false };
      if (typeof mc.getTools !== 'function') return { present: true, getTools: false };
      try {
        const tools = await mc.getTools({ fromOrigins: ['${FLOOR}'] });
        return {
          present: true, getTools: true, ok: true,
          count: (tools ?? []).length,
          names: (tools ?? []).map(t => t.name).sort(),
        };
      } catch (e) {
        return { present: true, getTools: true, ok: false, error: String(e).slice(0, 240) };
      }
    })()`);

    if (!cross?.present) {
      record("cross-origin discovery", false, "no WebMCP on the bidder origin");
    } else if (!cross.getTools) {
      record("cross-origin discovery", false, "getTools() not implemented");
    } else if (cross.ok) {
      const n = cross.count ?? 0;
      // The local page has its own tools, so a non-empty list proves nothing.
      // Only names absent from the local set can have come from the floor.
      const localHere = await cdp.eval(`(async () => {
        const mc = document.modelContext ?? navigator.modelContext;
        return (await mc.getTools()).map(t => t.name);
      })()`);
      const localNames = Array.isArray(localHere) ? localHere : [];
      const remoteOnly = (cross.names ?? []).filter((x) => !localNames.includes(x));
      record(
        "getTools({fromOrigins}) returns the floor's OWN tools",
        remoteOnly.length > 0,
        remoteOnly.length
          ? `${remoteOnly.length} remote: ${remoteOnly.join(", ")}`
          : `only this page's own ${localNames.length} tool(s) came back (${(cross.names ?? []).join(", ")}) — the bridge frame did not expose the floor`,
      );
      if (remoteOnly.length > 0) {
        const xexec = await cdp.eval(`(async () => {
          const mc = document.modelContext ?? navigator.modelContext;
          const tools = await mc.getTools({ fromOrigins: ['${FLOOR}'] });
          // Must be a FLOOR tool. Falling back to tools[0] can pick a local
          // tool and prove nothing about crossing the origin boundary.
          const t = (tools ?? []).find(x => x.name === 'get_auction_state');
          if (!t) return { ok: false, error: 'no floor tool reachable' };
          try {
            const out = await mc.executeTool(t, '{}');
            const text = String(out);
            // executeTool resolves even when the tool itself failed; the result
            // carries isError. Treating "did not throw" as success is how this
            // probe once reported L1 against a deployment where every
            // cross-origin call was erroring.
            let failed = false;
            try { failed = JSON.parse(text)?.isError === true; }
            catch { failed = /"isError"\s*:\s*true/.test(text); }
            return failed
              ? { ok: false, error: 'tool returned isError: ' + text.slice(0, 200) }
              : { ok: true, sample: text.slice(0, 160) };
          } catch (e) { return { ok: false, error: String(e).slice(0, 240) }; }
        })()`);
        record(
          "CROSS-ORIGIN executeTool() actually invokes",
          xexec?.ok === true,
          xexec?.ok ? xexec.sample : xexec?.error ?? "unknown",
        );
      }
    } else {
      record("getTools({fromOrigins})", false, cross.error);
    }

    /* ── Verdict ─────────────────────────────────────────────── */
    const has = (n) => findings.find((f) => f.name === n)?.value === true;
    const layer = has("CROSS-ORIGIN executeTool() actually invokes")
      ? "L1_cross_origin"
      : has("document.modelContext present")
        ? "L2_same_origin"
        : "L3_no_webmcp";

    console.log(`\n${"─".repeat(60)}`);
    console.log(`  Measured layer: \x1b[1m${layer}\x1b[0m`);
    console.log(`  ${findings.filter((f) => f.value === true).length} confirmed, ` +
      `${findings.filter((f) => f.value === false).length} negative, ` +
      `${findings.filter((f) => f.value === "?").length} inconclusive`);
    console.log(`${"─".repeat(60)}\n`);
    console.log(JSON.stringify({ layer, findings }, null, 2));
  } finally {
    cleanup();
  }
}

main().catch((e) => {
  console.error("\nProbe failed:", e.message);
  process.exit(1);
});
