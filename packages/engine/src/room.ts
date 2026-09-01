/**
 * What the auction engine needs from whatever platform it is running on.
 *
 * The engine itself is platform-neutral: the same tested logic backs both the
 * Cloudflare Durable Object adapter and the Node/Cloud Run adapter. Only these
 * six capabilities differ between them.
 */
export interface RoomHost {
  /** Stable identifier for this room. */
  readonly id: string;
  /** HMAC key used to sign bid mandates. */
  readonly secret: string;
  storageGet(key: string): Promise<Record<string, unknown> | undefined>;
  storagePut(key: string, value: unknown): Promise<void>;
  /** Schedule the lot-closing callback for an absolute epoch-ms time. */
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  /** Fan an event out to every connected client. */
  broadcast(event: ServerEvent): void;
}

import {
  type AuctionState,
  type AuditEntry,
  type Bid,
  type BidMandate,
  type BidResult,
  type CeilingRaiseRequest,
  type Lot,
  type PendingConfirmation,
  type ServerEvent,
  enforceMandate,
  fmt,
  headroom,
  sanitizeAlias,
  sanitizeRationale,
  signMandate,
  verifyMandate,
} from "@openfloor/shared";
import {
  ANTI_SNIPE_EXTENSION_SECONDS,
  ANTI_SNIPE_WINDOW_SECONDS,
  LOT_DURATION_SECONDS,
  SEED_LOTS,
} from "./seed.js";

/**
 * One Durable Object instance per auction room.
 *
 * WHY A DURABLE OBJECT: a DO executes one request at a time for a given
 * instance. That makes bid serialization a property of the RUNTIME rather than
 * something we implement with locks — two agents bidding in the same
 * millisecond are processed in a defined order, and "is this still the high
 * bid?" cannot go stale mid-check. In an auction, that race is the whole game.
 */
export class AuctionEngine {
  private lots: Lot[] = [];
  private lotIndex = 0;
  private currentPriceCents = 0;
  private highBidderId: string | null = null;
  private highBidderAlias: string | null = null;
  private lotEndsAt = 0;
  private clockExtended = false;
  private round = 0;

  private bids: Bid[] = [];
  private audit: AuditEntry[] = [];
  private auditSeq = 0;
  private mandates = new Map<string, BidMandate>();
  private aliases = new Map<string, string>();
  private confirmations = new Map<string, PendingConfirmation>();
  private ceilingRequests = new Map<string, CeilingRaiseRequest>();
  private withdrawn = new Set<string>();
  private rateLimit = new Map<string, number[]>();

  private loaded = false;

  constructor(private host: RoomHost) {}

