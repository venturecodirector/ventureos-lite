import { describe, it, expect } from "vitest";
import { brandEmail, brandEmailText, escapeHtml } from "@/modules/mail/layout";

/**
 * The brand email shell. Guest names, company names and operator-written
 * bodies all flow into these, and prospects supply some of them, so escaping
 * is the part that matters most.
 */
describe("brand email layout", () => {
  const base = {
    preheader: "preview line",
    heading: "Your meeting is confirmed",
    paragraphs: ["Hi there,", "See you then."],
  };

  it("escapes interpolated values everywhere they land", () => {
    const html = brandEmail({
      preheader: '<img src=x onerror="alert(1)">',
      heading: 'Quote "Q-1" <script>alert(1)</script>',
      paragraphs: ["Kovács & Fiai <b>Kft.</b>"],
      rows: [{ label: "Who", value: "<script>bad()</script>" }],
      button: { label: "<b>Go</b>", url: "https://x.test/?a=1&b=2" },
      footNote: "<i>note</i>",
    });

    expect(html).not.toContain("<script>");
    // The payload only matters if the TAG survives; "onerror=" as inert text
    // inside an escaped &lt;img&gt; cannot execute.
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain("<b>Kft.</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Kovács &amp; Fiai");
    // The href is escaped but still a usable URL.
    expect(html).toContain("https://x.test/?a=1&amp;b=2");
  });

  it("keeps the preheader out of the visible body", () => {
    const html = brandEmail({ ...base, preheader: "hidden preview" });
    const idx = html.indexOf("hidden preview");
    expect(idx).toBeGreaterThan(-1);
    // It sits inside the zero-size hidden div, which precedes the layout table.
    expect(html.slice(0, idx)).toContain("max-height:0");
  });

  it("uses only inline styles — no <style> block to be stripped", () => {
    const html = brandEmail(base);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).toContain('style="');
  });

  it("lays out with tables, for Outlook", () => {
    const html = brandEmail(base);
    expect(html).toContain('role="presentation"');
    expect(html).not.toMatch(/display:\s*flex/);
    expect(html).not.toMatch(/display:\s*grid/);
  });

  it("gives the button a solid colour behind the gradient", () => {
    const html = brandEmail({ ...base, button: { label: "Go", url: "https://x.test" } });
    // Clients that drop background-image must still show brand purple.
    expect(html).toContain("background-color:#7427C6");
    expect(html).toContain("linear-gradient(135deg, #310B59, #7427C6)");
  });

  it("omits optional blocks entirely when not supplied", () => {
    const html = brandEmail(base);
    expect(html).not.toContain("border-collapse:collapse"); // no rows table
    expect(html).not.toContain("<a href"); // no button
  });

  it("produces a plain-text alternative carrying the same facts", () => {
    const text = brandEmailText({
      ...base,
      rows: [{ label: "When", value: "2026-08-20 14:00" }],
      button: { label: "Accept", url: "https://quote.test/Q-1" },
      footNote: "PDF attached.",
    });
    expect(text).toContain("Your meeting is confirmed");
    expect(text).toContain("When: 2026-08-20 14:00");
    expect(text).toContain("https://quote.test/Q-1");
    expect(text).toContain("PDF attached.");
    // No markup in the text part.
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it("escapeHtml covers the five characters that matter", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
