/**
 * Bidder-console WebMCP tools, registered with the official `useWebMCP` hook
 * from GoogleChromeLabs' `use-webmcp-tool`.
 *
 * The auction house registers its tools against the raw API instead (see
 * packages/floor/src/webmcp/registerAuctionTools.ts). Both paths are shown
 * deliberately — the raw call is what the spec actually defines, and the hook
 * is what most React codebases should reach for, because it ties the
 * AbortSignal to component unmount and there is no `unregisterTool` to fall
 * back on if you get that wrong.
 *
 * THESE TOOLS ARE NOT EXPOSED. No `exposedTo` is passed, so they stay private
 * to the origin that registered them: no other bidder's agent can read or alter
 * your ceiling. That asymmetry — auction tools published to allowlisted
 * bidders, mandate tools published to nobody — is the trust model the whole
 * project rests on.
 *
 * What is deliberately NOT claimed: the mandate is stored and enforced by the
 * auction server, because client-side enforcement would not be enforcement at
 * all. The privacy property here holds between BIDDERS, not between a bidder
 * and the house.
 */

import { useWebMCP } from "use-webmcp-tool";
import {
  GET_MY_MANDATE,
  REQUEST_CEILING_RAISE,
  SET_BID_MANDATE,
  boundOutput,
  fmt,
} from "@openfloor/shared";
import { api, type Headroom } from "../lib/api";
import type { BidMandate } from "@openfloor/shared";

export interface BidderToolsOptions {
  bidderId: string;
  mandate: BidMandate | null;
  headroom: Headroom | null;
  currentPriceCents: number;
  onMandateChanged: () => void;
  onCeilingRaiseRequested: (requestId: string) => void;
}

export function useBidderTools(opts: BidderToolsOptions) {
  /* ── get_my_mandate ─────────────────────────────────────────────── */
  const mandateTool = useWebMCP<Record<string, never>, string>({
    name: GET_MY_MANDATE.name,
    description: GET_MY_MANDATE.description,
    inputSchema: GET_MY_MANDATE.inputSchema,
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    async execute() {
      const { mandate, headroom } = await api.getMandate(opts.bidderId);
      if (!mandate) {
        return boundOutput("No mandate set yet. Your human needs to set one before you can bid.");
      }
      return boundOutput(
        [
          `Hard ceiling: ${fmt(mandate.ceiling_cents)} — you can never exceed this.`,
          `Confirm above: ${fmt(mandate.notify_above_cents)} — bids past this need your human's approval.`,
          `Headroom to ceiling at the current price: ${fmt(headroom?.headroom_to_ceiling_cents ?? 0)}`,
          `Currently in the supervised band: ${headroom?.in_supervised_band ? "yes" : "no"}`,
          `Automatic bidding: ${mandate.auto_bid_enabled ? "on" : "OFF"}`,
          mandate.strategy_note ? `Your human's guidance: ${mandate.strategy_note}` : "",
          `Expires: ${new Date(mandate.expires_at).toLocaleTimeString()}`,
          ``,
          `These figures are computed by the server. Do not recalculate them.`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  });

  /* ── set_bid_mandate ────────────────────────────────────────────── */
  const setTool = useWebMCP<
    {
      ceiling_cents: number;
      notify_above_cents: number;
      strategy_note?: string;
      auto_bid_enabled?: boolean;
    },
    string
  >({
    name: SET_BID_MANDATE.name,
    description: SET_BID_MANDATE.description,
    inputSchema: SET_BID_MANDATE.inputSchema,
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute({ ceiling_cents, notify_above_cents, strategy_note, auto_bid_enabled }) {
      if (notify_above_cents > ceiling_cents) {
        return boundOutput(
          "The confirm-above threshold must be at or below the ceiling. " +
            "Ask your human which figure they meant.",
        );
      }
      const { mandate } = await api.setMandate({
        bidder_id: opts.bidderId,
        ceiling_cents: Math.trunc(ceiling_cents),
        notify_above_cents: Math.trunc(notify_above_cents),
        strategy_note,
        auto_bid_enabled,
      });
      opts.onMandateChanged();
      return boundOutput(
        `Mandate set. Ceiling ${fmt(mandate.ceiling_cents)}, confirming each bid above ` +
          `${fmt(mandate.notify_above_cents)}. Automatic bidding is ` +
          `${mandate.auto_bid_enabled ? "on" : "off"}.`,
      );
    },
  });

  /* ── request_ceiling_raise ──────────────────────────────────────── */
  const raiseTool = useWebMCP<
    { requested_ceiling_cents: number; justification: string },
    string
  >({
    name: REQUEST_CEILING_RAISE.name,
    description: REQUEST_CEILING_RAISE.description,
    inputSchema: REQUEST_CEILING_RAISE.inputSchema,
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute({ requested_ceiling_cents, justification }) {
      if (!opts.mandate) return boundOutput("No mandate on file to raise.");
      if (requested_ceiling_cents <= opts.mandate.ceiling_cents) {
        return boundOutput(
          `That is not higher than your current ceiling of ${fmt(opts.mandate.ceiling_cents)}.`,
        );
      }
      const { request } = await api.requestCeilingRaise({
        bidder_id: opts.bidderId,
        requested_ceiling_cents: Math.trunc(requested_ceiling_cents),
        justification,
      });
      opts.onCeilingRaiseRequested(request.id);
      return boundOutput(
        `Asked your human to raise the ceiling from ${fmt(opts.mandate.ceiling_cents)} to ` +
          `${fmt(requested_ceiling_cents)}. This is a request, not a change — your ceiling is ` +
          `unchanged until they approve. Keep bidding within the old limit meanwhile.`,
      );
    },
  });

  return {
    supported: mandateTool.supported,
    registered: mandateTool.registered && setTool.registered && raiseTool.registered,
    error: mandateTool.error ?? setTool.error ?? raiseTool.error,
  };
}