  /**
   * Serialize every request through this room.
   *
   * A Durable Object gets this free: the runtime runs one request at a time per
   * instance, so a bid cannot be read, judged and committed while another bid
   * interleaves. Node does NOT give that — its event loop switches at every
   * `await`, and the bid path awaits inside mandate signature verification,
   * squarely between reading auction state and writing it. Two agents bidding
   * in the same tick could both observe the pre-bid price and both be accepted.
   *
   * This promise chain restores the guarantee explicitly, so the Node adapter
   * has the same correctness property the Durable Object had implicitly. It is
   * a no-op under a Durable Object, which already serializes.
   */
  private chain: Promise<unknown> = Promise.resolve();

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }


  /* ─────────────────────────── persistence ─────────────────────────── */

  private async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.host.storageGet("room");
    if (stored) {
      this.lots = stored.lots as Lot[];
      this.lotIndex = stored.lotIndex as number;
      this.currentPriceCents = stored.currentPriceCents as number;
      this.highBidderId = stored.highBidderId as string | null;
      this.highBidderAlias = stored.highBidderAlias as string | null;
      this.lotEndsAt = stored.lotEndsAt as number;
      this.round = stored.round as number;
      this.bids = stored.bids as Bid[];
      this.audit = stored.audit as AuditEntry[];
      this.auditSeq = stored.auditSeq as number;
      this.mandates = new Map(stored.mandates as [string, BidMandate][]);
      this.aliases = new Map(stored.aliases as [string, string][]);
      this.withdrawn = new Set(stored.withdrawn as string[]);
      // These outlive a hibernation cycle too. A pending confirmation that
      // vanished because the DO slept would leave a human staring at an
      // approval card that no longer resolves to anything.
      this.confirmations = new Map((stored.confirmations ?? []) as [string, PendingConfirmation][]);
      this.ceilingRequests = new Map(
        (stored.ceilingRequests ?? []) as [string, CeilingRaiseRequest][],
      );
      this.clockExtended = Boolean(stored.clockExtended);
    } else {
      this.reset();
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await this.host.storagePut("room", {
      lots: this.lots,
      lotIndex: this.lotIndex,
      currentPriceCents: this.currentPriceCents,
      highBidderId: this.highBidderId,
      highBidderAlias: this.highBidderAlias,
      lotEndsAt: this.lotEndsAt,
      round: this.round,
      bids: this.bids,
      audit: this.audit.slice(-200),
      auditSeq: this.auditSeq,
      mandates: [...this.mandates.entries()],
      aliases: [...this.aliases.entries()],
      withdrawn: [...this.withdrawn],
      confirmations: [...this.confirmations.entries()],
      ceilingRequests: [...this.ceilingRequests.entries()],
      clockExtended: this.clockExtended,
    });
  }

  private reset(): void {
    this.lots = SEED_LOTS.map((l) => ({ ...l }));
    this.lotIndex = 0;
    this.currentPriceCents = this.lots[0].starting_price_cents;
    this.highBidderId = null;
    this.highBidderAlias = null;
    this.lotEndsAt = 0;
    this.clockExtended = false;
    this.round = 0;
    this.bids = [];
    this.audit = [];
    this.auditSeq = 0;
    this.mandates.clear();
    this.aliases.clear();
    this.confirmations.clear();
    this.ceilingRequests.clear();
    this.withdrawn.clear();
  }

  /* ─────────────────────────── state helpers ─────────────────────────── */

  private get currentLot(): Lot | null {
    return this.lots[this.lotIndex] ?? null;
  }

  private secondsRemaining(): number {
    if (!this.lotEndsAt) return 0;
    return Math.max(0, Math.ceil((this.lotEndsAt - Date.now()) / 1000));
  }

  private lotIsOpen(): boolean {
    const lot = this.currentLot;
    return !!lot && lot.status === "open" && this.secondsRemaining() > 0;
  }

  /**
   * Public auction state.
   *
   * Note what is NOT here: the reserve amount (only `reserve_met`), any
   * bidder's mandate or ceiling, and raw errors. Redaction is enforced at this
   * boundary so no call site can accidentally leak by forgetting to strip.
   */
  private snapshot(): AuctionState {
    const lot = this.currentLot;
    return {
      room_id: this.host.id.slice(0, 12),
      lot: lot ? { id: lot.id, title: lot.title, status: lot.status } : null,
      current_price_cents: this.currentPriceCents,
      min_increment_cents: lot?.min_increment_cents ?? 100,
      high_bidder_alias: this.highBidderAlias,
      high_bidder_id: this.highBidderId,
      reserve_met: lot ? this.currentPriceCents >= lot.reserve_cents : false,
      seconds_remaining: this.secondsRemaining(),
      round: this.round,
      bid_count: this.bids.filter((b) => b.lot_id === lot?.id).length,
      clock_extended: this.clockExtended,
    };
  }

  /**
   * What this bidder is on the hook for, across the whole session.
   *
   * A bid is not a spend until the lot closes in your favour — but holding the
   * high bid on a live lot IS exposure, because the hammer could fall at any
   * second. Both count.
   */
  private committedCents(bidderId: string): number {
    let total = 0;
    for (const lot of this.lots) {
      const lotBids = this.bids.filter((b) => b.lot_id === lot.id);
      if (!lotBids.length) continue;

      // Derive the leader from THIS lot's bids. `this.highBidderId` describes
      // only the lot currently on the block, so using it here silently valued
      // every previously-won lot at zero.
      const top = lotBids.reduce((a, b) => (b.amount_cents > a.amount_cents ? b : a));
      if (top.bidder_id !== bidderId) continue;

      // Won lots are owed. A live lot you lead is exposure — the hammer could
      // fall at any second. Passed lots cost nothing.
      if (lot.status === "sold" || lot.status === "open") total += top.amount_cents;
    }
    return total;
  }

  private log(
    entry: Omit<AuditEntry, "id" | "seq" | "at">,
  ): AuditEntry {
    const full: AuditEntry = {
      ...entry,
      id: crypto.randomUUID(),
      seq: ++this.auditSeq,
      at: new Date().toISOString(),
    };
    this.audit.push(full);
    if (this.audit.length > 300) this.audit = this.audit.slice(-300);
    this.host.broadcast({ type: "audit", entry: full });
    return full;
  }

  /**
   * Expire confirmation cards nobody answered.
   *
   * A pending confirmation is a bid held in suspense. If the human walked away,
   * it must resolve to "no" rather than linger — an approval that lands two
   * minutes late would place a bid at a price that has long since moved, which
   * is precisely the surprise the supervised band exists to prevent.
   *
   * Silence is a decline. That is the safe direction, and it is stated in the
   * audit trail so the agent and the human can both see what happened.
   */
  private sweepExpiredConfirmations(): void {
    const now = Date.now();
    for (const [id, c] of [...this.confirmations.entries()]) {
      if (new Date(c.expires_at).getTime() > now) continue;
      this.confirmations.delete(id);
      this.log({
        origin: "system",
        actor: this.aliases.get(c.bidder_id) ?? c.bidder_id,
        actor_kind: "system",
        action: "confirmation_expired",
        detail: `No answer on ${fmt(c.amount_cents)} within the window. Treated as declined.`,
      });
      this.host.broadcast({ type: "confirmation_resolved", id, approved: false });
    }
  }

  /**
   * Token-bucket-ish rate limit: max 8 bid attempts per bidder per 10s.
   * Prevents an agent stuck in a loop from hammering the room.
   */
  private rateLimited(bidderId: string): boolean {
    const now = Date.now();
    const window = (this.rateLimit.get(bidderId) ?? []).filter((t) => now - t < 10_000);
    window.push(now);
    this.rateLimit.set(bidderId, window);
    return window.length > 8;
  }

  /* ─────────────────────────── lot lifecycle ─────────────────────────── */

  private async openLot(): Promise<void> {
    const lot = this.currentLot;
    if (!lot) return;
    lot.status = "open";
    this.currentPriceCents = lot.starting_price_cents;
    this.highBidderId = null;
    this.highBidderAlias = null;
    this.withdrawn.clear();
    this.clockExtended = false;
    this.round += 1;
    this.lotEndsAt = Date.now() + LOT_DURATION_SECONDS * 1000;
    await this.host.setAlarm(this.lotEndsAt);
    this.log({
      origin: "system",
      actor: "auctioneer",
      actor_kind: "system",
      action: "lot_opened",
      detail: `${lot.title} opens at ${fmt(lot.starting_price_cents)}.`,
    });
    this.host.broadcast({ type: "state", state: this.snapshot() });
    await this.persist();
  }

  /**
   * Resolve the lot on the block against its reserve.
   *
   * Shared by the closing alarm and by skipping ahead, so a lot can never be
   * left in an unresolved "open" state with a winner nobody recorded.
   */
  private settleCurrentLot(): boolean {
    const lot = this.currentLot;
    if (!lot || lot.status !== "open") return false;
    const met = this.currentPriceCents >= lot.reserve_cents;
    lot.status = met ? "sold" : "passed";
    return met;
  }

  /** The state frame a client receives the moment it connects. */
  async snapshotEvent(): Promise<ServerEvent> {
    await this.load();
    return { type: "state", state: this.snapshot() };
  }

  /** Alarm handler: the hammer falls. Serialized like any other mutation. */
  async alarm(): Promise<void> {
    return this.serialize(() => this.runAlarm());
  }

  private async runAlarm(): Promise<void> {
    await this.load();
    const lot = this.currentLot;
    if (!lot || lot.status !== "open") return;

    // A late bid may have pushed the end time out (anti-snipe). Re-arm instead.
    if (this.secondsRemaining() > 0) {
      await this.host.setAlarm(this.lotEndsAt);
      return;
    }

    const met = this.settleCurrentLot();

    this.log({
      origin: "system",
      actor: "auctioneer",
      actor_kind: "system",
      action: met ? "lot_sold" : "lot_passed",
      detail: met
        ? `SOLD to ${this.highBidderAlias ?? "nobody"} at ${fmt(this.currentPriceCents)}.`
        : `Passed — reserve not met at ${fmt(this.currentPriceCents)}.`,
    });

    this.host.broadcast({
      type: "lot_closed",
      lot_id: lot.id,
      winner_alias: met ? this.highBidderAlias : null,
      final_price_cents: this.currentPriceCents,
    });
    this.host.broadcast({ type: "state", state: this.snapshot() });
    await this.persist();
  }

  /* ─────────────────────────── bidding ─────────────────────────── */

  /**
   * The single path by which money moves. Every guard lives here, server-side.
   *
   * Deliberate ordering: mandate validity is checked BEFORE auction mechanics,
   * so a forged or expired mandate never receives a reply that leaks live state.
   */
  private async placeBid(body: {
    bidder_id: string;
    lot_id: string;
    amount_cents: number;
    rationale?: string;
    placed_by: "human" | "agent";
    confirmation_id?: string;
    origin: string;
  }): Promise<BidResult> {
    const lot = this.currentLot;
    const base = {
      current_price_cents: this.currentPriceCents,
      min_increment_cents: lot?.min_increment_cents ?? 100,
    };

    if (this.rateLimited(body.bidder_id)) {
      this.log({
        origin: body.origin,
        actor: this.aliases.get(body.bidder_id) ?? body.bidder_id,
        actor_kind: body.placed_by,
        action: "bid_rate_limited",
        detail: "Too many bid attempts in a short window.",
        flagged: "rate_limited",
      });
      return { status: "rejected_rate_limited", message: "Too many bids too quickly. Slow down.", ...base };
    }

    // Withdrawal is binding for the rest of the lot. Without this check an
    // agent could declare itself out and bid again on the next tick, which
    // makes `withdraw_from_lot` decorative. A human may always change their
    // own mind — they are the authority, the agent is not.
    if (body.placed_by === "agent" && this.withdrawn.has(body.bidder_id)) {
      return {
        status: "rejected_not_authorized",
        message:
          "You withdrew from this lot. That is binding until the next lot opens. " +
          "Only your human can re-enter by bidding manually.",
        ...base,
      };
    }

    // A human bidding by hand needs no mandate — they ARE the authority.
    if (body.placed_by === "human") {
      return this.commitBid(body, false, base);
    }

    const mandate = this.mandates.get(body.bidder_id);
    if (!mandate) {
      return {
        status: "rejected_not_authorized",
        message: "No mandate on file. Your human must set one before you can bid.",
        ...base,
      };
    }

    if (!(await verifyMandate(mandate, this.host.secret))) {
      this.log({
        origin: body.origin,
        actor: body.bidder_id,
        actor_kind: "agent",
        action: "mandate_signature_invalid",
        detail: "Mandate failed signature verification and was refused.",
        flagged: "ceiling_blocked",
      });
      return { status: "rejected_not_authorized", message: "Mandate signature invalid.", ...base };
    }

    // Was this exact amount already approved by a human via a confirmation card?
    let humanConfirmed = false;
    if (body.confirmation_id) {
      const c = this.confirmations.get(body.confirmation_id);
      humanConfirmed =
        !!c && c.bidder_id === body.bidder_id && c.amount_cents === body.amount_cents;
      if (humanConfirmed) this.confirmations.delete(body.confirmation_id);
    }

    const outcome = enforceMandate({
      mandate,
      lot_id: body.lot_id,
      amount_cents: body.amount_cents,
      current_price_cents: this.currentPriceCents,
      min_increment_cents: lot?.min_increment_cents ?? 100,
      lot_open: this.lotIsOpen(),
      is_high_bidder: this.highBidderId === body.bidder_id,
      now: new Date(),
      human_confirmed: humanConfirmed,
      committed_cents: this.committedCents(body.bidder_id),
    });

    if (outcome.status === "awaiting_confirmation") {
      const confirmation: PendingConfirmation = {
        id: crypto.randomUUID(),
        bidder_id: body.bidder_id,
        lot_id: body.lot_id,
        amount_cents: body.amount_cents,
        rationale: sanitizeRationale(body.rationale ?? "").value,
        price_at_request_cents: this.currentPriceCents,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
      this.confirmations.set(confirmation.id, confirmation);
      this.log({
        origin: body.origin,
        actor: this.aliases.get(body.bidder_id) ?? body.bidder_id,
        actor_kind: "agent",
        action: "confirmation_requested",
        detail: `Agent wants ${fmt(body.amount_cents)} — above notify threshold. Awaiting human.`,
      });
      this.host.broadcast({ type: "confirmation_required", confirmation });
      await this.persist();
      return { ...outcome, ...base, pending_confirmation_id: confirmation.id };
    }

    if (outcome.status !== "accepted") {
      this.log({
        origin: body.origin,
        actor: this.aliases.get(body.bidder_id) ?? body.bidder_id,
        actor_kind: "agent",
        action: `bid_${outcome.status}`,
        detail: outcome.message,
        flagged: outcome.status === "rejected_ceiling" ? "ceiling_blocked" : undefined,
      });
      return { ...outcome, ...base };
    }

    return this.commitBid(body, humanConfirmed, base);
  }

  /** Actually append the bid. Only reachable after every guard has passed. */
  private async commitBid(
    body: {
      bidder_id: string;
      lot_id: string;
      amount_cents: number;
      rationale?: string;
      placed_by: "human" | "agent";
      origin: string;
    },
    humanConfirmed: boolean,
    base: { current_price_cents: number; min_increment_cents: number },
  ): Promise<BidResult> {
    const lot = this.currentLot;
    if (!lot || !this.lotIsOpen()) {
      return { status: "rejected_closed", message: "This lot is closed.", ...base };
    }

    // Nobody bids against themselves — not agents, and not humans either.
    //
    // enforceMandate() also checks this, but only agent bids go through it:
    // human bids short-circuit straight here because the human IS the authority
    // on spending. Authority over their own money is not authority to run the
    // price up against themselves, so the invariant belongs at the commit point
    // where both paths meet.
    if (this.highBidderId === body.bidder_id) {
      return {
        status: "rejected_not_authorized",
        message: "You already hold the high bid. Bidding against yourself is not allowed.",
        ...base,
      };
    }

    const minimum = this.currentPriceCents + lot.min_increment_cents;
    if (body.amount_cents < minimum) {
      return {
        status: this.highBidderId ? "outbid_in_flight" : "rejected_increment",
        message: `Too low — minimum is now ${fmt(minimum)}.`,
        current_price_cents: this.currentPriceCents,
        min_increment_cents: lot.min_increment_cents,
      };
    }

    const alias = this.aliases.get(body.bidder_id) ?? "Anonymous";
    const rationale = sanitizeRationale(body.rationale ?? "");

    const bid: Bid = {
      id: crypto.randomUUID(),
      lot_id: lot.id,
      bidder_id: body.bidder_id,
      bidder_alias: alias,
      amount_cents: body.amount_cents,
      placed_by: body.placed_by,
      rationale: rationale.value || undefined,
      human_confirmed: humanConfirmed || body.placed_by === "human",
      created_at: new Date().toISOString(),
    };

    this.bids.push(bid);
    this.currentPriceCents = bid.amount_cents;
    this.highBidderId = bid.bidder_id;
    this.highBidderAlias = alias;
    this.withdrawn.delete(body.bidder_id);

    // Anti-sniping: a bid in the closing seconds pushes the clock out, so a
    // late strike cannot win purely on timing. This directly addresses the
    // bid-sniping risk eBay cited when it restricted third-party AI bidding.
    if (this.secondsRemaining() <= ANTI_SNIPE_WINDOW_SECONDS) {
      this.lotEndsAt = Date.now() + ANTI_SNIPE_EXTENSION_SECONDS * 1000;
      this.clockExtended = true;
      await this.host.setAlarm(this.lotEndsAt);
      this.log({
        origin: "system",
        actor: "auctioneer",
        actor_kind: "system",
        action: "clock_extended",
        detail: `Late bid — clock extended by ${ANTI_SNIPE_EXTENSION_SECONDS}s.`,
      });
    }

    this.log({
      origin: body.origin,
      actor: alias,
      actor_kind: body.placed_by,
      action: "bid_placed",
      detail:
        `${fmt(bid.amount_cents)}` +
        (rationale.value ? ` — ${rationale.value}` : "") +
        (bid.human_confirmed && body.placed_by === "agent" ? " [human-approved]" : ""),
      flagged: rationale.flagged ? "injection_attempt" : undefined,
    });

    const state = this.snapshot();
    this.host.broadcast({ type: "bid", bid, state });
    await this.persist();

    return {
      status: "accepted",
      message: `Bid of ${fmt(bid.amount_cents)} accepted. You are the high bidder.`,
      current_price_cents: this.currentPriceCents,
      min_increment_cents: lot.min_increment_cents,
    };
  }

  /* ─────────────────────────── HTTP surface ─────────────────────────── */

  async handle(request: Request): Promise<Response> {
    return this.serialize(() => this.dispatch(request));
  }

  private async dispatch(request: Request): Promise<Response> {
    await this.load();
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "");
    const origin = request.headers.get("Origin") ?? "unknown";

    // Consume the request body exactly once, here, for every method that can
    // carry one — including endpoints that take no arguments.
    //
    // An unread request stream throws "Can't read from request stream after
    // response has been sent" once the response goes out, which kills this
    // object and makes every later request to the room fail with "Network
    // connection lost". Draining it centrally means no handler can reintroduce
    // that failure by forgetting to read its body.
    let raw = "";
    if (request.method !== "GET" && request.method !== "HEAD") {
      raw = await request.text();
    }
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

    // Resolve anything the human left hanging before serving this request.
    this.sweepExpiredConfirmations();

    try {
      switch (`${request.method} ${path}`) {
        case "GET /state":
          return this.json({ state: this.snapshot() });

        case "GET /lot": {
          const lot = this.currentLot;
          if (!lot) return this.json({ error: "No lot" }, 404);
          // Reserve is stripped here — it must never reach a client or an agent.
          const { reserve_cents: _reserve, ...safe } = lot;
          return this.json({ lot: safe });
        }

        case "GET /history": {
          const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 25);
          const lot = this.currentLot;
          const rows = this.bids
            .filter((b) => b.lot_id === lot?.id)
            .slice(-limit)
            .reverse()
            .map((b) => ({
              alias: b.bidder_alias,
              amount_cents: b.amount_cents,
              placed_by: b.placed_by,
              human_confirmed: b.human_confirmed,
              at: b.created_at,
            }));
          return this.json({ bids: rows });
        }

        case "GET /audit":
          return this.json({ entries: this.audit.slice(-60) });

        case "POST /join": {
          const payload = body as unknown as { bidder_id: string; alias: string };
          const clean = sanitizeAlias(payload.alias);
          this.aliases.set(payload.bidder_id, clean.value);
          this.log({
            origin,
            actor: clean.value,
            actor_kind: "human",
            action: "bidder_joined",
            detail: clean.flagged
              ? `Joined with a display name that tripped injection filters. Neutralized and flagged.`
              : `Joined the room.`,
            flagged: clean.flagged ? "injection_attempt" : undefined,
          });
          await this.persist();
          return this.json({ alias: clean.value, flagged: clean.flagged });
        }

        case "POST /mandate": {
          const payload = body as unknown as {
            bidder_id: string;
            ceiling_cents: number;
            notify_above_cents: number;
            total_budget_cents?: number;
            strategy_note?: string;
            auto_bid_enabled?: boolean;
          };
          if (payload.notify_above_cents > payload.ceiling_cents) {
            return this.json({ error: "notify_above_cents must be at or below ceiling_cents" }, 400);
          }
          const unsigned = {
            mandate_id: crypto.randomUUID(),
            bidder_id: payload.bidder_id,
            lot_ids: this.lots.map((l) => l.id),
            ceiling_cents: Math.trunc(payload.ceiling_cents),
            notify_above_cents: Math.trunc(payload.notify_above_cents),
            ...(payload.total_budget_cents !== undefined
              ? { total_budget_cents: Math.trunc(payload.total_budget_cents) }
              : {}),
            auto_bid_enabled: payload.auto_bid_enabled ?? true,
            strategy_note: (payload.strategy_note ?? "").slice(0, 200),
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            created_at: new Date().toISOString(),
          };
          const mandate: BidMandate = {
            ...unsigned,
            signature: await signMandate(unsigned, this.host.secret),
          };
          this.mandates.set(payload.bidder_id, mandate);
          this.log({
            origin,
            actor: this.aliases.get(payload.bidder_id) ?? payload.bidder_id,
            actor_kind: "human",
            action: "mandate_set",
            detail:
              `Ceiling ${fmt(mandate.ceiling_cents)}, confirm above ${fmt(mandate.notify_above_cents)}` +
              (mandate.total_budget_cents !== undefined
                ? `, total budget ${fmt(mandate.total_budget_cents)}.`
                : "."),
          });
          await this.persist();
          return this.json({ mandate });
        }

        case "GET /mandate": {
          const bidderId = url.searchParams.get("bidder_id") ?? "";
          const m = this.mandates.get(bidderId);
          if (!m) return this.json({ mandate: null });
          return this.json({
            mandate: m,
            headroom: headroom(m, this.currentPriceCents, this.committedCents(bidderId)),
          });
        }

        case "POST /bid": {
          const payload = body as unknown as Parameters<AuctionEngine["placeBid"]>[0];
          const result = await this.placeBid({ ...payload, origin });
          return this.json(result);
        }

        case "POST /check-bid": {
          // Dry run. Runs the identical enforcement path as a real bid so the
          // answer cannot drift from what would actually happen, but never
          // commits anything.
          const p = body as unknown as { bidder_id: string; amount_cents: number };
          const lot = this.currentLot;
          const mandate = this.mandates.get(p.bidder_id);
          if (!mandate) {
            return this.json({
              would: "rejected_not_authorized",
              message: "No mandate on file. Your human must set one before you can bid.",
            });
          }
          const outcome = enforceMandate({
            mandate,
            lot_id: lot?.id ?? "",
            amount_cents: Math.trunc(p.amount_cents),
            current_price_cents: this.currentPriceCents,
            min_increment_cents: lot?.min_increment_cents ?? 100,
            lot_open: this.lotIsOpen(),
            is_high_bidder: this.highBidderId === p.bidder_id,
            now: new Date(),
            committed_cents: this.committedCents(p.bidder_id),
          });
          return this.json({
            would: outcome.status,
            message: outcome.message,
            current_price_cents: this.currentPriceCents,
            min_increment_cents: lot?.min_increment_cents ?? 100,
            ...headroom(mandate, this.currentPriceCents, this.committedCents(p.bidder_id)),
          });
        }

        case "POST /withdraw": {
          const payload = body as unknown as { bidder_id: string; lot_id: string; reason?: string };
          this.withdrawn.add(payload.bidder_id);
          const reason = sanitizeRationale(payload.reason ?? "");
          this.log({
            origin,
            actor: this.aliases.get(payload.bidder_id) ?? payload.bidder_id,
            actor_kind: "agent",
            action: "withdrew",
            detail: reason.value || "Out on this lot.",
            flagged: reason.flagged ? "injection_attempt" : undefined,
          });
          await this.persist();
          return this.json({ ok: true });
        }

        case "POST /confirm": {
          const payload = body as unknown as { confirmation_id: string; approved: boolean };
          const c = this.confirmations.get(payload.confirmation_id);
          if (!c) return this.json({ error: "Unknown or expired confirmation" }, 404);
          if (!payload.approved) {
            this.confirmations.delete(payload.confirmation_id);
            this.log({
              origin,
              actor: this.aliases.get(c.bidder_id) ?? c.bidder_id,
              actor_kind: "human",
              action: "confirmation_declined",
              detail: `Human declined the agent's ${fmt(c.amount_cents)} bid.`,
            });
            this.host.broadcast({ type: "confirmation_resolved", id: c.id, approved: false });
            return this.json({ ok: true, placed: false });
          }
          const result = await this.placeBid({
            bidder_id: c.bidder_id,
            lot_id: c.lot_id,
            amount_cents: c.amount_cents,
            rationale: c.rationale,
            placed_by: "agent",
            confirmation_id: c.id,
            origin,
          });
          this.host.broadcast({ type: "confirmation_resolved", id: c.id, approved: true });
          return this.json({ ok: true, placed: result.status === "accepted", result });
        }

        case "POST /ceiling-raise": {
          const payload = body as unknown as {
            bidder_id: string;
            requested_ceiling_cents: number;
            justification: string;
          };
          const m = this.mandates.get(payload.bidder_id);
          if (!m) return this.json({ error: "No mandate" }, 404);
          const req: CeilingRaiseRequest = {
            id: crypto.randomUUID(),
            bidder_id: payload.bidder_id,
            mandate_id: m.mandate_id,
            current_ceiling_cents: m.ceiling_cents,
            requested_ceiling_cents: Math.trunc(payload.requested_ceiling_cents),
            justification: sanitizeRationale(payload.justification).value,
            created_at: new Date().toISOString(),
            status: "pending",
          };
          this.ceilingRequests.set(req.id, req);
          this.log({
            origin,
            actor: this.aliases.get(payload.bidder_id) ?? payload.bidder_id,
            actor_kind: "agent",
            action: "ceiling_raise_requested",
            detail: `Asked to raise ceiling ${fmt(m.ceiling_cents)} to ${fmt(req.requested_ceiling_cents)}. Human decides.`,
          });
          this.host.broadcast({ type: "ceiling_raise_requested", request: req });
          await this.persist();
          return this.json({ request: req });
        }

        case "POST /ceiling-raise/resolve": {
          const payload = body as unknown as { request_id: string; approved: boolean };
          const req = this.ceilingRequests.get(payload.request_id);
          if (!req) return this.json({ error: "Unknown request" }, 404);
          req.status = payload.approved ? "approved" : "declined";
          if (payload.approved) {
            const m = this.mandates.get(req.bidder_id);
            if (m) {
              const unsigned = { ...m, ceiling_cents: req.requested_ceiling_cents } as Omit<BidMandate, "signature">;
              const updated: BidMandate = {
                ...unsigned,
                signature: await signMandate(unsigned, this.host.secret),
              };
              this.mandates.set(req.bidder_id, updated);
            }
          }
          this.log({
            origin,
            actor: this.aliases.get(req.bidder_id) ?? req.bidder_id,
            actor_kind: "human",
            action: payload.approved ? "ceiling_raised" : "ceiling_raise_declined",
            detail: payload.approved
              ? `Human raised the ceiling to ${fmt(req.requested_ceiling_cents)}.`
              : `Human declined to raise the ceiling.`,
          });
          await this.persist();
          return this.json({ ok: true, request: req });
        }

        case "POST /start":
          await this.openLot();
          return this.json({ state: this.snapshot() });

        case "POST /next": {
          // Settle the outgoing lot before moving on. Leaving it "open" left a
          // zombie whose winner was never recorded, so their spend vanished
          // from the session budget.
          this.settleCurrentLot();
          if (this.lotIndex < this.lots.length - 1) {
            this.lotIndex += 1;
            await this.openLot();
          }
          return this.json({ state: this.snapshot() });
        }

        case "POST /reset": {
          this.reset();
          // Cancel the closing alarm too. Without this a reset room keeps a
          // pending alarm that fires against state it no longer describes.
          await this.host.deleteAlarm();
          await this.persist();
          this.host.broadcast({ type: "state", state: this.snapshot() });
          return this.json({ ok: true });
        }

        default:
          return this.json({ error: "Not found" }, 404);
      }
    } catch (err) {
      // Raw error text never reaches an agent — it is a prompt-injection vector
      // and an information leak. Log server-side, return a bounded message.
      console.error("auction-room error", err);
      return this.json(
        {
          status: "indeterminate",
          message: "The server could not complete this action. Do not retry — the outcome is unknown.",
          unsafe_to_retry: true,
        },
        500,
      );
    }
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
