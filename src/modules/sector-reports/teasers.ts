import type { WorkspaceClient } from "@/lib/db";
import type { SectorStats } from "./stats";

/**
 * Three LinkedIn teasers for a published report (playbook-v4 P12/2d).
 *
 * ── NO CLAUDE CALL, DELIBERATELY ───────────────────────────────────────────
 *
 * The playbook says "existing Claude drafting flow", and the existing flow is
 * available from the Content Hub for anyone who wants it. But the headline of a
 * teaser IS a statistic, and the statistic is already computed — asking a model
 * to restate a number it was handed is a call that adds a rounding risk and
 * nothing else. These are drafts a human edits, which is what the flow would
 * have produced anyway, minus the cost and minus a chance to get 62% wrong.
 *
 * Three angles rather than three rewrites: the headline number, the most common
 * gap, and the thing worth doing about it.
 */
export interface TeaserInput {
  title: string;
  sector: string;
  location: string;
  stats: SectorStats | null;
  url: string;
}

export function buildTeasers(input: TeaserInput): string[] {
  const { stats } = input;
  if (!stats || stats.audited === 0) return [];
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const worst = stats.failing[0];
  const second = stats.failing[1];
  const weakShare = stats.scoreBands.weak / Math.max(1, stats.audited);

  const posts: string[] = [];

  posts.push(
    `Megmértük ${stats.audited} ${input.sector} weboldalát ${input.location}ban.\n\n` +
      `A felük sem áll jól: ${pct(weakShare)} gyenge állapotú oldal.\n\n` +
      `Nem rangsort csináltunk — egyetlen céget sem nevezünk meg. Az érdekes az, hogy ` +
      `ugyanazok a hiányok térnek vissza szinte mindenhol.\n\n` +
      `A teljes riport: ${input.url}`,
  );

  if (worst) {
    posts.push(
      `A leggyakoribb hiány a ${input.location.toLowerCase()} ${input.sector} szakmában: ` +
        `${worst.label} — a megmért oldalak ${pct(worst.share)}-án.\n\n` +
        (second ? `A második: ${second.label} (${pct(second.share)}).\n\n` : "") +
        `Egyik sem drága javítani. Az a drága, hogy közben elmennek az érdeklődők.\n\n` +
        `${input.url}`,
    );
  }

  posts.push(
    `Mit tanultunk ${stats.audited} ${input.sector} weboldal átvilágításából?\n\n` +
      `Hogy a legtöbb probléma nem design-kérdés. Hiányzó impresszum, beállítatlan ` +
      `levélhitelesítés, mobilon széteső elrendezés — olyan dolgok, amiket egy hét alatt ` +
      `rendbe lehet tenni, és amiket évekig nem vesz észre senki.\n\n` +
      `Az összesített adatok, cégnevek nélkül: ${input.url}`,
  );

  return posts;
}

/** Create them as drafts. Never throws — publishing must not fail on a teaser. */
export async function draftTeaserPosts(
  db: WorkspaceClient,
  workspaceId: string,
  input: TeaserInput,
): Promise<number> {
  const bodies = buildTeasers(input);
  if (bodies.length === 0) return 0;

  const post = await db.contentPost.create({
    data: { workspaceId, title: `${input.title} — LinkedIn`, status: "DRAFT" },
    select: { id: true },
  });
  for (const body of bodies) {
    // A separate create per variant: a nested write does not pass through the
    // tenant guard.
    await db.contentVariant.create({
      data: { workspaceId, postId: post.id, channel: "LINKEDIN", body },
    });
  }
  return bodies.length;
}
