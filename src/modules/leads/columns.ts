/**
 * The leads table's column registry (playbook-v2 P3/2).
 *
 * Kept as data rather than as JSX so a saved view can name its columns, the
 * column picker can enumerate them, and CSV export can reuse exactly the same
 * set the user is looking at. The renderer lives in the table component; this
 * is the part that has to be serialisable.
 */

import type { SortField } from "./filters";

export interface ColumnDef {
  key: string;
  label: string;
  /** Which sort field this column maps to, when it is sortable at all. */
  sortField?: SortField;
  /** Right-aligned numerics get tabular figures (design system). */
  numeric?: boolean;
  /** Hidden on narrow screens — the table drops to the essentials at <700px. */
  secondary?: boolean;
}

export const COLUMNS: readonly ColumnDef[] = [
  { key: "contact", label: "Lead", sortField: "contactName" },
  { key: "company", label: "Company", sortField: "company" },
  { key: "title", label: "Title", secondary: true },
  { key: "email", label: "Email", secondary: true },
  { key: "phone", label: "Phone", secondary: true },
  { key: "industry", label: "Industry", secondary: true },
  { key: "city", label: "City", secondary: true },
  { key: "icpScore", label: "ICP score", sortField: "icpScore", numeric: true },
  { key: "stage", label: "Stage", sortField: "stage" },
  { key: "signals", label: "Signals" },
  { key: "source", label: "Source", secondary: true },
  { key: "owner", label: "Owner", secondary: true },
  { key: "lastActivity", label: "Last activity", sortField: "lastActivityAt", secondary: true },
  { key: "created", label: "Created", sortField: "createdAt", secondary: true },
] as const;

export const COLUMN_KEYS: readonly string[] = COLUMNS.map((c) => c.key);

/**
 * What the table shows before anyone chooses. Deliberately the same five the
 * pre-P3/2 table showed, plus company — so the surface people already knew does
 * not rearrange itself under them on upgrade.
 */
export const DEFAULT_COLUMNS: readonly string[] = [
  "contact",
  "company",
  "icpScore",
  "signals",
  "stage",
];

/**
 * The one column that cannot be turned off: it carries the link that opens the
 * lead. A table whose rows cannot be opened is not a table, it is a report.
 */
export const REQUIRED_COLUMN = "contact";

export function columnDef(key: string): ColumnDef | undefined {
  return COLUMNS.find((c) => c.key === key);
}
