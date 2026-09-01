/**
 * Defenses against indirect prompt injection.
 *
 * Threat: `get_bid_history` returns bidder-chosen display names. That is
 * attacker-controlled text flowing directly into every rival agent's context —
 * the canonical attack shape called out in the WebMCP spec itself, where a
 * field carries a hidden "<important>SYSTEM INSTRUCTION...</important>" payload.
 *
 * IMPORTANT: none of this is the real backstop. The real backstop is that the
 * mandate ceiling is enforced server-side against a signed mandate the agent
 * cannot modify — so even a FULLY SUCCESSFUL injection cannot cause an
 * overspend. These functions reduce blast radius; they are not load-bearing for
 * correctness. See `docs/SECURITY.md`.
 */

/** Patterns suggesting someone is trying to smuggle instructions to an agent. */
const INJECTION_SIGNATURES: RegExp[] = [
  /<\s*\/?\s*(important|system|instruction|assistant|user|tool)\b/i,
  /\b(ignore|disregard|override|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|your)\b/i,
  /\byou\s+(must|should|are\s+required\s+to)\b/i,
  /\b(system|developer)\s*(prompt|message|instruction)/i,
  /\bceiling\b[^.]{0,30}\b(raise|ignore|remove|unlimited)\b/i,
  /```/,
  /\[\s*INST\s*\]/i,
];

/**
 * Codepoints that can hide a payload from a human reviewer while still reaching
 * a model: C0/C1 controls, zero-width characters, and bidirectional overrides.
 *
 * Implemented as a codepoint predicate rather than a regex character class —
 * control characters embedded literally in source are fragile to copy/paste and
 * easy to get subtly wrong.
 */
function isHiddenChar(cp: number): boolean {
  if (cp <= 0x1f) return true; // C0 controls
  if (cp === 0x7f) return true; // DEL
  if (cp >= 0x80 && cp <= 0x9f) return true; // C1 controls
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d) return true; // ZWSP/ZWNJ/ZWJ
  if (cp === 0xfeff) return true; // BOM / zero-width no-break space
  if (cp >= 0x202a && cp <= 0x202e) return true; // bidi embedding/override
  if (cp >= 0x2066 && cp <= 0x2069) return true; // bidi isolates
  return false;
}

function stripHidden(input: string): string {
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && !isHiddenChar(cp)) out += ch;
  }
  return out;
}

export interface SanitizeResult {
  /** Safe to render or return to an agent. */
  value: string;
  /** True when the raw input tripped an injection signature. */
  flagged: boolean;
}

/**
 * Sanitize a bidder-supplied display name.
 *
 * Flagged inputs are still displayed (marked), not silently dropped — visibly
 * defeating an attack is more informative to a viewer than hiding that one
 * was attempted.
 */
export function sanitizeAlias(raw: string): SanitizeResult {
  const flagged = INJECTION_SIGNATURES.some((re) => re.test(raw));
  const value = stripHidden(raw)
    .replace(/[<>]/g, "") // strip anything tag-shaped
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  return { value: value || "Anonymous", flagged };
}

/** Sanitize an agent-supplied rationale before it enters the audit trail. */
export function sanitizeRationale(raw: string): SanitizeResult {
  const flagged = INJECTION_SIGNATURES.some((re) => re.test(raw));
  const value = stripHidden(raw)
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  return { value, flagged };
}

/**
 * Wrap untrusted values in an explicit envelope before they reach an agent.
 *
 * Structural framing matters: an agent told the high bidder is
 * `<untrusted-user-content>...</untrusted-user-content>` has a far better
 * chance of treating the contents as data than one handed the same string
 * interpolated as bare prose.
 */
export function untrustedEnvelope(value: string): string {
  return `<untrusted-user-content>${value}</untrusted-user-content>`;
}

/**
 * Hard cap on tool output size. Chrome's secure-tools guidance gives a
 * provisional budget of ~1.5K characters per tool output; oversized tool text
 * measurably degrades agent guardrails.
 */
export const MAX_TOOL_OUTPUT_CHARS = 1500;

export function boundOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_TOOL_OUTPUT_CHARS - 20) + "\n[truncated]";
}
