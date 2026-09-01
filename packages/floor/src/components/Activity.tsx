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
export function Activity({ entries, limit = 12 }: { entries: AuditEntry[]; limit?: number }) {
  if (!entries.length) {
    return <div className="empty">Nothing yet.</div>;
  }

  // Bounded by count rather than by a scrollbox: the page is the scroll
  // surface, and a nested one crowds the column and traps the wheel.
  const shown = [...entries].reverse().slice(0, limit);

  return (
    <div className="feed">
      {shown.map((e) => (
        <div key={e.id} className={`feed-row ${e.flagged ? "flagged" : ""}`}>
          <div className="feed-body">
            <span className="feed-who">{e.actor}</span>{" "}
            <span className="feed-detail">{e.detail}</span>
            {e.flagged && <span className="chip flag">{FLAG_LABEL[e.flagged] ?? e.flagged}</span>}
          </div>
          <time className="feed-when" dateTime={e.at}>
            {new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        </div>
      ))}
    </div>
  );
}
