import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AuctionState,
  AuditEntry,
  CeilingRaiseRequest,
  PendingConfirmation,
  ServerEvent,
} from "@openfloor/shared";
import { api } from "./api";

/**
 * Live auction subscription.
 *
 * The WebSocket is the primary channel; a slow poll runs alongside it purely to
 * keep the countdown honest if a socket silently drops. Server state always
 * wins — the client never advances the price or the clock on its own.
 */
export function useAuction() {
  const [state, setState] = useState<AuctionState | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [confirmations, setConfirmations] = useState<PendingConfirmation[]>([]);
  const [raiseRequests, setRaiseRequests] = useState<CeilingRaiseRequest[]>([]);
  const [connected, setConnected] = useState(false);
  /**
   * When the current snapshot arrived.
   *
   * `seconds_remaining` is a value the server computed at send time. Ticking a
   * re-render does not decrement it, so the clock sat frozen between events and
   * only jumped when a bid or the poll landed — which read as "needs a refresh".
   * The countdown is derived from this stamp instead.
   */
  const stamped = useRef<number>(0);
  const socketRef = useRef<WebSocket | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [{ state: s }, { entries }] = await Promise.all([api.state(), api.audit()]);
      setState(s);
      stamped.current = Date.now();
      setAudit(entries);
    } catch {
      /* transient; the socket or the next poll will recover */
    }
  }, []);

  useEffect(() => {
    void refresh();

    let closed = false;
    let ws: WebSocket | null = null;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(api.wsUrl());
      } catch {
        return;
      }
      socketRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) setTimeout(connect, 1500);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (ev) => {
        let msg: ServerEvent;
        try {
          msg = JSON.parse(ev.data as string) as ServerEvent;
        } catch {
          return;
        }
        switch (msg.type) {
          case "state":
            setState(msg.state);
            stamped.current = Date.now();
            break;
          case "bid":
            setState(msg.state);
            stamped.current = Date.now();
            break;
          case "audit":
            setAudit((prev) => [...prev.slice(-80), msg.entry]);
            break;
          case "confirmation_required":
            setConfirmations((prev) => [...prev, msg.confirmation]);
            break;
          case "confirmation_resolved":
            setConfirmations((prev) => prev.filter((c) => c.id !== msg.id));
            break;
          case "ceiling_raise_requested":
            setRaiseRequests((prev) => [...prev, msg.request]);
            break;
          case "lot_closed":
            setConfirmations([]);
            setRaiseRequests([]);
            void refresh();
            break;
        }
      };
    };

    connect();
    const poll = setInterval(() => void refresh(), 5000);

    return () => {
      closed = true;
      clearInterval(poll);
      ws?.close();
    };
  }, [refresh]);

  // Re-render often enough for a smooth countdown.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);

  /**
   * Seconds left, counted locally from the last snapshot.
   *
   * Only ever counts DOWN from a server-provided figure — a fresh snapshot
   * resets it, so an anti-snipe extension still lands correctly and the client
   * can never invent time the server has not granted.
   */
  const secondsLeft = state
    ? Math.max(0, Math.round(state.seconds_remaining - (Date.now() - stamped.current) / 1000))
    : 0;

  return {
    state,
    secondsLeft,
    audit,
    confirmations,
    raiseRequests,
    connected,
    refresh,
    setConfirmations,
    setRaiseRequests,
  };
}
