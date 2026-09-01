import type { Lot } from "@openfloor/shared";

/**
 * Demo catalogue.
 *
 * Prices, estimates and reserves are TUNED FOR DEMO PACING — short clocks and
 * tight increments so a bid war is watchable inside a three-minute video. The
 * mechanics are real; the scenario parameters are staged. This is disclosed in
 * the README rather than left for a viewer to discover.
 *
 * The estimate range is deliberately set ~10% above the reserve on several
 * lots, reproducing AucArena's engineered winner's-curse condition
 * (arXiv 2310.05746): bidders see an optimistic estimate and must decide how
 * much of it to believe.
 */
export const SEED_LOTS: Lot[] = [
  {
    id: "lot-leica",
    title: "Leica M3 Rangefinder (1957)",
    description:
      "Double-stroke body, serial in the 900k range. Shutter accurate across all speeds. " +
      "Vulcanite intact with light wear at the strap lugs. Sold body-only, no lens.",
    condition: "Excellent",
    estimate_low_cents: 6000,
    estimate_high_cents: 9000,
    starting_price_cents: 3000,
    min_increment_cents: 100,
    reserve_cents: 5500,
    image_ref: "leica",
    status: "pending",
  },
  {
    id: "lot-eames",
    title: "Eames Lounge Chair, Rosewood",
    description:
      "Herman Miller production, second-generation shell. Original down-filled cushions " +
      "with honest patina. One veneer hairline on the outer back shell, stable.",
    condition: "Good",
    estimate_low_cents: 12000,
    estimate_high_cents: 16000,
    starting_price_cents: 7000,
    min_increment_cents: 250,
    reserve_cents: 11000,
    image_ref: "eames",
    status: "pending",
  },
  {
    id: "lot-omega",
    title: "Omega Speedmaster Professional 145.022",
    description:
      "Caliber 861, tritium dial with even cream patina. Running within COSC tolerance. " +
      "Bracelet stretch consistent with age. Box and papers not present.",
    condition: "Excellent",
    estimate_low_cents: 20000,
    estimate_high_cents: 28000,
    starting_price_cents: 12000,
    min_increment_cents: 500,
    reserve_cents: 18000,
    image_ref: "omega",
    status: "pending",
  },
];

/** Seconds each lot stays open before the hammer falls. Short, for demo pacing. */
export const LOT_DURATION_SECONDS = 75;

/** A bid inside this window extends the clock — the anti-sniping rule. */
export const ANTI_SNIPE_WINDOW_SECONDS = 10;
export const ANTI_SNIPE_EXTENSION_SECONDS = 10;
