import { CATEGORY_LABEL, AUDIT_CATEGORIES } from "@/modules/audit/categories";
import { copyFor } from "@/modules/public-audit/copy";
import { otherLocale, type Locale } from "@/lib/locale";
import type { WorkspaceBrand } from "@/modules/workspaces/brand";
import { brandGradient } from "@/modules/workspaces/brand";
import { AuditRunnerIsland } from "./public-audit-runner";
import { LocaleSwitch } from "./locale-switch";

/**
 * The public audit landing (P12/1a, expanded to a full page).
 *
 * A server component: everything here is content, and content that only exists
 * after hydration is content a search engine never sees. The one interactive
 * region — the URL form, the progress, the teaser and the unlock form — is a
 * single client island underneath the hero.
 *
 * All copy comes from the bilingual dictionary; nothing on this page is a
 * hardcoded string, which is what keeps the two languages from drifting.
 */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-4 font-display text-[26px] font-bold lowercase leading-[1.15] tracking-display sm:text-[30px]">
      {children}
    </h2>
  );
}

export function PublicAuditLanding({
  brand,
  locale,
}: {
  brand: WorkspaceBrand;
  locale: Locale;
}) {
  const copy = copyFor(locale);

  return (
    <main className="relative z-10 min-h-screen">
      <div className="mx-auto max-w-[760px] px-5 py-12 sm:py-16">
        {/* ---- header ---- */}
        <header className="mb-12 flex items-center gap-4">
          <div className="font-display text-[18px]">
            {brand.logoUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element --
                 a workspace logo behind /api/files, not a static asset */
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
          <div className="ml-auto">
            <LocaleSwitch to={otherLocale(locale)} label={copy.footer.switchLabel} />
          </div>
        </header>

        {/* ---- hero + the tool ---- */}
        <h1 className="mb-3 font-display text-[34px] font-bold lowercase leading-[1.08] tracking-display sm:text-[46px]">
          {copy.hero.headline}
        </h1>
        <p className="mb-8 max-w-[560px] text-[15px] leading-relaxed text-muted">
          {copy.hero.sub}
        </p>

        <AuditRunnerIsland locale={locale} brandName={brand.name} />

        {/* ---- how it works ---- */}
        <section className="mt-20">
          <Eyebrow>{copy.steps.eyebrow}</Eyebrow>
          <SectionTitle>{copy.steps.title}</SectionTitle>
          <ol className="grid gap-3 sm:grid-cols-3">
            {copy.steps.items.map((step, i) => (
              <li
                key={step.title}
                className="rounded-card border border-line bg-panel p-4"
              >
                <div
                  className="mb-2 grid h-[26px] w-[26px] place-items-center rounded-full text-[12px] font-bold text-ink"
                  style={{ backgroundImage: brandGradient(brand) }}
                >
                  {i + 1}
                </div>
                <div className="mb-1 text-[13.5px] font-bold">{step.title}</div>
                <p className="text-[12.5px] leading-relaxed text-muted">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ---- what we check ----
            Generated from the audit engine's own category registry, so this
            page cannot advertise a check the engine does not run. */}
        <section className="mt-20">
          <Eyebrow>{copy.checks.eyebrow}</Eyebrow>
          <SectionTitle>{copy.checks.title}</SectionTitle>
          <p className="mb-5 max-w-[560px] text-[13.5px] leading-relaxed text-muted">
            {copy.checks.intro}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {AUDIT_CATEGORIES.map((category) => (
              <div
                key={category}
                className="flex items-center gap-3 rounded-[10px] border border-line bg-panel px-3.5 py-3"
              >
                <span
                  className="h-[7px] w-[7px] flex-none rounded-full"
                  style={{ backgroundImage: brandGradient(brand) }}
                  aria-hidden
                />
                <span className="text-[13px] text-[#C9CEE3]">
                  {CATEGORY_LABEL[category][locale]}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 max-w-[560px] text-[12px] leading-relaxed text-muted">
            {copy.checks.footnote}
          </p>
        </section>

        {/* ---- privacy ---- */}
        <section className="mt-20">
          <Eyebrow>{copy.privacy.eyebrow}</Eyebrow>
          <SectionTitle>{copy.privacy.title}</SectionTitle>
          <p className="mb-4 max-w-[560px] text-[13.5px] leading-relaxed text-muted">
            {copy.privacy.body}
          </p>
          <ul className="grid gap-2">
            {copy.privacy.bullets.map((b) => (
              <li key={b} className="flex gap-2.5 text-[13px] leading-relaxed text-[#C9CEE3]">
                <span className="text-muted" aria-hidden>
                  —
                </span>
                {b}
              </li>
            ))}
          </ul>
        </section>

        {/* ---- faq ---- */}
        <section className="mt-20">
          <Eyebrow>{copy.faq.eyebrow}</Eyebrow>
          <SectionTitle>{copy.faq.title}</SectionTitle>
          <div className="grid gap-2.5">
            {copy.faq.items.map((item) => (
              <details
                key={item.q}
                className="group rounded-card border border-line bg-panel px-4 py-3.5"
              >
                <summary className="cursor-pointer list-none text-[13.5px] font-semibold marker:content-none">
                  <span className="mr-2 text-muted group-open:hidden" aria-hidden>
                    +
                  </span>
                  <span className="mr-2 hidden text-muted group-open:inline" aria-hidden>
                    −
                  </span>
                  {item.q}
                </summary>
                <p className="mt-2 pl-5 text-[13px] leading-relaxed text-muted">{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* ---- footer ---- */}
        <footer className="mt-20 border-t border-line pt-6 text-[11.5px] leading-relaxed text-muted">
          <p>{copy.footer.contact}</p>
          <p className="mt-1.5">{brand.footerIdentity}</p>
        </footer>
      </div>
    </main>
  );
}
