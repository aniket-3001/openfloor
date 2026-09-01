# From prior art to design decisions

Every non-obvious decision in OpenFloor traces to something found during the prior-art study. This document is the audit trail for that, both so the reasoning is reviewable and because "we read the literature and it changed the build" is only credible if you can point at the changes.

Sources studied in depth are written up in `../../WEBMCP_PRIOR_ART_DEEP_DIVE.md`.

---

## AucArena — arXiv 2310.05746

*LLM agents bidding in English ascending auctions. The closest academic prior art.*

| Finding | What it changed | Where |
|---|---|---|
| Agents run a **Planning → Bidding → Belief Update → Replanning** loop; ablating the planning stages measurably degraded results | The bidder agent implements all four stages rather than deciding per-tick | `packages/bidder/src/agent/policy.ts`, `useAgent.ts` |
| **A trivial rule-based bidder (fixed cap, flat 10% increments) beat most naively-prompted LLMs** | Settled the core agent design: a model *advises* a bounded deterministic policy instead of driving bidding. Also why the loop wasn't shortcut to one-shot prompting | `decide()` / `decideWithModel()` |
| The auctioneer **corrects the bidder's arithmetic** before errors compound ("a notebook or calculator") | Taken further: agents do **no** money arithmetic. Headroom, price and increment are computed server-side and injected | `headroom()`, `AgentObservation` |
| Only **English ascending** auctions were tested | Chose ascending over sealed-bid, so the findings transfer without reinterpretation — and it is the more watchable format | `docs/ARCHITECTURE.md` |
| Winner's curse engineered by showing estimates **~10% above true value** | Seed lots deliberately set estimates above reserve, so an agent that believes the estimate overpays | `packages/worker/src/seed.ts` |
| Different models produced distinct temperaments (GPT-4 conservative, Mistral-7B aggressive) | Rival personas are differentiated by valuation, aggression and patience rather than being reskins | `personas.ts` |
| GPT-4-Turbo beat humans under **unpredictable ordering** | Became the "why delegate at all" argument in the README and demo narration | `README.md` |

## LLM agent collusion — arXiv 2507.01413

*Whether LLM agents tacitly collude in auction markets.*

| Finding | What it changed | Where |
|---|---|---|
| **Any direct agent-to-agent channel is the primary enabler** — without one, supracompetitive pricing does not persist past ~10 rounds | The architecture has **no bidder-to-bidder channel at all**. `exposedTo` allowlists bidders to call the *house*, never each other; mandate tools carry no `exposedTo` | `registerAuctionTools.ts`, `registerMandateTools.ts` |
| **Shared model identity increased coordination propensity** | Rival agents use different prompts and temperaments, never N clones of one policy | `personas.ts` |
| **Urgency framing sustained collusion even under active oversight** | Bidder prompts are deliberately neutral — no "win at all costs" language. An engineering decision with a citation, not a style preference | `decideWithModel()` system prompt |
| Convergence still occurred from **observing shared public state**, with no messaging | Disclosed as a residual risk rather than claimed solved: the public bid history is itself a low-bandwidth signalling surface | `docs/SECURITY.md` §2 |
| Their setup was a *double* auction with colluding sellers | Scope mismatch stated explicitly — ours inverts to a bidder-ring risk, so mechanisms transfer but market structure does not | `docs/SECURITY.md` §2 |

## Google AP2 (Agent Payments Protocol)

*Mandate architecture for agent-initiated payments.*

| Finding | What it changed | Where |
|---|---|---|
| **IntentMandate**: human-confirmed, signed, expiring, constraint-carrying | `BidMandate` mirrors that shape — signed, TTL'd, scope-limited, human-set | `packages/shared/src/mandate.ts` |
| `intent_expiry` TTL | Mandates expire; `rejected_mandate_expired` is a distinct outcome | `enforceMandate()` |
| AP2 is **additive** over existing tool-calling infrastructure | Lets us name the design lineage honestly ("IntentMandate-shaped") without claiming conformance we did not build | `README.md`, `mandate.ts` header |
| AP2 has **never implemented a multi-round competitive auction**, even in its own samples — "competitive sourcing" is single-shot quote comparison | Confirmed the novelty claim rather than undermining it | `WEBMCP_PRIOR_ART_DEEP_DIVE.md` |

## eBay's AI-agent policy, Feb 2026

