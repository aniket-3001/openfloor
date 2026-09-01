# Architecture

## Origins and trust

| Origin | Role | Registers | Exposure |
|---|---|---|---|
| `floor.<domain>` | Auction house. Owns lot state, clock, bid ledger. | 5 auction tools | `exposedTo: [bidder origins]` |
| `bidder.<domain>` | The human's cockpit. Mandate, live feed, confirmations. | 3 mandate tools | **private** |
| `rival.<domain>` | Rival consoles (Ada / Rex / Nia). Same code, different personas. | 3 mandate tools | **private** |

Subdomains are distinct origins, so this is a genuine cross-origin boundary. Locally, distinct ports achieve the same thing without DNS.

**The asymmetry is deliberate and load-bearing.** The auction house publishes its mechanics to bidders it has authorized. Bidders publish nothing. No bidder-to-bidder path exists in either direction.

## Why a single-threaded room

> **Note:** production runs on Google Cloud Run via `packages/server`. The
> Durable Object adapter in `packages/worker` still exists and still works, but
> the reasoning below is what the Node adapter had to reproduce explicitly —
> see [`DEPLOYMENT.md`](DEPLOYMENT.md).

### The original Durable Object argument

A DO executes one request at a time per instance. Bid serialization therefore comes from the runtime rather than from application locking:

- Two agents bidding in the same millisecond are ordered deterministically.
- "Am I still the high bidder?" cannot go stale between check and commit.
- The anti-snipe clock extension and the bid append happen in the same single-threaded turn.

In an auction, that race *is* the game. Getting it right with optimistic concurrency and retries would be considerably more code and considerably less certain.

## Request flow for a bid

```
agent calls place_bid (WebMCP tool, bidder origin)
        │
        ▼
tool execute() → POST /api/bid   (cross-origin, CORS-allowlisted)
        │
        ▼
Worker → Durable Object (single-threaded turn)
        │
        ├─ rate limit check
        ├─ mandate lookup + HMAC verification
        ├─ enforceMandate():
        │     expiry → auto-bid enabled → lot authorized
        │     → CEILING (hard wall)
        │     → lot open → not self-bidding → increment
        │     → notify threshold (supervised band)
        ├─ commit: append bid, advance price, extend clock if late
        ├─ append audit entry
        └─ broadcast over WebSocket
        │
        ▼
bounded, redacted result → agent
```

Ordering is deliberate: **mandate validity is checked before auction mechanics**, so a forged or expired mandate never receives a reply that leaks live auction state.

## Money

Integer cents everywhere. No floats. A rounding error in an auction is a real defect, and language models are unreliable at decimal arithmetic.

**Agents never do money arithmetic at all.** Headroom, current price, and minimum increment are computed server-side and injected into the agent's observation. This is AucArena's "auctioneer corrects the bidder's sums" insight taken further — the agent chooses strategy, the server owns every number. Combined with the server-enforced ceiling, a hallucinating agent cannot overspend even when its reasoning is wrong.

## The four-stage agent loop

| Stage | Trigger | Produces |
|---|---|---|
| Plan | Lot opens | Fair value, walk-away price, priority, strategy |
| Bid | State change | `bid` / `hold` / `out` / `request_raise` + rationale |
| Belief update | After a bid resolves | Server's authoritative figures replace the agent's view |
| Replan | Lot closes | Revised appetite carried into the next lot |

When a model is available it *advises* this policy rather than replacing it. Its suggested number is clamped by walk-away and ceiling in code before anything is sent — which is what makes an injected instruction inert rather than merely discouraged.

Without an API key the deterministic policy carries the auction unchanged. The demo degrades; it does not break.

## Capability probing

```
detectCapability([FLOOR_ORIGIN])
  ├─ no document.modelContext (or navigator.modelContext) → L3, manual UI
  ├─ present, getTools({fromOrigins}) returns tools        → L1, cross-origin
  └─ present, cross-origin discovery empty or throws       → L2, same-origin
```

The detected layer is rendered in the UI on both apps. Deprecated surfaces (`provideContext`, `clearContext`, `unregisterTool`) are deliberately not probed — they were removed from the spec, and reaching for them would be a correctness bug rather than a compatibility win.

## State

Durable Object storage holds lots, bids, audit ledger, mandates, and aliases, trimmed to bounded sizes. Clients receive state over WebSocket with a slow REST poll alongside purely to recover from a silently dropped socket.

The client never advances price or clock on its own. A local one-second tick smooths the countdown display between server frames and only ever counts *down* toward a server-provided end time.
