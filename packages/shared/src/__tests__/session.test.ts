import { describe, it, expect } from "vitest";
import { sessionCookie } from "../session";

/**
 * These assertions look pedantic — they are three string checks on a header.
 * They exist because getting this wrong is invisible. A session cookie the
 * browser refuses to store produces no error anywhere: every request simply
 * arrives without one, the server mints a fresh identity for each, and the
 * mandate written a second ago is read back as somebody else's. What you see
 * is an agent that stays paused for no stated reason, on some machines and
 * not others.
 */
describe("the session cookie survives a cross-site console", () => {
  const secure = sessionCookie("tok", { secure: true });

  it("is sent on cross-site requests at all", () => {
    // The console and the API are different origins by design.
    expect(secure).toContain("SameSite=None");
    expect(secure).toContain("Secure");
  });

  it("is partitioned, so third-party cookie blocking does not drop it", () => {
    // SameSite=None alone is not enough once a browser blocks third-party
    // cookies. CHIPS asks for a jar keyed to the top-level site instead.
    expect(secure).toContain("Partitioned");
  });

  it("falls back to Lax on plain http, where Secure is impossible", () => {
    const insecure = sessionCookie("tok", { secure: false });
    expect(insecure).toContain("SameSite=Lax");
    expect(insecure).not.toContain("SameSite=None");
    expect(insecure).not.toContain("Partitioned");
  });
});
