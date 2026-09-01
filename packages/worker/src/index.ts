/// <reference types="@cloudflare/workers-types" />

import { AuctionRoom } from "./auction-room.js";
import { handleLlm } from "./llm.js";

export { AuctionRoom };

interface Env {
  AUCTION_ROOM: DurableObjectNamespace;
  MANDATE_SECRET: string;
  ANTHROPIC_API_KEY?: string;
  ALLOWED_ORIGINS?: string;
  ASSETS?: Fetcher;
}

/**
 * Origins permitted to call the auction API cross-origin.
 *
 * This list is the HTTP-layer mirror of the `exposedTo` allowlist used for
 * WebMCP tool registration. Both must agree: a bidder origin that can invoke a
 * tool but cannot reach the API (or vice versa) is a half-open door.
 */
function allowedOrigins(env: Env): string[] {
  const configured = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return configured.length
    ? configured
    : [
        // Local development origins. Distinct ports are distinct origins, which
        // is what lets the cross-origin path be exercised without DNS.
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://127.0.0.1:5175",
      ];
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const list = allowedOrigins(env);
  const ok = list.includes(origin);
  return {
    // Echo only allowlisted origins — never reflect an arbitrary Origin header.
    "Access-Control-Allow-Origin": ok ? origin : list[0] ?? "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // LLM calls are proxied so provider keys never reach client JavaScript.
    if (url.pathname === "/api/llm") {
      const res = await handleLlm(request, env.ANTHROPIC_API_KEY);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    if (url.pathname.startsWith("/api/")) {
      const roomName = url.searchParams.get("room") ?? "main";
      const id = env.AUCTION_ROOM.idFromName(roomName);
      const stub = env.AUCTION_ROOM.get(id);

      // Buffer the body before forwarding.
      //
      // Forwarding the original Request hands the Durable Object a live stream.
      // Endpoints that take no arguments (/start, /next, /reset) never read it,
      // and the runtime then throws "Can't read from request stream after
      // response has been sent" — which kills the object, so every later request
      // to that room fails with "Network connection lost". Reading the body here
      // consumes the stream exactly once and forwards inert bytes.
      const isUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
      let forwarded = request;
      if (!isUpgrade && request.method !== "GET" && request.method !== "HEAD") {
        const body = await request.text();
        forwarded = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: body.length ? body : undefined,
        });
      }

      const res = await stub.fetch(forwarded);

      // WebSocket upgrades must be returned untouched.
      if (res.status === 101) return res;

      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // Static assets. The floor and bidder SPAs are served from the same Worker
    // but on different hostnames, which is what makes them separate origins.
    if (env.ASSETS) return env.ASSETS.fetch(request);

    return new Response("OpenFloor API. See /api/state.", {
      headers: { "Content-Type": "text/plain", ...cors },
    });
  },
};
