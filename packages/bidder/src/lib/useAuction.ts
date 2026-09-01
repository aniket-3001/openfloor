import { useCallback, useEffect, useState } from "react";
import type {
  AuctionState,
  AuditEntry,
  CeilingRaiseRequest,
  PendingConfirmation,
  ServerEvent,
} from "@openfloor/shared";
import { api } from "./api";

/**
 * Live subscription to the auction house from a bidder console.
 *
 * Note this connects to a DIFFERENT origin than the page it runs on — the
 * console watches the floor across the same boundary its agent calls tools
 * across.
 */
export function useAuction(bidderId: string) {
  const [state, setState] = useState<AuctionState | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [confirmations, setConfirmations] = useState<PendingConfirmation[]>([]);
  const [raiseRequests, setRaiseRequests] = useState<CeilingRaiseRequest[]>([]);
  const [connected, setConnected] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [{ state: s }, { entries }] = await Promise.all([api.state(), api.audit()]);
      setState(s);
      setAudit(entries);
    } catch {
      /* transient */
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
          case "bid":
            setState(msg.state);
            break;
          case "audit":
            setAudit((prev) => [...prev.slice(-80), msg.entry]);
            break;
          case "confirmation_required":
            // Only surface confirmations addressed to THIS bidder.
            if (msg.confirmation.bidder_id === bidderId) {
              setConfirmations((prev) => [...prev, msg.confirmation]);
            }
            break;
          case "confirmation_resolved":
            setConfirmations((prev) => prev.filter((c) => c.id !== msg.id));
            break;
          case "ceiling_raise_requested":
            if (msg.request.bidder_id === bidderId) {
              setRaiseRequests((prev) => [...prev, msg.request]);
            }
            break;
          case "lot_closed":
            void refresh();
            break;
        }
      };
    };

    connect();
    const poll = setInterval(() => void refresh(), 4000);
    return () => {
      closed = true;
      clearInterval(poll);
      ws?.close();
    };
  }, [refresh, bidderId]);

  // Smooth the countdown between server frames. Only ever counts down.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return { state, audit, confirmations, raiseRequests, connected, refresh, setConfirmations, setRaiseRequests };
}
