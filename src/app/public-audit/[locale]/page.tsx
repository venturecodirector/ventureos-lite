import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageTracker } from "@/components/page-tracker";
import { prismaUnsafe } from "@/lib/db";
import { PublicAuditLanding } from "@/components/public-audit-landing";
import { getPublicIntakeWorkspaceId } from "@/modules/public-audit/intake";
import { copyFor } from "@/modules/public-audit/copy";
import { brandFrom, VENTURE_BRAND } from "@/modules/workspaces/brand";
import { isLocale, LOCALES } from "@/lib/locale";

/**
 * The self-serve audit landing, in one language (P12/1a, expanded).
 *
 * Server-rendered: the marketing copy is the point of the page, and a landing
 * page whose content only appears after hydration is invisible to the crawlers
 * it exists to attract. Only the audit runner and the unlock form are client
 * components.
 */
export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const copy = copyFor(locale);
  return {
    title: copy.metaTitle,
    description: copy.metaDescription,
    alternates: {
      canonical: `/${locale}`,
      languages: { hu: "/hu", en: "/en" },
    },
  };
}

export default async function PublicAuditLocalePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  // The landing has no slug to resolve a tenant from, so its branding follows
  // the configured intake workspace — the same one that will receive the lead.
  // A misconfigured intake must not break the page, only its brand; the form
  // itself reports the problem in its own words.
  let brand = VENTURE_BRAND;
  try {
    const workspaceId = await getPublicIntakeWorkspaceId();
    const ws = await prismaUnsafe.workspace.findUnique({
      where: { id: workspaceId },
      select: { brand: true },
    });
    brand = brandFrom(ws?.brand);
  } catch {
    /* intake unavailable — handled where it matters, at submit time */
  }

  return (
    <>
      <PublicAuditLanding brand={brand} locale={locale} />
      {/*
        The first step of the funnel (P12/1d). Everything after it — audits
        run, emails captured, consented — was already recorded; how many people
        arrived was not, which made every conversion rate unmeasurable.
        The locale stands in for the slug: this page has no tenant to resolve.
      */}
      <PageTracker pageType="audit_landing" slug={locale} />
    </>
  );
}
