# OpenFloor

**Your agent bids. You set the limits. Everything on the record.**

A WebMCP-native live auction house where each bidder delegates to their own AI agent, bounded by a mandate the agent *structurally cannot exceed*, with every action on a public audit trail.

Built for the [WebMCP Challenge](https://webmcp.devpost.com/).

## Live

| | |
|---|---|
| **Auction floor** | https://openfloor-floor-101078802199.us-central1.run.app |
| **Bidder console** | https://openfloor-bidder-101078802199.us-central1.run.app |

Three Google Cloud Run services on three genuinely distinct origins. **Verified L1 cross-origin in Chrome 151 against the live deployment** — see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) and [`docs/BROWSER_VERIFICATION.md`](docs/BROWSER_VERIFICATION.md).

Open the floor in Chrome 149+ with `chrome://flags/#enable-webmcp-testing`, or in ChatGPT's in-app browser. Any other browser gets a fully working manual auction.

New here? [**USER_GUIDE.md**](docs/USER_GUIDE.md) explains the site in plain language, and [**FEATURES.md**](docs/FEATURES.md) lists what was built and what actually works.

Three rival agents — Ada, Rex and Nia — bid continuously against each other in the live room, so the auction is running whenever you arrive. They bid through the ordinary public path, with the same mandate checks, ceilings and audit entries as anyone else.

---

## The problem

There are two ways to bid in a live auction today, and both are bad.

