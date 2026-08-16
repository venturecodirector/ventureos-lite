import { notFound } from "next/navigation";
import { getPublicQuote } from "@/modules/documents/acceptance";
import { AcceptForm } from "@/components/accept-form";
import { BrandFooter, BrandMark, brandPanelStyle, brandStyle } from "@/components/brand-mark";

// Public, prospect-facing, no product chrome (spec §4.9). Cross-tenant read by
// the unlisted slug.
export const dynamic = "force-dynamic";

export default async function AcceptPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const q = await getPublicQuote(slug);
  if (!q) notFound();

  return (
    <main className="relative z-10 min-h-screen" style={brandStyle(q.brand)}>
      <div className="mx-auto max-w-[560px] px-5 py-14">
        <BrandMark brand={q.brand} className="mb-7 font-display text-[16px]" />

        <div
          className="rounded-card border border-line p-7"
          style={brandPanelStyle(q.brand)}
        >
          <h1 className="font-display text-[22px] font-extrabold lowercase tracking-display">
            árajánlat · {q.clientCompany.toLowerCase()}
          </h1>
          <div className="mb-5 text-[12px] text-muted">
            {q.quoteNumber}
            {q.validUntil ? ` · érvényes: ${q.validUntil}` : ""}
          </div>

          {q.items.map((it, i) => (
            <div key={i} className="flex justify-between border-b border-line py-1.5 text-[12px] text-[var(--brand-ink-soft)]">
              <span>{it.description}</span>
              <span className="tabular-nums">{it.line}</span>
            </div>
          ))}
          <div className="flex justify-between py-2 text-[13px]">
            <b>Összesen (nettó)</b>
            <b className="tabular-nums">{q.net}</b>
          </div>
          <div className="flex justify-between text-[11.5px] text-muted">
            <span>ÁFA {q.vatRatePct}%</span>
            <span className="tabular-nums">{q.vat}</span>
          </div>
          <div className="flex justify-between text-[13px]">
            <b>Bruttó</b>
            <b className="tabular-nums">{q.gross}</b>
          </div>

          <div className="mt-6">
            {q.accepted ? (
              <div className="rounded-[10px] border border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.1)] px-3.5 py-3 text-[13px] text-[#8FE9C3]">
                Elfogadva{q.acceptedByName ? ` — köszönjük, ${q.acceptedByName}!` : "."}
              </div>
            ) : (
              <AcceptForm slug={slug} />
            )}
          </div>

          <p className="mt-6 text-[10px] leading-relaxed text-muted">
            Ez a rögzített elfogadás szerződéses szándéknyilatkozat, nem minősített
            elektronikus aláírás. · A jövőbeli saját e-aláírás modul ide csatlakozik.
          </p>
        </div>
        <BrandFooter brand={q.brand} />
      </div>
    </main>
  );
}
