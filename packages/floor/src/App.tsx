import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BidMandate } from "@openfloor/shared";
import { fmt, describeLayer, detectCapability, type WebMcpLayer } from "@openfloor/shared";
import { api, type PublicLot } from "./lib/api";
import { useAuction } from "./lib/useAuction";
import { registerAuctionTools, bidderOrigins } from "./webmcp/registerAuctionTools";
import { registerMandateTools } from "./webmcp/registerMandateTools";
import { AuditTrail } from "./components/AuditTrail";

/** Stable per-tab identity so a bidder keeps their seat across reloads. */
function useBidderId(): string {
  return useMemo(() => {
    const k = "openfloor.bidder_id";
    let v = sessionStorage.getItem(k);
    if (!v) {
      v = `bidder_${crypto.randomUUID().slice(0, 8)}`;
      sessionStorage.setItem(k, v);
    }
    return v;
  }, []);
}

export function App() {
  const bidderId = useBidderId();
  const { state, audit, confirmations, raiseRequests, connected, refresh, setRaiseRequests } =
    useAuction();
  const [mandate, setMandate] = useState<BidMandate | null>(null);
  const [lot, setLot] = useState<PublicLot | null>(null);
  const [history, setHistory] = useState<
    { alias: string; amount_cents: number; placed_by: "human" | "agent"; human_confirmed: boolean; at: string }[]
  >([]);
  const [layer, setLayer] = useState<WebMcpLayer>("L3_no_webmcp");
  const [alias, setAlias] = useState("");
  const [joined, setJoined] = useState(false);
  const [aliasFlagged, setAliasFlagged] = useState(false);
  const [manualBid, setManualBid] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const prevPrice = useRef<number>(0);
  const [bump, setBump] = useState(false);

  const loadMandate = useCallback(async () => {
    const { mandate: m } = await api.getMandate(bidderId);
    setMandate(m);
  }, [bidderId]);

  /**
   * Register both tool sets.
   *
   * The five auction tools carry `exposedTo` and are reachable by allowlisted
   * bidder origins. The three mandate tools carry no `exposedTo` at all and stay
   * private to this page — exposure is scoped per tool, not per document.
   */
  useEffect(() => {
    let disposeAuction: (() => void) | undefined;
    let disposeMandate: (() => void) | undefined;
    void (async () => {
      const cap = await detectCapability([]);
      setLayer(cap.layer);
      if (cap.layer === "L3_no_webmcp") return;
      disposeAuction = await registerAuctionTools({
        bidderId,
        onActivity: () => void refresh(),
      });
      disposeMandate = await registerMandateTools({
        bidderId,
        onChanged: () => void Promise.all([refresh(), loadMandate()]),
      });
    })();
    // Aborting the registration signal is the only way to remove tools —
    // the spec has no unregisterTool.
    return () => {
      disposeAuction?.();
      disposeMandate?.();
    };
  }, [bidderId, refresh, loadMandate]);

  /* Keep the mandate panel in step with the live price. */
  useEffect(() => {
    void loadMandate();
  }, [state?.current_price_cents, loadMandate]);

  /* Keep lot + history in step with auction events. */
  useEffect(() => {
    void (async () => {
      const [{ lot: l }, { bids }] = await Promise.all([api.lot(), api.history(12)]);
      setLot(l);
      setHistory(bids);
    })();
  }, [state?.current_price_cents, state?.lot?.id, state?.lot?.status]);

  /* Flash the price when it moves. */
  useEffect(() => {
    if (!state) return;
    if (prevPrice.current && state.current_price_cents !== prevPrice.current) {
      setBump(true);
      const t = setTimeout(() => setBump(false), 430);
      return () => clearTimeout(t);
    }
    prevPrice.current = state.current_price_cents;
  }, [state?.current_price_cents]);

  const cap = describeLayer(layer);
  const seconds = state?.seconds_remaining ?? 0;
  const isOpen = state?.lot?.status === "open" && seconds > 0;
  const minNext = (state?.current_price_cents ?? 0) + (state?.min_increment_cents ?? 100);

  async function join() {
    const res = await api.join({ bidder_id: bidderId, alias: alias || "Guest" });
    setAlias(res.alias);
    setAliasFlagged(res.flagged);
    setJoined(true);
  }

  async function placeManualBid() {
    if (!state?.lot) return;
    const cents = Math.round(parseFloat(manualBid) * 100);
    if (!Number.isFinite(cents)) return;
    const res = await api.bid({
      bidder_id: bidderId,
      lot_id: state.lot.id,
      amount_cents: cents,
      placed_by: "human",
    });
    setNotice(res.message);
    setManualBid("");
    void refresh();
  }

  return (
    <div className="wrap">
      <header className="masthead">
        <div>
          <div className="brand">
            Open<span>Floor</span>
          </div>
          <div className="tagline">
            Your agent bids. You set the limits. Everything on the record.
          </div>
        </div>
        <div className="badges">
          <span className={`badge ${connected ? "ok" : ""}`}>
            {connected ? "live" : "reconnecting"}
          </span>
          <span className="badge">room · {state?.room_id ?? "—"}</span>
        </div>
      </header>

      <div className={`cap ${layer === "L1_cross_origin" ? "l1" : layer === "L2_same_origin" ? "l2" : "l3"}`}>
        <div className="dot" />
        <div>
          <div className="cap-title">{cap.label}</div>
          <div className="cap-detail">{cap.detail}</div>
          {layer !== "L3_no_webmcp" && (
            <div className="cap-detail mono" style={{ fontSize: 11.5, marginTop: 4 }}>
              6 auction tools exposed to {bidderOrigins().join(", ")} · 3 mandate tools private to
              this origin
            </div>
          )}
        </div>
      </div>

      {/* ── The agent stopping at the line you drew ───────────────────── */}
      {confirmations
        .filter((c) => c.bidder_id === bidderId)
        .map((c) => (
          <div className="confirm" key={c.id}>
            <h3>Your agent is asking before it crosses your line</h3>
            <div className="amt">{fmt(c.amount_cents)}</div>
            <div className="why">
              {c.rationale || "No reason given."} — the price was {fmt(c.price_at_request_cents)}{" "}
              when it asked. This bid has <strong>not</strong> been placed.
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

      {/* ── The agent asking to raise its ceiling — it can only ask ────── */}
      {raiseRequests
        .filter((r) => r.bidder_id === bidderId && r.status === "pending")
        .map((r) => (
          <div className="confirm" key={r.id}>
            <h3>Your agent wants a higher ceiling</h3>
            <div className="amt">
              {fmt(r.current_ceiling_cents)} → {fmt(r.requested_ceiling_cents)}
            </div>
            <div className="why">{r.justification}</div>
            <div className="controls">
              <button
                className="approve"
                onClick={async () => {
                  await api.resolveCeilingRaise({ request_id: r.id, approved: true });
                  setRaiseRequests((prev) =>
                    prev.map((x) => (x.id === r.id ? { ...x, status: "approved" as const } : x)),
                  );
                  void Promise.all([refresh(), loadMandate()]);
                }}
              >
                Raise to {fmt(r.requested_ceiling_cents)}
              </button>
              <button
                onClick={async () => {
                  await api.resolveCeilingRaise({ request_id: r.id, approved: false });
                  setRaiseRequests((prev) =>
                    prev.map((x) => (x.id === r.id ? { ...x, status: "declined" as const } : x)),
                  );
                }}
              >
                Keep {fmt(r.current_ceiling_cents)}
              </button>
            </div>
          </div>
        ))}

      <div className="layout">
        <div>
          {/* ── Lot ─────────────────────────────────────────── */}
          <div className="panel">
            <h2>Current lot</h2>
            {!lot && <div className="empty">No lot open. Start the auction to begin.</div>}
            {lot && (
              <>
                <h3 className="lot-title">{lot.title}</h3>
                <div className="lot-meta">
                  {lot.condition} · estimate {fmt(lot.estimate_low_cents)}–{fmt(lot.estimate_high_cents)} ·
                  increment {fmt(lot.min_increment_cents)}
                </div>

                <div className="price-row">
                  <div>
                    <div className="price-label">Current bid</div>
                    <div className={`price ${bump ? "bump" : ""}`}>
                      {fmt(state?.current_price_cents ?? lot.starting_price_cents)}
                    </div>
                  </div>
                  <div>
                    <div className={`clock ${seconds <= 10 && isOpen ? "urgent" : ""}`}>
                      {isOpen ? `0:${String(seconds).padStart(2, "0")}` : "—"}
                    </div>
                    {state?.clock_extended && isOpen && (
                      <div className="clock-note">extended · anti-snipe</div>
                    )}
                  </div>
                </div>

                <div className="badges">
                  <span className={`badge ${state?.reserve_met ? "ok" : "warn"}`}>
                    {state?.reserve_met ? "reserve met" : "reserve not met"}
                  </span>
                  {state?.high_bidder_alias && (
                    <span className="badge accent">high · {state.high_bidder_alias}</span>
                  )}
                  <span className="badge">{state?.bid_count ?? 0} bids</span>
                  <span className="badge">{state?.lot?.status ?? "pending"}</span>
                </div>

                <p className="lot-desc">{lot.description}</p>
              </>
            )}
          </div>

          {/* ── Bids ────────────────────────────────────────── */}
          <div className="panel">
            <h2>Bidding</h2>
            {history.length === 0 && <div className="empty">No bids yet.</div>}
            <ul className="bid-list">
              {history.map((b, i) => (
                <li className="bid-row" key={`${b.at}-${i}`}>
                  <div className="bid-who">
                    <span className={`tag ${b.placed_by}`}>{b.placed_by}</span>
                    <span className="bid-alias">{b.alias}</span>
                    {b.human_confirmed && b.placed_by === "agent" && (
                      <span className="tag human">approved</span>
                    )}
                  </div>
                  <span className="bid-amt">{fmt(b.amount_cents)}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* ── What the agent is operating under ─────────────── */}
          <div className="panel">
            <h2>Your agent's mandate</h2>
            {mandate ? (
              <>
                <div className="mandate-strip">
                  <div>
                    <span className="k">bids freely below</span>
                    <span className="v">{fmt(mandate.notify_above_cents)}</span>
                  </div>
                  <div>
                    <span className="k">asks you above</span>
                    <span className="v sup">{fmt(mandate.notify_above_cents)}</span>
                  </div>
                  <div>
                    <span className="k">cannot pass</span>
                    <span className="v wall">{fmt(mandate.ceiling_cents)}</span>
                  </div>
                  {mandate.total_budget_cents !== undefined && (
                    <div>
                      <span className="k">total budget</span>
                      <span className="v wall">{fmt(mandate.total_budget_cents)}</span>
                    </div>
                  )}
                  <div>
                    <span className="k">auto-bidding</span>
                    <span className="v">{mandate.auto_bid_enabled ? "on" : "off"}</span>
                  </div>
                </div>
                {mandate.strategy_note && (
                  <div className="hint">Your guidance: “{mandate.strategy_note}”</div>
                )}
                <div className="hint">
                  Enforced on the server against a signed mandate. No tool in this app can raise
                  that ceiling — the agent can only ask you.
                  {mandate.total_budget_cents !== undefined &&
                    " The ceiling caps one bid; the budget caps every lot together."}
                </div>
              </>
            ) : (
              <>
                <div className="empty">No mandate set.</div>
                <div className="hint">
                  Tell your agent something like “bid for me up to $80, but check with me before
                  you pass $65.” It will call <span className="mono">set_bid_mandate</span>.
                </div>
              </>
            )}
          </div>

          {/* ── Manual bidding: the L3 fallback and the human override ── */}
          <div className="panel">
            <h2>Bid by hand</h2>
            {!joined ? (
              <>
                <div className="field">
                  <label htmlFor="alias">Display name</label>
                  <input
                    id="alias"
                    type="text"
                    value={alias}
                    placeholder="How other bidders see you"
                    onChange={(e) => setAlias(e.target.value)}
                  />
                </div>
                <button className="primary" onClick={() => void join()}>
                  Take a seat
                </button>
                <div className="hint">
                  Display names are sanitized server-side before any agent sees them.
                </div>
              </>
            ) : (
              <>
                {aliasFlagged && (
                  <div className="badges" style={{ marginBottom: 10 }}>
                    <span className="badge" style={{ color: "var(--red)" }}>
                      your display name tripped the injection filter — neutralized
                    </span>
                  </div>
                )}
                <div className="field">
                  <label htmlFor="amt">
                    Your bid — minimum {fmt(minNext)}
                  </label>
                  <input
                    id="amt"
                    type="number"
                    step="0.01"
                    value={manualBid}
                    placeholder={(minNext / 100).toFixed(2)}
                    onChange={(e) => setManualBid(e.target.value)}
                  />
                </div>
                <div className="controls">
                  <button className="primary" disabled={!isOpen} onClick={() => void placeManualBid()}>
                    Place bid as {alias}
                  </button>
                  <button disabled={!isOpen} onClick={() => setManualBid((minNext / 100).toFixed(2))}>
                    Minimum
                  </button>
                </div>
                {notice && <div className="hint">{notice}</div>}
              </>
            )}
          </div>

          {/* ── Auctioneer controls (demo conveniences) ─────── */}
          <div className="panel">
            <h2>Auctioneer</h2>
            <div className="controls">
              <button onClick={() => void api.start().then(refresh)}>Open lot</button>
              <button onClick={() => void api.next().then(refresh)}>Next lot</button>
              <button className="danger" onClick={() => void api.reset().then(refresh)}>
                Reset room
              </button>
            </div>
            <div className="hint">
              All settlement is simulated. No payment is taken and no goods change hands.
            </div>
          </div>
        </div>

        {/* ── Audit ─────────────────────────────────────────── */}
        <div>
          <div className="panel">
            <h2>Audit trail</h2>
            <AuditTrail entries={audit} />
            <div className="hint">
              Every tool call, which origin made it, and whether a human approved it.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
