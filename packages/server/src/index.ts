/**
 * Node adapter — the Cloud Run deployment target.
 *
 * Runs the same `@openfloor/engine` as the Cloudflare Durable Object adapter,
 * supplying the four things the engine needs from its platform: storage,
 * alarms, WebSocket fan-out, and an id.
 *
 * WHY THIS IS SAFE WITHOUT DURABLE OBJECTS
 * ----------------------------------------
 * A Durable Object serializes whole requests per instance, which is what made
 * bid ordering correct by construction. Node does not: its event loop switches
 * at every `await`, and the bid path awaits inside mandate signature
 * verification — between reading the price and committing a bid. Two agents
 * bidding in the same tick could both observe the pre-bid price.
 *
 * Two things restore the guarantee:
 *   1. The engine serializes every request through an explicit promise chain,
 *      so the critical section is atomic regardless of runtime.
 *   2. Cloud Run is deployed with `--max-instances=1`, so a room lives in
 *      exactly one process and there is no cross-instance race to lose.
 *
 * Room state is in memory and deliberately ephemeral: these are demo auction
 * rooms, and a restart should start a clean auction rather than resume a stale
 * one. Nothing here takes payment, so there is nothing to durably lose.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { AuctionEngine, type RoomHost } from "@openfloor/engine";
import {
  SESSION_COOKIE,
  bidderIdForHandle,
  newSession,
  normalizeHandle,
  openSession,
  passphraseVerifier,
  readCookie,
  safeEqual,
  sealSession,
  sessionCookie,
  type Session,
} from "@openfloor/shared";
import type { ServerEvent } from "@openfloor/shared";
import { startRivals } from "./rivals.js";
import { startContinuousAuction } from "./continuous.js";

const PORT = Number(process.env.PORT ?? 8080);
const MANDATE_SECRET = process.env.MANDATE_SECRET ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
/** Which app this instance serves: "floor" | "bidder" | "api". */
const ROLE = process.env.OPENFLOOR_ROLE ?? "api";
const STATIC_DIR = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;

