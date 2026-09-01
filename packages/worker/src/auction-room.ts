/// <reference types="@cloudflare/workers-types" />

import { AuctionEngine, type RoomHost } from "@openfloor/engine";
import type { ServerEvent } from "@openfloor/shared";

interface Env {
  MANDATE_SECRET: string;
}

/**
 * Cloudflare Durable Object adapter.
 *
 * All auction logic lives in `@openfloor/engine` and is shared with the
 * Node/Cloud Run adapter. This class supplies only what is Cloudflare-specific:
 * DO storage, DO alarms, and WebSocket fan-out.
 *
 * The DO's defining property — one request at a time per instance — is what
 * originally made bid serialization free. The engine now enforces that itself
 * so the guarantee survives on runtimes that do not provide it; here it is
 * simply redundant.
 */
export class AuctionRoom implements DurableObject {
  private engine: AuctionEngine;
  private sockets = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    const host: RoomHost = {
      id: state.id.toString(),
      secret: env.MANDATE_SECRET,
      storageGet: (key) => state.storage.get<Record<string, unknown>>(key),
      storagePut: (key, value) => state.storage.put(key, value),
      setAlarm: (at) => state.storage.setAlarm(at),
      deleteAlarm: () => state.storage.deleteAlarm(),
      broadcast: (event) => this.broadcast(event),
    };
    this.engine = new AuctionEngine(host);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.replace(/^\/api/, "") === "/ws") return this.handleWebSocket();
    return this.engine.handle(request);
  }

  /** The lot-closing alarm. */
  async alarm(): Promise<void> {
    await this.engine.alarm();
  }

  private broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of [...this.sockets]) {
      try {
        ws.send(payload);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  private handleWebSocket(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.add(server);
    server.addEventListener("close", () => this.sockets.delete(server));
    server.addEventListener("error", () => this.sockets.delete(server));
    void this.engine.snapshotEvent().then((e) => {
      try {
        server.send(JSON.stringify(e));
      } catch {
        /* client vanished */
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}
