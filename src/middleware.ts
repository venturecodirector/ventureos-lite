import { NextResponse, type NextRequest } from "next/server";

/**
 * Subdomain routing for the public booking page (spec §4.21): requests to
 * meet.{domain}/{slug} are rewritten to /book/{slug}, so the host sees a clean
 * meet.ventureco.group/tamas URL while the app serves it from /book/[slug].
 *
 * Direct /book/{slug} also works (dev + tests). BOOKING_HOST can override the
 * "meet." prefix match if needed.
 */
export function middleware(req: NextRequest) {
  const host = (req.headers.get("host") ?? "").split(":")[0].toLowerCase();
  const isMeet = host.startsWith("meet.") || host === (process.env.BOOKING_HOST ?? "");
  if (!isMeet) return NextResponse.next();

  const { pathname } = req.nextUrl;
  // Only rewrite bare first-segment paths (the slug); leave assets/api alone.
  if (
    pathname === "/" ||
    pathname.startsWith("/book") ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }
  const url = req.nextUrl.clone();
  url.pathname = `/book${pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
