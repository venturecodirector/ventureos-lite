"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The scrolling middle section of the sidebar.
 *
 * A client component for one reason: the fade masks have to know whether
 * anything is actually clipped. A static gradient would dim the first nav item
 * even when the list is scrolled to the top, and CSS scroll-driven animations
 * (`animation-timeline: scroll()`) are still Chromium-only — a fade that only
 * works in one browser is worse than one that works everywhere for thirty
 * lines of state.
 */
export function SidebarNav({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement | null>(null);
  const [fade, setFade] = useState({ top: false, bottom: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 1px of tolerance: sub-pixel layout otherwise leaves a permanent bottom
    // fade on lists that fit exactly.
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setFade((f) => (f.top === top && f.bottom === bottom ? f : { top, bottom }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();

    // Re-measure when the viewport, the rail's own size, or its contents change
    // — a shorter window is exactly when the fade starts mattering.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  return (
    <nav
      ref={ref}
      onScroll={measure}
      data-testid="sidebar-nav"
      data-fade-top={fade.top}
      data-fade-bottom={fade.bottom}
      className="brand-scroll nav-fade flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain pr-1"
    >
      {children}
    </nav>
  );
}
