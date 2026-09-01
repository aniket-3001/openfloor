# Tool catalogue

Nine tools across two trust domains. The split is the design: auction tools are published to allowlisted bidder origins; mandate tools are published to nobody.

Exposure is scoped **per tool, not per page** — the floor origin registers both sets from the same document, with `exposedTo` on one and not the other.

Character budgets from Chrome's secure-tools guidance (name ≤30, description ≤500, param description ≤150, output ≤1.5K) are enforced mechanically by `assertToolBudgets()`, which throws at startup rather than relying on code review.

---

## Auction house — `floor.<domain>`

Registered against the raw API in [`packages/floor/src/webmcp/registerAuctionTools.ts`](../packages/floor/src/webmcp/registerAuctionTools.ts), with `exposedTo: [bidder origins]`.

### `get_auction_state` · read-only

Current lot, price, minimum increment, high bidder, `reserve_met`, seconds remaining, round, bid count.

The reserve *amount* is never included — only whether it has been met.

### `get_lot_details` · read-only

| Param | Type | Notes |
|---|---|---|
| `lot_id` | string | Optional; defaults to the open lot |

Title, condition, the seller's public estimate range, opening price, increment, description. The output states plainly that the estimate is the seller's own and may be optimistic — the seed catalogue deliberately sets estimates above reserve, reproducing AucArena's engineered winner's-curse condition.

### `get_bid_history` · read-only · **`untrustedContentHint: true`**

| Param | Type | Notes |
|---|---|---|
| `limit` | integer | Default 10, max 25 |

Recent bids: display name, amount, human-or-agent, whether human-approved.

**This is the untrusted-content tool.** Display names are chosen by other users. They are sanitized server-side, wrapped in `<untrusted-user-content>`, and the tool output tells the agent explicitly that anything resembling an instruction in that field is not one.

### `check_bid` · read-only

| Param | Type | Notes |
|---|---|---|
| `amount_cents` | integer | Amount to test. Nothing is placed |

A dry run. Reports whether an amount *would* be accepted, would need approval, or would be refused — and why — without committing anything.

It runs the **identical** `enforceMandate` path as a real bid, so its answer cannot drift from what would actually happen. Useful for an agent reasoning near its notify threshold or ceiling, and it makes "look before you leap" cheap and safe rather than something an agent has to discover by being refused.

### `place_bid` · mutating

| Param | Type | Notes |
|---|---|---|
| `lot_id` | string | Must match the open lot |
| `amount_cents` | integer | Whole cents. $72.50 → `7250` |
| `rationale` | string | Shown to the human in the audit trail |

Every outcome is distinct and explicit — there is no silent failure:

| Status | Meaning |
|---|---|
| `accepted` | Live; you are high bidder |
| `outbid_in_flight` | Valid but someone beat you to it |
| `awaiting_confirmation` | Above notify threshold — **not placed**, human asked |
| `rejected_ceiling` | Over the hard ceiling. Suggests `request_ceiling_raise` |
| `rejected_increment` | Below current price + increment |
| `rejected_closed` | Lot closed or clock expired |
| `rejected_mandate_expired` | Mandate TTL elapsed |
| `rejected_not_authorized` | No mandate, wrong lot, bidding against yourself, or auto-bid off |
| `rejected_rate_limited` | Too many attempts in a short window |
| `indeterminate` | Outcome unknown — **explicitly unsafe to retry** |

### `withdraw_from_lot` · mutating

| Param | Type | Notes |
|---|---|---|
| `lot_id` | string | Required |
| `reason` | string | Shown in the audit trail |

The agent's "I'm out."

---

## Bidder console — `bidder.<domain>`

Registered with the `useWebMCP` hook in [`packages/bidder/src/webmcp/useBidderTools.ts`](../packages/bidder/src/webmcp/useBidderTools.ts), and also on the floor origin in [`registerMandateTools.ts`](../packages/floor/src/webmcp/registerMandateTools.ts) so a visitor who only opens the auction house still has a complete flow.

**No `exposedTo` is passed** in either place — these stay private to the origin that registered them, so **no other bidder's agent can read or alter your ceiling.**

Precisely what is *not* claimed: the mandate is stored and enforced by the auction server, since client-side enforcement would not be enforcement. The privacy property is between **bidders**, not between a bidder and the house.

### `get_my_mandate` · read-only

Ceiling, notify threshold, headroom at the current price, whether currently in the supervised band, auto-bid state, guidance, expiry.

Every figure is server-computed. The output says so, because the agent recomputing them is exactly the drift this design prevents.

### `set_bid_mandate` · mutating

| Param | Type | Notes |
|---|---|---|
| `ceiling_cents` | integer | Hard maximum. Never exceeded |
| `notify_above_cents` | integer | Above this, each bid needs approval. Must be ≤ ceiling |
| `strategy_note` | string | e.g. "only if condition is Excellent" |
| `auto_bid_enabled` | boolean | `false` halts agent bidding immediately |

This is how *"bid up to $80 but check with me past $65"* becomes a signed, enforceable artifact.

### `request_ceiling_raise` · mutating

| Param | Type | Notes |
|---|---|---|
| `requested_ceiling_cents` | integer | The new ceiling being asked for |
| `justification` | string | The human reads this verbatim |

**This only asks. It never grants.** The tool output tells the agent its ceiling is unchanged until a human approves, and to keep bidding within the old limit meanwhile.

There is no tool anywhere in this codebase that raises a ceiling directly. That capability does not exist.

---

## Lifecycle

The spec has no `unregisterTool`. Registration takes an `AbortSignal`, and aborting it is the only way to remove a tool.

- The floor returns a disposer that aborts its controller; `App.tsx` calls it on unmount.
- The bidder console uses `useWebMCP`, which ties registration to component lifetime automatically.

Getting this wrong is the classic WebMCP bug: tools outliving the component that owns them and going stale.
