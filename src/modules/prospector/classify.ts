/**
 * Batching for the fit classifier.
 *
 * One Haiku call covers 25 rows — which is what the button has always claimed
 * ("1 Haiku call / 25 rows") and what the code did not do: it classified the
 * first 25 and silently ignored the rest, so a 60-result search came back with
 * 35 unmarked rows and no explanation.
 *
 * The index arithmetic lives here, on its own, because it is the part that can
 * corrupt quietly: every batch asks the model about rows 0..24, so an answer
 * from the third batch applied without its offset would overwrite the verdicts
 * of the first — wrong data rather than missing data.
 */
export const CLASSIFY_BATCH = 25;

export function batchStarts(total: number): number[] {
  const out: number[] = [];
  for (let start = 0; start < total; start += CLASSIFY_BATCH) out.push(start);
  return out;
}

/**
 * Map one batch's answers back onto absolute row positions.
 *
 * Anything outside the batch is dropped rather than clamped: a model that
 * invents index 40 in a batch of 25 has told us nothing about row 40, and
 * writing a guess there is worse than leaving it unclassified.
 */
export function resolveBatchIndices<T extends { index: number }>(
  items: T[],
  offset: number,
  batchLength: number,
): Array<{ row: number; item: T }> {
  const out: Array<{ row: number; item: T }> = [];
  for (const item of items) {
    if (!Number.isInteger(item.index)) continue;
    if (item.index < 0 || item.index >= batchLength) continue;
    out.push({ row: offset + item.index, item });
  }
  return out;
}
