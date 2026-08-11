"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setGrant, type Member } from "@/modules/settings/actions";

const GROUPS: Array<{ module: string; grants: string[] }> = [
  {
    module: "Documents",
    grants: [
      "documents.quote.create",
      "documents.contract.create",
      "documents.certificate.create",
      "documents.send",
    ],
  },
  { module: "Templates", grants: ["templates.edit"] },
  { module: "Signal Engine", grants: ["signal_engine.approve"] },
  { module: "Exports", grants: ["exports.run"] },
];

function grantLabel(grant: string): string {
  return grant.split(".").slice(1).join(" · ") || grant;
}

export function SettingsGrants({
  members,
  isOwner,
}: {
  members: Member[];
  isOwner: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(userId: string, grant: string, enabled: boolean) {
    setBusy(`${userId}:${grant}`);
    setError(null);
    try {
      await setGrant({ userId, grant, enabled });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-[1000px]">
      <h2 className="mb-1 font-display text-2xl font-bold lowercase tracking-display">
        users &amp; grants
      </h2>
      <p className="mb-4 text-[12.5px] text-muted">
        Capabilities are per user per workspace. Owner-only by default. Every
        change is written to the audit log — <span className="text-accent-ink">logged</span>.
      </p>
      {!isOwner && (
        <div className="mb-3 rounded-[10px] border border-line bg-panel px-3.5 py-2.5 text-[12.5px] text-warn">
          Read-only — only the workspace Owner can change grants.
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      <div className="grid gap-3">
        {members.map((m) => {
          const implicit = m.role === "OWNER" || m.role === "ADMIN";
          return (
            <div key={m.userId} className="rounded-card border border-line bg-panel p-[18px]">
              <div className="mb-3 flex items-center gap-2">
                <div className="grid h-8 w-8 place-items-center rounded-full bg-grad text-[12px] font-bold">
                  {m.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <b className="text-[13px]">{m.name}</b>
                  <span className="block text-[11.5px] text-muted">{m.email}</span>
                </div>
                <span className="ml-auto rounded-full bg-accent-soft px-2.5 py-0.5 text-[10.5px] font-semibold text-accent-ink">
                  {m.role}
                </span>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {GROUPS.map((g) => (
                  <div key={g.module}>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                      {g.module}
                    </div>
                    {g.grants.map((grant) => {
                      const checked = implicit || m.grants.includes(grant);
                      const key = `${m.userId}:${grant}`;
                      return (
                        <label
                          key={grant}
                          className="flex items-center gap-2 py-1 text-[12.5px] text-[#C9CEE3]"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!isOwner || implicit || busy === key}
                            onChange={(e) => toggle(m.userId, grant, e.target.checked)}
                            style={{ accentColor: "#7427C6" }}
                          />
                          {grantLabel(grant)}
                          {implicit && <span className="text-[10.5px] text-muted">· via role</span>}
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
