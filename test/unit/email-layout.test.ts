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

/**
 * Reports and digests, which need more than a paragraph and a button.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * "Nézd át az összes email templatet, legyen sokkal designosabb, illetve a
 * weekly digest egyéb riportok is legyenek html-ek és fullos design-al ellátva."
 *
 * The layout above already existed and was used by the six transactional
 * senders. The four REPORT senders bypassed it entirely and concatenated tags:
 *
 *     `<h2>${subject}</h2><p>${intro}</p><ul>${rows}</ul>`
 *
 * which arrives as unstyled browser-default text — Times New Roman on a white
 * background — with no sender identity, no plain-text part, and no resemblance
 * to the product it reports on. Two of them also said "Venture OS" in the
 * heading AND the subject line of every workspace's mail.
 */
describe("report blocks", () => {
  const report = {
    preheader: "the week",
    heading: "Friday report",
    paragraphs: ["The week in numbers."],
    metrics: [
      { label: "New leads", value: "34", hint: "target 30" },
      { label: "Meetings", value: "6" },
      { label: "Quotes", value: "2" },
      { label: "Revenue", value: "1 800 000 Ft" },
    ],
    sections: [
      { heading: "Funnel", rows: [{ label: "Contacted", value: "21 · 62%" }] },
      { heading: "What works", bullets: ["Audits first.", "Referrals close."] },
      { heading: "Next", paragraphs: ["Keep auditing."], emphasis: true },
    ],
  };

  it("renders every metric with its label, value and hint", () => {
    const html = brandEmail(report);
    for (const m of report.metrics) {
      expect(html).toContain(m.label);
      expect(html).toContain(m.value);
    }
    expect(html).toContain("target 30");
  });

  /**
   * Three per row, because a fourth box in 600px leaves each too narrow for a
   * thousands-separated figure — and Outlook will not wrap a cell to rescue it.
   */
  it("chunks metrics into rows of at most three", () => {
    const html = brandEmail(report);
    const widths = [...html.matchAll(/<td width="(\d+)%"/g)].map((m) => m[1]);
    expect(widths).toEqual(["33", "33", "33", "100"]);
  });

  it("renders sections in the order given", () => {
    const html = brandEmail(report);
    const at = (s: string) => html.indexOf(s);
    expect(at("Funnel")).toBeLessThan(at("What works"));
    expect(at("What works")).toBeLessThan(at("Next"));
  });

  it("draws an emphasised section in the accent, so a conclusion reads as one", () => {
    const html = brandEmail(report);
    const box = html.slice(html.indexOf("Next") - 400, html.indexOf("Keep auditing."));
    expect(box).toContain("#7427C6");
  });

  it("still uses only tables and inline styles for the new blocks", () => {
    const html = brandEmail(report);
    expect(html).not.toContain("<style");
    expect(html).not.toContain("display:flex");
    expect(html).not.toContain("display:grid");
  });

  it("escapes metric and section content too", () => {
    const html = brandEmail({
      ...report,
      metrics: [{ label: "<script>x</script>", value: "<b>1</b>", hint: "<i>h</i>" }],
      sections: [
        {
          heading: "<script>s</script>",
          bullets: ["<img src=x>"],
          rows: [{ label: "<b>l</b>", value: "<b>v</b>" }],
          paragraphs: ["<script>p</script>"],
        },
      ],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });

  /** A report with no plain-text part is a report half the clients cannot read. */
  it("carries the metrics and sections in the text part as well", () => {
    const text = brandEmailText(report);
    expect(text).toContain("New leads: 34 (target 30)");
    expect(text).toContain("FUNNEL");
    expect(text).toContain("Contacted: 21 · 62%");
    expect(text).toContain("· Audits first.");
    expect(text).toContain("Keep auditing.");
  });

  it("omits the new blocks entirely when a message has none", () => {
    const html = brandEmail({ preheader: "p", heading: "h", paragraphs: ["b"] });
    expect(html).not.toContain('<td width="33%"');
    expect(html).not.toContain("text-transform:uppercase;color:#858CAE;padding-bottom:8px");
  });
});
