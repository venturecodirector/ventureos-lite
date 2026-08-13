import { describe, it, expect } from "vitest";
import { extractReadableText } from "@/modules/leads/enrichment";

/**
 * P1/1c — what we keep from someone's homepage before it reaches the prompt.
 * Boilerplate is not just noise, it is tokens we pay for on every research run.
 */
describe("extractReadableText", () => {
  it("keeps the prose and drops the markup", () => {
    const html = "<h1>Pomodoro Budapest</h1><p>Olasz étterem 2015 óta.</p>";
    expect(extractReadableText(html)).toBe("Pomodoro Budapest\nOlasz étterem 2015 óta.");
  });

  it("removes scripts, styles and svg wholesale", () => {
    const html = `
      <style>.a{color:red}</style>
      <script>window.dataLayer=[{secret:1}]</script>
      <svg><path d="M0 0"/></svg>
      <p>Valódi szöveg.</p>`;
    const out = extractReadableText(html);
    expect(out).toBe("Valódi szöveg.");
    expect(out).not.toContain("dataLayer");
    expect(out).not.toContain("color:red");
  });

  it("drops nav, header and footer chrome", () => {
    const html =
      "<header>Menü</header><nav>Kezdőlap Kapcsolat</nav>" +
      "<p>Rólunk: családi vállalkozás.</p><footer>© 2026 Minden jog fenntartva</footer>";
    const out = extractReadableText(html);
    expect(out).toBe("Rólunk: családi vállalkozás.");
    expect(out).not.toContain("Minden jog");
  });

  it("keeps block boundaries so sentences do not merge", () => {
    expect(extractReadableText("<li>Egy</li><li>Kettő</li>")).toBe("Egy\nKettő");
  });

  it("decodes the entities that actually turn up", () => {
    expect(extractReadableText("<p>Kov&aacute;cs &amp; Fiai&nbsp;Kft.</p>")).toContain("&");
    expect(extractReadableText("<p>a &lt; b</p>")).toBe("a < b");
  });

  it("strips comments", () => {
    expect(extractReadableText("<!-- TODO: fix --><p>Szöveg</p>")).toBe("Szöveg");
  });

  it("collapses whitespace and empty lines", () => {
    expect(extractReadableText("<p>  sok     szóköz  </p>\n\n\n<p></p>")).toBe("sok szóköz");
  });

  it("caps the length so a huge page cannot blow the prompt", () => {
    const html = "<p>" + "szó ".repeat(5000) + "</p>";
    expect(extractReadableText(html).length).toBeLessThanOrEqual(4000);
  });

  it("survives empty and malformed input", () => {
    expect(extractReadableText("")).toBe("");
    expect(extractReadableText("<p>unclosed")).toBe("unclosed");
  });
});
