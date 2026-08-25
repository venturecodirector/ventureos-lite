import type { Metadata } from "next";
import Link from "next/link";
import { prismaUnsafe } from "@/lib/db";
import { brandFrom, VENTURE_BRAND } from "@/modules/workspaces/brand";
import { BrandFooter, BrandMark, brandPanelStyle, brandStyle } from "@/components/brand-mark";
import { getPublicIntakeWorkspaceId } from "@/modules/public-audit/intake";
import { PageTracker } from "@/components/page-tracker";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Szektor-riportok" };

/**
 * The published reports (playbook-v4 P12/2c).
 *
 * Deliberately plain: a list, a sentence each, and a link. The report itself is
 * the artefact — a landing page that oversells it before anyone has read a
 * number is the thing that makes an industry report look like an advertisement.
 */
export default async function ReportsIndexPage() {
  let brand = VENTURE_BRAND;
  let reports: Array<{ slug: string; title: string; sector: string; location: string; audited: number; publishedAt: Date | null }> = [];

  try {
    const workspaceId = await getPublicIntakeWorkspaceId();
    const [ws, rows] = await Promise.all([
      prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { brand: true } }),
      prismaUnsafe.sectorReport.findMany({
        where: { workspaceId, status: "published", slug: { not: null } },
        orderBy: { publishedAt: "desc" },
        take: 40,
        select: { slug: true, title: true, sector: true, location: true, auditedCount: true, publishedAt: true },
      }),
    ]);
    brand = brandFrom(ws?.brand);
    reports = rows.map((r) => ({
      slug: r.slug!,
      title: r.title,
      sector: r.sector,
      location: r.location,
      audited: r.auditedCount,
      publishedAt: r.publishedAt,
    }));
  } catch {
    /* intake unavailable — an empty list is better than an error page */
  }

  return (
    <main className="relative z-10 min-h-screen" style={brandStyle(brand)}>
      <div className="mx-auto max-w-[720px] px-5 py-14">
        <BrandMark brand={brand} className="mb-7 font-display text-[16px]" />
        <h1 className="mb-2 font-display text-[26px] font-extrabold lowercase tracking-display">
          szektor-riportok
        </h1>
        <p className="mb-8 text-[13px] leading-relaxed text-muted">
          Egy-egy szakma weboldalainak állapota, nyilvános adatokból, összesítve.
          Egyetlen vállalkozás sem azonosítható belőlük.
        </p>

        {reports.length === 0 ? (
          <div className="rounded-card border border-line p-7" style={brandPanelStyle(brand)}>
            <p className="text-[13px] text-muted">Még nincs közzétett riport.</p>
          </div>
        ) : (
          <div className="grid gap-2.5">
            {reports.map((r) => (
              <Link
                key={r.slug}
                href={`/reports/${r.slug}`}
                className="rounded-card border border-line p-5 transition-colors hover:border-accent"
                style={brandPanelStyle(brand)}
              >
                <span className="block font-display text-[16px] font-bold">{r.title}</span>
                <span className="mt-1 block text-[12px] text-muted">
                  {r.location} · {r.sector} · {r.audited} megmért weboldal
                  {r.publishedAt && ` · ${r.publishedAt.toISOString().slice(0, 10)}`}
                </span>
              </Link>
            ))}
          </div>
        )}

        <BrandFooter brand={brand} />
        <PageTracker pageType="audit_landing" slug="reports" />
      </div>
    </main>
  );
}
