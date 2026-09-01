/**
 * Lot imagery.
 *
 * A saleroom is image-first — a listing with no picture reads as a database
 * row, not a lot. `image_ref` existed in the data from the start but nothing
 * ever rendered it.
 *
 * These are deliberately line drawings rather than photographs. A stock photo
 * would imply a real object in a real sale; a drawn plate is honestly an
 * illustration while still giving the page something to look at. They are
 * inline SVG, so there is no external fetch and nothing to block.
 */

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.25,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  vectorEffect: "non-scaling-stroke" as const,
};

function Leica() {
  return (
    <svg viewBox="0 0 200 150" role="img" aria-label="Line drawing of a 35mm rangefinder camera">
      <g {...stroke}>
        <rect x="26" y="46" width="148" height="72" rx="7" />
        <rect x="26" y="46" width="148" height="15" rx="7" />
        <circle cx="100" cy="86" r="27" />
        <circle cx="100" cy="86" r="18" />
        <circle cx="100" cy="86" r="8" />
        <circle cx="46" cy="70" r="6" />
        <rect x="128" y="66" width="26" height="13" rx="3" />
        <path d="M66 46v-8h22v8" />
        <circle cx="156" cy="53" r="3.2" />
      </g>
    </svg>
  );
}

function Eames() {
  return (
    <svg viewBox="0 0 200 150" role="img" aria-label="Line drawing of a lounge chair and ottoman">
      <g {...stroke}>
        <path d="M42 84c-6-20 0-40 10-46 12-7 30-6 38 2 4 4 5 12 3 20" />
        <path d="M36 86c0 12 10 20 24 20h26c10 0 16-6 16-14 0-6-4-11-12-12" />
        <path d="M54 106l-6 22M92 106l6 22" />
        <path d="M40 130h66" />
        <rect x="126" y="96" width="46" height="16" rx="5" />
        <path d="M136 112l-4 18M164 112l4 18" />
        <path d="M128 130h44" />
      </g>
    </svg>
  );
}

function Omega() {
  return (
    <svg viewBox="0 0 200 150" role="img" aria-label="Line drawing of a chronograph wristwatch">
      <g {...stroke}>
        <circle cx="100" cy="75" r="38" />
        <circle cx="100" cy="75" r="31" />
        <path d="M100 52v23l15 10" />
        <circle cx="84" cy="88" r="7" />
        <circle cx="116" cy="88" r="7" />
        <circle cx="100" cy="58" r="7" />
        <path d="M78 40l4-16h36l4 16M78 110l4 16h36l4-16" />
        <path d="M138 66h7v18h-7" />
      </g>
    </svg>
  );
}

const PLATES: Record<string, () => JSX.Element> = {
  leica: Leica,
  eames: Eames,
  omega: Omega,
};

export function LotPlate({ imageRef }: { imageRef: string }) {
  const Art = PLATES[imageRef];
  return (
    <div className="plate" style={{ color: "var(--ink-3)" }}>
      {Art ? (
        <Art />
      ) : (
        <svg viewBox="0 0 200 150" role="img" aria-label="No image for this lot">
          <g {...stroke}>
            <rect x="40" y="35" width="120" height="80" rx="6" />
            <path d="M40 95l32-26 24 19 20-16 44 33" />
            <circle cx="72" cy="60" r="7" />
          </g>
        </svg>
      )}
    </div>
  );
}
