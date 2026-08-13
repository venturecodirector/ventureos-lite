import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { detectLocale, LOCALE_COOKIE } from "@/lib/locale";

/**
 * The audit domain root: decide a language, then send them to it.
 *
 * A redirect rather than rendering here, so every visitor ends up on an
 * explicit URL. Serving different content at the same address would mean a
 * link shared with a colleague renders in a language the sender never saw, and
 * would make the page uncacheable and its hreflang meaningless.
 */
export const dynamic = "force-dynamic";

export default async function PublicAuditRootPage() {
  const [h, c] = await Promise.all([headers(), cookies()]);
  const locale = detectLocale({
    cookie: c.get(LOCALE_COOKIE)?.value,
    acceptLanguage: h.get("accept-language"),
  });
  redirect(`/public-audit/${locale}`);
}
