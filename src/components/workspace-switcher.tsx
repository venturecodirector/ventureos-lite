"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { switchWorkspace, type WorkspaceOption } from "@/modules/workspaces/actions";

export function WorkspaceSwitcher({ workspaces }: { workspaces: WorkspaceOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = workspaces.find((w) => w.active) ?? workspaces[0];

  async function pick(id: string) {
    if (id === active?.id) {
      setOpen(false);
      return;
    }
    setBusy(true);
    await switchWorkspace(id);
    setBusy(false);
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="mb-1.5 flex w-full cursor-pointer items-center gap-2.5 rounded-[11px] border border-line bg-panel px-2.5 py-2.5 hover:bg-panel-2 disabled:opacity-60"
      >
        <div className="grid h-[26px] w-[26px] place-items-center rounded-lg bg-grad font-display text-[13px] font-extrabold">
          {(active?.name ?? "V").charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 leading-tight">
          <b className="block truncate text-left text-[12.5px]" data-testid="active-workspace">
            {active?.name ?? "No workspace"}
          </b>
          <span className="block text-[10px] uppercase tracking-[0.08em] text-muted">workspace</span>
        </div>
        <span className="ml-auto text-[11px] text-muted">▾</span>
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-[52px] z-50 overflow-hidden rounded-[11px] border border-line bg-[rgba(6,11,38,0.98)] backdrop-blur"
        >
          {workspaces.map((w) => (
            <li key={w.id}>
              <button
                onClick={() => pick(w.id)}
                data-testid="workspace-option"
                className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12.5px] hover:bg-panel-2 ${
                  w.active ? "text-ink" : "text-[#C9CEE3]"
                }`}
              >
                <span className="truncate">{w.name}</span>
                <span className="ml-auto text-[10px] uppercase tracking-[0.08em] text-muted">{w.role.toLowerCase()}</span>
                {w.active && <span className="text-[11px] text-[#3DDC97]">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
