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
  const socketRef = useRef<WebSocket | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [{ state: s }, { entries }] = await Promise.all([api.state(), api.audit()]);
      setState(s);
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
            break;
          case "bid":
            setState(msg.state);
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

  // Local tick so the countdown reads smoothly between server events. This
  // only ever counts DOWN toward a server-provided end time; it never extends.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return {
    state,
    audit,
    confirmations,
    raiseRequests,
    connected,
    refresh,
    setConfirmations,
    setRaiseRequests,
  };
}
