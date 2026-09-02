# Devpost submission text

Paste-ready. The four numbered sections are the ones the rules require; the rest
is the usual Devpost furniture and can be trimmed to fit the form.

---

## Elevator pitch (one line)

An auction where you hand the bidding to an AI — and the AI physically cannot spend more than you allowed.

---

## 1. Why this use case is a strong fit for WebMCP

Because it is the case where getting it wrong costs you immediately.

Most agent demos are reversible. A wrong search wastes a second; a bad draft gets deleted. A live auction is none of those things:

- **It is binding.** A winning bid is a purchase. No undo, no return window.
- **It is too fast for a person.** The clock is 30 seconds. "Ask the human every time" is not an available answer — so the agent needs real autonomy, which means the limits on that autonomy have to be real too.
- **It is adversarial.** Other bidders actively benefit from your agent misbehaving. This is one of the few consumer settings where prompt injection has an obvious paying attacker rather than a hypothetical one.
- **The cost only goes up.** A limit that is slightly wrong compounds instead of settling.

WebMCP fits specifically because the alternative is so much worse. Without it, an agent bids by looking at the screen and clicking — reading prices out of the DOM, guessing which button submits. That is unreliable at any speed and hopeless at auction speed. With WebMCP the page states what it can do in structured form, and the server checks every call.

There is also a timely reason. In February 2026 eBay blocked third-party "buy for me" agents, citing bid-sniping and fraud. But read the policy closely: it does not ban agents on principle — it permits them *with prior approval*. The real problem is that **no mechanism has existed for a site to say "this agent, these actions, this ceiling."** WebMCP's `exposedTo` is exactly that mechanism. OpenFloor is built to be the shape of access that policy says it would allow.

---

## 2. How it creates a better user experience

The honest before-and-after.

**Before, you had two bad options.** Sit there yourself — watching a clock, doing arithmetic against your budget under time pressure, reacting within seconds. People are measurably bad at this. Or hand it to a bidding bot, which is opaque, unbounded, and gives you no control once it starts.

**With OpenFloor you set three numbers and walk away:**

| | |
|---|---|
| **Ask me above** | Below this, your agent bids on its own. Above it, it stops and asks — every time. |
| **Never pass** | A hard maximum for any single bid. |
| **Budget, all lots** | The most you will spend in total, across everything. |

Say $65 / $80 / $150. At $40 it bids without bothering you. At $70 it asks first. At $85 it refuses. And if it already won something for $100, it has $50 left for everything else — because without that third number, an "$80 maximum" across three lots quietly permits $240.

**You do not have to take any of that on trust.** Two things on the page make it concrete rather than claimed:

- **Bid for me** — one button. An agent starts bidding for you, and within seconds it stops and asks permission to go higher. No setup, no second site, no forms.
- **Try to make it overspend** — a box where you write your own instruction telling the agent to ignore its limit. It is sent as the agent's real guidance, a bid far past your limit is really attempted, and you see the server's own refusal verbatim.

That second one matters because "the AI cannot overspend" reads exactly like every guardrail that is really just a sentence in a prompt. So we hand you the attack.

Three things make this feel different in practice:

- **It asks, and it waits.** When it wants to cross your line, a card appears with the amount and the reasoning. Nothing is bid until you agree. Ignore it and it counts as *no* after a minute — silence is never taken as yes.
- **You see what it did, as it did it.** Not a summary written afterwards. Every action, who took it, and whether a person approved it, recorded as it happens.
- **It works with no AI at all.** Open it in Safari and you get a working auction, not a blank page. The agent layer is an addition, never a prerequisite.

---

## 3. What people and agents can do together that was hard or impossible before

**Delegate spending with a limit the agent cannot argue with.**

Almost everyone building agents today writes the guardrail as an instruction: *"you must not spend more than $80."* That is a request, not a constraint. It lives in the same text channel as everything the agent reads, so any web page, any other bidder's display name, any email can argue with it. You are defending money with a sentence.

In OpenFloor the limit lives on the server, behind a signed mandate the agent never holds. **There is no tool, no argument, and no code path by which an agent raises its own ceiling.** It can only ask a person. A test fails the build if anyone ever adds one, so it cannot be quietly broken later.

That flips the security question. Normally you ask *"can the agent be tricked?"* — and the honest answer is always eventually yes. Here you get to ask the better question: *"if it is tricked, what can it actually do?"* Nothing it could not already do.

**And: two websites that trust each other by name.**

The floor and the bidder console are separate origins. The console's agent can use the floor's tools because the floor named it in `exposedTo` — not because they share a codebase, and not because someone pasted an API key. We did not assume this worked. We measured it in a real browser: an allowed origin reached **7 tools** and used them; the identical page served from a non-allowed origin reached **zero**.

That is a real trust boundary between two sites, declared in code and enforced by the browser. It is the part of the standard almost nobody uses, because it is the hardest part — and it is the part that makes "let an agent act for me across sites" safe enough to actually mean something.

---

## 4. Technical explanation of the WebMCP implementation

**The API, used directly.** `document.modelContext.registerTool(...)` with no wrapper library, plus a `navigator.modelContext` fallback because Chrome is mid-migration between the two names. Ten tools on the floor, three on the console.

