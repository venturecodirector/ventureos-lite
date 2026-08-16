"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  markAllNotificationsRead,
  markNotificationsRead,
  myNotifications,
  myUnreadCount,
} from "@/modules/notifications/actions";
import { NOTIFICATION_TYPE_DEFS, isNotificationType } from "@/modules/notifications/types";
import type { NotificationView } from "@/modules/notifications/store";

/**
 * The bell and the notification centre (playbook-v2 P6/1).
 *
 * The unread count is server-rendered into `initialUnread` so the badge is
 * right on first paint rather than popping in a moment later. The LIST is
 * fetched only when the panel opens: it is the expensive half and most page
 * loads never open it.
 */

/** How often the badge re-checks while the tab is open. */
const POLL_MS = 60_000;

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3a6 6 0 0 0-6 6v3.6L4.5 15.5h15L18 12.6V9a6 6 0 0 0-6-6Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9.5 18a2.5 2.5 0 0 0 5 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** "3 min ago" — a bell is scanned, not read. */
function ago(at: Date | string): string {
  const then = typeof at === "string" ? new Date(at) : at;
  const mins = Math.floor((Date.now() - then.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return then.toISOString().slice(0, 10);
}

function typeLabel(type: string): string {
  return isNotificationType(type) ? NOTIFICATION_TYPE_DEFS[type].label : type;
}

export function NotificationBell({
  initialUnread,
  testId = "notification-bell",
}: {
  initialUnread: number;
  /**
   * The shell renders one bell per header and hides the other by breakpoint,
   * so both are in the DOM at once. Distinct ids keep a test (and a screen
   * reader walking the tree) from finding the invisible one — the same reason
   * BudgetMeter takes `compact`.
   */
  testId?: string;
}) {
  const router = useRouter();
  const [unread, setUnread] = useState(initialUnread);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // The server-rendered count is authoritative on navigation.
  useEffect(() => setUnread(initialUnread), [initialUnread]);

  const refreshCount = useCallback(async () => {
    try {
      setUnread(await myUnreadCount());
    } catch {
      // A failed poll is not worth a visible error; the next one will do.
    }
  }, []);

  useEffect(() => {
    // Only poll while the tab is actually being looked at — a backgrounded tab
    // polling every minute for hours is pure waste.
    const tick = () => {
      if (document.visibilityState === "visible") void refreshCount();
    };
    const id = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refreshCount]);

  // Click-away and Escape close the panel.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    setBusy(true);
    try {
      const list = await myNotifications();
      setItems(list);
      setUnread(list.filter((n) => !n.readAt).length);
    } finally {
      setBusy(false);
    }
  }

  /** Opening one marks it read, then follows its deep link. */
  async function openItem(item: NotificationView) {
    setOpen(false);
    if (!item.readAt) {
      setUnread((u) => Math.max(0, u - 1));
      setItems((list) =>
        list?.map((n) => (n.id === item.id ? { ...n, readAt: new Date() } : n)) ?? null,
      );
      await markNotificationsRead([item.id]).catch(() => {});
    }
    router.push(item.href);
  }

  async function markAll() {
    setBusy(true);
    try {
      await markAllNotificationsRead();
      setUnread(0);
      setItems((list) => list?.map((n) => ({ ...n, readAt: n.readAt ?? new Date() })) ?? null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex-none" ref={panelRef}>
      <button
        type="button"
        onClick={toggle}
        data-testid={testId}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        className="relative grid h-9 w-9 place-items-center rounded-[10px] border border-line bg-panel text-muted hover:bg-panel-2 hover:text-ink"
      >
        <BellIcon />
        {unread > 0 && (
          <span
            data-testid={`${testId}-badge`}
            className="absolute -right-1 -top-1 min-w-[17px] rounded-full bg-grad px-1 text-[10px] font-bold leading-[17px] text-ink"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid={`${testId}-panel`}
          className="absolute right-0 top-[calc(100%+8px)] z-40 w-[min(380px,calc(100vw-32px))] overflow-hidden rounded-card border border-line bg-[#050A25] shadow-glow-lg"
        >
          <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
            <b className="text-[13px]">Notifications</b>
            {unread > 0 && (
              <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] text-[#E4D3FF]">
                {unread} new
              </span>
            )}
            <button
              type="button"
              onClick={markAll}
              disabled={busy || unread === 0}
              data-testid={`${testId}-mark-all`}
              className="ml-auto text-[12px] text-muted underline hover:text-ink disabled:opacity-40 disabled:no-underline"
            >
              Mark all read
            </button>
          </div>

          <div className="max-h-[min(60vh,420px)] overflow-y-auto">
            {busy && items === null && (
              <p className="px-3.5 py-6 text-center text-[12.5px] text-muted">Loading…</p>
            )}
            {items !== null && items.length === 0 && (
              <p
                data-testid={`${testId}-empty`}
                className="px-3.5 py-8 text-center text-[12.5px] text-muted"
              >
                Nothing yet. Replies, due callbacks and approvals land here.
              </p>
            )}
            {items?.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => openItem(n)}
                data-testid={`${testId}-item`}
                data-read={n.readAt ? "true" : "false"}
                className={`block w-full border-b border-line px-3.5 py-2.5 text-left last:border-b-0 hover:bg-panel-2 ${
                  n.readAt ? "" : "bg-accent-soft/15"
                }`}
              >
                <span className="flex items-center gap-2">
                  {!n.readAt && (
                    <i aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-accent-ink" />
                  )}
                  <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted">
                    {typeLabel(n.type)}
                  </span>
                  <span className="ml-auto flex-none text-[11px] text-muted">
                    {ago(n.createdAt)}
                  </span>
                </span>
                <b className="mt-0.5 block text-[13px] leading-snug">{n.title}</b>
                {n.body && (
                  <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-muted">
                    {n.body}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