*The dominant consumer auction platform banning third-party buy-for-me agents.*

| Finding | What it changed | Where |
|---|---|---|
| Ban cites **bid-sniping** specifically | Anti-snipe clock extension: a bid inside the final 10s extends the clock | `commitBid()` |
| Ban is **not absolute** — agents are permitted *with prior approval* | The central pitch framing: `exposedTo` is a page declaring which agents it authorizes, so this is the shape of access eBay says it would allow | `README.md` |
| Cites fraud and **mistaken purchases** | Motivates the supervised band and mandatory confirmation above a human-set line | two-tier ceiling |
| eBay's own proxy bidding is a plain server-side max-bid algorithm, not agentic | Kept the novelty claim honest: we are not reimplementing proxy bidding | `WEBMCP_PRIOR_ART_DEEP_DIVE.md` |

## Chrome WebMCP secure-tools guidance

| Finding | What it changed | Where |
|---|---|---|
| Canonical injection shape: a field carrying `<important>SYSTEM INSTRUCTION…</important>` | Built as a live demo beat, with `sanitizeAlias` tested against exactly that payload | `sanitize.ts`, `sanitize.test.ts` |
| `untrustedContentHint` for user-generated content | Set on `get_bid_history`, the one tool carrying attacker-controlled text | `schemas.ts` |
| `readOnlyHint` so agents can reason about which calls need confirmation | Set correctly on all eight tools, asserted in tests | `schemas.test.ts` |
| Provisional character budgets (name ≤30, description ≤500, param ≤150, output ≤1.5K) | Enforced **mechanically** at startup by `assertToolBudgets()`, which throws rather than relying on review | `schemas.ts` |
| Oversized tool text degrades guardrails | `boundOutput()` caps every tool response | `sanitize.ts` |
| Tools are private by default; `exposedTo` allowlists origins | The entire trust architecture | both register files |
| Safety inside an LLM cannot be guaranteed, only mitigated | Set the tone for `SECURITY.md`: layers 1–5 reduce blast radius, layer 6 (the server-enforced ceiling) is the one that actually holds | `docs/SECURITY.md` |

## vercel/shop PR #498

*A real WebMCP retrofit onto a production storefront.*

| Finding | What it changed | Where |
|---|---|---|
| Re-validate tool inputs **server-side**; never trust agent arguments | Every mutating tool re-validates in the Durable Object | `placeBid()` |
| Deliberately **redact** tool outputs (no IDs, checkout URLs, payment data, raw errors) | Redaction enforced at the `snapshot()` boundary; hidden reserve never leaves the server; raw errors never forwarded | `snapshot()`, catch block |
| Report ambiguous mutations as **unsafe to retry** rather than retrying | The `indeterminate` status with `unsafe_to_retry: true`, and tool text telling the agent to re-read state | `types.ts`, `registerAuctionTools.ts` |
| `AbortSignal` cleanup on unmount | Both registration paths return disposers tied to component lifetime | both register files |

## 638Labs MCP auction server

*The one shipped agent-bidding implementation found.*

| Finding | What it changed |
|---|---|
| Theirs is **sealed-bid**, B2B, agents bidding to *do work* | Confirmed the differentiation: OpenFloor is ascending/English, consumer-facing, agents bidding to *buy on a human's behalf*. Also confirmed we chose the harder and more watchable format |
| Static tool descriptions carry no runtime signal (price, latency, track record) | Reinforced surfacing live state through read-only tools rather than baking assumptions into descriptions |

---

## Decisions that came from research rather than instinct

Stated plainly, because this is the part worth defending in review:

1. **The four-stage loop exists because a dumb baseline beat naive prompting.** Without AucArena we would have shipped one-shot prompting and it would have looked like a bot.
2. **Agents do no arithmetic** — a direct escalation of AucArena's belief-correction step.
3. **No inter-agent channel** is a citable structural mitigation, not an accident of architecture.
4. **Neutral prompts** are a safety control with evidence behind them.
5. **Heterogeneous personas** serve collusion resistance first, demo interest second.
6. **Anti-sniping** exists because eBay named sniping when restricting agent bidding.
7. **The mandate is IntentMandate-shaped** because a live, multi-partner protocol had already solved that shape.
8. **The residual signalling risk is disclosed** because the paper found convergence without messaging, and claiming otherwise would be false.
