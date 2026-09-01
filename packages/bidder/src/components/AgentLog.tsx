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
export function AgentLog({ entries }: { entries: AgentLogEntry[] }) {
  if (!entries.length) {
    return <div className="empty">Waiting for a lot to open.</div>;
  }

  return (
    <div className="log">
      {[...entries].reverse().map((e) => (
        <div className="log-row" key={e.id}>
          <div className="log-head">
            <span className={`stage ${e.stage}`}>{STAGE_LABEL[e.stage]}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-faint)" }}>
              {new Date(e.at).toLocaleTimeString()}
            </span>
          </div>
          <div className="log-text">{e.text}</div>
          {e.outcome && <div className="log-outcome">{e.outcome}</div>}
        </div>
      ))}
    </div>
  );
}
