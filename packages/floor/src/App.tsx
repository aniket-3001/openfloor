import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BidMandate } from "@openfloor/shared";
import { fmt, detectCapability, type WebMcpLayer } from "@openfloor/shared";
import { api, type PublicLot } from "./lib/api";
import { useAuction } from "./lib/useAuction";
import { registerAuctionTools } from "./webmcp/registerAuctionTools";
import { registerMandateTools } from "./webmcp/registerMandateTools";
import { LotPlate } from "./components/LotPlate";
import { SeatClaim } from "./components/SeatClaim";
import { BreakIt } from "./components/BreakIt";
import { useFloorAgent, suggestedLimits } from "./lib/useFloorAgent";
import { Activity } from "./components/Activity";

/**
 * The saleroom.
 *
 * Everything here is the lot, the price, your position, or the record. Room
 * controls, tool counts and transport diagnostics are not a visitor's concern
 * and are no longer on the page — the auctioneer controls stay reachable at
 * ?admin for running a demo, which is all they were ever for.
 *
 * Identity now comes from the session rather than a per-tab random id, so the
 * page can say "you are leading" and mean it.
 */
export function App() {
  const { state, secondsLeft, audit, confirmations, raiseRequests, connected, refresh, setRaiseRequests } =
    useAuction();
  const [me, setMe] = useState<{ bidder_id: string; alias: string; handle: string | null } | null>(null);
  const [mandate, setMandate] = useState<BidMandate | null>(null);
  const [lot, setLot] = useState<PublicLot | null>(null);
  const [history, setHistory] = useState<
    { alias: string; amount_cents: number; placed_by: "human" | "agent"; human_confirmed: boolean; at: string }[]
  >([]);
  const [layer, setLayer] = useState<WebMcpLayer>("L3_no_webmcp");
  const [bid, setBid] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  const prevPrice = useRef(0);

  const admin = useMemo(() => new URLSearchParams(location.search).has("admin"), []);
  const bidderId = me?.bidder_id ?? "";
  const [delegating, setDelegating] = useState(false);

  /**
   * Hand the bidding over in one click.
   *
   * The limits are derived from the live price rather than fixed, so the agent
   * gets a couple of free bids and then has to ask — while someone is still
   * watching. A supervised band pinned far above the current price produces a
   * demo where nothing happens.
   */
  const delegate = useCallback(async () => {
    if (!state?.lot || !bidderId) return;
    setDelegating(true);
    try {
      const limits = suggestedLimits(state.current_price_cents, state.min_increment_cents);
      await api.join({ bidder_id: bidderId, alias: me?.handle ?? me?.alias ?? "You" });
      const { mandate: m } = await api.setMandate({
        bidder_id: bidderId,
        ...limits,
        strategy_note: "Bid for me, but check with me before going past my line.",
        auto_bid_enabled: true,
      });
      setMandate(m);
      setNotice("Your agent is bidding. It will ask before passing your line.");
    } catch {
      setNotice("Could not start your agent. Try again.");
    } finally {
      setDelegating(false);
    }
  }, [state, bidderId, me]);

  const { agentLine, agentRunning } = useFloorAgent({
    bidderId,
    state,
    lot,
    mandate,
    onActed: refresh,
  });

  const loadMe = useCallback(async () => {
    try {
      const { session } = await api.session();
      setMe(session);
      if (session) setMandate((await api.getMandate(session.bidder_id)).mandate);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe, state?.current_price_cents]);

  /* Auction tools carry exposedTo; mandate tools deliberately do not. Aborting
     the registration signal is the only way to remove a tool, so both disposers
     run on unmount. */
  useEffect(() => {
    if (!bidderId) return;
    let a: (() => void) | undefined;
    let b: (() => void) | undefined;
    void (async () => {
      const cap = await detectCapability([]);
      setLayer(cap.layer);
      if (cap.layer === "L3_no_webmcp") return;
      a = await registerAuctionTools({ bidderId, onActivity: () => void refresh() });
      b = await registerMandateTools({
        bidderId,
        onChanged: () => void Promise.all([refresh(), loadMe()]),
      });
    })();
    return () => {
      a?.();
      b?.();
    };
  }, [bidderId, refresh, loadMe]);

  useEffect(() => {
    void (async () => {
      const [{ lot: l }, { bids }] = await Promise.all([api.lot(), api.history(12)]);
      setLot(l);
      setHistory(bids);
    })();
  }, [state?.current_price_cents, state?.lot?.id, state?.lot?.status]);

  useEffect(() => {
    if (!state) return;
    if (prevPrice.current && state.current_price_cents !== prevPrice.current) {
      setMoved(true);
      const t = setTimeout(() => setMoved(false), 520);
      return () => clearTimeout(t);
    }
    prevPrice.current = state.current_price_cents;
  }, [state?.current_price_cents]);

  const seconds = secondsLeft;
  const open = state?.lot?.status === "open" && seconds > 0;
  const minNext = (state?.current_price_cents ?? 0) + (state?.min_increment_cents ?? 100);
  const leading = !!bidderId && state?.high_bidder_id === bidderId;

  async function placeBid() {
    if (!state?.lot) return;
    const cents = Math.round(parseFloat(bid) * 100);
    if (!Number.isFinite(cents)) return;
    const res = await api.bid({
      bidder_id: bidderId,
      lot_id: state.lot.id,
      amount_cents: cents,
      placed_by: "human",
    });
    setNotice(res.message);
    setBid("");
    void refresh();
  }

  return (
    <div className="wrap">
      <header className="masthead">
        <div className="brand">OpenFloor</div>
        <div className="masthead-right">
          {open && (
            <span className={`live-dot ${connected ? "" : "idle"}`}>
              {connected ? "Live" : "Reconnecting"}
            </span>
          )}
          {me && <SeatClaim me={me} onClaimed={() => void loadMe()} />}
        </div>
      </header>

      {/* The auction announces itself to a screen reader without adding chrome. */}
      <div className="sr" aria-live="polite" aria-atomic="true">
        {open && state ? `Current bid ${fmt(state.current_price_cents)}, ${seconds} seconds left.` : ""}
      </div>

      {/* The only thing allowed to interrupt: your agent asking permission. */}
      {confirmations
        .filter((c) => c.bidder_id === bidderId)
        .map((c) => (
          <div className="ask" key={c.id} role="alertdialog" aria-label="Approval needed">
            <h3>Your agent needs approval</h3>
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
        .filter((r) => r.bidder_id === bidderId && r.status === "pending")
        .map((r) => (
          <div className="ask" key={r.id} role="alertdialog" aria-label="Limit increase requested">
            <h3>Your agent is asking to raise your limit</h3>
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
                  void Promise.all([refresh(), loadMe()]);
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
        <div className="empty">The saleroom is quiet. The next lot opens shortly.</div>
      ) : (
        <div className="lot">
          <LotPlate imageRef={lot.image_ref} />

          <div>
            <div className="eyebrow">
              Lot {lot.id.replace(/^lot-/, "").toUpperCase()}
            </div>
            <h1 className="lot-title">{lot.title}</h1>
            <div className="lot-meta">
              {lot.condition}
              <span className="dot">·</span>
              Estimate {fmt(lot.estimate_low_cents)}–{fmt(lot.estimate_high_cents)}
            </div>

            <div className="price-block">
              <div className="price-row">
                <div className={`price ${moved ? "moved" : ""}`}>
                  {fmt(state?.current_price_cents ?? lot.starting_price_cents)}
                </div>
                <div>
                  <div className={`clock ${seconds <= 10 && open ? "urgent" : ""}`}>
                    {open ? `0:${String(seconds).padStart(2, "0")}` : "Closed"}
                  </div>
                  {state?.clock_extended && open && <div className="clock-note">Extended</div>}
                </div>
              </div>
              <div className="price-sub">
                <span className={state?.reserve_met ? "met" : ""}>
                  {state?.reserve_met ? "Reserve met" : "Reserve not met"}
                </span>
                <span>{state?.bid_count ?? 0} bids</span>
                {leading ? (
                  <span className="met">You are leading</span>
                ) : (
                  state?.high_bidder_alias && <span>{state.high_bidder_alias} leads</span>
                )}
              </div>
            </div>

            <div className="act">
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                aria-label={`Your bid, minimum ${fmt(minNext)}`}
                placeholder={(minNext / 100).toFixed(2)}
                value={bid}
                disabled={!open}
                onChange={(e) => setBid(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void placeBid()}
              />
              <button disabled={!open || leading} onClick={() => void placeBid()}>
                Place bid
              </button>
              <button
                className="quiet small"
                disabled={!open}
                onClick={() => setBid((minNext / 100).toFixed(2))}
              >
                {fmt(minNext)}
              </button>
            </div>
            {notice && <div className="note">{notice}</div>}

            <p className="lot-desc">{lot.description}</p>
          </div>
        </div>
      )}

      {/* The offer, when nothing has been delegated yet. This is the first
          thing a visitor can do that demonstrates what the project is for. */}
      {!mandate && open && (
        <section className="section delegate">
          <div className="section-head">
            <h2>Or let an agent bid for you</h2>
          </div>
          <p className="delegate-lede">
            It bids on its own up to a line you set, stops and asks before crossing it, and can
            never pass your maximum. You can change all three numbers afterwards.
          </p>
          <div className="act">
            <button onClick={() => void delegate()} disabled={delegating || !bidderId}>
              {delegating ? "Starting…" : "Bid for me"}
            </button>
            <span className="delegate-note">Nothing is charged. No goods change hands.</span>
          </div>
        </section>
      )}

      {mandate && (
        <section className="section">
          <div className="section-head">
            <h2>Your limits</h2>
            <span className="aside">
              {mandate.auto_bid_enabled ? "Agent bidding on" : "Agent bidding off"}
            </span>
          </div>
          {agentRunning && agentLine && (
            <p className="agent-line">
              <span className="agent-dot" aria-hidden="true" />
              {agentLine}
            </p>
          )}
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
            {mandate.total_budget_cents !== undefined && (
              <div className="fact">
                <span className="k">Budget, all lots</span>
                <span className="v wall">{fmt(mandate.total_budget_cents)}</span>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Bidding</h2>
        </div>
        {!history.length ? (
          <div className="empty">No bids yet.</div>
        ) : (
          <ul className="rows">
            {history.map((b, i) => (
              <li className={`row ${b.alias === me?.alias ? "mine" : ""}`} key={`${b.at}-${i}`}>
                <span className="row-l">
                  <span className="row-name">{b.alias}</span>
                  {b.placed_by === "agent" && <span className="chip agent">agent</span>}
                  {b.human_confirmed && b.placed_by === "agent" && (
                    <span className="chip ok">approved</span>
                  )}
                </span>
                <span className="row-amt">{fmt(b.amount_cents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Placed after Activity deliberately: the refusal it produces, and the
          flag on the injected text, both show up in the trail directly above. */}
      {mandate && (
        <BreakIt
          bidderId={bidderId}
          lotId={state?.lot?.id ?? null}
          mandate={mandate}
          onDone={refresh}
        />
      )}

      <section className="section">
        <div className="section-head">
          <h2>Activity</h2>
          <span className="aside">Every action, and who authorised it</span>
        </div>
        <Activity entries={audit} />
      </section>

      {admin && (
        <section className="section">
          <div className="section-head">
            <h2>Saleroom controls</h2>
          </div>
          <div className="act">
            <button className="quiet small" onClick={() => void api.start().then(refresh)}>
              Open lot
            </button>
            <button className="quiet small" onClick={() => void api.next().then(refresh)}>
              Next lot
            </button>
            <button className="quiet small" onClick={() => void api.reset().then(refresh)}>
              Reset
            </button>
          </div>
        </section>
      )}

      <footer className="foot">
        <span>Bids are simulated. No payment is taken and no goods change hands.</span>
        <span>
          {layer === "L3_no_webmcp"
            ? "Manual bidding — enable WebMCP in Chrome 149+ to delegate to an agent"
            : "Agent bidding available"}
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