// Only the API role signs mandates. A static-serving instance has no business
// holding the signing key, so it is not given one and must not demand one.
if (ROLE === "api" && !MANDATE_SECRET) {
  console.error("MANDATE_SECRET is required for the api role — mandates cannot be signed without it.");
  process.exit(1);
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* ── Room registry ────────────────────────────────────────────── */

interface Room {
  engine: AuctionEngine;
  sockets: Set<WebSocket>;
  store: Map<string, unknown>;
  timer: NodeJS.Timeout | null;
}

const rooms = new Map<string, Room>();

/**
 * Claimed seats: handle -> passphrase verifier.
 *
 * In memory, like room state. This is a demo: a durable user table would mean
 * a real datastore and real account-recovery obligations, neither of which the
 * project is trying to demonstrate. A seat survives a browser restart via its
 * cookie; claiming one lets you return to the same identity from elsewhere
 * until the process recycles.
 */
const claimedSeats = new Map<string, string>();

function getRoom(name: string): Room {
  const existing = rooms.get(name);
  if (existing) return existing;

  const room: Room = {
    engine: null as unknown as AuctionEngine,
    sockets: new Set(),
    store: new Map(),
    timer: null,
  };

  const host: RoomHost = {
    id: name,
    secret: MANDATE_SECRET,
    async storageGet(key) {
      return room.store.get(key) as Record<string, unknown> | undefined;
    },
    async storagePut(key, value) {
      room.store.set(key, value);
    },
    async setAlarm(at) {
      if (room.timer) clearTimeout(room.timer);
      const delay = Math.max(0, at - Date.now());
      room.timer = setTimeout(() => {
        room.timer = null;
        // Mirrors the Durable Object alarm contract: fire once, let the engine
        // decide whether to close the lot or re-arm for an extended clock.
        void room.engine.alarm().catch((e) => console.error("alarm failed", e));
      }, delay);
      // Never keep the process alive purely for a pending auction clock.
      room.timer.unref?.();
    },
    async deleteAlarm() {
      if (room.timer) clearTimeout(room.timer);
      room.timer = null;
    },
    broadcast(event: ServerEvent) {
      const payload = JSON.stringify(event);
      for (const ws of [...room.sockets]) {
        try {
          if (ws.readyState === ws.OPEN) ws.send(payload);
          else room.sockets.delete(ws);
        } catch {
          room.sockets.delete(ws);
        }
      }
    },
  };

  room.engine = new AuctionEngine(host);
  rooms.set(name, room);
  return room;
}

/* ── HTTP helpers ─────────────────────────────────────────────── */

function corsHeaders(origin: string | undefined): Record<string, string> {
  // Echo only allowlisted origins — never reflect an arbitrary Origin header.
  // This is the HTTP mirror of the `exposedTo` allowlist used for WebMCP tools.
  const ok = !!origin && ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : (ALLOWED_ORIGINS[0] ?? "*"),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // The bidder console is a different origin; without this the session cookie
    // never reaches the API and every caller would look anonymous.
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Serve the built SPA, falling back to index.html for client-side routes. */
async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  if (!STATIC_DIR) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  // Resolve inside STATIC_DIR only — a normalized path that escapes the root
  // is a traversal attempt, not a missing file.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(STATIC_DIR, rel);
  if (!file.startsWith(STATIC_DIR)) file = join(STATIC_DIR, "index.html");

  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(STATIC_DIR, "index.html"); // SPA fallback
  }

  try {
    const raw = await readFile(file);
    let body: Buffer | string = raw;
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";

    // Chrome origin-trial token, injected at serve time rather than baked into
    // the HTML. Without a token a visitor must enable chrome://flags by hand;
    // with one, WebMCP simply works on this origin. Registration is a manual
    // step on Google's side, so this stays configuration rather than a constant.
    const trialToken = process.env.ORIGIN_TRIAL_TOKEN;
    if (trialToken && type.startsWith("text/html")) {
      body = Buffer.from(raw)
        .toString("utf8")
        .replace("</head>", `  <meta http-equiv="origin-trial" content="${trialToken}" />
  </head>`);
    }
    const immutable = /\/assets\//.test(file);
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Proxy model calls so the provider key never reaches client JavaScript. */
async function handleLlm(bodyText: string): Promise<{ status: number; body: unknown }> {
  if (!ANTHROPIC_API_KEY) {
    return {
      status: 503,
      body: {
        error: "no_api_key",
        message:
          "No ANTHROPIC_API_KEY configured. Rival agents will use their heuristic " +
          "policy instead of model-driven bidding.",
      },
    };
  }
  let parsed: { system?: string; messages?: unknown; model?: string; max_tokens?: number };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const allowed = new Set(["claude-haiku-4-5-20251001", "claude-sonnet-5"]);
  const model = parsed.model && allowed.has(parsed.model) ? parsed.model : "claude-haiku-4-5-20251001";

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.min(parsed.max_tokens ?? 512, 1024),
      system: parsed.system,
      messages: parsed.messages,
    }),
  });
  if (!upstream.ok) {
    // Upstream error text is never forwarded — it can carry content that would
    // land straight in an agent's context.
    console.error("llm upstream", upstream.status);
    return { status: 502, body: { error: "upstream_error", status: upstream.status } };
  }
  const data = (await upstream.json()) as { content?: { type: string; text?: string }[] };
  const text = (data.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();
  return { status: 200, body: { text } };
}

/* ── Server ───────────────────────────────────────────────────── */

/** Cookies must be Secure to be SameSite=None; local http dev cannot be. */
const SECURE_COOKIES = process.env.OPENFLOOR_SECURE_COOKIES !== "false";

