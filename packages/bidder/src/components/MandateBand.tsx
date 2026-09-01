import { fmt } from "@openfloor/shared";

/**
 * The two-tier ceiling, drawn.
 *
 * This is the central idea of the project made literal: a green band the agent
 * moves through freely, an amber band where every bid needs a human, and a wall
 * it cannot pass at all. A marker shows where the live price sits.
 */
export function MandateBand({
  currentPriceCents,
  notifyAboveCents,
  ceilingCents,
}: {
  currentPriceCents: number;
  notifyAboveCents: number;
  ceilingCents: number;
}) {
  // Scale the track slightly past the ceiling so the wall is visible rather
  // than flush with the right edge.
  const max = Math.max(ceilingCents * 1.12, currentPriceCents * 1.05, 1);
  const pct = (v: number) => Math.min(100, Math.max(0, (v / max) * 100));

  const notifyPct = pct(notifyAboveCents);
  const ceilingPct = pct(ceilingCents);
  const pricePct = pct(currentPriceCents);
  const inSupervised = currentPriceCents >= notifyAboveCents;
  const atWall = currentPriceCents >= ceilingCents;

  return (
    <div className="band">
      <div className="band-track">
        <div className="band-auto" style={{ width: `${notifyPct}%` }} />
        <div className="band-sup" style={{ left: `${notifyPct}%`, width: `${Math.max(0, ceilingPct - notifyPct)}%` }} />
        <div
          className="band-marker"
          style={{ left: `${pricePct}%` }}
          title={`Current price ${fmt(currentPriceCents)}`}
        />
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${ceilingPct}%`,
            width: 3,
            background: "var(--red)",
          }}
          title={`Hard ceiling ${fmt(ceilingCents)}`}
        />
      </div>

      <div className="band-legend">
        <span>{fmt(0)}</span>
        <span>{fmt(notifyAboveCents)}</span>
        <span>{fmt(ceilingCents)}</span>
      </div>

      <div className="band-key">
        <span className="key">
          <span className="swatch auto" /> agent bids freely
        </span>
        <span className="key">
          <span className="swatch sup" /> you approve each bid
        </span>
        <span className="key">
          <span className="swatch wall" /> impossible
        </span>
      </div>

      <div className="hint" style={{ marginTop: 10 }}>
        Price is at <strong className="mono">{fmt(currentPriceCents)}</strong>
        {atWall
          ? " — at the ceiling. The agent can only ask you to raise it."
          : inSupervised
            ? " — in the supervised band. Every bid needs your approval."
            : " — the agent is bidding on its own."}
      </div>
    </div>
  );
}
