"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";

export interface MobileNavItem {
  label: string;
  href?: string;
  locked?: boolean;
}

/**
 * Bottom tab bar for phones (CLAUDE.md → Responsive: "<700px → bottom tab bar,
 * 44px touch targets"). Hidden from `nav:` (700px) upward, where the sidebar
 * takes over.
 *
 * Five slots: the four screens the daily loop actually runs through, plus a
 * sheet holding everything else. Anything a BDR touches hourly — the queue, the
 * board, replies, callbacks — is one tap away; the rest is one tap plus a
 * sheet, which is the right trade at this width.
 */
export function MobileNav({
  primary,
  secondary,
  activePath,
  icons,
}: {
  primary: MobileNavItem[];
  secondary: MobileNavItem[];
  activePath?: string;
  /** Icons are rendered server-side and passed in, keyed by label. */
  icons: Record<string, ReactNode>;
}) {
  const [open, setOpen] = useState(false);

  // A route change must close the sheet, or it covers the page just navigated to.
  useEffect(() => {
    setOpen(false);
  }, [activePath]);

  // While the sheet is up, the page behind it must not scroll.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const moreActive = secondary.some((i) => i.href && i.href === activePath);

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-canvas/80 backdrop-blur-sm nav:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      {open && (
        <div
          role="dialog"
          aria-label="More screens"
          className="fixed inset-x-0 bottom-[68px] z-50 max-h-[62vh] overflow-y-auto rounded-t-[18px] border-t border-line bg-canvas px-3 pb-4 pt-3 nav:hidden"
        >
          <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-line" />
          <ul className="grid grid-cols-2 gap-1.5">
            {secondary.map((item) => {
              const active = item.href === activePath;
              const inner = (
                <>
                  <span className="h-[18px] w-[18px] flex-none [&_svg]:h-[18px] [&_svg]:w-[18px]">
                    {icons[item.label]}
                  </span>
                  <span className="truncate">{item.label}</span>
                  {item.locked && <span className="ml-auto text-[10px] opacity-70">🔒</span>}
                </>
              );
              const cls = [
                "flex min-h-[44px] items-center gap-2.5 rounded-[10px] border px-3 text-[13.5px] font-medium",
                active
                  ? "border-line bg-panel-2 text-ink [&_svg]:text-accent-2"
                  : "border-transparent text-muted",
              ].join(" ");
              return (
                <li key={item.label}>
                  {item.href ? (
                    <Link href={item.href} className={cls} onClick={() => setOpen(false)}>
                      {inner}
                    </Link>
                  ) : (
                    <div className={cls}>{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <nav
        aria-label="Primary"
        data-testid="mobile-tabbar"
        className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 border-t border-line bg-canvas/95 pb-[env(safe-area-inset-bottom)] backdrop-blur nav:hidden"
      >
        {primary.map((item) => {
          const active = item.href === activePath;
          return (
            <Link
              key={item.label}
              href={item.href ?? "#"}
              aria-current={active ? "page" : undefined}
              className={[
                // 44px is the floor; 56px gives a comfortable thumb target.
                "flex min-h-[56px] flex-col items-center justify-center gap-1 px-1 text-[10px] font-semibold",
                active ? "text-ink [&_svg]:text-accent-2" : "text-muted",
              ].join(" ")}
            >
              <span className="h-[19px] w-[19px] [&_svg]:h-[19px] [&_svg]:w-[19px]">
                {icons[item.label]}
              </span>
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}

        <button
          type="button"
          aria-expanded={open}
          aria-label="More screens"
          onClick={() => setOpen((v) => !v)}
          className={[
            "flex min-h-[56px] flex-col items-center justify-center gap-1 px-1 text-[10px] font-semibold",
            open || moreActive ? "text-ink [&_svg]:text-accent-2" : "text-muted",
          ].join(" ")}
        >
          <span className="h-[19px] w-[19px] [&_svg]:h-[19px] [&_svg]:w-[19px]">
            {icons.More}
          </span>
          <span>More</span>
        </button>
      </nav>
    </>
  );
}
