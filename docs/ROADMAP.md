# Roadmap

Features are ordered by how much they strengthen the core proposition — *bounded, auditable delegation* — not by how easy they are. Anything that does not make delegation safer, clearer, or more useful is left out deliberately.

---

## Tier 1 — closes real gaps in the promise

### 1. ~~Cross-lot budget mandates~~ — SHIPPED

**Shipped.** `total_budget_cents` now bounds total exposure across the session, enforced server-side and included in the signed mandate. What follows is the original write-up, kept because it explains why it mattered.

**The gap this closed was real and had shipped.** A mandate's `ceiling_cents` is enforced **per bid**, not per session. A bidder with an $80 ceiling across three lots can win all three at $80 each and spend $240. The ceiling is honest about each individual bid and silent about the total, which is not what "up to $80" means to a person.

Design:

```ts
interface BidMandate {
  ceiling_cents: number;          // per-lot cap (existing)
  total_budget_cents?: number;    // NEW: hard cap across the whole session
  lot_priorities?: Record<string, 1 | 2 | 3>;  // NEW: 3 = must win, 1 = drop if tight
}
```

- Enforcement gains a `committed_cents` running total in the Durable Object; `enforceMandate` refuses when `committed + amount > total_budget_cents`.
- The agent's Plan stage already emits priority scores 1–3 — this is exactly AucArena's multi-item allocation design, which the current single-lot loop under-uses. Wiring `lot_priorities` in makes the Replan stage genuinely meaningful: after overpaying on lot 1, appetite for lot 2 must actually fall.
- New tool: `get_budget_status` (read-only) — committed, remaining, lots left.

**Why first:** it makes the agent's job an allocation problem rather than a threshold problem, which is both the more interesting demo and the more honest reading of the promise on the tin.

### 2. Away-mode policy

Confirmations currently expire as declines after 60s (safe, and now enforced). But "I stepped away" and "I said no" are different intents, and conflating them means an unattended auction is simply lost.

- `on_timeout: "decline" | "hold_and_extend" | "auto_approve_below"` on the mandate.
- `auto_approve_below_cents` — a third, narrower band: *pre-authorized while away*, still under the hard ceiling.
- Browser Notifications API when a confirmation is raised and the tab is hidden.
- An explicit "I'm away" toggle that switches policy in one click.

**Why:** delegation matters most precisely when you are not watching. Right now the design implicitly assumes you are.

### 3. Seller-side agent

Today the seller is a static reserve number. Making the seller a participant doubles the human+agent surface and turns this into a genuine two-sided market.

- Seller console (a third origin) with its own private tools: `get_lot_performance`, `set_reserve`, `accept_current_bid`, `pass_lot`.
- The seller's agent advises — "bidding has stalled $12 under reserve with 20s left; recommend accepting" — and the human decides.
- Same guardrails, mirrored: a seller's agent cannot drop the reserve past a human-set floor.

**Why:** the strongest version of the pitch is two humans, each with an agent, transacting through a structured surface neither could scrape. This is the feature that gets there.

---

## Tier 2 — strengthens the product

### 4. Settlement summary and signed audit export

- Post-auction receipt: what you won, what you spent, which bids were agent-placed vs. human-approved.
- `GET /api/receipt` returning an HMAC-signed record of the session.
- `export_audit_trail` tool so an agent can hand its human a verifiable account of its own conduct.

**Why:** "everything on the record" currently means a scrolling panel. A signed, exportable record is what makes that claim inspectable after the fact.

### 5. Ask-your-agent

A `explain_last_decision` read-only tool: why it held, why it withdrew, what it thinks the lot is worth now.

The four-stage log already surfaces this passively; making it queryable lets the *human* interrogate the agent conversationally mid-auction, which is the collaboration direction currently missing (right now information flows agent → human only).

### 6. Concurrent rooms and a lobby

Multiple simultaneous auctions, one mandate per room, a lobby view. Mostly plumbing — the DO is already per-room — but needed before any real multi-user use.

---

## Tier 3 — worthwhile, not yet load-bearing

- **Watchlist and alerts** — notify when a lot matching stated interests opens.
- **Bid analytics** — how often the agent's ceiling bound, average paid vs. estimate, how often humans overrode.
- **Replay mode** — scrub a completed auction for demos and dispute review.
- **Mandate presets** — "cautious / normal / determined" as starting points.

---

## Explicitly not planned

- **Real payments.** Settlement stays simulated. Doing this properly means PCI scope and a payments partner, and it would add nothing to what the project demonstrates.
- **Bidder-to-bidder messaging.** Ever. The absence of that channel is the structural collusion mitigation (`docs/SECURITY.md` §2) — adding chat would trade away the strongest safety property for a feature nobody asked for.
- **Fully autonomous end-to-end bidding with no human in the loop.** That is the thing eBay banned, and the thing this project exists to offer an alternative to.

---

## Engineering work outstanding (not features)

| Item | Why it matters |
|---|---|
| Chrome origin-trial token | Needed for WebMCP on a deployed origin without the local flag |
| Verify in ChatGPT's in-app browser | A separate, non-Chromium implementation. Its docs state iframe tools are never discovered, so L1 cannot work there on any host — the single-origin path is what applies |
| DO storage growth | `bids` grows unbounded per room; `audit` is already trimmed to 300. Needs the same bound before any long-running use |
| Demo video | Script is written (`DEMO_SCRIPT.md`); needs recording |
| Devpost gallery re-check | Was unpublished during the prior-art study; worth a final look before submitting |

---

## Known limitations, stated plainly

1. **`bids` array grows unbounded** in a long-lived room.
2. **`wrangler dev` on Windows wedges** under rapid back-to-back requests to one DO; the integration suite paces itself to work around it. Deployed Workers are unaffected.
3. **Rate limiting is per-instance and in memory** — it resets on restart.
4. **Cross-origin WebMCP is probed, never assumed.** The UI reports the layer actually in use.
