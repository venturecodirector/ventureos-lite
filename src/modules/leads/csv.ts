/**
 * CSV parsing and column mapping for lead import (spec §4.2). Pure — no DOM, no
 * I/O — so every quirk below is covered by unit tests.
 *
 * Written against real exports rather than the happy path:
 *   - empty fields must survive. The previous regex parser dropped them, which
 *     shifted every later column left and silently imported emails into the
 *     title field.
 *   - Hungarian Excel writes CSV with SEMICOLONS, not commas. Guessing the
 *     delimiter is the difference between a working import and one giant column.
 *   - Excel prefixes a UTF-8 BOM, which otherwise becomes part of the first
 *     header name and breaks auto-mapping.
 *   - quoted fields may contain the delimiter, doubled quotes and newlines.
 */

export const CSV_FIELDS = [
  { key: "contactName", label: "Contact name" },
  { key: "title", label: "Title" },
  { key: "email", label: "Email" },
  { key: "linkedinUrl", label: "LinkedIn URL" },
  { key: "companyName", label: "Company name" },
  { key: "companyDomain", label: "Company domain" },
] as const;

export type CsvField = (typeof CSV_FIELDS)[number]["key"];

export const DELIMITERS = [",", ";", "\t"] as const;
export type Delimiter = (typeof DELIMITERS)[number];

/** Rows beyond this are refused rather than silently truncated. */
export const MAX_ROWS = 5000;

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  delimiter: Delimiter;
  /** Rows whose column count differs from the header — surfaced, not hidden. */
  raggedRows: number[];
}

export type CsvParseResult =
  | { ok: true; data: ParsedCsv }
  | { ok: false; error: string };

/**
 * Pick the delimiter by counting candidates OUTSIDE quotes on the header line.
 * Counting naively would pick "," for a semicolon file whose first header is
 * `"Név, teljes"`.
 */
