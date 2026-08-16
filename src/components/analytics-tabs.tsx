"use client";

import Link from "next/link";

/**
 * Analytics gained a second surface in playbook-v3 P11/1b, so it needs a way to
 * choose between them.
 *
 * Plain links with a query parameter rather than client state: the tab is then
 * linkable, survives a refresh, and each side is server-rendered with only its
 * own data — the Revenue tab reads the whole event log, which there is no
 * reason to load for someone looking at the funnel.
 */
const TABS = [
  { key: "performance", label: "Performance" },
  { key: "revenue", label: "Revenue" },
] as const;

export function AnalyticsTabs({ active }: { active: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-line pb-2">
      {TABS.map((tab) => {
        const on = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.key === "performance" ? "/analytics" : `/analytics?tab=${tab.key}`}
            data-testid={`analytics-tab-${tab.key}`}
            aria-current={on}
            className={`rounded-[10px] px-3 py-1.5 text-[12.5px] font-semibold ${
              on
                ? "border border-accent bg-accent-soft text-[#E4D3FF]"
                : "border border-transparent text-muted hover:bg-panel-2 hover:text-ink"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
