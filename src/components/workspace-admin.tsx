"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createWorkspace, addMember } from "@/modules/workspaces/actions";
import { GRANTS } from "@/lib/grants";

const INPUT =
  "rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none placeholder:text-muted focus:border-accent";

export function WorkspaceAdmin({ isOwner }: { isOwner: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // create workspace
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [brandColor, setBrandColor] = useState("#7427C6");
  const [logoUrl, setLogoUrl] = useState("");
  const [mailgunDomain, setMailgunDomain] = useState("");
  const [claudeBudget, setClaudeBudget] = useState("2");
  const [retentionDays, setRetentionDays] = useState("365");

  // add member
  const [email, setEmail] = useState("");
  const [memberName, setMemberName] = useState("");
  const [role, setRole] = useState("BDR");
  const [grants, setGrants] = useState<string[]>([]);

  if (!isOwner) {
    return (
      <div className="rounded-card border border-line bg-panel p-[18px]">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Workspaces</div>
        <p className="text-[12.5px] text-muted">Only an Owner can provision workspaces and assign members.</p>
      </div>
    );
  }

  async function provision() {
    if (!name.trim()) return;
    setBusy(true);
    setMsg(null);
    const res = await createWorkspace({
      name, legalName, brandColor, logoUrl, mailgunDomain,
      claudeBudget: Number(claudeBudget), retentionDays: Number(retentionDays),
    });
    setBusy(false);
    if (res.ok) {
      setMsg("Workspace created. Switch to it from the sidebar.");
      setName("");
      setLegalName("");
      router.refresh();
    } else setMsg(res.error);
  }

  async function invite() {
    if (!email.trim()) return;
    setBusy(true);
    setMsg(null);
    const res = await addMember({ email, name: memberName, role, grants });
    setBusy(false);
    if (res.ok) {
      setMsg(`${email} assigned as ${role}.`);
      setEmail("");
      setMemberName("");
      setGrants([]);
      router.refresh();
    } else setMsg(res.error);
  }

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Workspaces</div>
      <p className="mb-3 text-[11.5px] text-muted">Provision a new workspace and assign members. Owner-only, audit-logged.</p>
      {msg && <p className="mb-3 text-[12px] text-[#C9CEE3]">{msg}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* provision */}
        <div className="grid gap-2 rounded-[11px] border border-line bg-panel-2 p-3.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">New workspace</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name *" className={INPUT} />
          <input value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Legal name" className={INPUT} />
          <div className="flex gap-2">
            <label className="flex items-center gap-2 text-[12px] text-muted">
              Brand
              <input type="color" value={brandColor} onChange={(e) => setBrandColor(e.target.value)} className="h-8 w-10 rounded border border-line bg-transparent" />
            </label>
            <input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="Logo URL" className={`${INPUT} flex-1`} />
          </div>
          <input value={mailgunDomain} onChange={(e) => setMailgunDomain(e.target.value)} placeholder="Mailgun domain (placeholder)" className={INPUT} />
          <div className="flex gap-2">
            <label className="flex flex-1 items-center justify-between gap-2 text-[12px] text-muted">
              Claude $/day
              <input value={claudeBudget} onChange={(e) => setClaudeBudget(e.target.value)} inputMode="decimal" className={`${INPUT} w-20 text-right`} />
            </label>
            <label className="flex flex-1 items-center justify-between gap-2 text-[12px] text-muted">
              Retention (days)
              <input value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} inputMode="numeric" className={`${INPUT} w-20 text-right`} />
            </label>
          </div>
          <button onClick={provision} disabled={busy || !name.trim()} className="mt-1 w-fit rounded-[9px] border border-accent bg-accent-soft px-3 py-1.5 text-[12px] font-semibold text-[#E4D3FF] disabled:opacity-60">
            Create workspace
          </button>
        </div>

        {/* invite member */}
        <div className="grid gap-2 rounded-[11px] border border-line bg-panel-2 p-3.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Assign a member (this workspace)</div>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email *" className={INPUT} />
          <input value={memberName} onChange={(e) => setMemberName(e.target.value)} placeholder="Name" className={INPUT} />
          <select value={role} onChange={(e) => setRole(e.target.value)} className={INPUT}>
            <option value="BDR">BDR</option>
            <option value="ADMIN">Admin</option>
            <option value="OWNER">Owner</option>
          </select>
          <div className="text-[11px] text-muted">Grants</div>
          <div className="grid gap-1">
            {GRANTS.map((g) => (
              <label key={g} className="flex items-center gap-2 text-[12px] text-[#C9CEE3]">
                <input
                  type="checkbox"
                  checked={grants.includes(g)}
                  onChange={(e) => setGrants((cur) => (e.target.checked ? [...cur, g] : cur.filter((x) => x !== g)))}
                  style={{ accentColor: "#7427C6" }}
                />
                {g}
              </label>
            ))}
          </div>
          <button onClick={invite} disabled={busy || !email.trim()} className="mt-1 w-fit rounded-[9px] border border-line bg-panel px-3 py-1.5 text-[12px] font-semibold hover:bg-panel-2 disabled:opacity-60">
            Assign member
          </button>
        </div>
      </div>
    </div>
  );
}
