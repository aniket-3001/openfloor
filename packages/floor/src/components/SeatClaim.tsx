import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

/**
 * Claiming a seat.
 *
 * Every visitor is already seated — an identity is minted on first contact, so
 * there is no signup wall and no empty state to get past. This exists for the
 * one thing that anonymity cannot do: pick the same seat up again on another
 * device, or after clearing cookies.
 *
 * So it is deliberately not a login. There is nothing to log in to until you
 * decide there is, and the wording says "keep this seat" rather than "sign up"
 * because that is honestly what it does — your bids, limits and history are
 * already yours, and this only makes them portable.
 */
export function SeatClaim({
  me,
  onClaimed,
}: {
  me: { alias: string; handle: string | null };
  onClaimed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  // Dismiss on an outside click or Escape, like any other menu on the page.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const out = await api.claimSeat(handle.trim(), passphrase);
      if (out.error) {
        setError(out.error);
        return;
      }
      setPassphrase("");
      setOpen(false);
      onClaimed();
    } catch {
      setError("Could not reach the saleroom. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Already claimed: there is nothing to do here, so offer no controls.
  if (me.handle) {
    return <span className="who">{me.handle}</span>;
  }

  return (
    <div className="seat" ref={box}>
      <button
        type="button"
        className="who who-button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {me.alias} <span className="seat-caret" aria-hidden="true" />
      </button>

      {open && (
        <div className="seat-pop" role="dialog" aria-label="Keep this seat">
          <p className="seat-lede">
            You are already bidding as <strong>{me.alias}</strong>. Choose a name and passphrase to
            pick this seat up on another device.
          </p>
          <form onSubmit={submit}>
            <label className="seat-label" htmlFor="seat-handle">
              Name
            </label>
            <input
              id="seat-handle"
              className="seat-input"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="lowercase, 3–24 characters"
              autoComplete="username"
              spellCheck={false}
            />
            <label className="seat-label" htmlFor="seat-pass">
              Passphrase
            </label>
            <input
              id="seat-pass"
              className="seat-input"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="at least 6 characters"
              autoComplete="current-password"
            />
            {error && <p className="seat-error">{error}</p>}
            <button type="submit" className="seat-submit" disabled={busy || !handle || !passphrase}>
              {busy ? "Keeping…" : "Keep this seat"}
            </button>
          </form>
          <p className="seat-foot">
            If the name is already taken, the passphrase has to match. Nothing else is stored, and
            this is a demonstration — do not reuse a real password.
          </p>
        </div>
      )}
    </div>
  );
}
