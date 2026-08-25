"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { callClaude } from "@/lib/ai/call-claude";
import { BudgetExceededError } from "@/lib/ai/budget";
import { brandFrom } from "@/modules/workspaces/brand";
import {
  CONTENT_DRAFT_SYSTEM,
  buildContentMessage,
  contentDraftSchema,
  type ContentDraft,
} from "@/lib/ai/prompts/content-draft";
import {
  CHANNELS,
  CONTENT_STATUSES,
  canTransition,
  isChannel,
  isOverLimit,
  maxCharsFor,
  labelFor,
  validateForStatus,
  type ContentStatus,
} from "./board";
import { isTrustedMember } from "@/lib/grants";

/**
 * Content Hub (spec §4.12). Every read and write goes through
 * getWorkspaceClient, so posts are confined to the active workspace
 * (CLAUDE.md hard rule #1).
 */

/** One channel's text within a topic. */
export interface ContentVariantView {
  id: string;
  channel: string;
  body: string;
  aiDrafted: boolean;
  /** Live comparison, not a stored flag. */
  humanEdited: boolean;
  publishedAt: string | null;
  publishedUrl: string | null;
  maxChars: number | null;
  overLimit: boolean;
}

export interface ContentPostView {
  id: string;
  title: string;
  status: ContentStatus;
  /** Every channel this topic has been written for, in CHANNELS order. */
  variants: ContentVariantView[];
  authorName: string | null;
  approvedByName: string | null;
  publishedAt: string | null;
  reviewNote: string | null;
  /** True when any variant is an unedited Claude draft — the card shows it. */
  hasUneditedDraft: boolean;
  /** True when any variant is over its channel's character limit. */
  anyOverLimit: boolean;
  updatedAt: string;
}

export interface ContentBoardView {
  posts: ContentPostView[];
  /** Owner/Admin may approve and reopen. */
  isApprover: boolean;
}

async function nameMap(ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return new Map();
  // `users` is global, not workspace-scoped; ids come from this workspace's rows.
  const users = await prismaUnsafe.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
}

export async function getContentBoard(): Promise<ContentBoardView> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const [posts, membership] = await Promise.all([
    db.contentPost.findMany({
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: { variants: true },
    }),
    prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { role: true },
    }),
  ]);
  const names = await nameMap(posts.flatMap((p) => [p.authorUserId, p.approvedBy]));

  return {
    isApprover: isTrustedMember(membership?.role),
    posts: posts.map((p) => {
      const variants = toVariantViews(p.variants);
      return {
        id: p.id,
        title: p.title,
        status: p.status as ContentStatus,
        variants,
        authorName: p.authorUserId ? (names.get(p.authorUserId) ?? null) : null,
        approvedByName: p.approvedBy ? (names.get(p.approvedBy) ?? null) : null,
        publishedAt: p.publishedAt?.toISOString() ?? null,
        reviewNote: p.reviewNote,
        hasUneditedDraft: variants.some((v) => v.aiDrafted && !v.humanEdited),
        anyOverLimit: variants.some((v) => v.overLimit),
        updatedAt: p.updatedAt.toISOString(),
      };
    }),
  };
}

/** In CHANNELS order, so the tabs never reshuffle as variants are added. */
function toVariantViews(
  rows: Array<{
    id: string;
    channel: string;
    body: string;
    aiDrafted: boolean;
    aiDraftBody: string | null;
    publishedAt: Date | null;
    publishedUrl: string | null;
  }>,
): ContentVariantView[] {
  const order = new Map(CHANNELS.map((c, i) => [c.key as string, i]));
  return [...rows]
    .sort((a, b) => (order.get(a.channel) ?? 99) - (order.get(b.channel) ?? 99))
    .map((v) => ({
      id: v.id,
      channel: v.channel,
      body: v.body,
      aiDrafted: v.aiDrafted,
      humanEdited: v.aiDrafted ? normalize(v.aiDraftBody) !== normalize(v.body) : true,
      publishedAt: v.publishedAt?.toISOString() ?? null,
      publishedUrl: v.publishedUrl,
      maxChars: maxCharsFor(v.channel),
      overLimit: isOverLimit(v.channel, v.body),
    }));
}

