import type { AuditEntry } from "@openfloor/shared";

const FLAG_LABEL: Record<string, string> = {
  injection_attempt: "injection attempt",
  rate_limited: "rate limited",
  ceiling_blocked: "ceiling blocked",
};

/**
 * The public record.
 *
 * Two things are shown that a conventional auction UI would not bother with,
 * because they are the point of the project: the ORIGIN that initiated each
 * action (making the cross-origin trust boundary visible rather than implied),
 * and whether a human personally approved it.
 */
export function AuditTrail({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) {
    return <div className="empty">Nothing yet.</div>;
  }

  return (
    <div className="audit">
      {[...entries].reverse().map((e) => (
        <div key={e.id} className={`audit-row ${e.flagged ? "flagged" : ""}`}>
          <div className="audit-head">
            <span className="audit-actor">{e.actor}</span>
            <span className={`tag ${e.actor_kind === "agent" ? "agent" : e.actor_kind === "human" ? "human" : ""}`}>
              {e.actor_kind}
            </span>
            <span className="audit-action">{e.action}</span>
            {e.flagged && <span className="tag danger">{FLAG_LABEL[e.flagged] ?? e.flagged}</span>}
          </div>
          <div className="audit-detail">{e.detail}</div>
          <div className="audit-origin">
            {new Date(e.at).toLocaleTimeString()} · {e.origin}
          </div>
        </div>
      ))}
    </div>
  );
}
