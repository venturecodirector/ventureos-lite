import { notFound } from "next/navigation";
import { prismaUnsafe } from "@/lib/db";
import { isShareExpired } from "@/modules/audit/share";
import { auditRowToView } from "@/modules/audit/view";

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
  const share = await prismaUnsafe.auditShare.findUnique({
    where: { slug },
    include: { audit: true },
  });
  if (!share) notFound();

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

  return (
    <main className="relative z-10 min-h-screen">
      <div className="mx-auto max-w-[720px] px-5 py-14">
        <div className="mb-8 font-display text-[18px]">
          <b className="font-extrabold">venture</b>{" "}
          <span className="font-light text-muted">co.group</span>
        </div>

        {expired ? (
          <div className="rounded-card border border-line bg-panel p-8">
            <h1 className="mb-2 font-display text-2xl font-bold lowercase">
              this report has expired
            </h1>
            <p className="text-[13px] text-muted">
              Audit share links are available for 60 days. Ask your Venture
              contact for a fresh one.
            </p>
          </div>
        ) : (
          <div className="rounded-card border border-line bg-[radial-gradient(500px_300px_at_90%_-10%,rgba(116,39,198,0.18),transparent_60%),rgba(239,241,248,0.02)] p-7 sm:p-9">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
              Website opportunity audit
            </div>
            <h1 className="mb-6 font-display text-[26px] font-bold lowercase tracking-display">
              {view.url.replace(/^https?:\/\//, "")}
            </h1>

            <div className="flex items-center gap-6 border-b border-line pb-6">
              <div className="bg-grad bg-clip-text font-display text-[68px] font-extrabold leading-none tracking-[-0.03em] text-transparent">
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
                      className="mr-1 mb-1 inline-flex items-center rounded-full border-[1.5px] border-transparent bg-grad px-2.5 py-0.5 text-[11px] font-semibold text-ink"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              Findings
            </div>
            <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {view.checks.map((c) => (
                <div key={c.key} className="flex items-center gap-2.5 py-1 text-[12.5px] text-[#C9CEE3]">
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
              Az elemzést a Venture CO Group készítette, gépi mérések alapján,
              {" "}
              {new Date().toISOString().slice(0, 10)}. Kérdés esetén válaszoljon
              erre az e-mailre, és átnézzük együtt.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
