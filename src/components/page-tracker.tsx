import type { PageType } from "@/modules/tracking/types";

/**
 * The measurement script and the sentence that has to go with it (v3 P8/a, e).
 *
 * One component so a tracked page cannot exist without its notice: the script
 * and the disclosure are the same import, and adding one adds the other.
 *
 * A plain <script src> rather than next/script: this file is 3.3 KB of source
 * that Caddy serves gzipped at about 1.5 KB, it is deferred, and it must run on
 * pages that are otherwise entirely static HTML.
 */
export function PageTracker({ pageType, slug }: { pageType: PageType; slug: string }) {
  return (
    <>
      <script src="/t.js" data-page={pageType} data-slug={slug} defer />
      <p className="mt-3 text-center text-[10px] leading-relaxed text-muted">
        Ez az oldal látogatottsági adatokat gyűjt a szolgáltatás működtetéséhez —
        sütik nélkül.{" "}
        <a href="/privacy" className="underline hover:text-ink">
          Részletek
        </a>
      </p>
    </>
  );
}
