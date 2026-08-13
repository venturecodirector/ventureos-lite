"use client";

import { useRouter } from "next/navigation";
import {
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  type Locale,
} from "@/lib/locale";

/**
 * The language switcher.
 *
 * Sets the cookie BEFORE navigating, so the choice survives the root
 * redirect — otherwise a visitor who switches to English is sent back to
 * Hungarian by `Accept-Language` the next time they open the page, which reads
 * as the switch being broken.
 *
 * A real link underneath: right-click, middle-click and a crawler following it
 * all work, and the cookie is a preference on top rather than the mechanism.
 */
export function LocaleSwitch({ to, label }: { to: Locale; label: string }) {
  const router = useRouter();

  return (
    <a
      /*
        `/public-audit/<locale>` is the href because it resolves on EVERY host.
        The short `/hu` only exists on the audit domain, where Caddy and the
        middleware rewrite it — on a direct path in development or in the e2e
        suite it would be a 404. The click handler below upgrades to the short
        URL when the visitor is actually on that domain, so the pretty address
        is what they end up with and the plain link still works everywhere.
      */
      href={`/public-audit/${to}`}
      hrefLang={to}
      data-testid="locale-switch"
      onClick={(e) => {
        // Let the browser handle modified clicks (new tab, download, etc.).
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        document.cookie = `${LOCALE_COOKIE}=${to}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
        const onAuditHost = !window.location.pathname.startsWith("/public-audit");
        const target = onAuditHost ? `/${to}` : `/public-audit/${to}`;
        router.push(target);
        router.refresh();
      }}
      className="rounded-full border border-line px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-accent hover:text-ink"
    >
      {label}
    </a>
  );
}
