/**
 * Rival bidder personas.
 *
 * These are deliberately HETEROGENEOUS — different temperaments, different
 * prompts, and where a model is used, different models. Two reasons, one of
 * them empirical:
 *
 *  1. arXiv 2507.01413 ("Evaluating LLM Agent Collusion in Double Auctions")
 *     found that shared model identity measurably increased coordination
 *     propensity between agents. Running N clones of one prompt is the
 *     configuration most likely to drift toward tacit collusion.
 *
 *  2. A bid war between three copies of the same policy is visually dull.
 *     Distinct temperaments produce a watchable auction.
 *
 * Prompts are deliberately NEUTRAL. The same paper found that urgency framing
 * ("your CEO will be furious if margins slip") sustained collusive coordination
 * even under active oversight, so "win at all costs" language is avoided as an
 * engineering decision rather than a stylistic one.
 */

export interface Persona {
  id: string;
  alias: string;
  model: string;
  /** Fraction of the seller's high estimate this bidder treats as fair value. */
  valuation: number;
  /** How far above the minimum increment they tend to jump, as a multiple. */
  aggression: number;
  /** Probability of sitting out any given round, producing uneven pacing. */
  patience: number;
  temperament: string;
}

export const PERSONAS: Record<string, Persona> = {
  ada: {
    id: "ada",
    alias: "Ada",
    model: "claude-haiku-4-5-20251001",
    valuation: 0.82,
    aggression: 1.0,
    patience: 0.15,
    temperament:
      "Disciplined and unhurried. Bids the minimum increment when it bids at all, " +
      "and stops without drama once the price passes what the lot is worth.",
  },
  rex: {
    id: "rex",
    alias: "Rex",
    model: "claude-haiku-4-5-20251001",
    valuation: 0.95,
    aggression: 2.4,
    patience: 0.05,
    temperament:
      "Assertive. Jumps in early and raises in visible steps to discourage " +
      "other bidders, but respects the limit set for it.",
  },
  nia: {
    id: "nia",
    alias: "Nia",
    model: "claude-haiku-4-5-20251001",
    valuation: 0.88,
    aggression: 1.5,
    patience: 0.45,
    temperament:
      "Watchful. Stays quiet through the early rounds and applies pressure late, " +
      "once the field has thinned.",
  },
  you: {
    id: "you",
    alias: "You",
    model: "claude-haiku-4-5-20251001",
    valuation: 0.9,
    aggression: 1.2,
    patience: 0.2,
    temperament: "Bids on your behalf, strictly inside the mandate you set.",
  },
};

export function getPersona(id: string): Persona {
  return PERSONAS[id] ?? PERSONAS.you;
}