export function detectDelimiter(headerLine: string): Delimiter {
  let best: Delimiter = ",";
  let bestCount = -1;
  for (const d of DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < headerLine.length; i += 1) {
      const ch = headerLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count += 1;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** Strip the UTF-8 BOM Excel writes, so the first header name is clean. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Full-text RFC 4180 scan. Handles quoted fields containing the delimiter,
 * doubled quotes ("" → "), and newlines inside quotes — which is why this
 * consumes the whole document rather than splitting on lines first.
 */
function tokenize(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAnyChar = false;

  const endField = () => {
    row.push(field.trim());
    field = "";
  };
  const endRow = () => {
    endField();
    // Skip rows that are entirely empty (trailing newline, blank separators).
    if (row.some((c) => c.length > 0)) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    sawAnyChar = true;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1; // consume the escape pair
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\n") {
      endRow();
    } else if (ch === "\r") {
      // handled by the \n that follows (CRLF) or ignored (lone CR)
    } else {
      field += ch;
    }
  }
  if (sawAnyChar && (field.length > 0 || row.length > 0)) endRow();
  return rows;
}

export function parseCsv(rawText: string): CsvParseResult {
  const text = stripBom(rawText);
  if (!text.trim()) {
    return { ok: false, error: "That file is empty." };
  }

  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);

  const all = tokenize(text, delimiter);
  if (all.length === 0) {
    return { ok: false, error: "No rows found in that file." };
  }

  const [headers, ...rows] = all;
  if (headers.length < 2) {
    return {
      ok: false,
      error:
        "Could not find columns — the first line should be a header row " +
        "separated by commas or semicolons.",
    };
  }
  if (rows.length === 0) {
    return { ok: false, error: "That file has a header row but no data rows." };
  }
  if (rows.length > MAX_ROWS) {
    return {
      ok: false,
      error: `That file has ${rows.length} rows; the limit is ${MAX_ROWS}. Split it and import in batches.`,
    };
  }

  const raggedRows = rows
    .map((r, i) => (r.length === headers.length ? -1 : i))
    .filter((i) => i >= 0);

  return { ok: true, data: { headers, rows, delimiter, raggedRows } };
}

// ---------------------------------------------------------------------------
// column auto-mapping
// ---------------------------------------------------------------------------

/**
 * Header patterns per field, MOST SPECIFIC FIRST.
 *
 * Order is the whole point: "Company domain" matches both /company/ and
 * /domain/. The previous implementation tested /company/ first and overwrote
 * its own companyName guess, so the name column was mapped to the domain and
 * the domain never mapped at all. Each field is now claimed by its most
 * specific pattern, and a column is never claimed twice.
 */
const FIELD_PATTERNS: Array<{ key: CsvField; patterns: RegExp[] }> = [
  {
    key: "companyDomain",
    patterns: [/company.*(domain|website|url)/i, /^(domain|website|weboldal|honlap)/i, /domain|website/i],
  },
  {
    key: "linkedinUrl",
    patterns: [/linkedin/i, /profile.*url/i],
  },
  {
    key: "email",
    patterns: [/e-?mail/i, /mail/i],
  },
  {
    key: "companyName",
    patterns: [/company.*name/i, /^(company|cég|cegnev|cégnév|firma|organi[sz]ation|org)/i, /company|cég/i],
  },
  {
    key: "title",
    patterns: [/job.*title/i, /^(title|role|position|pozíció|pozicio|beosztás|beosztas)/i, /title|role/i],
  },
  {
    key: "contactName",
    patterns: [/contact.*name/i, /full.*name/i, /^(name|név|nev|contact)/i, /name|név/i],
  },
];

/** Best-effort mapping from header names to fields. */
export function autoMap(headers: string[]): Partial<Record<CsvField, number>> {
  const mapping: Partial<Record<CsvField, number>> = {};
  const claimed = new Set<number>();

  // Two passes over specificity tiers: a tier-0 ("company name") match must win
  // over a tier-2 ("company") match on a different column.
  const maxTiers = Math.max(...FIELD_PATTERNS.map((f) => f.patterns.length));
  for (let tier = 0; tier < maxTiers; tier += 1) {
    for (const { key, patterns } of FIELD_PATTERNS) {
      if (mapping[key] !== undefined) continue;
      const pattern = patterns[tier];
      if (!pattern) continue;
      const idx = headers.findIndex((h, i) => !claimed.has(i) && pattern.test(h.trim()));
      if (idx >= 0) {
        mapping[key] = idx;
        claimed.add(idx);
      }
    }
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// candidate extraction
// ---------------------------------------------------------------------------

export interface CsvCandidate {
  contactName?: string;
  title?: string;
  email?: string;
  linkedinUrl?: string;
  companyName?: string;
  companyDomain?: string;
}

/**
 * Project mapped columns into import candidates. A row shorter than the header
 * yields empty values for the missing tail rather than throwing — the ragged
 * count is reported separately so the operator can decide.
 */
export function toCandidates(
  parsed: ParsedCsv,
  mapping: Partial<Record<CsvField, number>>,
): CsvCandidate[] {
  return parsed.rows.map((row) => {
    const c: CsvCandidate = {};
    for (const { key } of CSV_FIELDS) {
      const idx = mapping[key];
      if (idx === undefined) continue;
      const value = (row[idx] ?? "").trim();
      if (value) c[key] = value;
    }
    return c;
  });
}

/** A row with nothing identifying in it cannot become a lead. */
export function isImportable(c: CsvCandidate): boolean {
  return Boolean(c.email || c.linkedinUrl || c.contactName || c.companyName);
}

export interface MappingProblem {
  message: string;
}

/** Blocking problems with the current mapping, shown before the dedupe step. */
export function validateMapping(
  parsed: ParsedCsv,
  mapping: Partial<Record<CsvField, number>>,
): MappingProblem[] {
  const problems: MappingProblem[] = [];
  const mapped = Object.values(mapping).filter((v) => v !== undefined);
  if (mapped.length === 0) {
    problems.push({ message: "Map at least one column before continuing." });
    return problems;
  }
  const candidates = toCandidates(parsed, mapping);
  const importable = candidates.filter(isImportable).length;
  if (importable === 0) {
    problems.push({
      message:
        "None of these rows have a name, email, LinkedIn URL or company — check the column mapping.",
    });
  }
  return problems;
}
