"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createPost,
  deletePost,
  draftPostWithClaude,
  movePost,
  updatePost,
  type ContentBoardView,
  type ContentPostView,
} from "@/modules/content/actions";
import {
  CHANNELS,
  CONTENT_STATUSES,
  STATUS_LABEL,
  allowedTransitions,
  maxCharsFor,
  type ContentStatus,
} from "@/modules/content/board";
import { Modal } from "./modal";

const CARD = "rounded-card border border-line bg-panel p-3";
const BTN =
  "min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const BTN_PRIMARY =
  "min-h-[40px] rounded-[9px] bg-grad px-3.5 py-2 text-[12.5px] font-semibold text-ink shadow-glow transition-opacity disabled:opacity-45 disabled:shadow-none";
const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-2 text-[13px] text-ink outline-none focus:border-accent";

const COLUMN_HINT: Record<ContentStatus, string> = {
  DRAFT: "Being written",
  IN_REVIEW: "Waiting on an Owner or Admin",
  APPROVED: "Ready to post",
  PUBLISHED: "Live — recorded by hand",
};

/**
 * How far the pointer may travel between press and release and still count as
 * a click. Same value and reasoning as the pipeline board: without it, the
 * drift of starting a drag opens the editor on top of the drag you wanted.
 */
const DRAG_THRESHOLD_PX = 5;

