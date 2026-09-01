# Real-browser verification

Everything else in this repo tests WebMCP against mocks. This document records what was measured against an actual browser, and where the shipped implementation differs from the written spec.

**Environment:** Chrome `151.0.7922.174`, Windows 11, launched with a throwaway profile and driven over the Chrome DevTools Protocol. Reproduce with:

```bash
# The Node server is the deployment target; the Durable Object adapter still
# exists but is no longer what runs in production.
MANDATE_SECRET=dev npm run dev -w @openfloor/server   # :8080
npm run dev:floor      # http://localhost:5173
npm run dev:bidder     # http://localhost:5174

npm run probe          # API surface, registration, L1/L2/L3
npm run probe:exec     # executeTool call contract, fromOrigins semantics
npm run probe:exposed  # does exposedTo actually enforce?
```

No Puppeteer or Playwright — Node 22 ships a `WebSocket`, and CDP is HTTP plus a socket.

---

## Verdict

| Claim | Status |
|---|---|
| `document.modelContext` exists in Chrome 151 | **Confirmed** |
| Surface is exactly `registerTool` / `getTools` / `executeTool` | **Confirmed** |
| No deprecated `provideContext` / `unregisterTool` | **Confirmed** |
| All 9 of our tools register, `exposedTo` accepted | **Confirmed** |
| `executeTool` invokes a real tool and returns its content | **Confirmed** |
| Cross-origin discovery reaches another origin's tools | **Confirmed — but only via a frame** |
| Cross-origin `executeTool` invokes a remote tool | **Confirmed** |
| Cross-origin **mutation** (`place_bid`) works | **Confirmed** |
| **`exposedTo` blocks a non-allowlisted origin** | **Confirmed** |
| Server-side mandate enforcement holds across the origin boundary | **Confirmed** |

**Measured layer: L1 (cross-origin).** This was previously an assumption the architecture rested on. It is now a measurement.

---

## Finding 1 — `executeTool` takes a JSON **string**, not an object

The spec IDL reads `executeTool(RegisteredTool tool, optional object inputObject, ...)`. Chrome 151 rejects an object:

| Call | Result |
|---|---|
| `executeTool(tool, {})` | `UnknownError: Failed to parse input arguments` |
| `executeTool(tool, undefined)` | `UnknownError: Failed to parse input arguments` |
| `executeTool(tool, null)` | `UnknownError: Failed to parse input arguments` |
| `executeTool(tool)` | `TypeError: 2 arguments required, but only 1 present` |
| `executeTool("get_auction_state", {})` | `TypeError: The provided value is not of type 'RegisteredTool'` |
| `executeTool({name: "..."}, {})` | `TypeError: Failed to read the 'description' property from 'RegisteredToolDeprecated'` |
| **`executeTool(tool, JSON.stringify(args))`** | **works** |

Two things worth noting. The error wording ("failed to parse input arguments") reads like a schema-validation failure, which sends you looking in the wrong place — the argument is fine, the *serialization* is wrong. And the tool object must be the exact instance returned by `getTools()`; a hand-built `{name}` is rejected, with the error mentioning a `RegisteredToolDeprecated` interface that suggests the shape is still in flux.

Encoded in `callTool()` in `packages/shared/src/webmcp.ts`, with tests.

## Finding 2 — `fromOrigins` only reaches origins in the frame tree

Measured from `http://localhost:5174` with no frame of the floor present:

| Call | Returned |
|---|---|
| `getTools()` | the page's own 3 tools |
| `getTools({fromOrigins: [floor]})` | the page's own 3 tools |
| `getTools({fromOrigins: [self]})` | the page's own 3 tools |
| `getTools({fromOrigins: ["https://nope.example"]})` | the page's own 3 tools |
| `getTools({fromOrigins: []})` | the page's own 3 tools |

The argument made no difference — even a bogus origin returned the local set.

Then the floor was loaded into an `<iframe allow="tools">` and the call repeated:

| | Returned |
|---|---|
| `getTools()` | still the local 3 — frame tools do **not** leak into the default listing |
| `getTools({fromOrigins: [floor]})` | **all 9**, including `place_bid` and `get_auction_state` |

So cross-origin discovery is real, but the remote origin must be present as a descendant navigable. This matches the spec's non-normative "observation" walk over descendant navigables, and it is not obvious from the IDL alone.

**Consequence for this project:** the bidder console mounts a hidden `<iframe allow="tools">` pointing at the floor (`mountToolBridge()`). Without it, L1 is unreachable no matter what the browser supports.

## Finding 3 — a bug this exposed in our own capability detection

`detectCapability` previously declared **L1** whenever `getTools({fromOrigins})` returned a non-empty array. Given Finding 2, that array is *never* empty — it always contains the local tools. So the check would have reported L1 in every WebMCP browser, and **the UI would have claimed a cross-origin boundary that was never crossed.**

The sound test is a set comparison: cross-origin succeeded only if tools came back that the local listing does not contain. Fixed, with a regression test that pins the exact Chrome behavior.

