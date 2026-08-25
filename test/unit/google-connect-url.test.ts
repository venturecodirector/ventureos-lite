import { describe, it, expect } from "vitest";
import { googleConsentUrl } from "../../src/modules/meetings/google-oauth";

/**
 * The consent URL that decides whether a SECOND calendar can be connected.
 *
 * ── WHAT THIS MISSED ───────────────────────────────────────────────────────
 *
 * `multi-calendar.test.ts` proves everything downstream of two connected
 * accounts: both are kept, meetings go only to the WRITE one, every account
 * blocks slots. All of it passed while connecting the second account was
 * impossible.
 *
 * `prompt=consent` re-asks for CONSENT. It does not ask WHICH ACCOUNT. With one
 * Google account signed into the browser — the normal case — Google skips the
 * chooser and returns the same account, the callback finds its row by email and
 * updates it, and the host lands back on a page still showing one calendar.
 * Nothing errors, and the personal calendar's busy times never block anything.
 */
function consentUrl(): URL {
  return new URL(
    googleConsentUrl({
      clientId: "test-client-id",
      redirectUri: "https://ventureco.agency/api/google/callback",
    }),
  );
}

describe("the Google consent URL", () => {
  it("asks WHICH account, not only for consent", () => {
    const prompt = consentUrl().searchParams.get("prompt") ?? "";
    expect(prompt.split(/\s+/)).toContain("select_account");
    // And still asks for consent, which is what produces a refresh token.
    expect(prompt.split(/\s+/)).toContain("consent");
  });

  it("asks for offline access, so the token survives the session", () => {
    expect(consentUrl().searchParams.get("access_type")).toBe("offline");
  });

  /**
   * `calendar.events` alone is rejected by freeBusy with
   * insufficientPermissions — which made every slot look free and let prospects
   * book over existing meetings.
   */
  it("asks for the scope freeBusy actually needs", () => {
    const scope = consentUrl().searchParams.get("scope") ?? "";
    expect(scope).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(scope).toContain("https://www.googleapis.com/auth/calendar.events");
  });

  it("goes to Google, with the configured client and redirect", () => {
    const url = consentUrl();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://ventureco.agency/api/google/callback",
    );
  });
});
