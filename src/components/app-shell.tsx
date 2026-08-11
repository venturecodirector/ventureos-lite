import type { ReactNode } from "react";
import Link from "next/link";
import { getShellContext } from "@/modules/workspaces/actions";
import { WorkspaceSwitcher } from "./workspace-switcher";
import {
  DashboardIcon,
  ProspectorIcon,
  SearchIcon,
  AuditIcon,
  PipelineIcon,
  InboxIcon,
  CallsIcon,
  MeetingsIcon,
  ReferrersIcon,
  CampaignsIcon,
  DocumentsIcon,
  PublicIcon,
  ContentIcon,
  AnalyticsIcon,
  SettingsIcon,
} from "./nav-icons";

type NavItem = {
  label: string;
  icon: ReactNode;
  href?: string;
  count?: number;
  locked?: boolean;
};

// Nav mirroring docs/prototype.html. Items gain hrefs as their screens land.
const NAV: NavItem[] = [
  { label: "Dashboard", icon: <DashboardIcon />, href: "/" },
  { label: "Prospector", icon: <ProspectorIcon />, href: "/prospector" },
  { label: "Lead Engine", icon: <SearchIcon />, href: "/leads" },
  { label: "Site Audit", icon: <AuditIcon />, href: "/audit" },
  { label: "Pipeline", icon: <PipelineIcon />, href: "/pipeline" },
  { label: "Inbox", icon: <InboxIcon />, href: "/inbox" },
  { label: "Calls", icon: <CallsIcon />, href: "/calls" },
  { label: "Meetings", icon: <MeetingsIcon />, href: "/meetings" },
  { label: "Referrers", icon: <ReferrersIcon />, href: "/referrers" },
  { label: "Campaigns", icon: <CampaignsIcon />, href: "/campaigns", locked: true },
  { label: "Documents", icon: <DocumentsIcon />, href: "/documents", locked: true },
  { label: "Public Pages", icon: <PublicIcon /> },
  { label: "Content Hub", icon: <ContentIcon /> },
  { label: "Analytics", icon: <AnalyticsIcon />, href: "/analytics" },
];

function NavRow({ item, activePath }: { item: NavItem; activePath?: string }) {
  const active = item.href ? item.href === activePath : false;
  const className = [
    "flex items-center gap-2.5 rounded-[10px] border px-2.5 py-2 font-medium transition-colors",
    active
      ? "border-line bg-panel-2 text-ink [&_svg]:text-accent-2"
      : "cursor-pointer border-transparent text-muted hover:bg-panel hover:text-ink",
  ].join(" ");
  const inner = (
    <>
      <span className="h-4 w-4 flex-none [&_svg]:h-4 [&_svg]:w-4">{item.icon}</span>
      <span>{item.label}</span>
      {item.count !== undefined && (
        <span className="ml-auto rounded-full bg-accent-soft px-2 py-px text-[11px] font-semibold text-accent-ink tabular-nums">
          {item.count}
        </span>
      )}
      {item.locked && <span className="ml-auto text-[10px] opacity-70">🔒</span>}
    </>
  );
  return item.href ? (
    <Link href={item.href} className={className}>
      {inner}
    </Link>
  ) : (
    <div className={className}>{inner}</div>
  );
}

export async function AppShell({
  children,
  activePath,
}: {
  children?: ReactNode;
  activePath?: string;
}) {
  const shell = await getShellContext();
  const active = shell.workspaces.find((w) => w.active);
  return (
    <div className="relative z-10 grid h-screen grid-cols-[228px_1fr]">
      {/* ---------- sidebar ---------- */}
      <aside className="flex flex-col gap-1.5 border-r border-line bg-canvas/60 px-3.5 py-5">
        <WorkspaceSwitcher workspaces={shell.workspaces} />

        <div className="px-2.5 pb-5 pt-0 font-display text-[22px] tracking-display">
          <b className="font-extrabold">venture</b>
          <span className="ml-1.5 font-light text-muted">os</span>
          <em className="ml-1.5 rounded-[5px] border border-line px-1.5 py-px align-middle text-[9px] font-semibold not-italic uppercase tracking-[0.14em] text-muted">
            lite
          </em>
        </div>

        <nav className="flex flex-col gap-1.5">
          {NAV.map((item) => (
            <NavRow key={item.label} item={item} activePath={activePath} />
          ))}
          <div className="px-2.5 pb-1.5 pt-3.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            System
          </div>
          <NavRow
            item={{ label: "Settings", icon: <SettingsIcon />, href: "/settings" }}
            activePath={activePath}
          />
        </nav>

        {/* Claude budget meter */}
        <div className="mt-auto border-t border-line px-2.5 pb-3 pt-2.5">
          <div className="mb-2 flex justify-between text-[10.5px] text-muted">
            <span>✦ Claude budget</span>
            <b className="font-semibold text-ink tabular-nums">$0.84 / $2.00</b>
          </div>
          <div className="h-[3px] overflow-hidden rounded-[3px] bg-line">
            <i className="block h-full rounded-[3px] bg-grad" style={{ width: "42%" }} />
          </div>
        </div>

        <div className="flex items-center gap-2.5 border-t border-line p-2.5">
          <div className="grid h-[30px] w-[30px] place-items-center rounded-full bg-grad text-[12px] font-bold">
            {shell.user.initials || "U"}
          </div>
          <div className="min-w-0 leading-tight">
            <b className="block truncate text-[13px]" data-testid="active-user">{shell.user.name}</b>
            <span className="block truncate text-[11px] text-muted">
              {shell.role} · {active?.name ?? ""}
            </span>
          </div>
        </div>
      </aside>

      {/* ---------- main ---------- */}
      <div className="flex min-w-0 flex-col">
        <header className="flex items-center gap-4 border-b border-line px-7 py-4">
          <h1 className="font-display text-[26px] font-extrabold lowercase tracking-display">
            good morning, {shell.user.name.split(" ")[0].toLowerCase()}
          </h1>
          <div className="ml-auto flex w-[260px] items-center gap-2 rounded-[10px] border border-line bg-panel px-3 py-2 text-[13px] text-muted">
            <SearchIcon className="h-3.5 w-3.5" />
            <span>Search leads, companies…</span>
            <span className="ml-auto rounded-[5px] border border-line px-1.5 text-[11px]">
              /
            </span>
          </div>
          <button className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] font-semibold text-ink hover:bg-panel-2">
            Import CSV
          </button>
          <button className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background:linear-gradient(var(--tw-gradient-stops))] [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box]">
            + New lead
          </button>
        </header>

        <main className="flex-1 overflow-auto p-7">{children}</main>
      </div>
    </div>
  );
}