**Sit there yourself.** Watch a countdown, do arithmetic against your budget under time pressure, react in seconds. People are measurably bad at this — in AucArena ([arXiv 2310.05746](https://arxiv.org/abs/2310.05746)), GPT-4-Turbo beat human bidders specifically under unpredictable ordering, exactly where attention and mental arithmetic are stressed.

**Hand it to a bot.** Opaque, unbounded, and as of February 2026, [banned on eBay](https://www.pymnts.com/artificial-intelligence-2/2026/ebay-blocks-use-of-ai-buy-for-me-agents/) — which cited bid-sniping and fraud risk directly.

OpenFloor is the third option: **bounded, auditable delegation.** Your agent has real autonomy inside a band you set, stops and asks the moment it wants to leave that band, cannot exceed your hard ceiling under any circumstances, and leaves a complete record.

Crucially, eBay's policy does not ban agentic bidding on principle — it bans *unauthorized, unreviewable* bidding, and explicitly permits agent access with prior approval. WebMCP's `exposedTo` is a page declaring in code which agents it authorizes. **OpenFloor's trust model is the shape of access eBay's own policy says it would allow, not the shape it just banned.**

---

## The core idea

```
$0 ─────────── notify_above ─────────── ceiling ──────────► ∞
   agent bids freely    you approve each bid    IMPOSSIBLE
   (autonomous band)    (supervised band)       (hard wall)
```

You say: *"Bid for me on the Leica, up to $80, but check with me before you pass $65 — and don't spend more than $150 all evening."*

- Below **$65** the agent bids on its own judgement.
- Between **$65 and $80** every single bid raises a confirmation card and waits for you.
- Above **$80** is not a policy, it is a wall. There is **no tool anywhere in this codebase that lets an agent raise its own ceiling.** The most it can do is call `request_ceiling_raise` and ask you.

The ceiling bounds a **single bid**. A separate optional **session budget** bounds total spend across every lot — without it, an $80 ceiling across three lots quietly permits $240, which is not what a person means by "up to $80".

Enforcement is server-side against a signed mandate. A hallucinating agent, a prompt-injected agent, or a tampered client all hit the same wall.

---

## Architecture

Three genuinely separate origins. Subdomains are distinct origins, so this is a real cross-origin boundary rather than a same-page simulation.

```
┌──────────────────────────┐      ┌──────────────────────────┐
│ bidder.<domain>          │      │ rival.<domain>           │
│  PRIVATE mandate tools:  │      │  (Ada / Rex / Nia)       │
│   get_my_mandate         │      │  PRIVATE mandate tools   │
│   set_bid_mandate        │      │                          │
│   request_ceiling_raise  │      │  4-stage bidding loop    │
└──────────┬───────────────┘      └──────────┬───────────────┘
           │  getTools({fromOrigins})        │
           │  executeTool(...)               │
           ▼                                 ▼
┌────────────────────────────────────────────────────────────┐
│ floor.<domain> — auction house                             │
│  AUCTION TOOLS, exposedTo: [bidder origins]                │
│   get_auction_state · get_lot_details · get_bid_history    │
│   check_bid · get_my_activity · place_bid                  │
│   withdraw_from_lot                                        │
│  MANDATE TOOLS, no exposedTo — private to this origin      │
└──────────┬─────────────────────────────────────────────────┘
           │ WebSocket + REST (authoritative)
           ▼
┌────────────────────────────────────────────────────────────┐
│ Cloudflare Worker + Durable Object                         │
│  serialized bids · mandate enforcement · hidden reserve    │
│  anti-snipe extension · audit ledger · LLM proxy           │
└────────────────────────────────────────────────────────────┘
```

**The trust asymmetry is the point.** Exposure is scoped **per tool, not per page**. The seven auction tools carry `exposedTo` and are reachable by allowlisted bidder origins. The three mandate tools carry no `exposedTo` at all, so **no other bidder's agent can read or alter your ceiling** — and there is **no bidder-to-bidder channel of any kind**, which per [arXiv 2507.01413](https://arxiv.org/abs/2507.01413) is the single most effective known mitigation against LLM-agent collusion.

To be precise about what is *not* claimed: the mandate is stored and enforced by the auction server, because client-side enforcement would not be enforcement at all. The privacy property here is between **bidders**, not between a bidder and the house.

**Why a Durable Object:** a DO processes one request at a time per instance, so bid serialization is a property of the runtime rather than something implemented with locks. Two agents bidding in the same millisecond are ordered deterministically, and "am I still the high bidder?" cannot go stale mid-check.

---

## How WebMCP is used

Both integration paths are shown deliberately.

**Raw API** — [`packages/floor/src/webmcp/registerAuctionTools.ts`](packages/floor/src/webmcp/registerAuctionTools.ts):

```js
await modelContext.registerTool({
  name: "place_bid",
  description: "Place a bid on the current lot on your human's behalf...",
  inputSchema: {
    type: "object",
    properties: {
      lot_id:       { type: "string",  description: "Lot being bid on." },
      amount_cents: { type: "integer", description: "Bid amount in whole cents." },
      rationale:    { type: "string",  description: "One line explaining why." }
    },
    required: ["lot_id", "amount_cents"]
  },
  annotations: { readOnlyHint: false, untrustedContentHint: false },
  execute: async ({ lot_id, amount_cents, rationale }) => { /* server re-validates */ }
}, { signal: controller.signal, exposedTo: BIDDER_ORIGINS });
```

**React hook** — [`packages/bidder/src/webmcp/useBidderTools.ts`](packages/bidder/src/webmcp/useBidderTools.ts), using GoogleChromeLabs' [`use-webmcp-tool`](https://github.com/GoogleChromeLabs/use-webmcp-tool). The hook ties the `AbortSignal` to component unmount, which matters because **the spec has no `unregisterTool`** — aborting the registration signal is the only way to remove a tool.

Details worth noting:
- `untrustedContentHint: true` on `get_bid_history`, because bidder display names are attacker-controlled text entering every agent's context.
- Tool text is held under Chrome's provisional budgets (name ≤30, description ≤500, param description ≤150, output ≤1.5K) — enforced mechanically by `assertToolBudgets()`, which throws at startup rather than relying on review.
- Every mutating call is re-validated server-side. Agent arguments are untrusted input, never authority.
- Outputs are bounded and redacted: no reserve amounts, no other bidders' mandates, no raw server errors.

---

## Browser support — measured, not assumed

WebMCP is new and unevenly implemented, so rather than trust the spec, this project **probes a real browser** and records what it finds. Full results in [`docs/BROWSER_VERIFICATION.md`](docs/BROWSER_VERIFICATION.md).

**Measured in Chrome 151: L1, full cross-origin.** A bidder origin discovers and invokes the floor's tools across a real `exposedTo` boundary, including mutating ones — and a non-allowlisted origin serving the identical app reaches **zero** of them.

Three findings the mocked tests could not have produced:

1. **`executeTool` wants a JSON string, not an object.** Passing an object fails with "Failed to parse input arguments", which reads like a schema error but is a serialization one. The spec IDL says `optional object inputObject`; the shipped behavior differs.
2. **`getTools({fromOrigins})` only reaches origins present in the frame tree.** With no frame, it returns the *local* tools whatever you pass — a bogus origin included. So the bidder console mounts a hidden `<iframe allow="tools">` (`mountToolBridge()`); without it L1 is unreachable in any browser.
3. **That second finding exposed a bug in our own detection.** `detectCapability` keyed off "getTools returned something", which is always true — so it would have reported L1 everywhere and the UI would have claimed a boundary that was never crossed. Now it compares tool sets, with a regression test pinning the real Chrome behavior.

The runtime still degrades, and still reports the layer it is actually running at:

| Layer | Condition | Behavior |
|---|---|---|
| **L1** | Cross-origin `executeTool` works | Bidder agents call the floor across a real `exposedTo` boundary |
| **L2** | Cross-origin blocked, same-origin WebMCP works | Identical `getTools`/`executeTool` path, same-origin |
| **L3** | No WebMCP | Full manual-bidding UI — never a blank page |

**To see the agent demo:** Chrome 149+ with `chrome://flags/#enable-webmcp-testing`, or ChatGPT's in-app browser. Any other browser gets a fully working manual auction.

ChatGPT's in-app browser is a separate, non-Chromium implementation and remains **unmeasured** — which is the main reason the fallback ladder stays.

## Running it locally

```bash
npm install
cp .dev.vars.example .dev.vars     # set MANDATE_SECRET
npx wrangler dev --port 8123        # the auction house API
npm run dev:floor                   # http://localhost:5173
npm run dev:bidder                  # http://localhost:5174
```

Distinct ports are distinct origins, so the cross-origin path is exercised locally without DNS.

To stage a bid war, run additional consoles with different personas:

```bash
VITE_PERSONA=rex npm run dev -w @openfloor/bidder -- --port 5175
VITE_PERSONA=nia npm run dev -w @openfloor/bidder -- --port 5176
```

`ANTHROPIC_API_KEY` is optional. Without it, agents fall back to their deterministic policy and the auction still runs — it simply runs without model-driven bidding. Keys live in Worker secrets and never reach the client bundle.

---

## The bidding agent

A four-stage loop, after AucArena: **Plan → Bid → Belief Update → Replan** ([`packages/bidder/src/agent/policy.ts`](packages/bidder/src/agent/policy.ts)).

Two findings from that paper shaped this directly:

1. **A trivial rule-based bidder (fixed cap, flat 10% increments) beat most naively-prompted LLMs**, and removing the planning stages measurably degraded results. A one-shot "call the model when the price changes" policy doesn't look like an agent; it looks like a loop with a language model bolted on.

2. **The auctioneer corrects the bidder's arithmetic** before errors compound — likened in the paper to a human bidder using a notebook. OpenFloor goes further: **the agent never does money arithmetic at all.** Headroom, current price, and minimum increment are computed server-side and injected. The agent chooses strategy; the server owns every number.

When a model is available it *advises* a bounded policy rather than replacing it. Its suggested number is clamped to the walk-away and ceiling before anything is sent — which is what makes an injected instruction in a rival's display name inert.

Rival personas use different temperaments and prompts rather than N clones, because [arXiv 2507.01413](https://arxiv.org/abs/2507.01413) found shared model identity measurably increased coordination propensity between agents. Prompts are deliberately neutral: the same paper found urgency framing sustained collusive coordination even under active oversight.

---

## Security

Full threat model in [`docs/SECURITY.md`](docs/SECURITY.md). In brief:

- **Indirect prompt injection** is the headline threat, and the demo includes a live attempt. Defenses layer: `untrustedContentHint`, server-side sanitization, an explicit `<untrusted-user-content>` envelope — and the real backstop, which is that **even a fully successful injection cannot cause an overspend**, because the ceiling is enforced server-side against a signed mandate the agent cannot modify.
- **Collusion**: no bidder-to-bidder channel exists by architecture. The residual risk — public bid history is itself a low-bandwidth signaling surface — is disclosed rather than claimed solved.
- **Anti-sniping**: a bid inside the final 10 seconds extends the clock, addressing the concern eBay named.
- **Hidden reserve**: only `reserve_met` (a boolean) ever leaves the server.

---

## Testing

**179 tests across three suites**, all passing.

```bash
npm run test              # 102 unit tests (node + jsdom)
npm run typecheck

npx wrangler dev --port 8123
npm run test:integration  # 52 end-to-end tests against a live Durable Object
npm run test:live         # 25 live-behaviour tests (~2 min, waits on real time)

npm run verify            # typecheck + unit + build
```

**Unit (102)** — the security-critical logic. All three mandate bands and every rejection path; signature tampering and canonical-form stability; injection signatures including hidden-codepoint smuggling; tool budgets; the agent's decision policy; WebMCP layer detection; and nine jsdom render tests.

Three assert properties that are the whole point of the project, mechanically, so a future edit that breaks one fails CI rather than shipping:

- **No tool anywhere can raise a ceiling.**
- **`decide()` never proposes a bid above the ceiling** — swept across the full price range for every persona, rather than checked by example.
- **A model advising a bid of `9999999` is clamped to the ceiling** — the injection scenario, proving the model advises a bounded policy rather than driving it.

**Integration (52)** — what unit tests cannot reach: serialization, persistence, rate limiting, and the redaction boundary. Includes regressions for every defect found during testing.

**Live (25)** — WebSocket fan-out, CORS as the HTTP mirror of the `exposedTo` allowlist, the LLM proxy's keyless fallback, and the auction clock: it waits out a real countdown, fires a genuine last-second bid, and verifies the anti-snipe extension actually moves the clock and that the Durable Object alarm closes the lot consistently with the reserve.

The L3 promise is tested rather than assumed — the floor is rendered with **no** `document.modelContext` and asserted to show a working auction, the countdown, manual bidding, and an explanation of how to enable WebMCP. A companion test asserts the trust asymmetry at runtime: `place_bid` registers **with** `exposedTo`, `set_bid_mandate` registers **without** it.

## Honest limitations

- **All settlement is simulated.** No payment is taken, no goods change hands.
- **Demo scenario parameters are tuned for pacing** — short clocks, tight increments, estimates set above reserve — so a bid war is watchable in under three minutes. The mechanics are real; the staging is deliberate.
- **Cross-origin `executeTool` is probed, not assumed.** If your browser cannot do it, the UI says so.
- The mandate signature check is defence-in-depth against storage tampering; mandates are held server-side and are not client-supplied.

---

## Repository layout

```
packages/
  shared/   types, mandate signing + enforcement, tool schemas, sanitizers
  worker/   Durable Object auction engine, REST + WebSocket, LLM proxy
  floor/    auction house origin — raw registerTool integration
  bidder/   bidder console origin — useWebMCP hook, 4-stage agent
docs/       ARCHITECTURE, SECURITY, TOOLS, DEMO_SCRIPT
```

## License

MIT — see [LICENSE](LICENSE).
