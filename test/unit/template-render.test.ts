import { describe, it, expect } from "vitest";
import {
  renderTemplate,
  extractVariables,
  findEmptyVariables,
} from "../../src/modules/templates/render";

describe("extractVariables", () => {
  it("finds unique dotted variables and ignores plain text", () => {
    const body = "Hello {{client.name}} of {{client.company}}, ref {{quote.number}}. {{client.name}}.";
    expect(extractVariables(body).sort()).toEqual([
      "client.company",
      "client.name",
      "quote.number",
    ]);
  });
});

describe("renderTemplate", () => {
  const data = {
    client: { name: "Aventa", company: "Aventa Logistics Kft." },
    quote: { number: "Q-2026-014", total_net: "2 313 000 Ft" },
  };

  it("resolves dot paths", () => {
    const { output } = renderTemplate("{{client.company}} · {{quote.number}}", data);
    expect(output).toBe("Aventa Logistics Kft. · Q-2026-014");
  });

  it("HTML-escapes text values (legal-doc safety)", () => {
    const { output } = renderTemplate("{{client.name}}", {
      client: { name: "A & B <script>" },
    });
    expect(output).toBe("A &amp; B &lt;script&gt;");
  });

  it("inserts items_table raw (it is pre-rendered HTML)", () => {
    const { output } = renderTemplate("{{items_table}}", {
      items_table: "<table><tr><td>x</td></tr></table>",
    });
    expect(output).toBe("<table><tr><td>x</td></tr></table>");
  });

  it("tracks missing/empty variables and renders them blank", () => {
    const { output, missing } = renderTemplate(
      "{{client.name}} / {{client.tax_id}} / {{quote.date}}",
      data,
    );
    expect(output).toBe("Aventa /  / ");
    expect(missing.sort()).toEqual(["client.tax_id", "quote.date"]);
  });

  it("is deterministic — same body+data re-renders identically (versioning)", () => {
    const body = "{{client.name}} {{quote.total_net}}";
    expect(renderTemplate(body, data).output).toBe(renderTemplate(body, data).output);
  });
});

describe("findEmptyVariables (blocks finalization)", () => {
  it("returns the variables that would render empty", () => {
    const empties = findEmptyVariables("{{client.name}} {{quote.valid_until}}", {
      client: { name: "Aventa" },
    });
    expect(empties).toEqual(["quote.valid_until"]);
  });
  it("returns [] when every variable resolves", () => {
    expect(
      findEmptyVariables("{{a}} {{b}}", { a: "1", b: "2" }),
    ).toEqual([]);
  });
});
