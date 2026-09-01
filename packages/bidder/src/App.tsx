import { useCallback, useEffect, useMemo, useState } from "react";
import type { BidMandate } from "@openfloor/shared";
import {
  fmt,
  describeLayer,
  detectCapability,
  mountToolBridge,
  loadConfig,
  getPersona,
  type WebMcpLayer,
} from "@openfloor/shared";
import { api, type Headroom, type PublicLot } from "./lib/api";
import { useAuction } from "./lib/useAuction";
import { useBidderTools } from "./webmcp/useBidderTools";
import { useAgent } from "./agent/useAgent";

import { MandateBand } from "./components/MandateBand";
import { AgentLog } from "./components/AgentLog";

const CONFIG = loadConfig();
const FLOOR_ORIGIN = CONFIG.floorOrigin || "http://localhost:5173";
const PERSONA_ID = CONFIG.persona;

function useBidderId(personaId: string): string {
  return useMemo(() => {
    const k = `openfloor.bidder_id.${personaId}`;
    let v = sessionStorage.getItem(k);
    if (!v) {
      v = `${personaId}_${crypto.randomUUID().slice(0, 6)}`;
      sessionStorage.setItem(k, v);
    }
    return v;
  }, [personaId]);
}

export function App() {
  const persona = getPersona(PERSONA_ID);
  const bidderId = useBidderId(persona.id);
  const { state, confirmations, raiseRequests, connected, refresh, setRaiseRequests } = useAuction(bidderId);

  const [lot, setLot] = useState<PublicLot | null>(null);
  const [mandate, setMandate] = useState<BidMandate | null>(null);
  const [headroom, setHeadroom] = useState<Headroom | null>(null);
  const [layer, setLayer] = useState<WebMcpLayer>("L3_no_webmcp");
  const [probe, setProbe] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);

  const [ceiling, setCeiling] = useState("80.00");
  const [notify, setNotify] = useState("65.00");
  const [note, setNote] = useState("");
  const [budget, setBudget] = useState("150.00");

  const loadMandate = useCallback(async () => {
    const { mandate: m, headroom: h } = await api.getMandate(bidderId);
    setMandate(m);
    setHeadroom(h ?? null);
  }, [bidderId]);

  /**
   * Bring the floor into the frame tree, then probe.
   *
   * Measured in Chrome 151: `getTools({fromOrigins})` only reaches a remote
   * origin's tools when that origin is loaded in a descendant navigable with
   * `allow="tools"`. Without this hidden bridge frame the console can never
   * reach L1, no matter what the browser supports — the tools simply are not
   * observable from here.
   *
   * The frame is mounted first and given a moment to register its tools, since
   * registration happens after its React tree mounts.
   */
  useEffect(() => {
    let unmountBridge: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      unmountBridge = mountToolBridge(FLOOR_ORIGIN);
      await new Promise((r) => setTimeout(r, 2500));
      if (cancelled) return;

      const cap = await detectCapability([FLOOR_ORIGIN]);
      setLayer(cap.layer);
      setProbe(cap.crossOriginProbe?.detail ?? null);
      if (cap.crossOriginProbe) {
        console.info("[OpenFloor] cross-origin probe:", cap.crossOriginProbe.detail);
      }
    })();

    return () => {
      cancelled = true;
      unmountBridge?.();
    };
  }, []);

  /* Take a seat under this persona's name. */
  useEffect(() => {
    void (async () => {
      await api.join({ bidder_id: bidderId, alias: persona.alias });
      setJoined(true);
      await loadMandate();
    })();
  }, [bidderId, persona.alias, loadMandate]);

  useEffect(() => {
    void loadMandate();
  }, [state?.current_price_cents, loadMandate]);

  useEffect(() => {
    void (async () => setLot((await api.lot()).lot))();
  }, [state?.lot?.id]);

  /* Register the three PRIVATE mandate tools (no exposedTo — see the hook). */
  const tools = useBidderTools({
    bidderId,
    mandate,
    headroom,
    currentPriceCents: state?.current_price_cents ?? 0,
    onMandateChanged: () => void loadMandate(),
    onCeilingRaiseRequested: () => void refresh(),
  });

  const agentEnabled = !!mandate?.auto_bid_enabled && joined;
  const agent = useAgent({
    bidderId,
    persona,
    state,
    lot,
    mandate,
    headroom,
    enabled: agentEnabled,
    onNeedsRefresh: () => void Promise.all([refresh(), loadMandate()]),
  });

  async function saveMandate() {
    const c = Math.round(parseFloat(ceiling) * 100);
    const n = Math.round(parseFloat(notify) * 100);
    if (!Number.isFinite(c) || !Number.isFinite(n)) return;
    const b = Math.round(parseFloat(budget) * 100);
    await api.setMandate({
      bidder_id: bidderId,
      ceiling_cents: c,
      notify_above_cents: Math.min(n, c),
      // A budget below the per-bid ceiling would be incoherent; the ceiling is
      // the floor of what a session can cost if you win anything at all.
      ...(Number.isFinite(b) && b >= c ? { total_budget_cents: b } : {}),
      strategy_note: note,
      auto_bid_enabled: true,
    });
    await loadMandate();
  }

  async function toggleAuto(on: boolean) {
    if (!mandate) return;
    await api.setMandate({
      bidder_id: bidderId,
      ceiling_cents: mandate.ceiling_cents,
      notify_above_cents: mandate.notify_above_cents,
      strategy_note: mandate.strategy_note,
      auto_bid_enabled: on,
    });
    await loadMandate();
  }

  const cap = describeLayer(layer);
  const seconds = state?.seconds_remaining ?? 0;
  const isOpen = state?.lot?.status === "open" && seconds > 0;
  const isHigh = state?.high_bidder_id === bidderId;

  return (
    <div className="wrap">
      <header className="masthead">
        <div>
          <div className="brand">
            Bidder Console · <span>{persona.alias}</span>
          </div>
          <div className="tagline">{persona.temperament}</div>
        </div>
        <div className="badges">
          <span className={`badge ${connected ? "ok" : ""}`}>{connected ? "live" : "reconnecting"}</span>
          {tools.registered && <span className="badge ok">3 private tools</span>}
          <span className={`badge ${agentEnabled ? "ok" : "off"}`}>
            agent {agentEnabled ? "on" : "off"}
          </span>
        </div>
      </header>

      <div className={`cap ${layer === "L1_cross_origin" ? "l1" : layer === "L2_same_origin" ? "l2" : "l3"}`}>
        <div className="dot" />
        <div>
          <div className="cap-title">{cap.label}</div>
          <div className="cap-detail">{cap.detail}</div>
          <div className="cap-detail mono" style={{ fontSize: 11.5, marginTop: 4 }}>
            watching {FLOOR_ORIGIN} · mandate tools stay private to this origin
          </div>
          {probe && (
            <div className="cap-detail mono" style={{ fontSize: 11, marginTop: 3, opacity: 0.8 }}>
              {probe}
            </div>
          )}
        </div>
      </div>

      {/* ── Confirmation cards: the agent stopping at your line ────────── */}
      {confirmations.map((c) => (
        <div className="confirm" key={c.id}>
          <h3>{persona.alias} wants your approval</h3>
          <div className="amt">{fmt(c.amount_cents)}</div>
          <div className="why">
            {c.rationale || "No reason given."} — the price was {fmt(c.price_at_request_cents)} when
            it asked. This bid has <strong>not</strong> been placed.
          </div>
          <div className="controls">
            <button
              className="approve"
              onClick={async () => {
                await api.confirm({ confirmation_id: c.id, approved: true });
                void refresh();
              }}
            >
              Approve {fmt(c.amount_cents)}
            </button>
            <button
              className="decline"
              onClick={async () => {
                await api.confirm({ confirmation_id: c.id, approved: false });
                void refresh();
              }}
            >
              Decline
            </button>
          </div>
        </div>
      ))}

      {/* ── Ceiling raise requests: the agent asking, never taking ─────── */}
      {raiseRequests
        .filter((r) => r.status === "pending")
        .map((r) => (
          <div className="confirm" key={r.id}>
            <h3>{persona.alias} is asking to raise your ceiling</h3>
            <div className="amt">
              {fmt(r.current_ceiling_cents)} → {fmt(r.requested_ceiling_cents)}
            </div>
            <div className="why">{r.justification}</div>
            <div className="controls">
              <button
                className="approve"
                onClick={async () => {
                  await api.resolveCeilingRaise({ request_id: r.id, approved: true });
                  setRaiseRequests((prev) => prev.map((x) => (x.id === r.id ? { ...x, status: "approved" } : x)));
                  await loadMandate();
                }}
              >
                Raise to {fmt(r.requested_ceiling_cents)}
              </button>
              <button
                className="decline"
                onClick={async () => {
                  await api.resolveCeilingRaise({ request_id: r.id, approved: false });
                  setRaiseRequests((prev) => prev.map((x) => (x.id === r.id ? { ...x, status: "declined" } : x)));
                }}
              >
                Keep it at {fmt(r.current_ceiling_cents)}
              </button>
            </div>
          </div>
        ))}

      <div className="layout">
        <div>
          {/* ── The lot ─────────────────────────────────────── */}
          <div className="panel">
            <h2>On the block</h2>
            {!lot ? (
              <div className="empty">Nothing open yet.</div>
            ) : (
              <>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{lot.title}</div>
                <div className="price-row">
                  <div>
                    <div className="price-label">Current bid</div>
                    <div className="price">{fmt(state?.current_price_cents ?? 0)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className={`clock ${seconds <= 10 && isOpen ? "urgent" : ""}`}>
                      {isOpen ? `0:${String(seconds).padStart(2, "0")}` : "—"}
                    </div>
                    {state?.clock_extended && isOpen && (
                      <div style={{ color: "var(--amber)", fontSize: 12 }}>extended · anti-snipe</div>
                    )}
                  </div>
                </div>
                <div className="badges" style={{ marginTop: 12 }}>
                  {isHigh && <span className="badge ok">you hold the high bid</span>}
                  {state?.high_bidder_alias && !isHigh && (
                    <span className="badge">high · {state.high_bidder_alias}</span>
                  )}
                  <span className={`badge ${state?.reserve_met ? "ok" : "warn"}`}>
                    {state?.reserve_met ? "reserve met" : "reserve not met"}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* ── Mandate ─────────────────────────────────────── */}
          <div className="panel">
            <h2>Your mandate</h2>
            {mandate && headroom ? (
              <>
                <MandateBand
                  currentPriceCents={state?.current_price_cents ?? 0}
                  notifyAboveCents={mandate.notify_above_cents}
                  ceilingCents={mandate.ceiling_cents}
                />
                <div className="controls" style={{ marginTop: 14 }}>
                  <button
                    className={mandate.auto_bid_enabled ? "danger" : "primary"}
                    onClick={() => void toggleAuto(!mandate.auto_bid_enabled)}
                  >
                    {mandate.auto_bid_enabled ? "Stop the agent" : "Let the agent bid"}
                  </button>
                </div>
                {headroom.total_budget_cents !== undefined && (
                  <div className="hint">
                    Session budget {fmt(headroom.total_budget_cents)} ·{" "}
                    <strong>{fmt(headroom.budget_remaining_cents ?? 0)} left</strong> across all lots
                    ({fmt(headroom.committed_cents ?? 0)} committed).
                  </div>
                )}
                <div className="hint">
                  The ceiling caps a single bid; the budget caps every lot together. Both are
                  enforced on the server — {persona.alias} cannot raise either.
                </div>
              </>
            ) : (
              <>
                <div className="field-row">
                  <div className="field">
                    <label htmlFor="ceil">Hard ceiling</label>
                    <input id="ceil" type="number" step="0.01" value={ceiling} onChange={(e) => setCeiling(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="notif">Ask me above</label>
                    <input id="notif" type="number" step="0.01" value={notify} onChange={(e) => setNotify(e.target.value)} />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="budget">Total across all lots</label>
                  <input id="budget" type="number" step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="note">Guidance (optional)</label>
                  <input
                    id="note"
                    type="text"
                    value={note}
                    placeholder="e.g. only if condition is Excellent"
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
                <button className="primary" onClick={() => void saveMandate()}>
                  Set mandate
                </button>
                <div className="hint">
                  Or just tell your agent: “bid up to $80, but check with me past $65.”
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Agent reasoning ───────────────────────────────── */}
        <div>
          <div className="panel">
            <h2>
              {persona.alias}'s reasoning{" "}
              {agent.thinking && <span className="thinking">· thinking</span>}
            </h2>
            <AgentLog entries={agent.log} />
            <div className="hint">
              Four stages: plan, bid, belief update, replan. Every figure comes from the
              server — the agent never does the arithmetic itself.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
