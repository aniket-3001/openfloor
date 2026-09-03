import type { AgentLogEntry } from "../agent/useAgent";

const STAGE_LABEL: Record<AgentLogEntry["stage"], string> = {
  plan: "plan",
  bid: "bid",
  belief: "belief update",
  replan: "replan",
};

/**
 * The agent's reasoning, stage by stage.
 *
 * Showing the loop rather than just its output is the point: a viewer can see
 * that the agent formed a plan, decided against it, took the server's corrected
 * figures, and revised — instead of a black box that emits bids.
 */
export function AgentLog({
  entries,
  limit = 10,
  idleReason = "Nothing yet.",
}: {
  entries: AgentLogEntry[];
  limit?: number;
  /**
   * Why there is nothing to show. This used to be a fixed "Waiting for a lot
   * to open", which was usually untrue — a lot was open and the real reason
   * was that no limits had been set — and so said nothing about what to do
   * next.
   */
  idleReason?: string;
}) {
  if (!entries.length) {
    return <div className="empty">{idleReason}</div>;
  }

  // Bounded by count rather than a scrollbox: the page is the scroll surface.
  const shown = [...entries].reverse().slice(0, limit);

  return (
    <div className="log">
      {shown.map((e) => (
        <div className="log-row" key={e.id}>
          <div className="log-head">
            <span className={`stage ${e.stage}`}>{STAGE_LABEL[e.stage]}</span>
            <span className="log-text">{e.text}</span>
          </div>
          {e.outcome && <div className="log-outcome">{e.outcome}</div>}
        </div>
      ))}
    </div>
  );
}