function normalize(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// create / edit
// ---------------------------------------------------------------------------

const createSchema = z.object({
  title: z.string().trim().max(200).default(""),
  body: z.string().max(20_000).default(""),
  channel: z.string().refine(isChannel, "Unknown channel").default("linkedin"),
});

export async function createPost(
  raw: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the post details." };

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const post = await db.contentPost.create({
    data: {
      workspaceId,
      title: parsed.data.title || "Untitled post",
      status: "DRAFT",
      authorUserId: userId,
    },
    select: { id: true },
  });
  /**
   * A separate create, deliberately: a nested write through the relation does
   * NOT go through the tenant guard, so `workspace_id` would come from the
   * caller rather than from the session. Every guarded model gets its own call.
   */
  await db.contentVariant.create({
    data: { workspaceId, postId: post.id, channel: parsed.data.channel, body: parsed.data.body },
  });
  revalidatePath("/content");
  return { ok: true, id: post.id };
}

// ---------------------------------------------------------------------------
// variants — one channel's text within a topic
// ---------------------------------------------------------------------------

/**
 * Give the topic a channel it does not have yet.
 *
 * This is the whole point of the change: the same subject as a LinkedIn post, a
 * blog article and a newsletter, inside one card, moving through review once.
 */
export async function addVariant(
  raw: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const parsed = z
    .object({
      postId: z.string().min(1),
      channel: z.string().refine(isChannel, "Unknown channel"),
      body: z.string().max(20_000).default(""),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the channel." };

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const post = await db.contentPost.findUnique({
    where: { id: parsed.data.postId },
    select: { id: true, status: true },
  });
  if (!post) return { ok: false, error: "Post not found." };
  if (post.status === "PUBLISHED") {
    return { ok: false, error: "Reopen the post before adding a channel." };
  }
  const clash = await db.contentVariant.findFirst({
    where: { postId: post.id, channel: parsed.data.channel },
    select: { id: true },
  });
  if (clash) {
    return { ok: false, error: `This topic already has a ${labelFor(parsed.data.channel)} version.` };
  }

  const created = await db.contentVariant.create({
    data: {
      workspaceId,
      postId: post.id,
      channel: parsed.data.channel,
      body: parsed.data.body,
    },
    select: { id: true },
  });
  revalidatePath("/content");
  return { ok: true, id: created.id };
}

/** Remove one channel's version, leaving the topic and the others alone. */
export async function deleteVariant(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.object({ id: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown version." };

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const variant = await db.contentVariant.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, channel: true, post: { select: { status: true } } },
  });
  if (!variant) return { ok: false, error: "Version not found." };
  if (variant.post.status === "PUBLISHED") {
    return { ok: false, error: "Reopen the post before removing a channel." };
  }
  await db.contentVariant.delete({ where: { id: variant.id } });
  revalidatePath("/content");
  return { ok: true };
}

const updateSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().max(200),
  /** One channel's text. Omitted when only the topic's title changed. */
  variant: z
    .object({ id: z.string().min(1), body: z.string().max(20_000) })
    .optional(),
});

export async function updatePost(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the post details." };

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const existing = await db.contentPost.findUnique({
    where: { id: parsed.data.id },
    select: { status: true },
  });
  if (!existing) return { ok: false, error: "Post not found." };
  if (existing.status === "PUBLISHED") {
    return { ok: false, error: "Reopen the post before editing it." };
  }

  if (parsed.data.variant) {
    // Scoped to this post, so an id from another topic cannot be written here.
    const { count } = await db.contentVariant.updateMany({
      where: { id: parsed.data.variant.id, postId: parsed.data.id },
      data: { body: parsed.data.variant.body },
    });
    if (count === 0) return { ok: false, error: "That version is not on this post." };
  }
  await db.contentPost.update({
    where: { id: parsed.data.id },
    data: { title: parsed.data.title || "Untitled post" },
  });
  revalidatePath("/content");
  return { ok: true };
}