export function ContentHub({ board }: { board: ContentBoardView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [openId, setOpenId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<ContentStatus | null>(null);
  /**
   * Optimistic placement while the server decides. A refused move clears it and
   * the card snaps back to where it came from — the board never shows a state
   * the server did not agree to.
   */
  const [optimistic, setOptimistic] = useState<{ id: string; to: ContentStatus } | null>(null);
  const draggedRef = useRef(false);
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const [moveMenuFor, setMoveMenuFor] = useState<string | null>(null);

  const byStatus = useMemo(() => {
    const map = new Map<ContentStatus, ContentPostView[]>();
    for (const s of CONTENT_STATUSES) map.set(s, []);
    for (const p of board.posts) {
      const status = optimistic?.id === p.id ? optimistic.to : p.status;
      map.get(status)?.push(p);
    }
    return map;
  }, [board.posts, optimistic]);

  function moveTo(post: ContentPostView, to: ContentStatus) {
    if (post.status === to) return;
    setMsg(null);
    setMoveMenuFor(null);
    setOptimistic({ id: post.id, to });
    startTransition(async () => {
      const res = await movePost({ id: post.id, to });
      if (!res.ok) {
        // Snap back, and say why — a card silently returning is a mystery.
        setOptimistic(null);
        setMsg({ kind: "err", text: res.error });
        return;
      }
      // Deliberately do NOT clear the optimistic placement here. router.refresh
      // is async, so clearing now drops the card back into its old column until
      // the new data arrives — a visible flash backwards after a move that
      // actually succeeded. The effect below clears it once the server agrees.
      router.refresh();
    });
  }

  // Retire the optimistic placement only when the refreshed board reports the
  // same status, so there is no window where the card sits in the old column.
  useEffect(() => {
    if (!optimistic) return;
    const post = board.posts.find((p) => p.id === optimistic.id);
    if (post && post.status === optimistic.to) setOptimistic(null);
  }, [board.posts, optimistic]);

  const open = board.posts.find((p) => p.id === openId) ?? null;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, okText?: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setMsg({ kind: "err", text: res.error ?? "That did not work." });
      else if (okText) setMsg({ kind: "ok", text: okText });
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold lowercase tracking-display">
            content hub
          </h2>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Company-page posts. Claude drafts in a locked brand voice; a human
            approves and posts.
          </p>
        </div>
        <button
          type="button"
          className={BTN_PRIMARY}
          data-testid="content-new"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await createPost({ channel: "linkedin" });
              if (res.ok) {
                setOpenId(res.id);
                router.refresh();
              } else {
                setMsg({ kind: "err", text: res.error });
              }
            })
          }
        >
          + New post
        </button>
      </div>

      {msg && (
        <p
          role="status"
          data-testid="content-message"
          className={`rounded-[8px] border px-3 py-2 text-[12.5px] ${
            msg.kind === "ok"
              ? "border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] text-[#8CEFC0]"
              : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] text-[#FFB3C2]"
          }`}
        >
          {msg.text}
        </p>
      )}

      {/* Swipeable columns on a phone, four across on desktop. */}
      <div
        className="grid snap-x snap-mandatory auto-cols-[82vw] grid-flow-col items-start gap-3 overflow-x-auto pb-3 nav:auto-cols-fr nav:grid-flow-row nav:grid-cols-4 nav:overflow-visible"
        data-testid="content-board"
        data-pending={pending}
      >
        {CONTENT_STATUSES.map((status) => {
          const posts = byStatus.get(status) ?? [];
          return (
            <section
              key={status}
              data-testid={`content-col-${status}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(status);
              }}
              onDragLeave={() => setDragOver((s) => (s === status ? null : s))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                // One move at a time. A second drop while the first is still
                // in flight is judged by the server against the OLD status and
                // refused, which looks to the user like the board rejecting a
                // legal move.
                if (pending) return;
                const post = board.posts.find((c) => c.id === dragId);
                if (post) moveTo(post, status);
              }}
              className={`min-h-[160px] snap-start rounded-card border bg-panel p-2.5 ${
                dragOver === status
                  ? "border-accent shadow-[0_0_20px_rgba(116,39,198,0.3)_inset]"
                  : "border-line"
              }`}
            >
              <header className="flex items-baseline gap-2 px-1 pb-2.5">
                <h3 className="text-[12.5px] font-semibold text-ink">{STATUS_LABEL[status]}</h3>
                <span className="text-[11px] text-muted tabular-nums">{posts.length}</span>
              </header>
              <p className="px-1 pb-2 text-[10.5px] uppercase tracking-[0.1em] text-muted">
                {COLUMN_HINT[status]}
              </p>

              {posts.length === 0 && (
                <p className="px-1 py-3 text-[12px] text-muted">Nothing here.</p>
              )}

              {posts.map((p) => (
                <div
                  key={p.id}
                  draggable
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${p.title}`}
                  data-testid="content-card"
                  onDragStart={() => {
                    draggedRef.current = true;
                    setDragId(p.id);
                  }}
                  onDragEnd={() => setDragId(null)}
                  onPointerDown={(e) => {
                    pressRef.current = { x: e.clientX, y: e.clientY };
                    draggedRef.current = false;
                  }}
                  onClick={(e) => {
                    // The Move to… control handles itself.
                    if ((e.target as HTMLElement).closest("button")) return;
                    if (draggedRef.current) return;
                    const start = pressRef.current;
                    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_THRESHOLD_PX) {
                      return;
                    }
                    setOpenId(p.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOpenId(p.id);
                    }
                  }}
                  className={`mb-2 w-full cursor-pointer rounded-[11px] border bg-panel-2 p-2.5 text-left transition-shadow hover:border-accent-soft hover:shadow-[0_0_16px_rgba(116,39,198,0.25)] focus:outline-none focus-visible:border-accent ${
                    dragId === p.id ? "border-accent opacity-60" : "border-line"
                  }`}
                >
                  <span className="mb-1 inline-block rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-muted">
                    {STATUS_LABEL[p.status]}
                  </span>
                  <b className="block text-[13px] text-ink">{p.title}</b>
                  {/* No `block` here: line-clamp needs display:-webkit-box, and `block`
                      overrides it — which is why the excerpt was never actually
                      clamped. */}
                  <span className="mt-0.5 line-clamp-2 text-[11.5px] text-muted">
                    {p.body || "No text yet."}
                  </span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted">
                    <span className="rounded-[5px] border border-line px-1.5 py-px">
                      {CHANNELS.find((c) => c.key === p.channel)?.label ?? p.channel}
                    </span>
                    {p.aiDrafted && (
                      <span className={p.humanEdited ? "text-pos" : "text-warn"}>
                        {p.humanEdited ? "✦ edited" : "✦ unedited draft"}
                      </span>
                    )}
                    {p.overLimit && <span className="text-neg">over limit</span>}
                    {p.publishedAt && <span>{p.publishedAt.slice(0, 10)}</span>}
                  </span>

                  {/*
                    Touch fallback: dragging between columns is awkward on a
                    phone, where the columns are a swipeable carousel and a
                    horizontal drag means "scroll".
                  */}
                  <div className="mt-2 nav:hidden">
                    {moveMenuFor === p.id ? (
                      <div className="flex flex-wrap gap-1.5">
                        {allowedTransitions(p.status, board.isApprover).map((tr) => (
                          <button
                            key={tr.to}
                            type="button"
                            data-testid={`move-to-${tr.to}`}
                            onClick={() => moveTo(p, tr.to)}
                            className="min-h-[36px] rounded-full border border-accent-soft px-3 text-[11.5px] font-semibold text-accent-ink"
                          >
                            {tr.label}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => setMoveMenuFor(null)}
                          className="min-h-[36px] rounded-full border border-line px-3 text-[11.5px] text-muted"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-testid="move-to-open"
                        onClick={() => setMoveMenuFor(p.id)}
                        className="min-h-[36px] rounded-full border border-line px-3 text-[11.5px] text-muted"
                      >
                        Move to…
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </section>
          );
        })}
      </div>

      {open && (
        <PostEditor
          post={open}
          isApprover={board.isApprover}
          pending={pending}
          onClose={() => setOpenId(null)}
          onRun={run}
        />
      )}
    </div>
  );
}

function PostEditor({
  post,
  isApprover,
  pending,
  onClose,
  onRun,
}: {
  post: ContentPostView;
  isApprover: boolean;
  pending: boolean;
  onClose: () => void;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string }>, okText?: string) => void;
}) {
  const [title, setTitle] = useState(post.title);
  const [body, setBody] = useState(post.body);
  const [channel, setChannel] = useState(post.channel);
  const [topic, setTopic] = useState("");
  const [notes, setNotes] = useState("");
  const [rationale, setRationale] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const max = maxCharsFor(channel);
  const over = max !== null && body.length > max;
  const locked = post.status === "PUBLISHED";
  const transitions = allowedTransitions(post.status, isApprover);

  async function draft() {
    setError(null);
    setDrafting(true);
    try {
      const res = await draftPostWithClaude({ id: post.id, topic, notes, language: "HU" });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setTitle(res.title);
      setBody(res.body);
      setRationale(res.rationale || null);
    } finally {
      setDrafting(false);
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="content-editor-title" wide>
      <div className="mb-3 flex items-center gap-2">
        <h3 id="content-editor-title" className="font-display text-lg font-bold lowercase">
          {STATUS_LABEL[post.status].toLowerCase()}
        </h3>
        {post.authorName && (
          <span className="text-[11.5px] text-muted">by {post.authorName}</span>
        )}
        {post.approvedByName && (
          <span className="text-[11.5px] text-muted">· approved by {post.approvedByName}</span>
        )}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="ml-auto text-muted hover:text-ink"
        >
          ✕
        </button>
      </div>

      {error && (
        <p
          role="alert"
          data-testid="content-editor-error"
          className="mb-3 rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] px-3 py-2 text-[12.5px] text-[#FFB3C2]"
        >
          {error}
        </p>
      )}

      {locked && (
        <p className="mb-3 rounded-[8px] border border-line px-3 py-2 text-[12px] text-muted">
          Published{post.publishedAt ? ` on ${post.publishedAt.slice(0, 10)}` : ""}. Reopen it to
          make changes.
          {post.publishedUrl && (
            <>
              {" "}
              <a
                href={post.publishedUrl}
                target="_blank"
                rel="noreferrer"
                className="text-accent-ink underline-offset-2 hover:underline"
              >
                View post
              </a>
            </>
          )}
        </p>
      )}

      {/* ---------- Claude draft ---------- */}
      {!locked && (
        <div className="mb-3 rounded-[11px] border border-line p-3">
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
            Draft with Claude · brand voice is fixed
          </p>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What is the post about?"
              data-testid="content-topic"
              className={INPUT}
            />
            <button
              type="button"
              className={BTN_PRIMARY}
              data-testid="content-draft"
              disabled={drafting || topic.trim().length < 3}
              onClick={draft}
            >
              {drafting ? "Drafting…" : "✦ Draft"}
            </button>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Facts to include (optional) — no invented numbers"
              className={`${INPUT} sm:col-span-2`}
            />
          </div>
          {rationale && (
            <p className="mt-2 text-[12px] text-muted">
              <b className="text-ink">Angle:</b> {rationale}
            </p>
          )}
        </div>
      )}

      {/* ---------- editor ---------- */}
      <div className="grid gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={locked}
          placeholder="Internal title"
          data-testid="content-title"
          className={INPUT}
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={locked}
          rows={12}
          placeholder="The post…"
          data-testid="content-body"
          className={`${INPUT} resize-y leading-relaxed`}
        />
        <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            disabled={locked}
            data-testid="content-channel"
            className="rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
          >
            {CHANNELS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          {max !== null && (
            <span className={over ? "font-semibold text-neg tabular-nums" : "text-muted tabular-nums"}>
              {body.length} / {max}
            </span>
          )}
          {post.aiDrafted && (
            <span className={post.humanEdited ? "text-pos" : "text-warn"}>
              {post.humanEdited ? "edited by a human" : "still Claude's words"}
            </span>
          )}
        </div>
      </div>

      {/* ---------- actions ---------- */}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className={BTN}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(body);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setError("Could not copy — select the text and copy it manually.");
            }
          }}
          disabled={!body.trim()}
        >
          {copied ? "Copied ✓" : "Copy text"}
        </button>

        {!locked && (
          <button
            type="button"
            className={BTN}
            data-testid="content-save"
            disabled={pending}
            onClick={() => onRun(() => updatePost({ id: post.id, title, body, channel }), "Saved.")}
          >
            Save
          </button>
        )}

        {transitions.map((t) => (
          <button
            key={t.to}
            type="button"
            className={t.to === "APPROVED" || t.to === "PUBLISHED" ? BTN_PRIMARY : BTN}
            data-testid={`content-move-${t.to}`}
            disabled={pending}
            onClick={() =>
              onRun(async () => {
                // Persist edits first, so the gate judges what is on screen.
                if (!locked) {
                  const saved = await updatePost({ id: post.id, title, body, channel });
                  if (!saved.ok) return saved;
                }
                const res = await movePost({ id: post.id, to: t.to });
                if (res.ok) onClose();
                return res;
              }, `${t.label}.`)
            }
          >
            {t.label}
          </button>
        ))}

        <button
          type="button"
          className={BTN}
          data-testid="content-delete"
          disabled={pending}
          onClick={() =>
            onRun(async () => {
              const res = await deletePost({ id: post.id });
              if (res.ok) onClose();
              return res;
            }, "Deleted.")
          }
        >
          Delete
        </button>
      </div>
    </Modal>
  );
}
