# Deployment — Google Cloud Run

Live:

| Service | URL |
|---|---|
| **Auction floor** | https://openfloor-floor-101078802199.us-central1.run.app |
| **Bidder console** | https://openfloor-bidder-101078802199.us-central1.run.app |
| **API** | https://openfloor-api-101078802199.us-central1.run.app |

Three Cloud Run services in project `openfloor-webmcp-2026`, region `us-central1`. Each service gets its own hostname, so these are three genuinely distinct web origins — which is what the cross-origin WebMCP architecture requires.

---

## Why Cloud Run, and what had to change

The auction engine was originally a Cloudflare Durable Object. A DO runs one request at a time per instance, which made bid serialization correct *by construction*: a bid could not be read, judged and committed while another interleaved.

Node gives no such guarantee. Its event loop switches at every `await`, and the bid path awaits inside mandate signature verification — squarely between reading the price and writing the bid. Two agents bidding in the same tick could both observe the pre-bid price and both be accepted.

Two things restore it:

1. **An explicit promise chain in the engine** (`serialize()`), making the critical section atomic on any runtime.
2. **`--max-instances=1`** on the API service, so a room lives in exactly one process and there is no cross-instance race to lose.

`scripts/concurrency.mjs` exists to prove this rather than assert it: ten simultaneous identical bids yield exactly one acceptance, fifty concurrent bids produce strictly-ordered distinct prices, and a concurrent stampede cannot cross a ceiling. It passes against the deployed service, over real network latency.

The auction logic itself is untouched — `packages/engine` is platform-neutral and shared by both the Durable Object adapter (`packages/worker`) and the Node adapter (`packages/server`). Only storage, alarms, fan-out and identity differ.

## One image, three roles

The same container serves the API, the floor, or a bidder console, selected by environment variables. Byte-identical images mean a behavioural difference between origins can only come from configuration, never from build drift.

| Variable | Purpose |
|---|---|
| `OPENFLOOR_ROLE` | `api` \| `floor` \| `bidder` |
| `STATIC_DIR` | Which SPA to serve (relative — see the path gotcha below) |
| `MANDATE_SECRET` | HMAC key. **Required for `api` only** — a static-serving instance is not given the signing key |
| `ALLOWED_ORIGINS` | CORS allowlist; the HTTP mirror of `exposedTo` |
| `PUBLIC_API_BASE` | API origin handed to the browser at runtime |
| `PUBLIC_BIDDER_ORIGINS` | Origins the floor exposes its tools to (`exposedTo`) |
| `PUBLIC_FLOOR_ORIGIN` | Floor origin the bidder bridges into its frame tree |
| `PUBLIC_ROOM`, `PUBLIC_PERSONA` | Room name and bidder persona |
| `OPENFLOOR_RIVALS` | Personas to run server-side, e.g. `ada,rex,nia`. API role only |

The API service runs with `--min-instances=1` so the rival loop stays alive; scale-to-zero would stop the auction whenever nobody was watching, which defeats the point of arriving to a live room.

## Two bugs the first deploy exposed

Both were invisible locally and would have shipped silently.

### 1. Build-time config never arrived

`gcloud run deploy --set-build-env-vars` feeds **buildpacks**, not Docker `--build-arg`. Building from a Dockerfile, every `VITE_*` value compiled to `""`.

Nothing crashed. Vite inlines `import.meta.env` at build time, so the bundles were pinned to empty strings and the failure was quiet and misleading:

- The floor fell back to its own origin and **talked to itself** — its own in-process auction room, not the API service. It looked like it worked.
- `exposedTo` still listed `localhost`, so cross-origin discovery silently failed.
- The bidder's API base was `""`, producing `Failed to construct 'URL': Invalid URL` inside a tool result.

**Fix — runtime configuration.** The server generates `/config.js` from its own environment, and the SPA reads `window.__OPENFLOOR_CONFIG__` with `import.meta.env` as a local-dev fallback. One image now runs anywhere, and the origins a page trusts are a deployment decision rather than a compile-time one.

### 2. The probe called a broken deployment a success

`scripts/browser-probe.mjs` reported **L1** against that broken deploy. Two flaws:

- **It treated "did not throw" as success.** `executeTool` resolves even when the tool itself failed — the result carries `isError: true`. The reported "successful" call was actually returning `Failed to construct 'URL': Invalid URL`.
- **It counted any returned tools as cross-origin success.** The calling page has its own tools, so a non-empty list proves nothing. It was seeing the bidder's own three mandate tools and calling that a crossed boundary.

Both fixed: the probe now parses `isError`, and only counts tool names **absent from the local set** as remote. Under the stricter probe the broken deployment fails and the fixed one passes — which is the only way to know the pass means anything.

## Verified on the deployment

| Suite | Result |
|---|---|
| Integration (56) | pass |
| Live — WebSocket/WSS, clock, anti-snipe, alarm (25) | pass |
| Concurrency / serialization (9) | pass |
| Real-Chrome probe | **L1 cross-origin** |

The probe against production HTTPS reached **6 remote tools** from the bidder origin — `check_bid`, `get_auction_state`, `get_bid_history`, `get_lot_details`, `place_bid`, `withdraw_from_lot` — and invoked one, receiving live auction state.

The three mandate tools did **not** cross. That is the trust asymmetry holding on production HTTPS: auction tools published to an allowlisted origin, mandate tools published to nobody.

## Reproducing

```bash
gcloud auth login
gcloud projects create <project> && gcloud config set project <project>
gcloud billing projects link <project> --billing-account=<id>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
N=$(gcloud projects describe <project> --format='value(projectNumber)')
API="https://openfloor-api-$N.us-central1.run.app"
FLOOR="https://openfloor-floor-$N.us-central1.run.app"
BIDDER="https://openfloor-bidder-$N.us-central1.run.app"

# Cloud Run URLs are predictable from the project number, so all three can be
# configured up front — there is no chicken-and-egg between origins.

gcloud run deploy openfloor-api --source . --region=us-central1 --allow-unauthenticated \
  --max-instances=1 --timeout=3600 \
  --set-env-vars="^@^OPENFLOOR_ROLE=api@MANDATE_SECRET=$SECRET@ALLOWED_ORIGINS=$FLOOR,$BIDDER"

gcloud run deploy openfloor-floor --source . --region=us-central1 --allow-unauthenticated \
  --set-env-vars="^@^OPENFLOOR_ROLE=floor@STATIC_DIR=static/floor@PUBLIC_API_BASE=$API@PUBLIC_BIDDER_ORIGINS=$BIDDER@PUBLIC_ROOM=main"

gcloud run deploy openfloor-bidder --source . --region=us-central1 --allow-unauthenticated \
  --set-env-vars="^@^OPENFLOOR_ROLE=bidder@STATIC_DIR=static/bidder@PUBLIC_API_BASE=$API@PUBLIC_FLOOR_ORIGIN=$FLOOR@PUBLIC_ROOM=main"
```

Three gotchas worth knowing:

- **`^@^` delimiter.** `ALLOWED_ORIGINS` contains a comma, which gcloud otherwise reads as an env-var separator.
- **Relative `STATIC_DIR`.** Under Git Bash on Windows, MSYS rewrites a leading-slash value into a Windows path — `/app/static/floor` arrived in the container as `C:/Program Files/Git/app/static/floor`. A relative path resolved against the working directory is shell-independent.
- **No `--omit=optional` or `--ignore-scripts` in the image build.** esbuild ships its binary as a platform-specific optional dependency installed by a lifecycle script; omitting either fails with *"The package @esbuild/linux-x64 could not be found"* when the lockfile came from Windows.
