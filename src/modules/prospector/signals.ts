/**
 * What Google knows that is worth keeping as a signal rather than a column.
 *
 * The rating and the review count arrived with every search, were shown in the
 * results table, and were then dropped on the floor the moment the row became a
 * lead — so the one piece of evidence that a business is real and active never
 * reached the person who had to work it.
 *
 * Signals are informational: they do not feed the ICP score (that comes from
 * research), so putting Google's numbers here cannot move a lead through the
 * score gate on its own.
 */
export function googleSignals(input: {
  rating?: number | null;
  reviews?: number | null;
  businessStatus?: string | null;
}): string[] {
  const out: string[] = [];
  if (typeof input.rating === "number") {
    const count = typeof input.reviews === "number" ? ` (${input.reviews} reviews)` : "";
    out.push(`Google ${input.rating.toFixed(1)}★${count}`);
  } else if (typeof input.reviews === "number" && input.reviews > 0) {
    out.push(`Google: ${input.reviews} reviews`);
  }
  if (input.businessStatus === "CLOSED_PERMANENTLY") out.push("Permanently closed on Google");
  if (input.businessStatus === "CLOSED_TEMPORARILY") out.push("Temporarily closed on Google");
  return out;
}
