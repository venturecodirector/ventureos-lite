import { notFound } from "next/navigation";
import { PageTracker } from "@/components/page-tracker";
import { prismaUnsafe } from "@/lib/db";
import { isShareExpired } from "@/modules/audit/share";
import { auditRowToView } from "@/modules/audit/view";
import { publicCategoryGroups, CATEGORY_LABEL } from "@/modules/audit/categories";
import { FieldData } from "@/components/field-data";
import { PublicComparison } from "@/components/public-comparison";
import { brandFrom, brandGradient } from "@/modules/workspaces/brand";
import { loadComparison } from "@/modules/audit/comparison-load";
import { isRateLimited } from "@/lib/rate-limit-guard";

// Public, prospect-facing, no product chrome. Cross-tenant read keyed on the
// unguessable slug — a deliberate public surface, not tenant business logic.
export const dynamic = "force-dynamic";

const VERDICT_LABEL: Record<string, string> = {
  STRONG: "Strong prospect",
  POSSIBLE: "Possible",
  SKIP: "Skip",
};

export default async function SharePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // Unauthenticated and cross-tenant by design, so it gets an abuse control
  // like every other public surface (P6/2). Refusing with a plain page rather
  // than a 404 keeps the two states distinguishable: "slow down" is not the
  // same as "this report does not exist".
  if (await isRateLimited("auditShare")) {
    return (
      <main className="mx-auto max-w-[520px] px-6 py-20 text-center">
        <h1 className="font-display text-[24px] lowercase tracking-display">slow down</h1>
        <p className="mt-2 text-[13.5px] text-muted">
          This report has been opened a lot in the last hour. Try again shortly.
        </p>
      </main>
    );
  }

  const share = await prismaUnsafe.auditShare.findUnique({
    where: { slug },
    include: { audit: true },
  });
  if (!share) notFound();

  // Whose report this is (P2/6). A share link is cross-tenant by design, so the
  // brand has to come from the OWNING workspace rather than from any session.
  const workspace = await prismaUnsafe.workspace.findUnique({
    where: { id: share.workspaceId },
    select: { brand: true },
  });
  const brand = brandFrom(workspace?.brand);

  const expired = isShareExpired(share.expiresAt, new Date());

  if (!expired) {
    // Open tracking → lead timeline (spec §4.4).
    await prismaUnsafe.auditShare.update({
      where: { id: share.id },
      data: {
        openCount: { increment: 1 },
        firstOpenedAt: share.firstOpenedAt ?? new Date(),
      },
    });
    if (share.leadId) {
      await prismaUnsafe.activity.create({
        data: {
          workspaceId: share.workspaceId,
          leadId: share.leadId,
          type: "audit_share_opened",
          payload: { slug },
        },
      });
    }
  }

  const view = auditRowToView(share.audit);
  // Anonymised inside PublicComparison — the loader returns the named table,
  // and nothing named ever reaches the markup (P2/3).
  const comparison = await loadComparison(prismaUnsafe, {
    id: share.audit.id,
    url: share.audit.url,
    status: share.audit.status,
    score: share.audit.score,
    checks: share.audit.checks,
    comparison: share.audit.comparison,
  });

  return (
    <main className="relative z-10 min-h-screen">
      <div className="mx-auto max-w-[720px] px-5 py-14">
        <div className="mb-8 font-display text-[18px]">
          {brand.logoUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element --
               a workspace logo served from /api/files, not a static asset */
            <img src={brand.logoUrl} alt={brand.name} className="max-h-[34px]" />
          ) : (
            <>
              <b className="font-extrabold">{brand.markBold}</b>
              {brand.markLight ? (
                <span className="font-light text-muted"> {brand.markLight}</span>
              ) : null}
            </>
          )}
        </div>

        {expired ? (
          <div className="rounded-card border border-line bg-panel p-8">
            <h1 className="mb-2 font-display text-2xl font-bold lowercase">
              this report has expired
            </h1>
            <p className="text-[13px] text-muted">
              Audit share links are available for 60 days. Ask your{" "}
              {brand.name} contact for a fresh one.
            </p>
          </div>
        ) : (
          <div
            className="rounded-card border border-line p-7 sm:p-9"
            style={{
              backgroundImage: `radial-gradient(500px 300px at 90% -10%, ${brand.color}2E, transparent 60%), linear-gradient(rgba(239,241,248,0.02), rgba(239,241,248,0.02))`,
            }}
          >
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
              Website opportunity audit
            </div>
            <h1 className="mb-6 font-display text-[26px] font-bold lowercase tracking-display">
              {view.url.replace(/^https?:\/\//, "")}
            </h1>

            <div className="flex items-center gap-6 border-b border-line pb-6">
              <div
                className="bg-clip-text font-display text-[68px] font-extrabold leading-none tracking-[-0.03em] text-transparent"
                style={{ backgroundImage: brandGradient(brand) }}
              >
                {view.score}
              </div>
              <div>
                <div className="text-[20px] font-bold">
                  {VERDICT_LABEL[view.verdict] ?? "Skip"}
                </div>
                <div className="mt-2 max-w-[360px]">
                  {view.flags.map((f) => (
                    <span
                      key={f}
                      className="mr-1 mb-1 inline-flex items-center rounded-full border-[1.5px] border-transparent px-2.5 py-0.5 text-[11px] font-semibold text-ink"
                      style={{ backgroundImage: brandGradient(brand) }}
                    >
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/*
              Grouped by category with a per-category count (P1/3d), in
              Hungarian — this is the prospect-facing surface. Categories with
              nothing measured are left out entirely rather than shown as gaps,
              and so is Site structure: that comes from the internal multi-page
              crawl (P2/1), and public audits are single-page by design.
            */}
            {publicCategoryGroups(view.checks).map((g) => (
                <div key={g.category} className="mt-6">
                  <div className="flex items-baseline gap-2 border-b border-line pb-1.5">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                      {CATEGORY_LABEL[g.category].hu}
                    </span>
                    <span className="ml-auto text-[11px] text-muted">
                      {g.failed === 0
                        ? "rendben"
                        : `${g.failed} / ${g.total} javítanivaló`}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                    {g.checks.map((c) => (
                <div key={c.key} className="flex items-center gap-2.5 py-1 text-[12.5px] text-[var(--brand-ink-soft)]">
                  <span
                    className={`grid h-[17px] w-[17px] flex-none place-items-center rounded-full text-[10px] ${
                      c.pass
                        ? "bg-[rgba(61,220,151,0.15)] text-[#3DDC97]"
                        : "bg-[rgba(255,92,122,0.15)] text-[#FF5C7A]"
                    }`}
                  >
                    {c.pass ? "✓" : "✗"}
                  </span>
                  {c.label}
                  {c.detail ? <span className="text-muted">· {c.detail}</span> : null}
                        </div>
                      ))}
                  </div>
                </div>
              ))}

            {/*
              Field data (P2/2) belongs on the public page: it is a measurement
              of the reader's own site by their own visitors, which is exactly
              what "facts only" means. The no-data case says so plainly rather
              than implying anything.
            */}
            <FieldData
              crux={view.crux}
              lang="hu"
              labDetail={view.checks.find((c) => c.key === "psiPerformance")?.detail ?? null}
            />

            <PublicComparison table={comparison} />

            {/*
              FACTS ONLY on the public route (P1/3b). Two things used to render
              here and must never render again:

                - view.pitchSummary, the Claude-written sales angle. It is
                  written FOR US, about how to sell to this reader. Showing it
                  to them is both a bad look and a breach of the internal /
                  public split the spec draws.
                - "High score = weak site = strong opportunity", which explains
                  our scoring in terms of how weak their site is.

              The internal view and the sales PDF keep both. A test asserts the
              pitch text never appears on this page.
            */}
            {(view.screenshots.desktop || view.screenshots.mobile) && (
              <div className="mt-7">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                  Így néz ki az oldal
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {(["desktop", "mobile"] as const).map((kind) =>
                    view.screenshots[kind] ? (
                      <figure key={kind}>
                        {/* eslint-disable-next-line @next/next/no-img-element --
                            served by a slug-scoped public route, not an
                            optimisable static asset */}
                        <img
                          src={`/api/share/${slug}/shot/${kind}`}
                          alt={kind === "desktop" ? "Asztali nézet" : "Mobil nézet"}
                          loading="lazy"
                          className="w-full rounded-[10px] border border-line object-cover object-top"
                        />
                        <figcaption className="mt-1 text-center text-[10.5px] text-muted">
                          {kind === "desktop" ? "Asztali nézet" : "Mobil nézet"}
                        </figcaption>
                      </figure>
                    ) : null,
                  )}
                </div>
              </div>
            )}

            <p className="mt-7 text-[10.5px] leading-relaxed text-muted">
              Az elemzést {brand.footerIdentity} készítette, gépi mérések alapján,
              {" "}
              {new Date().toISOString().slice(0, 10)}. Kérdés esetén válaszoljon
              erre az e-mailre, és átnézzük együtt.
            </p>
          </div>
        )}
        {/* Not on an expired link: there is nothing there to have read. */}
        {!expired && <PageTracker pageType="audit_share" slug={slug} />}
      </div>
    </main>
  );
}
