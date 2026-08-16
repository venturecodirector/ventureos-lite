"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  removeBrandLogo,
  resetWorkspaceBrand,
  saveWorkspaceBrand,
  uploadBrandLogo,
} from "@/modules/workspaces/brand-actions";
import {
  brandFooterLine,
  brandGradient,
  contrastRatio,
  type WorkspaceBrand,
} from "@/modules/workspaces/brand";
import { BrandMark } from "./brand-mark";

/**
 * Settings → Branding (audit-v2 item 6). Owner-gated, audit-logged.
 *
 * Shows a LIVE letterhead preview beside the fields, because the thing being
 * configured is not a set of values — it is what a client sees on a quote, and
 * the only way to judge that is to look at it.
 */

const input =
  "w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent disabled:opacity-50";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-[12.5px]">
      <span className="block">{label}</span>
      {hint && <span className="block text-[11px] text-muted">{hint}</span>}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

/** A colour input plus its hex, and the contrast it achieves on the canvas. */
function ColorField({
  label,
  value,
  canvas,
  min,
  disabled,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  canvas?: string;
  min?: number;
  disabled: boolean;
  onChange: (v: string) => void;
  testId: string;
}) {
  const ratio = canvas ? contrastRatio(value, canvas) : null;
  const bad = ratio !== null && min !== undefined && ratio < min;
  return (
    <label className="block text-[12.5px]">
      <span className="block">{label}</span>
      <span className="mt-1 flex items-center gap-2">
        <input
          type="color"
          value={value}
          disabled={disabled}
          data-testid={`${testId}-picker`}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="h-8 w-10 cursor-pointer rounded border border-line bg-transparent disabled:opacity-50"
        />
        <input
          value={value}
          disabled={disabled}
          data-testid={testId}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className={`${input} font-mono`}
        />
      </span>
      {ratio !== null && (
        <span className={`mt-0.5 block text-[11px] ${bad ? "text-neg" : "text-muted"}`}>
          {ratio.toFixed(1)}:1 on the canvas{min ? ` · needs ${min}:1` : ""}
        </span>
      )}
    </label>
  );
}