/**
 * Credential for PROGRAMMATIC actors — the rival driver, the auction runner,
 * and the test suites — which act on behalf of several bidders and therefore
 * cannot be a single browser session.
 *
 * This is a credential, not a loophole: without it a caller is anonymous and
 * gets a session-derived identity like anyone else. It is deliberately not a
 * "trust the body if no cookie" rule, which would hand the forgery back to
 * anybody who simply declined to send one.
 */
const INTERNAL_TOKEN = process.env.OPENFLOOR_INTERNAL_TOKEN || MANDATE_SECRET;
const INTERNAL_HEADER = "x-openfloor-internal";

const server = createServer((req, res) => {
  void (async () => {
    const origin = req.headers.origin;
    const cors = corsHeaders(origin);
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Resolve the caller's session, minting one on first contact so there is no
    // signup wall — you open the page and you are already seated.
    // Constant-time: `===` on a secret short-circuits at the first differing
    // byte, which is a timing oracle. Cheap to avoid in a project whose whole
    // argument is about trust boundaries.
    const presented = req.headers[INTERNAL_HEADER];
    const internal =
      !!INTERNAL_TOKEN && typeof presented === "string" && safeEqual(presented, INTERNAL_TOKEN);

    let session = await openSession(readCookie(req.headers.cookie, SESSION_COOKIE), MANDATE_SECRET);
    let setCookie: string | null = null;
    // Programmatic actors manage their own identities and are not issued one.
    if (!session && !internal && ROLE === "api") {
      session = newSession();
      setCookie = sessionCookie(await sealSession(session, MANDATE_SECRET), { secure: SECURE_COOKIES });
    }
    const withSession = (h: Record<string, string>) =>
      setCookie ? { ...h, "Set-Cookie": setCookie } : h;

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    // Runtime configuration for the SPA, generated from this instance's
    // environment. Build-time inlining pinned the bundle to whatever origins it
    // was compiled against, which silently broke the first deploy; serving it
    // here keeps one image usable in any environment.
    if (url.pathname === "/config.js") {
      const cfg = {
        apiBase: process.env.PUBLIC_API_BASE ?? "",
        room: process.env.PUBLIC_ROOM ?? "main",
        bidderOrigins: (process.env.PUBLIC_BIDDER_ORIGINS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        floorOrigin: process.env.PUBLIC_FLOOR_ORIGIN ?? "",
        persona: process.env.PUBLIC_PERSONA ?? "you",
      };
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(`window.__OPENFLOOR_CONFIG__ = ${JSON.stringify(cfg)};\n`);
      return;
    }

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, role: ROLE, rooms: rooms.size }));
      return;
    }

    if (url.pathname === "/api/llm") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ error: "POST only" }));
        return;
      }
      const { status, body } = await handleLlm(await readBody(req));
      res.writeHead(status, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify(body));
      return;
    }

    if (url.pathname === "/api/session") {
      if (req.method === "POST") {
        // Claim a seat: bind this session to a handle so it can be resumed
        // elsewhere. First claim wins the handle; later ones must match.
        const b = JSON.parse((await readBody(req)) || "{}") as { handle?: string; passphrase?: string };
        const handle = normalizeHandle(b.handle ?? "");
        if (!handle || !b.passphrase || b.passphrase.length < 6) {
          res.writeHead(400, withSession({ "Content-Type": "application/json", ...cors }));
          res.end(JSON.stringify({ error: "Handle must be 3-24 chars [a-z0-9_-]; passphrase at least 6." }));
          return;
        }
        const verifier = await passphraseVerifier(handle, b.passphrase, MANDATE_SECRET);
        const existing = claimedSeats.get(handle);
        if (existing && existing !== verifier) {
          res.writeHead(403, withSession({ "Content-Type": "application/json", ...cors }));
          res.end(JSON.stringify({ error: "That handle is taken and the passphrase does not match." }));
          return;
        }
        claimedSeats.set(handle, verifier);
        const claimed: Session = {
          ...(session as Session),
          handle,
          alias: (session as Session).alias === "Guest" ? handle : (session as Session).alias,
          bidder_id: await bidderIdForHandle(handle, MANDATE_SECRET),
        };
        const cookie = sessionCookie(await sealSession(claimed, MANDATE_SECRET), { secure: SECURE_COOKIES });
        res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": cookie, ...cors });
        res.end(JSON.stringify({ session: { bidder_id: claimed.bidder_id, alias: claimed.alias, handle } }));
        return;
      }
      res.writeHead(200, withSession({ "Content-Type": "application/json", ...cors }));
      res.end(JSON.stringify({
        session: session
          ? { bidder_id: session.bidder_id, alias: session.alias, handle: session.handle ?? null }
          : null,
      }));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const room = getRoom(url.searchParams.get("room") ?? "main");
      const bodyText = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);

      // Hand the engine a fully-buffered request. The engine drains bodies
      // centrally, but reading here keeps Node's stream out of its way.
      const request = new Request(url.toString(), {
        method: req.method ?? "GET",
        headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
        body: bodyText && bodyText.length ? bodyText : undefined,
      });

      // Internal callers assert their own bidder_id; everyone else gets theirs
      // from the session and cannot override it.
      const out = await room.engine.handle(request, internal ? undefined : session?.bidder_id);
      const text = await out.text();
      res.writeHead(out.status, withSession({ "Content-Type": "application/json", ...cors }));
      res.end(text);
      return;
    }

    await serveStatic(url.pathname, res);
  })().catch((err) => {
    console.error("request failed", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "indeterminate",
          message: "The server could not complete this action. Do not retry — the outcome is unknown.",
          unsafe_to_retry: true,
        }),
      );
    }
  });
});

