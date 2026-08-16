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
  CONTENT_STATUSES,
  canTransition,
  isChannel,
  isOverLimit,
  maxCharsFor,
  validateForStatus,
  type ContentStatus,
} from "./board";

/**
 * Content Hub (spec §4.12). Every read and write goes through
 * getWorkspaceClient, so posts are confined to the active workspace
 * (CLAUDE.md hard rule #1).
 */

export interface ContentPostView {
  id: string;
  title: string;
  body: string;
  channel: string;
  status: ContentStatus;
  aiDrafted: boolean;
  /** Live comparison, not a stored flag. */
  humanEdited: boolean;
  authorName: string | null;
  approvedByName: string | null;
  publishedAt: string | null;
  publishedUrl: string | null;
  reviewNote: string | null;
  maxChars: number | null;
  overLimit: boolean;
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
    db.contentPost.findMany({ orderBy: { updatedAt: "desc" }, take: 200 }),
    prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { role: true },
    }),
  ]);
  const names = await nameMap(posts.flatMap((p) => [p.authorUserId, p.approvedBy]));

  return {
    isApprover: membership?.role === "OWNER" || membership?.role === "ADMIN",
    posts: posts.map((p) => ({
      id: p.id,
      title: p.title,
      body: p.body,
      channel: p.channel,
      status: p.status as ContentStatus,
      aiDrafted: p.aiDrafted,
      humanEdited: p.aiDrafted ? normalize(p.aiDraftBody) !== normalize(p.body) : true,
      authorName: p.authorUserId ? (names.get(p.authorUserId) ?? null) : null,
      approvedByName: p.approvedBy ? (names.get(p.approvedBy) ?? null) : null,
      publishedAt: p.publishedAt?.toISOString() ?? null,
      publishedUrl: p.publishedUrl,
      reviewNote: p.reviewNote,
      maxChars: maxCharsFor(p.channel),
      overLimit: isOverLimit(p.channel, p.body),
      updatedAt: p.updatedAt.toISOString(),
    })),
  };
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
      body: parsed.data.body,
      channel: parsed.data.channel,
      status: "DRAFT",
      authorUserId: userId,
    },
    select: { id: true },
  });
  revalidatePath("/content");
  return { ok: true, id: post.id };
}

const updateSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().max(200),
  body: z.string().max(20_000),
  channel: z.string().refine(isChannel, "Unknown channel"),
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

  await db.contentPost.update({
    where: { id: parsed.data.id },
    data: {
      title: parsed.data.title || "Untitled post",
      body: parsed.data.body,
      channel: parsed.data.channel,
    },
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
    db.contentPost.findUnique({ where: { id: parsed.data.id } }),
    prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { role: true },
    }),
  ]);
  if (!post) return { ok: false, error: "Post not found." };

  const isApprover = membership?.role === "OWNER" || membership?.role === "ADMIN";
  const check = canTransition(post.status as ContentStatus, parsed.data.to, isApprover);
  if (!check.allowed) return { ok: false, error: check.message };

  const gate = validateForStatus({
    status: parsed.data.to,
    title: post.title,
    body: post.body,
    channel: post.channel,
  });
  if (!gate.ok) return { ok: false, error: gate.message };

  const now = new Date();
  await db.contentPost.update({
    where: { id: post.id },
    data: {
      status: parsed.data.to,
      reviewNote: parsed.data.reviewNote ?? post.reviewNote,
      ...(parsed.data.to === "APPROVED" ? { approvedBy: userId, approvedAt: now } : {}),
      ...(parsed.data.to === "PUBLISHED"
        ? { publishedAt: now, publishedUrl: parsed.data.publishedUrl || null }
        : {}),
      // Reopening clears the previous sign-off; it has to be earned again.
      ...(parsed.data.to === "DRAFT"
        ? { approvedBy: null, approvedAt: null, publishedAt: null, publishedUrl: null }
        : {}),
    },
  });

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
        channel: post.channel,
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
    select: { id: true, channel: true, status: true },
  });
  if (!post) return { ok: false, error: "Post not found." };
  if (post.status === "PUBLISHED") return { ok: false, error: "Reopen the post before redrafting." };

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
            channel: post.channel,
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

  await db.contentPost.update({
    where: { id: post.id },
    data: {
      title: draft.title,
      body: draft.body,
      aiDrafted: true,
      aiDraftBody: draft.body,
    },
  });
  revalidatePath("/content");
  return { ok: true, title: draft.title, body: draft.body, rationale: draft.rationale };
}
