/**
 * The four weekly KPIs the Friday report measures (spec §4.1, §4.14).
 *
 * A plain module, not the "use server" one beside it: that file may only export
 * async functions, and a const array exported from one fails the production
 * build. Deliberately four metrics and one period — a matrix of periods and
 * owners is worth building once somebody has asked for it.
 */
export const TARGET_METRICS = [
  {
    metric: "invites_sent",
    label: "Kiküldött megkeresés",
    unit: "db / hét",
    hint: "Hány első megkeresés menjen ki egy héten.",
  },
  {
    metric: "acceptance_rate",
    label: "Elfogadási arány",
    unit: "%",
    hint: "A megkeresettek hány százaléka jut el az Elfogadott állapotig.",
  },
  {
    metric: "reply_rate",
    label: "Válaszarány",
    unit: "%",
    hint: "A megkeresettek hány százaléka válaszol egyáltalán.",
  },
  {
    metric: "meetings_booked",
    label: "Lefoglalt találkozó",
    unit: "db / hét",
    hint: "Hány találkozó kerüljön be egy héten.",
  },
] as const;

export type TargetMetric = (typeof TARGET_METRICS)[number]["metric"];
