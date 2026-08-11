import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyMailgunSignature } from "../../src/modules/mail/signature";
import { mapMailgunEvent } from "../../src/modules/mail/events";
import { isRecipientSuppressed } from "../../src/modules/mail/suppression";
import { resolveSendingIdentity } from "../../src/modules/mail/identity";

describe("verifyMailgunSignature (webhook auth)", () => {
  const key = "key-test-signing";
  const ts = "1786500000";
  const token = "abc123token";
  const sig = createHmac("sha256", key).update(ts + token).digest("hex");

  it("accepts a correctly signed payload", () => {
    expect(verifyMailgunSignature(key, ts, token, sig)).toBe(true);
  });
  it("rejects a tampered or wrong-key signature", () => {
    expect(verifyMailgunSignature(key, ts, token, "deadbeef")).toBe(false);
    expect(verifyMailgunSignature("wrong", ts, token, sig)).toBe(false);
    expect(verifyMailgunSignature(key, ts, "other", sig)).toBe(false);
  });
});

describe("mapMailgunEvent", () => {
  it("maps delivery + open to statuses (no suppression)", () => {
    expect(mapMailgunEvent("delivered")).toEqual({ status: "DELIVERED", suppress: false });
    expect(mapMailgunEvent("opened")).toEqual({ status: "OPENED", suppress: false });
  });
  it("maps failures/complaints/unsubscribes to suppression", () => {
    expect(mapMailgunEvent("failed")).toEqual({ status: "BOUNCED", suppress: true });
    expect(mapMailgunEvent("complained")).toMatchObject({ suppress: true });
    expect(mapMailgunEvent("unsubscribed")).toMatchObject({ suppress: true });
  });
  it("ignores unknown events", () => {
    expect(mapMailgunEvent("clicked")).toEqual({ status: null, suppress: false });
  });
});

describe("isRecipientSuppressed", () => {
  it("matches case-insensitively against the suppression list", () => {
    expect(isRecipientSuppressed("Bob@X.com", ["bob@x.com"])).toBe(true);
    expect(isRecipientSuppressed("a@x.com", ["bob@x.com"])).toBe(false);
    expect(isRecipientSuppressed("", ["bob@x.com"])).toBe(false);
  });
});

describe("resolveSendingIdentity (per-workspace)", () => {
  it("composes the From identity from the workspace mailgun config", () => {
    const id = resolveSendingIdentity({
      domain: "mail.ventureco.group",
      fromName: "Venture CO",
      fromEmail: "hello@mail.ventureco.group",
      replyTo: "reply@ventureco.group",
    });
    expect(id.domain).toBe("mail.ventureco.group");
    expect(id.from).toBe("Venture CO <hello@mail.ventureco.group>");
    expect(id.replyTo).toBe("reply@ventureco.group");
  });
  it("falls back to defaults for an empty config", () => {
    const id = resolveSendingIdentity(null);
    expect(id.from).toContain("<");
    expect(id.domain.length).toBeGreaterThan(0);
  });
});
