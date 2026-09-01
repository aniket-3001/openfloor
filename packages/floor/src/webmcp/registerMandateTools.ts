/**
 * Mandate tools, registered on the auction-house origin — PRIVATE.
 *
 * Note what is different about this file versus registerAuctionTools.ts, which
 * sits beside it and registers against the same `document.modelContext`:
 *
 *   registerAuctionTools  →  { signal, exposedTo: BIDDER_ORIGINS }
 *   this file             →  { signal }                     ← no exposedTo
 *
 * Same page, same origin, same API — but these three tools are visible only to
 * an agent operating on this page, while the five auction tools are published
 * to allowlisted bidder origins. WebMCP scopes exposure PER TOOL, not per page,
 * and that is what lets one document publish its mechanics while keeping the
 * viewer's own limits to itself. Another bidder's agent can read the price and
 * place a bid; it cannot read or alter your ceiling.
 *
 * These exist here so a visitor who only ever opens the auction house still has
 * a complete flow: state their limits, bid inside them, be asked before the
 * agent crosses the line they set.
 */

import {
  GET_MY_MANDATE,
  REQUEST_CEILING_RAISE,
  SET_BID_MANDATE,
  BIDDER_TOOLS,
  assertToolBudgets,
  boundOutput,
  fmt,
  type ToolSpec,
} from "@openfloor/shared";
import { api } from "../lib/api";

interface ToolResult {
  content: { type: "text"; text: string }[];
}

function reply(text: string): ToolResult {
  return { content: [{ type: "text", text: boundOutput(text) }] };
}

function toTool(spec: ToolSpec, execute: (input: any) => Promise<ToolResult>) {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: {
      readOnlyHint: spec.readOnlyHint,
      untrustedContentHint: spec.untrustedContentHint,
    },
    execute,
  };
}

export interface MandateToolOptions {
  bidderId: string;
  onChanged: () => void;
}

export async function registerMandateTools(opts: MandateToolOptions): Promise<() => void> {
  assertToolBudgets(BIDDER_TOOLS);

  const modelContext = (document as any).modelContext ?? (navigator as any).modelContext;
  if (!modelContext || typeof modelContext.registerTool !== "function") return () => {};

  const controller = new AbortController();
  // Deliberately no `exposedTo` — private to this origin.
  const privateOptions = { signal: controller.signal };

  await modelContext.registerTool(
    toTool(GET_MY_MANDATE, async () => {
      const { mandate, headroom } = await api.getMandate(opts.bidderId);
      if (!mandate) {
        return reply(
          "No mandate set. Before bidding, ask your human what their limit is, then " +
            "call set_bid_mandate. You cannot bid without one.",
        );
      }
      return reply(
        [
          `Hard ceiling: ${fmt(mandate.ceiling_cents)} — you can never exceed this.`,
          `Confirm above: ${fmt(mandate.notify_above_cents)} — bids past this need approval.`,
          `Headroom to ceiling at the current price: ${fmt(headroom?.headroom_to_ceiling_cents ?? 0)}`,
          `In the supervised band right now: ${headroom?.in_supervised_band ? "yes" : "no"}`,
          `Automatic bidding: ${mandate.auto_bid_enabled ? "on" : "OFF"}`,
          mandate.strategy_note ? `Guidance from your human: ${mandate.strategy_note}` : "",
          ``,
          `These figures come from the server. Do not recalculate them.`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }),
    privateOptions,
  );

  await modelContext.registerTool(
    toTool(
      SET_BID_MANDATE,
      async (input: {
        ceiling_cents: number;
        notify_above_cents: number;
        strategy_note?: string;
        auto_bid_enabled?: boolean;
      }) => {
        if (input.notify_above_cents > input.ceiling_cents) {
          return reply(
            "The confirm-above threshold must be at or below the ceiling. Ask your " +
              "human which figure they meant before setting anything.",
          );
        }
        const { mandate } = await api.setMandate({
          bidder_id: opts.bidderId,
          ceiling_cents: Math.trunc(input.ceiling_cents),
          notify_above_cents: Math.trunc(input.notify_above_cents),
          strategy_note: input.strategy_note,
          auto_bid_enabled: input.auto_bid_enabled,
        });
        opts.onChanged();
        return reply(
          `Mandate set and signed. Ceiling ${fmt(mandate.ceiling_cents)}; every bid above ` +
            `${fmt(mandate.notify_above_cents)} will stop and ask your human first. You now ` +
            `have authority to bid below that line on your own judgement.`,
        );
      },
    ),
    privateOptions,
  );

  await modelContext.registerTool(
    toTool(
      REQUEST_CEILING_RAISE,
      async (input: { requested_ceiling_cents: number; justification: string }) => {
        const { mandate } = await api.getMandate(opts.bidderId);
        if (!mandate) return reply("No mandate on file to raise.");
        if (input.requested_ceiling_cents <= mandate.ceiling_cents) {
          return reply(`That is not above your current ceiling of ${fmt(mandate.ceiling_cents)}.`);
        }
        await api.requestCeilingRaise({
          bidder_id: opts.bidderId,
          requested_ceiling_cents: Math.trunc(input.requested_ceiling_cents),
          justification: input.justification,
        });
        opts.onChanged();
        return reply(
          `Asked your human to raise the ceiling from ${fmt(mandate.ceiling_cents)} to ` +
            `${fmt(input.requested_ceiling_cents)}. This is a request, not a change. Your ceiling ` +
            `is unchanged until they approve it — keep bidding within the current limit.`,
        );
      },
    ),
    privateOptions,
  );

  return () => controller.abort();
}
