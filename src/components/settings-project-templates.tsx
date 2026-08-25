"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import {
  saveProjectTemplate,
  archiveProjectTemplate,
  type TemplateRow,
} from "@/modules/projects/actions";

/**
 * Settings → Milestone templates (playbook-v3 P11/2d).
 *
 * Versioned like a document template, and the version is shown: a project
 * records the one it was built from, so editing this cannot rewrite what a
 * running project agreed to deliver — and the count of projects using it says
 * how much history is behind that number.
 */
const BTN =
  "min-h-[34px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const INPUT =
  "rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent";

interface Draft {
  id?: string;
  name: string;
  milestones: Array<{ title: string; dayOffset: number; kind: "generic" | "certificate" }>;
}

export function SettingsProjectTemplates({ templates }: { templates: TemplateRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  function edit(t: TemplateRow) {
    setMsg(null);
    setDraft({
      id: t.id,
      name: t.name,
      milestones: t.milestones.map((m) => ({
        title: m.title,
        dayOffset: m.dayOffset,
        kind: m.kind === "certificate" ? "certificate" : "generic",
      })),
    });
  }

  function blank() {
    setMsg(null);
    setDraft({
      name: "",
      // A new template starts with the line that closes the chain already in
      // place: it is the one that gets forgotten.
      milestones: [{ title: "Teljesítésigazolás", dayOffset: 30, kind: "certificate" }],
    });
  }

  function save() {
    if (!draft) return;
    setMsg(null);
    startTransition(async () => {
      const res = await attempt(saveProjectTemplate(draft));
      if (!res.ok) {
        setMsg(res.error);
        return;
      }
      setDraft(null);
      router.refresh();
    });
  }

  function archive(id: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await attempt(archiveProjectTemplate(id));
      if (!res.ok) {
        setMsg(res.error);
        return;
      }
      router.refresh();
    });
  }

  function patchLine(i: number, next: Partial<Draft["milestones"][number]>) {
    setDraft((d) =>
      d ? { ...d, milestones: d.milestones.map((m, j) => (j === i ? { ...m, ...next } : m)) } : d,
    );
  }

  return (
    <section
      data-testid="settings-project-templates"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <h2 className="mb-1 font-display text-lg font-bold lowercase">milestone templates</h2>
      <p className="mb-3 text-[12.5px] text-muted">
        Amiből egy megnyert deal projektje indul. Minden sablon a
        teljesítésigazolással záruljon — az zárja a dokumentum-láncot, és az a
        lépés, ami elmarad. Szerkesztés új verziót hoz létre; a futó projektek a
        sajátjukat őrzik.
      </p>
      <div className="grid gap-3">
      {msg && (
        <p className="rounded-[9px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3 py-2 text-[12px] text-[#FFB3C2]">
          {msg}
        </p>
      )}

      {!draft && (
        <>
          <div className="grid gap-2">
            {templates.map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line px-3 py-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-semibold text-ink">{t.name}</span>
                  <span className="block text-[11px] text-muted">
                    {t.milestones.length} mérföldkő · v{t.version}
                    {t.inUse > 0 && ` · ${t.inUse} projekt használja`}
                  </span>
                </span>
                <button onClick={() => edit(t)} disabled={pending} className={BTN}>
                  Szerkesztés
                </button>
                <button
                  onClick={() => archive(t.id)}
                  disabled={pending}
                  className={BTN}
                  title="A sablon archiválódik — a rá hivatkozó projektek érintetlenek maradnak"
                >
                  Archiválás
                </button>
              </div>
            ))}
          </div>
          <button onClick={blank} className={BTN} data-testid="template-new">
            Új sablon
          </button>
        </>
      )}

      {draft && (
        <div className="grid gap-2.5 rounded-[10px] border border-line p-3">
          <input
            className={INPUT}
            placeholder="Sablon neve"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />

          {draft.milestones.map((m, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <input
                className={`${INPUT} min-w-[160px] flex-1`}
                placeholder="Mérföldkő"
                value={m.title}
                onChange={(e) => patchLine(i, { title: e.target.value })}
              />
              <input
                className={`${INPUT} w-[80px] tabular-nums`}
                type="number"
                min={0}
                value={m.dayOffset}
                onChange={(e) => patchLine(i, { dayOffset: Math.max(0, Number(e.target.value) || 0) })}
                title="Hányadik napra a projekt indulásától"
              />
              <select
                className={INPUT}
                value={m.kind}
                onChange={(e) =>
                  patchLine(i, { kind: e.target.value === "certificate" ? "certificate" : "generic" })
                }
              >
                <option value="generic">normál</option>
                <option value="certificate">teljesítésigazolás</option>
              </select>
              <button
                onClick={() =>
                  setDraft({ ...draft, milestones: draft.milestones.filter((_, j) => j !== i) })
                }
                className={BTN}
                aria-label="Sor törlése"
              >
                ×
              </button>
            </div>
          ))}

          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() =>
                setDraft({
                  ...draft,
                  milestones: [
                    ...draft.milestones,
                    { title: "", dayOffset: 7, kind: "generic" as const },
                  ],
                })
              }
              className={BTN}
            >
              + Mérföldkő
            </button>
            <button onClick={save} disabled={pending} className={BTN} data-testid="template-save">
              Mentés{draft.id ? " (új verzió)" : ""}
            </button>
            <button onClick={() => setDraft(null)} className={BTN}>
              Mégse
            </button>
          </div>

          <p className="text-[11px] text-muted">
            A szám a projekt indulásától számított nap. Mentéskor a sablon új verziót kap —
            a már futó projektek a saját verziójukat őrzik.
          </p>
        </div>
      )}
      </div>
    </section>
  );
}
