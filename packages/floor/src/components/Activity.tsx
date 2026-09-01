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
export function Activity({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) {
    return <div className="empty">Nothing yet.</div>;
  }

  return (
    <div className="feed">
      {[...entries].reverse().map((e) => (
        <div key={e.id} className={`feed-row ${e.flagged ? "flagged" : ""}`}>
          <div className="feed-top">
            <span className="feed-who">{e.actor}</span>
            {e.actor_kind !== "system" && <span className="chip">{e.actor_kind}</span>}
            {e.flagged && <span className="chip flag">{FLAG_LABEL[e.flagged] ?? e.flagged}</span>}
            <span className="feed-when">{new Date(e.at).toLocaleTimeString()}</span>
          </div>
          <div className="feed-detail">{e.detail}</div>
        </div>
      ))}
    </div>
  );
}