export function SettingsBranding({
  initial,
  isOwner,
}: {
  initial: WorkspaceBrand;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [brand, setBrand] = useState<WorkspaceBrand>(initial);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const set = <K extends keyof WorkspaceBrand>(key: K, value: WorkspaceBrand[K]) => {
    setSaved(false);
    setBrand((b) => ({ ...b, [key]: value }));
  };

  async function save() {
    setBusy(true);
    setError(null);
    setProblems([]);
    setSaved(false);
    try {
      const res = await saveWorkspaceBrand({
        name: brand.name,
        legalName: brand.legalName,
        markBold: brand.markBold,
        markLight: brand.markLight,
        color: brand.color,
        gradientFrom: brand.gradientFrom,
        gradientTo: brand.gradientTo,
        canvas: brand.canvas,
        ink: brand.ink,
        muted: brand.muted,
        fontDisplay: brand.fontDisplay,
        fontBody: brand.fontBody,
        footerIdentity: brand.footerIdentity,
        footerAddress: brand.footerAddress ?? "",
        footerRegistration: brand.footerRegistration ?? "",
        footerContact: brand.footerContact ?? "",
        senderName: brand.senderName,
        senderEmail: brand.senderEmail ?? "",
        slugPrefix: brand.slugPrefix,
        publicHost: brand.publicHost ?? "",
      });
      if (!res.ok) {
        setError(res.error);
        setProblems(res.problems ?? []);
        return;
      }
      setBrand(res.brand);
      setSaved(true);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("logo", file);
      const res = await uploadBrandLogo(form);
      if (!res.ok) setError(res.error);
      else {
        setBrand(res.brand);
        router.refresh();
      }
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const disabled = !isOwner || busy;

  return (
    <section
      data-testid="settings-branding"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="font-display text-lg font-bold lowercase">branding</h2>
        <span className="rounded-full border border-line px-2 py-0.5 text-[10.5px] text-muted">
          owner-only · audit-logged
        </span>
      </div>
      <p className="mb-3 text-[12.5px] text-muted">
        What every client-facing artefact this workspace produces looks like, and
        who it says it is from: audit reports, quotes, contracts, the public
        share and booking pages, and transactional email.
      </p>

      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3 py-2 text-[12.5px] text-[#FFB3C2]">
          {error}
          {problems.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-[12px]">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {saved && <p className="mb-3 text-[12px] text-pos">Saved.</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Display name">
              <input
                value={brand.name}
                disabled={disabled}
                data-testid="brand-name"
                onChange={(e) => set("name", e.target.value)}
                className={input}
              />
            </Field>
            <Field label="Legal name" hint="Goes on contracts and invoices.">
              <input
                value={brand.legalName}
                disabled={disabled}
                data-testid="brand-legal-name"
                onChange={(e) => set("legalName", e.target.value)}
                className={input}
              />
            </Field>
            <Field label="Wordmark — bold half">
              <input
                value={brand.markBold}
                disabled={disabled}
                data-testid="brand-mark-bold"
                onChange={(e) => set("markBold", e.target.value)}
                className={input}
              />
            </Field>
            <Field label="Wordmark — light half">
              <input
                value={brand.markLight}
                disabled={disabled}
                data-testid="brand-mark-light"
                onChange={(e) => set("markLight", e.target.value)}
                className={input}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <ColorField
              label="Canvas"
              value={brand.canvas}
              disabled={disabled}
              testId="brand-canvas"
              onChange={(v) => set("canvas", v)}
            />
            <ColorField
              label="Text"
              value={brand.ink}
              canvas={brand.canvas}
              min={4.5}
              disabled={disabled}
              testId="brand-ink"
              onChange={(v) => set("ink", v)}
            />
            <ColorField
              label="Muted text"
              value={brand.muted}
              canvas={brand.canvas}
              min={3}
              disabled={disabled}
              testId="brand-muted"
              onChange={(v) => set("muted", v)}
            />
            <ColorField
              label="Accent"
              value={brand.color}
              canvas={brand.canvas}
              min={1.5}
              disabled={disabled}
              testId="brand-color"
              onChange={(v) => set("color", v)}
            />
            <ColorField
              label="Gradient from"
              value={brand.gradientFrom}
              disabled={disabled}
              testId="brand-gradient-from"
              onChange={(v) => set("gradientFrom", v)}
            />
            <ColorField
              label="Gradient to"
              value={brand.gradientTo}
              disabled={disabled}
              testId="brand-gradient-to"
              onChange={(v) => set("gradientTo", v)}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Display font" hint="Headings.">
              <input
                value={brand.fontDisplay}
                disabled={disabled}
                data-testid="brand-font-display"
                onChange={(e) => set("fontDisplay", e.target.value)}
                className={input}
              />
            </Field>
            <Field label="Body font">
              <input
                value={brand.fontBody}
                disabled={disabled}
                data-testid="brand-font-body"
                onChange={(e) => set("fontBody", e.target.value)}
                className={input}
              />
            </Field>
          </div>

          <Field label="Footer identity" hint="The first line under every document.">
            <input
              value={brand.footerIdentity}
              disabled={disabled}
              data-testid="brand-footer-identity"
              onChange={(e) => set("footerIdentity", e.target.value)}
              className={input}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Address">
              <input
                value={brand.footerAddress ?? ""}
                disabled={disabled}
                data-testid="brand-footer-address"
                onChange={(e) => set("footerAddress", e.target.value || null)}
                className={input}
              />
            </Field>
            <Field label="Registration" hint="Cg. / adószám.">
              <input
                value={brand.footerRegistration ?? ""}
                disabled={disabled}
                data-testid="brand-footer-registration"
                onChange={(e) => set("footerRegistration", e.target.value || null)}
                className={input}
              />
            </Field>
            <Field label="Contact">
              <input
                value={brand.footerContact ?? ""}
                disabled={disabled}
                data-testid="brand-footer-contact"
                onChange={(e) => set("footerContact", e.target.value || null)}
                className={input}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Email sender name">
              <input
                value={brand.senderName}
                disabled={disabled}
                data-testid="brand-sender-name"
                onChange={(e) => set("senderName", e.target.value)}
                className={input}
              />
            </Field>
            <Field label="Email sender address" hint="Must be on a verified domain.">
              <input
                value={brand.senderEmail ?? ""}
                disabled={disabled}
                data-testid="brand-sender-email"
                onChange={(e) => set("senderEmail", e.target.value || null)}
                className={input}
              />
            </Field>
            <Field label="Public host" hint="e.g. audit.studio.hu. Blank uses ours.">
              <input
                value={brand.publicHost ?? ""}
                disabled={disabled}
                data-testid="brand-public-host"
                onChange={(e) => set("publicHost", e.target.value || null)}
                className={input}
              />
            </Field>
            <Field label="Public slug prefix" hint="The path segment public links sit under.">
              <input
                value={brand.slugPrefix}
                disabled={disabled}
                data-testid="brand-slug-prefix"
                onChange={(e) => set("slugPrefix", e.target.value)}
                className={input}
              />
            </Field>
          </div>
        </div>

        {/* Live letterhead. The values mean nothing; this is the thing. */}
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Letterhead preview
          </div>
          <div
            data-testid="brand-preview"
            className="rounded-card border border-line p-4"
            style={{
              background: brand.canvas,
              color: brand.ink,
              fontFamily: `"${brand.fontBody}", sans-serif`,
            }}
          >
            <BrandMark brand={brand} className="text-[18px]" />
            <div
              className="mt-3 h-1.5 rounded-full"
              style={{ backgroundImage: brandGradient(brand) }}
            />
            <p className="mt-3 text-[13px] font-bold" style={{ fontFamily: `"${brand.fontDisplay}", sans-serif` }}>
              Árajánlat · Q-2026-014
            </p>
            <p className="mt-1 text-[11.5px]" style={{ color: brand.muted }}>
              Weboldal fejlesztés · 1 200 000 Ft
            </p>
            <p className="mt-4 text-[10px]" style={{ color: brand.muted }}>
              {brandFooterLine(brand)}
            </p>
          </div>

          <div className="mt-3 grid gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              disabled={disabled}
              data-testid="brand-logo-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
              className="text-[11.5px] text-muted file:mr-2 file:rounded-[8px] file:border file:border-line file:bg-panel file:px-2 file:py-1 file:text-[11.5px] file:text-ink"
            />
            <span className="text-[11px] text-muted">
              PNG, JPEG, SVG or WebP, under 512 KB — it is embedded in every PDF.
              A logo replaces the wordmark.
            </span>
            {brand.logoUrl && (
              <button
                type="button"
                disabled={disabled}
                data-testid="brand-logo-remove"
                onClick={async () => {
                  setBusy(true);
                  const res = await removeBrandLogo();
                  if (res.ok) setBrand(res.brand);
                  setBusy(false);
                  router.refresh();
                }}
                className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2 disabled:opacity-50"
              >
                Remove logo
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={disabled}
          data-testid="brand-save"
          className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save branding"}
        </button>
        <button
          type="button"
          disabled={disabled}
          data-testid="brand-reset"
          onClick={async () => {
            setBusy(true);
            const res = await resetWorkspaceBrand();
            if (res.ok) setBrand(res.brand);
            setBusy(false);
            router.refresh();
          }}
          className="rounded-[10px] border border-line bg-panel px-3 py-2 text-[12.5px] hover:bg-panel-2 disabled:opacity-50"
        >
          Restore defaults
        </button>
        {!isOwner && <span className="text-[11.5px] text-muted">Owner-only</span>}
      </div>
    </section>
  );
}
