import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prismaUnsafe } from "@/lib/db";
import { brandFrom, VENTURE_BRAND } from "@/modules/workspaces/brand";
import { BrandFooter, BrandMark, brandPanelStyle, brandStyle } from "@/components/brand-mark";
import { SectorReportForm } from "@/components/sector-report-form";
import { PageTracker } from "@/components/page-tracker";
import type { SectorStats } from "@/modules/sector-reports/stats";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const r = await prismaUnsafe.sectorReport.findUnique({
    where: { slug },
    select: { title: true, status: true },
  });
  return { title: r?.status === "published" ? r.title : "Szektor-riport" };
}

/**
 * One published report (playbook-v4 P12/2c).
 *
 * The headline numbers are shown FREELY. The full PDF is behind the same dual
 * consent as the self-serve audit — which only works as a trade if what is
 * visible is genuinely worth reading, so the teaser is the real findings rather
 * than a blurred screenshot.
 */
export default async function SectorReportPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const report = await prismaUnsafe.sectorReport.findUnique({ where: { slug } });
  if (!report || report.status !== "published") notFound();

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: report.workspaceId },
    select: { brand: true },
  });
  const brand = ws ? brandFrom(ws.brand) : VENTURE_BRAND;
  const stats = (report.stats ?? null) as SectorStats | null;
  const narrative = (report.narrative ?? null) as { summary?: string } | null;

  return (
    <main className="relative z-10 min-h-screen" style={brandStyle(brand)}>
      <div className="mx-auto max-w-[680px] px-5 py-14">
        <BrandMark brand={brand} className="mb-7 font-display text-[16px]" />

        <div className="rounded-card border border-line p-7" style={brandPanelStyle(brand)}>
          <h1 className="font-display text-[24px] font-extrabold lowercase tracking-display">
            {report.title.toLowerCase()}
          </h1>
          <p className="mb-5 mt-1 text-[12px] text-muted">
            {report.location} · {report.sector} · {report.auditedCount} megmért weboldal
          </p>

          {narrative?.summary && (
            <p className="mb-5 text-[13.5px] leading-relaxed text-[#C9CEE4]">{narrative.summary}</p>
          )}

          {stats && (
            <div className="mb-5 grid gap-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                A leggyakoribb hiányok
              </div>
              {stats.failing.slice(0, 4).map((f) => (
                <div key={f.key} className="flex items-center gap-2 text-[12.5px]">
                  <span className="flex-1 text-[#C9CEE4]">{f.label}</span>
                  <span className="tabular-nums font-semibold">{Math.round(f.share * 100)}%</span>
                </div>
              ))}
            </div>
          )}

          <SectorReportForm slug={slug} />

          <p className="mt-5 text-[10.5px] leading-relaxed text-muted">
            A riport kizárólag összesített adatokat tartalmaz — egyetlen vállalkozás
            sem azonosítható belőle.
          </p>
        </div>

        <BrandFooter brand={brand} />
        <PageTracker pageType="audit_landing" slug={`report-${slug}`} />
      </div>
    </main>
  );
}
