import { useCallback, useEffect, useState } from "react";
import type { BidMandate } from "@openfloor/shared";
import {
  fmt,
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
import { AgentLog } from "./components/AgentLog";

const CONFIG = loadConfig();
const FLOOR_ORIGIN = CONFIG.floorOrigin || "http://localhost:5173";
const PERSONA_ID = CONFIG.persona;

/**
 * Identity comes from the server, never from the client.
 *
 * This console used to mint its own id in sessionStorage. Once sessions
 * arrived, the API began taking the caller's identity from their cookie and
 * ignoring any id in the payload — so a mandate was written under the session
 * and then read back under the invented id, which the server correctly refused
 * as someone else's. The console's agent could therefore never be enabled: it
 * asked for its own mandate, was told 403, and sat paused forever.
 */
function useSessionBidderId(): string {
  const [id, setId] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { session } = await api.session();
        if (!cancelled && session) setId(session.bidder_id);
      } catch {
        /* the next render retries via the effect below */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return id;
}

/**
 * The bidder's console.
 *
 * Same register as the saleroom: one column, hairline rules, the numbers that
 * matter set large and everything else deferring to them. This previously read
 * as a dashboard — a two-column panel grid, status badges, and a transport
 * diagnostic banner — none of which is a bidder's concern.
 *
 * What remains is the four things a person delegating actually needs: what is
 * on the block, what their limits are, what their agent is thinking, and the
 * moment it asks permission.
 */
export function App() {
  const persona = getPersona(PERSONA_ID);
  const bidderId = useSessionBidderId();
  const { state, secondsLeft, confirmations, raiseRequests, connected, refresh, setRaiseRequests } =
    useAuction(bidderId);

  const [lot, setLot] = useState<PublicLot | null>(null);
  const [mandate, setMandate] = useState<BidMandate | null>(null);
  const [headroom, setHeadroom] = useState<Headroom | null>(null);
  const [layer, setLayer] = useState<WebMcpLayer>("L3_no_webmcp");

  const [ceiling, setCeiling] = useState("80.00");
  const [notify, setNotify] = useState("65.00");
  const [budget, setBudget] = useState("150.00");

  const loadMandate = useCallback(async () => {
    if (!bidderId) return;
    try {
      const { mandate: m, headroom: h } = await api.getMandate(bidderId);
      setMandate(m);
      setHeadroom(h ?? null);
    } catch {
      // A failed read must not leave a stale mandate on screen implying the
      // agent is running when it is not.
      setMandate(null);
      setHeadroom(null);
    }
  }, [bidderId]);

  /* Bring the floor into the frame tree, then probe. Without this hidden
     bridge frame the console cannot reach the floor's tools at all — measured
     in Chrome 151, getTools only sees origins present as descendants. */
  useEffect(() => {
    let unmount: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      unmount = mountToolBridge(FLOOR_ORIGIN);
      await new Promise((r) => setTimeout(r, 2500));
      if (cancelled) return;
      const cap = await detectCapability([FLOOR_ORIGIN]);
      setLayer(cap.layer);
      if (cap.crossOriginProbe) console.info("[OpenFloor]", cap.crossOriginProbe.detail);
    })();
    return () => {
      cancelled = true;
      unmount?.();
    };
  }, []);

  useEffect(() => {
    if (!bidderId) return;
    void (async () => {
      // Joining registers a display name; it is not what authorises anything.
      // An unretried failure here used to disable the agent permanently — the
      // effect threw before `setJoined`, nothing retried, and the console sat
      // paused with a mandate on file and no explanation.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await api.join({ bidder_id: bidderId, alias: persona.alias });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
      }
      await loadMandate();
    })();
  }, [bidderId, persona.alias, loadMandate]);

  useEffect(() => {
    void loadMandate();
  }, [state?.current_price_cents, loadMandate]);

  useEffect(() => {
    void (async () => setLot((await api.lot()).lot))();
  }, [state?.lot?.id]);

  const tools = useBidderTools({
    bidderId,
    mandate,
    headroom,
    currentPriceCents: state?.current_price_cents ?? 0,
    onMandateChanged: () => void loadMandate(),
    onCeilingRaiseRequested: () => void refresh(),
  });

  // The mandate is the authority, not the display name. Gating on `joined`
  // meant a failed cosmetic call could silently stop the agent.
  const agentEnabled = !!mandate?.auto_bid_enabled && !!bidderId;
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
    const b = Math.round(parseFloat(budget) * 100);
    if (!Number.isFinite(c) || !Number.isFinite(n)) return;
    if (!bidderId) return;
    // Take the mandate straight from the reply rather than reading it back.
    // The round trip raced with identity resolution: the write succeeded, the
    // follow-up read was skipped, and the agent stayed paused with the form
    // looking as though nothing had happened.
    const { mandate: saved } = await api.setMandate({
      bidder_id: bidderId,
      ceiling_cents: c,
      notify_above_cents: Math.min(n, c),
      // A budget below the per-bid ceiling is incoherent: the ceiling is the
      // least a session can cost if you win anything at all.
      ...(Number.isFinite(b) && b >= c ? { total_budget_cents: b } : {}),
      auto_bid_enabled: true,
    });
    setMandate(saved);
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

  // The default persona is literally called "You", so a naive possessive reads
  // as "You's reasoning". Rivals keep their own names.
  const possessive = persona.alias === "You" ? "Your agent's" : `${persona.alias}'s`;

  const seconds = secondsLeft;
  const open = state?.lot?.status === "open" && seconds > 0;
  const leading = state?.high_bidder_id === bidderId;

  return (
    <div className="wrap">
      <header className="masthead">
        <div className="brand">
          OpenFloor <span className="who">· {persona.alias}</span>
        </div>
        <div className="masthead-right">
          {open && (
            <span className={`live-dot ${connected ? "" : "idle"}`}>
              {connected ? "Live" : "Reconnecting"}
            </span>
          )}
          <span className="who">{agentEnabled ? "Agent bidding" : "Agent paused"}</span>
        </div>
      </header>

      <div className="sr" aria-live="polite" aria-atomic="true">
        {open && state ? `Current bid ${fmt(state.current_price_cents)}, ${seconds} seconds left.` : ""}
      </div>

      {/* The moment this console exists for. */}
      {confirmations.map((c) => (
        <div className="ask" key={c.id} role="alertdialog" aria-label="Approval needed">
          <h3>{persona.alias === "You" ? "Your agent" : persona.alias} needs your approval</h3>
          <div className="amt">{fmt(c.amount_cents)}</div>
          <div className="why">
            {c.rationale || "No reason given."} The price was {fmt(c.price_at_request_cents)} when it
            asked. Nothing has been bid.
          </div>
          <div className="act">
            <button
              onClick={async () => {
                await api.confirm({ confirmation_id: c.id, approved: true });
                void refresh();
              }}
            >
              Approve {fmt(c.amount_cents)}
            </button>
            <button
              className="quiet"
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

      {raiseRequests
        .filter((r) => r.status === "pending")
        .map((r) => (
          <div className="ask" key={r.id} role="alertdialog" aria-label="Limit increase requested">
            <h3>{persona.alias === "You" ? "Your agent" : persona.alias} is asking to raise your limit</h3>
            <div className="amt">
              {fmt(r.current_ceiling_cents)} → {fmt(r.requested_ceiling_cents)}
            </div>
            <div className="why">{r.justification}</div>
            <div className="act">
              <button
                onClick={async () => {
                  await api.resolveCeilingRaise({ request_id: r.id, approved: true });
                  setRaiseRequests((p) =>
                    p.map((x) => (x.id === r.id ? { ...x, status: "approved" as const } : x)),
                  );
                  await loadMandate();
                }}
              >
                Raise to {fmt(r.requested_ceiling_cents)}
              </button>
              <button
                className="quiet"
                onClick={async () => {
                  await api.resolveCeilingRaise({ request_id: r.id, approved: false });
                  setRaiseRequests((p) =>
                    p.map((x) => (x.id === r.id ? { ...x, status: "declined" as const } : x)),
                  );
                }}
              >
                Keep {fmt(r.current_ceiling_cents)}
              </button>
            </div>
          </div>
        ))}

      {!lot ? (
        <div className="empty">Nothing on the block. The next lot opens shortly.</div>
      ) : (
        <>
          <div className="eyebrow">On the block</div>
          <h1 className="lot-title">{lot.title}</h1>
          <div className="price-block">
            <div className="price-row">
              <div className="price">{fmt(state?.current_price_cents ?? 0)}</div>
              <div className={`clock ${seconds <= 10 && open ? "urgent" : ""}`}>
                {open ? `0:${String(seconds).padStart(2, "0")}` : "Closed"}
              </div>
            </div>
            <div className="price-sub">
              {leading ? (
                <span className="met">You are leading</span>
              ) : (
                state?.high_bidder_alias && <span>{state.high_bidder_alias} leads</span>
              )}
              <span className={state?.reserve_met ? "met" : ""}>
                {state?.reserve_met ? "Reserve met" : "Reserve not met"}
              </span>
            </div>
          </div>
        </>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Your limits</h2>
          {mandate && (
            <button
              className="quiet small"
              onClick={() => void toggleAuto(!mandate.auto_bid_enabled)}
            >
              {mandate.auto_bid_enabled ? "Pause agent" : "Resume agent"}
            </button>
          )}
        </div>

        {mandate && headroom ? (
          <>
            <Band
              price={state?.current_price_cents ?? 0}
              notify={mandate.notify_above_cents}
              ceiling={mandate.ceiling_cents}
            />
            <div className="facts">
              <div className="fact">
                <span className="k">Bids alone below</span>
                <span className="v">{fmt(mandate.notify_above_cents)}</span>
              </div>
              <div className="fact">
                <span className="k">Asks you above</span>
                <span className="v sup">{fmt(mandate.notify_above_cents)}</span>
              </div>
              <div className="fact">
                <span className="k">Never passes</span>
                <span className="v wall">{fmt(mandate.ceiling_cents)}</span>
              </div>
              {headroom.total_budget_cents !== undefined && (
                <div className="fact">
                  <span className="k">Left, all lots</span>
                  <span className="v">{fmt(headroom.budget_remaining_cents ?? 0)}</span>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="act">
              <label className="field-inline">
                <span className="k">Never pass</span>
                <input
                  type="number"
                  step="0.01"
                  aria-label="Hard ceiling"
                  value={ceiling}
                  onChange={(e) => setCeiling(e.target.value)}
                />
              </label>
              <label className="field-inline">
                <span className="k">Ask me above</span>
                <input
                  type="number"
                  step="0.01"
                  aria-label="Ask above"
                  value={notify}
                  onChange={(e) => setNotify(e.target.value)}
                />
              </label>
              <label className="field-inline">
                <span className="k">Budget, all lots</span>
                <input
                  type="number"
                  step="0.01"
                  aria-label="Total budget"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
              </label>
              <button onClick={() => void saveMandate()}>Set limits</button>
            </div>
            <div className="note">
              Or say it in words to your agent: “bid up to {ceiling}, but check with me past{" "}
              {notify}.”
            </div>
          </>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>{possessive} reasoning</h2>
          {agent.thinking && <span className="aside">thinking…</span>}
        </div>
        <AgentLog
          entries={agent.log}
          idleReason={
            !bidderId
              ? "Connecting to the saleroom…"
              : !mandate
                ? "Set your limits above, and your agent will start bidding and show its working here."
                : !mandate.auto_bid_enabled
                  ? "Your agent is paused. Resume it above."
                  : state?.lot?.status !== "open"
                    ? "Waiting for the next lot to open."
                    : "Watching the bidding."
          }
        />
      </section>

      <footer className="foot">
        <span>Bids are simulated. No payment is taken and no goods change hands.</span>
        <span>
          {tools.registered ? "Agent tools registered" : "Agent tools unavailable"}
          {layer === "L1_cross_origin" ? " · reaching the floor" : ""}
        </span>
      </footer>
    </div>
  );
}

/** The mandate, drawn: free below, supervised between, impossible past. */
function Band({ price, notify, ceiling }: { price: number; notify: number; ceiling: number }) {
  const max = Math.max(ceiling * 1.1, price * 1.05, 1);
  const pct = (v: number) => Math.min(100, Math.max(0, (v / max) * 100));
  return (
    <div className="band">
      <div className="band-track">
        <div className="band-auto" style={{ width: `${pct(notify)}%` }} />
        <div
          className="band-sup"
          style={{ left: `${pct(notify)}%`, width: `${Math.max(0, pct(ceiling) - pct(notify))}%` }}
        />
        <div className="band-mark" style={{ left: `${pct(price)}%` }} />
      </div>
      <div className="band-legend">
        <span>{fmt(0)}</span>
        <span>{fmt(ceiling)}</span>
      </div>
    </div>
  );
}