/* ── WebSocket ────────────────────────────────────────────────── */

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/api/ws") {
    socket.destroy();
    return;
  }
  const room = getRoom(url.searchParams.get("room") ?? "main");
  wss.handleUpgrade(req, socket, head, (ws) => {
    room.sockets.add(ws);
    ws.on("close", () => room.sockets.delete(ws));
    ws.on("error", () => room.sockets.delete(ws));
    void room.engine.snapshotEvent().then((e) => {
      try {
        ws.send(JSON.stringify(e));
      } catch {
        /* client vanished */
      }
    });
  });
});

/**
 * Rival bidders, on the API instance only.
 *
 * Without them a visitor to the deployed floor watches an auction where nobody
 * bids. They bid through the ordinary HTTP path — no privileged route — so
 * every mandate check, ceiling, and audit entry applies to them exactly as it
 * would to a browser agent.
 */
const RIVAL_PERSONAS = (process.env.OPENFLOOR_RIVALS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

server.listen(PORT, () => {
  if (ROLE === "api" && RIVAL_PERSONAS.length) {
    startRivals({
      personas: RIVAL_PERSONAS,
      apiBase: `http://127.0.0.1:${PORT}`,
      tickMs: Number(process.env.OPENFLOOR_RIVAL_TICK_MS ?? 2500),
      ceilingCents: Number(process.env.OPENFLOOR_RIVAL_CEILING_CENTS ?? 25000),
    });
  }

  // Opt-in so the live-behaviour suite, which asserts a lot closes and STAYS
  // closed, is unaffected.
  if (ROLE === "api" && process.env.OPENFLOOR_CONTINUOUS === "true") {
    startContinuousAuction({
      apiBase: `http://127.0.0.1:${PORT}`,
      room: process.env.PUBLIC_ROOM ?? "main",
    });
  }
  console.log(
    `OpenFloor ${ROLE} listening on :${PORT}` +
      (STATIC_DIR ? ` · serving ${STATIC_DIR}` : "") +
      (ALLOWED_ORIGINS.length ? ` · CORS: ${ALLOWED_ORIGINS.join(", ")}` : ""),
  );
});