**Tool surface (floor):** read state, read the lot, read bid history, *check* a bid without placing it, place a bid, withdraw, read your mandate, set your mandate, request a ceiling raise, read your own activity. Tools carry `readOnlyHint` and `untrustedContentHint` where they apply, and every schema is bounded — a startup assertion fails the process if any name, description or output exceeds the spec's character budget.

**Cross-origin.** Auction tools are published with `exposedTo` naming the console's origin. Mandate tools deliberately are not — so a remote page can bid *within* your limits but can never touch the limits themselves. The bridge is a hidden `<iframe allow="tools">`, which turns out to be required and undocumented: without it the cross-origin path silently returns nothing and tells you nothing.

**Graceful degradation, three layers**, detected at runtime: cross-origin WebMCP, same-origin only, or none at all. The last is a fully working manual auction. Detection compares the local and remote tool *sets*, because `getTools()` echoes your own tools back — an early version declared success on any non-empty result and was therefore wrong every time.

**Enforcement is server-side, always.** A mandate is HMAC-signed over a canonical field order. Every bid re-checks it in a fixed sequence: amount validity → expiry → auto-bid enabled → lot authorized → **ceiling** → **total budget** → lot open → self-bid → increment → notify threshold. The agent's own arithmetic is never trusted, and the server returns the real reason for each refusal so the agent behaves coherently instead of retrying blindly.

**Concurrency.** Requests are serialized per room through an explicit promise chain, so simultaneous bids resolve in a defined order. A test fires fifty at once and asserts exactly one wins and the other forty-nine get an accurate reason.

**Against prompt injection.** Display names and rationales are sanitized, wrapped in an explicit untrusted-content envelope, and flagged in the audit trail. The real defense is structural, though: a completely successful injection still cannot overspend, because the ceiling is checked somewhere the agent cannot reach.

**Rival agents get no privileged path.** Ada, Rex and Nia bid through the same public HTTP route as everyone else — same mandate check, same ceiling, same rate limit, same audit entries. A house bot allowed to cheat would invalidate every other claim here. Their behaviour differs deliberately: research on multi-agent collusion (arXiv 2507.01413) found shared identity raises coordination propensity, so heterogeneity is a safety property, not decoration. There is no bidder-to-bidder channel at all, by design.

**Stack.** TypeScript throughout, React on both front ends, and a shared package holding the mandate logic and tool schemas so client and server cannot drift. Deployed on Google Cloud Run — one image, three roles — with GitHub Actions running typecheck, unit, integration and concurrency suites as a gate before any deploy.

**Both origins are registered in Chrome's WebMCP origin trial**, so visitors need no flag and no restart. Verified in a clean, stock Chrome 151: WebMCP present, 10 tools on the floor, 3 on the console. The trial runs to 17 November 2026.

---

## Challenges we ran into

The interesting ones were all cases where something *looked* fine and wasn't.

- **Our own cross-origin test lied to us.** It reported the allowlist was enforced — but it pointed at a port serving nothing, so "blocked" really meant "nothing loaded." It now asserts the denied page actually loads before judging its access.
- **Capability detection was wrong in a way mocks could not catch.** It declared full cross-origin support whenever `getTools()` returned anything, which is always, because it echoes your own tools. Every mocked test passed against wrong logic. Only a real browser found it.
- **The live demo had no bids for most of its uptime.** Looping the catalogue cleared every stored mandate, silently de-authorizing every bidder including the rivals. The refusal was never logged, so a live clock ticked over an empty room. Found by watching the deployed site, not by testing it.
- **One lot could never be bid on by anyone.** Agents get less eager as a sale wears on — but that restraint was carried between lots as a cash figure rather than a share of the current lot's value. After a $90 camera they were pinned near $92, and the $280 watch opens at $120. It passed every single time.
- **Four places where Chrome differs from the written spec**, including that `getTools()` returns a promise rather than a list — which made our first origin-trial check report zero tools when ten were registered.

---

## Accomplishments we're proud of

- A spending limit that is **structural rather than instructed**, with a test that fails the build if anyone ever adds a way around it.
- A **measured** cross-origin trust boundary: 7 tools from an allowlisted origin, 0 from an identical non-allowlisted one.
- **187 automated tests**, including fifty simultaneous bids, every price against every persona, and an injected instruction to bid $99,999.99 that gets clamped back to the ceiling.
- Findings worth contributing back: four documented Chrome-versus-spec differences, including two where **our own testing was the thing that was wrong**.

---

## What we learned

That the hard part of agent safety is not the model. It is deciding where the limit lives. Put it in the prompt and it is a suggestion; put it behind a signature the agent never holds and it becomes a fact.

And that a passing test suite is not evidence a feature works. Three of the four real bugs here passed every test we had, and were found by opening the site and looking at it.

---

## What's next

- Persistence, so accounts and auction state survive a restart.
- A seller-side agent, so both sides of the negotiation are represented.
- Measuring the ChatGPT in-app browser. OpenAI's documentation says it does not see tools inside embedded frames, which is how the cross-origin path works — so we expect the single-page experience to work there and the multi-site one not to. We have not measured it, and would rather say so than guess.

---

## Try it

- **Auction floor:** https://openfloor-floor-101078802199.us-central1.run.app
- **Bidder console:** https://openfloor-bidder-101078802199.us-central1.run.app
- **Code:** https://github.com/aniket-3001/openfloor

No sign-up and no flag to enable. Open the floor and bid by hand, or open both and let an agent do it.