This is the clearest argument for running this probe at all. The mocked tests all passed against a detection function that was wrong about reality.

## Finding 4 — `exposedTo` is genuinely enforced

The security story rests on the floor's tools being reachable by allowlisted bidder origins and nobody else. Prior runs only showed the allowlisted case working, which demonstrates exposure, not restriction.

Controlled experiment — the floor allowlists ports 5174 and 5175; the **identical** bidder app was also served on **5176**, outside the allowlist. Same code, same machine, same browser, same bridge frame. The only variable is the origin.

| Origin | On allowlist | Own tools visible | Floor tools reached |
|---|---|---|---|
| `localhost:5174` | yes | 3 | **9** — including `place_bid` |
| `localhost:5176` | **no** | 3 | **0** |

The denied page loaded correctly and had its own three mandate tools, so the empty result is a genuine block rather than a page that failed to load. An earlier version of this probe used `127.0.0.1:5174`, which Vite does not serve — it reported "enforced" purely because nothing loaded. That was a false positive, and the probe now asserts the denied page loaded before trusting the result.

## Finding 5 — defense in depth holds across the boundary

A cross-origin `place_bid` of `999999` cents from the allowlisted origin invoked successfully and was then **refused by the server**:

```
{"content":[{"type":"text","text":"No mandate on file. Your human must set one before you can bid."}]}
```

The tool call crossed the origin boundary; the spend did not. Transport working is not authorization — which is the whole point of enforcing the mandate server-side rather than in the tool.

## Finding 6 — a robustness bug in our own tool output

During probing, `check_bid` returned:

```
If you bid $50.00: undefined
```

The API client swallowed a failed request into `{}`, and the tool interpolated the missing field straight into agent-facing text. An agent has no way to distinguish that from a real verdict — silent empties become confident nonsense in a model's context.

Fixed in two places: the client now throws on an empty or non-JSON response instead of returning `{}`, and the tool refuses to render a verdict it does not have, telling the agent to re-read state rather than assume the bid is allowed.

---

## ChatGPT's in-app browser — documented, not measured

Not measured here, but OpenAI documents a decisive limitation that changes what the demo can claim in that browser.

**Tools inside iframes are not discovered — same-origin or cross-origin.** OpenAI's WebMCP documentation states this plainly and directs developers to "register tools via JavaScript in the top-level page instead." `exposedTo`, `getTools`, `executeTool` and `fromOrigins` do not appear anywhere in it; the docs defer to the spec and Chrome's guide for "the broader APIs."

Consequences:

- **The L1 path cannot work in ChatGPT's browser on any host.** `mountToolBridge()` makes the floor reachable by loading it in an `<iframe allow="tools">` — precisely the mechanism ChatGPT does not observe. This is a property of that browser, not of where the app is deployed.
- **The single-origin path works fine.** The floor registers all nine tools at the top level, mandate tools included, so a visitor there can set a mandate, bid, and answer confirmation cards without any frame involved.

So the demo has two honest halves:

| Browser | What works |
|---|---|
| Chrome 149+ | Full L1 — cross-origin discovery, invocation and mutation across `exposedTo` (measured above) |
| ChatGPT in-app | Top-level tools on a single origin; rival agents driven by the deployed backend rather than by cross-origin tool calls |

Claiming cross-origin agent-to-agent bidding inside ChatGPT's browser would be false, and the UI's layer indicator will show L2 there rather than pretending otherwise.

## Still not verified

- **Live measurement in ChatGPT's in-app browser.** The above is from OpenAI's documentation, not a probe. Requires the desktop app and a GPT-5.6 Sol/Terra session.
- ~~Deployed cross-origin over HTTPS on real subdomains.~~ **Now verified.** Re-probed against the live Google Cloud Run deployment: the bidder origin reached **6 remote tools** on the floor origin (`check_bid`, `get_auction_state`, `get_bid_history`, `get_lot_details`, `place_bid`, `withdraw_from_lot`) and invoked one, receiving live auction state. The three mandate tools did NOT cross — the trust asymmetry holds on production HTTPS. See [`DEPLOYMENT.md`](DEPLOYMENT.md).
- **Behavior of Chrome's own built-in agent.** The spec notes it uses an internal observation step rather than `getTools`/`executeTool`, so what a real agent sees may differ from what in-page JS sees.
- ~~Deployed cross-origin over HTTPS on real subdomains.~~ **Now verified.** Re-probed against the live Google Cloud Run deployment: the bidder origin reached **6 remote tools** on the floor origin (`check_bid`, `get_auction_state`, `get_bid_history`, `get_lot_details`, `place_bid`, `withdraw_from_lot`) and invoked one, receiving live auction state. The three mandate tools did NOT cross — the trust asymmetry holds on production HTTPS. See [`DEPLOYMENT.md`](DEPLOYMENT.md).
- **Behavior of Chrome's own built-in agent.** The spec notes it uses an internal observation step rather than `getTools`/`executeTool`, so what a real agent sees may differ from what in-page JS sees.
