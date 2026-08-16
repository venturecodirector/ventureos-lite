import type { CSSProperties } from "react";
import {
  brandCssVars,
  brandFooterLine,
  brandGradient,
  type WorkspaceBrand,
} from "@/modules/workspaces/brand";

/**
 * The workspace wordmark on a prospect-facing page (audit-v2 item 6).
 *
 * Extracted because four public surfaces were each rendering their own copy —
 * the share page from the brand, and the acceptance, booking and unsubscribe
 * pages from a hardcoded "venture co.group". Three of them would have sent a
 * second workspace's client a page signed by this agency.
 */
export function BrandMark({
  brand,
  className = "font-display text-[16px]",
}: {
  brand: WorkspaceBrand;
  className?: string;
}) {
  if (brand.logoUrl) {
    return (
      <div className={className}>
        {/* eslint-disable-next-line @next/next/no-img-element -- an uploaded
            logo of unknown dimensions served from the files route; next/image
            would need a configured loader for a path that is per workspace. */}
        <img src={brand.logoUrl} alt={brand.name} className="max-h-[34px] object-contain" />
      </div>
    );
  }
  return (
    <div className={className}>
      <b className="font-extrabold">{brand.markBold}</b>
      {brand.markLight ? (
        <span className="font-light text-muted"> {brand.markLight}</span>
      ) : null}
    </div>
  );
}

/** The identity line for the foot of a public page. */
export function BrandFooter({ brand }: { brand: WorkspaceBrand }) {
  return (
    <p className="mt-8 text-center text-[11px] text-muted">{brandFooterLine(brand)}</p>
  );
}

/**
 * The brand's variables as a `style` object.
 *
 * Applied to a public page's root so its own CSS can read `var(--brand-*)`
 * instead of naming a token — the same derivation the PDFs use, so a page and
 * the PDF of the same thing cannot drift apart.
 */
export function brandStyle(brand: WorkspaceBrand): CSSProperties {
  return brandCssVars(brand) as CSSProperties;
}

/** The tinted panel every prospect-facing card uses, in the workspace's accent. */
export function brandPanelStyle(brand: WorkspaceBrand): CSSProperties {
  return {
    backgroundImage: `radial-gradient(500px 300px at 90% -10%, ${brand.color}2E, transparent 60%), linear-gradient(rgba(239,241,248,0.02), rgba(239,241,248,0.02))`,
  };
}

export { brandGradient };