export async function deletePost(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.object({ id: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown post." };
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const { count } = await db.contentPost.deleteMany({ where: { id: parsed.data.id } });
  if (count === 0) return { ok: false, error: "Post not found." };
  revalidatePath("/content");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// status transitions
// ---------------------------------------------------------------------------

const moveSchema = z.object({
  id: z.string().min(1),
  to: z.enum(CONTENT_STATUSES),
  reviewNote: z.string().max(2000).optional(),
  publishedUrl: z.string().max(500).optional(),
  /** Which channel the URL belongs to. Unambiguous when there is only one. */
  publishedChannel: z.string().optional(),
});

/**
 * Move a post along the board. The legality of the move AND the permission to
 * make it are both checked here — the UI hides what you cannot do, but this is
 * where it is enforced.
 */
export async function movePost(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = moveSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the request." };

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const [post, membership] = await Promise.all([
    db.contentPost.findUnique({
      where: { id: parsed.data.id },
      include: { variants: { select: { id: true, channel: true, body: true } } },
    }),
    prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { role: true },
    }),
  ]);
  if (!post) return { ok: false, error: "Post not found." };

  const isApprover = isTrustedMember(membership?.role);
  const check = canTransition(post.status as ContentStatus, parsed.data.to, isApprover);
  if (!check.allowed) return { ok: false, error: check.message };

  const gate = validateForStatus({
    status: parsed.data.to,
    title: post.title,
    variants: post.variants,
  });
  if (!gate.ok) return { ok: false, error: gate.message };

  const now = new Date();
  await db.contentPost.update({
    where: { id: post.id },
    data: {
      status: parsed.data.to,
      reviewNote: parsed.data.reviewNote ?? post.reviewNote,
      ...(parsed.data.to === "APPROVED" ? { approvedBy: userId, approvedAt: now } : {}),
      ...(parsed.data.to === "PUBLISHED" ? { publishedAt: now } : {}),
      // Reopening clears the previous sign-off; it has to be earned again.
      ...(parsed.data.to === "DRAFT"
        ? { approvedBy: null, approvedAt: null, publishedAt: null }
        : {}),
    },
  });

  /**
   * Publishing stamps every channel's version.
   *
   * A topic is marked published once, but each channel was posted somewhere of
   * its own — so the date goes on all of them and the URL, when one is given,
   * goes on the channel it belongs to. `publishedChannel` says which; with a
   * single-variant topic there is no ambiguity and it is optional.
   */
  if (parsed.data.to === "PUBLISHED") {
    await db.contentVariant.updateMany({
      where: { postId: post.id },
      data: { publishedAt: now },
    });
    if (parsed.data.publishedUrl) {
      const target =
        post.variants.find((v) => v.channel === parsed.data.publishedChannel) ??
        (post.variants.length === 1 ? post.variants[0] : null);
      if (target) {
        await db.contentVariant.updateMany({
          where: { id: target.id, postId: post.id },
          data: { publishedUrl: parsed.data.publishedUrl },
        });
      }
    }
  }
  if (parsed.data.to === "DRAFT") {
    await db.contentVariant.updateMany({
      where: { postId: post.id },
      data: { publishedAt: null, publishedUrl: null },
    });
  }

  // Every status change is logged, not just the editorial ones. Who sent a
  // post back to draft, and when, is exactly the question asked after the
  // fact — and a trail with holes in it is not a trail.
  const ACTION: Record<string, string> = {
    APPROVED: "content.approved",
    PUBLISHED: "content.published",
    IN_REVIEW: "content.submitted",
    DRAFT: "content.reopened",
  };
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: ACTION[parsed.data.to] ?? "content.status_changed",
      entityType: "ContentPost",
      entityId: post.id,
      meta: {
        title: post.title,
        channels: post.variants.map((v) => v.channel),
        from: post.status,
        to: parsed.data.to,
      },
    },
  });

  revalidatePath("/content");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Claude draft (manual trigger only)
// ---------------------------------------------------------------------------

const draftSchema = z.object({
  id: z.string().min(1),
  /** Which channel's version to draft. Optional when the topic has only one. */
  variantId: z.string().optional(),
  topic: z.string().trim().min(3).max(500),
  notes: z.string().max(2000).optional(),
  language: z.enum(["HU", "EN"]).default("HU"),
});

/**
 * Draft a post with Claude (Haiku — see the prompt module for why not Sonnet).
 * Manual button only, never on load or save (hard rule #3), and metered by the
 * budget middleware inside callClaude.
 */
export async function draftPostWithClaude(
  raw: unknown,
): Promise<{ ok: true; title: string; body: string; rationale: string } | { ok: false; error: string }> {
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Describe the topic first (a few words)." };

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const post = await db.contentPost.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      status: true,
      variants: { select: { id: true, channel: true } },
    },
  });
  if (!post) return { ok: false, error: "Post not found." };
  if (post.status === "PUBLISHED") return { ok: false, error: "Reopen the post before redrafting." };

  /**
   * Claude drafts ONE channel's version, because the channel decides the shape
   * of the text — a 3000-character LinkedIn post and a blog article are not the
   * same piece of writing with a different length. The caller names it; with a
   * single-variant topic it is the only one there is.
   */
  const variant = parsed.data.variantId
    ? post.variants.find((v) => v.id === parsed.data.variantId)
    : post.variants.length === 1
      ? post.variants[0]
      : undefined;
  if (!variant) {
    return { ok: false, error: "Pick which channel to draft for." };
  }

  const workspace = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { legalName: true, name: true, brand: true },
  });

  let draft: ContentDraft;
  try {
    const { data } = await callClaude({
      useCase: "content_draft",
      workspaceId,
      system: CONTENT_DRAFT_SYSTEM,
      messages: [
        {
          role: "user",
          content: buildContentMessage({
            topic: parsed.data.topic,
            channel: variant.channel,
            language: parsed.data.language,
            notes: parsed.data.notes,
            companyName:
              workspace?.legalName || workspace?.name || brandFrom(workspace?.brand).name,
          }),
        },
      ],
      schema: contentDraftSchema,
    });
    draft = data as ContentDraft;
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      return { ok: false, error: `${e.message} You can still write the post yourself.` };
    }
    return { ok: false, error: "Claude could not draft this. Write it yourself, or retry." };
  }

  await db.contentVariant.updateMany({
    where: { id: variant.id, postId: post.id },
    data: { body: draft.body, aiDrafted: true, aiDraftBody: draft.body },
  });
  // The title belongs to the topic, and the first draft is usually the one that
  // names it. A title already written by a human is not overwritten.
  await db.contentPost.updateMany({
    where: { id: post.id, OR: [{ title: "" }, { title: "Untitled post" }] },
    data: { title: draft.title },
  });
  revalidatePath("/content");
  return { ok: true, title: draft.title, body: draft.body, rationale: draft.rationale };
}
