/**
 * Session identity.
 *
 * WHY THIS EXISTS
 * ---------------
 * `bidder_id` used to arrive in the request body, chosen by the client and
 * never checked. Anyone could bid as someone else, approve another person's
 * confirmation card, or — worst — issue a mandate for another bidder and set
 * their ceiling to any number they liked.
 *
 * The project's central claim is that no tool can raise a ceiling and only a
 * human can approve. An unauthenticated mandate endpoint made that claim
 * unenforceable: the signature protects a mandate at rest, but says nothing
 * about who was allowed to issue it. The audit trail recorded "human approved"
 * while the server had no way to know whether a human, or which human, did.
 *
 * So identity is now derived from a signed session cookie and NEVER from the
 * payload. A body-supplied bidder_id is ignored wherever a session exists.
 *
 * Sessions are issued automatically on first request, so there is no signup
 * wall: you open the page and you are already seated. A session can then be
 * CLAIMED with a handle and passphrase to make it durable across devices,
 * which is what turns a seat into an account.
 */

export interface Session {
  /** Stable bidder identity. This is the only trusted source of bidder_id. */
  bidder_id: string;
  /** Display name. Sanitized before it ever reaches another agent. */
  alias: string;
  /** Set once a session has been claimed with a handle. */
  handle?: string;
  issued_at: string;
  expires_at: string;
}

/** Cookie name. Host-only, HttpOnly, SameSite=None so it survives the cross-origin bridge frame. */
export const SESSION_COOKIE = "openfloor_session";

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
}

/** Constant-time-ish compare, so a mismatch does not leak where it diverged. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Serialize and sign. The value is readable but not forgeable. */
export async function sealSession(session: Session, secret: string): Promise<string> {
  const payload = b64url(encoder.encode(JSON.stringify(session)));
  return `${payload}.${await hmac(payload, secret)}`;
}

/**
 * Verify and parse. Returns null for anything that fails — a bad signature and
 * an expired session are indistinguishable to the caller on purpose.
 */
export async function openSession(token: string | undefined, secret: string): Promise<Session | null> {
  if (!token) return null;
  // A role without a signing key cannot have sessions. Returning null is right;
  // importKey on an empty secret THROWS, which made every request on the
  // static-serving roles 500 and failed Cloud Run's startup probe.
  if (!secret) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, await hmac(payload, secret))) return null;

  try {
    const session = JSON.parse(new TextDecoder().decode(unb64url(payload))) as Session;
    if (new Date(session.expires_at).getTime() <= Date.now()) return null;
    if (!session.bidder_id) return null;
    return session;
  } catch {
    return null;
  }
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function newSession(alias = "Guest"): Session {
  const now = Date.now();
  return {
    bidder_id: `b_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    alias,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
  };
}

/**
 * Derive a stable bidder id from a claimed handle.
 *
 * Claiming a seat must land you on the SAME bidder id every time, or your
 * history would fragment across logins. Deriving it from the handle under the
 * server secret gives that without storing a user table.
 */
export async function bidderIdForHandle(handle: string, secret: string): Promise<string> {
  const mac = await hmac(`handle:${handle.toLowerCase()}`, secret);
  return `u_${mac.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}`;
}

/** Verifier stored against a claimed handle. Never store the passphrase itself. */
export async function passphraseVerifier(handle: string, passphrase: string, secret: string): Promise<string> {
  return hmac(`pass:${handle.toLowerCase()}:${passphrase}`, secret);
}

export function normalizeHandle(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  return /^[a-z0-9_-]{3,24}$/.test(h) ? h : null;
}

/** Build the Set-Cookie header. */
export function sessionCookie(token: string, opts: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  // SameSite=None is required: the bidder console reaches the auction API from
  // a different origin, and the WebMCP tool bridge runs the floor inside an
  // iframe. Lax would drop the cookie in exactly the flow this project is about.
  // None demands Secure, so plain-HTTP local dev falls back to Lax.
  parts.push(opts.secure ? "SameSite=None; Secure" : "SameSite=Lax");
  return parts.join("; ");
}

export function readCookie(header: string | undefined | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
