import { NextResponse, type NextRequest } from "next/server";

/**
 * Two jobs, in order: route the public surfaces, then gate everything else
 * behind a session.
 *
 * PUBLIC SURFACES (CLAUDE.md → Domain layout). The authenticated app is the
 * ROOT of ventureco.agency. Three prospect-facing surfaces are served by the
 * same Next app on their own subdomains:
 *
 *   audit.<domain>/<slug>  →  /share/<slug>    public website-audit report
 *   quote.<domain>/<slug>  →  /accept/<slug>   public quote acceptance
 *   meet.<domain>/<slug>   →  /book/<slug>     public booking page
 *
 * The authoritative, env-driven mapping lives in the Caddyfile, which knows the
 * real hostnames and marks each request with `X-Public-Surface`. Middleware
 * runs in the edge runtime, where `process.env` is inlined at BUILD time — so
 * it must not read hostnames from env itself. It honours Caddy's header and
 * falls back to the structural subdomain prefix, which needs no configuration
 * and works in local dev too.
 *
 * AUTH GATE. This is a cheap presence check on the session cookie so signed-out
 * visitors get a clean redirect instead of an error page. It is NOT the
 * security boundary: the cookie is signed by Auth.js and the token inside it is
 * resolved against the `sessions` table by `getActiveContext()` on every server
 * action and page. Forging a cookie gets you a redirect loop, not access.
 */
const SURFACES = {
  audit: "/share",
  quote: "/accept",
  meet: "/book",
} as const;

type Surface = keyof typeof SURFACES;

/** Paths that must stay reachable without a session. */
const PUBLIC_PREFIXES = [
  "/login",
  "/reset", // one-time password reset links (the token is the credential)
  "/api/auth", // Auth.js endpoints
  "/api/health", // container + proxy probes
  "/api/cold/unsubscribe", // one-click unsubscribe in cold mail
  "/api/mailgun", // inbound mail routes (signature-verified)
  "/api/webhooks", // delivery/bounce webhooks (signature-verified)
  "/share", // public audit reports
  "/accept", // public quote acceptance
  "/book", // public booking pages
  "/manifest.webmanifest",
  "/icon.svg",
  "/sw.js",
];

function detectSurface(req: NextRequest): Surface | null {
  const marked = req.headers.get("x-public-surface")?.trim().toLowerCase();
  if (marked === "audit" || marked === "quote" || marked === "meet") return marked;

  const host = (req.headers.get("host") ?? "").split(":")[0].toLowerCase();
  for (const key of Object.keys(SURFACES) as Surface[]) {
    if (host.startsWith(`${key}.`)) return key;
  }
  return null;
}

/**
 * Auth.js names its cookie `authjs.session-token`, prefixed with `__Secure-`
 * when served over https. Match either rather than hardcoding one.
 */
function hasSessionCookie(req: NextRequest): boolean {
  return req.cookies
    .getAll()
    .some((c) => /^(__Secure-)?authjs\.session-token(\.\d+)?$/.test(c.name) && !!c.value);
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const surface = detectSurface(req);

  // ---- public surfaces: rewrite a bare slug onto its app route -------------
  if (surface) {
    const target = SURFACES[surface];
    if (
      pathname === "/" ||
      pathname.startsWith(target) ||
      pathname.startsWith("/api") ||
      pathname.startsWith("/_next") ||
      pathname.includes(".")
    ) {
      return NextResponse.next();
    }
    // Only the bare first segment is a slug; anything deeper is not a public page.
    if (pathname.slice(1).includes("/")) return NextResponse.next();

    const url = req.nextUrl.clone();
    url.pathname = `${target}${pathname}`;
    return NextResponse.rewrite(url);
  }

  // ---- app origin: require a session --------------------------------------
  if (
    pathname.startsWith("/_next") ||
    PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    return NextResponse.next();
  }

  if (!hasSessionCookie(req)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Preserve where they were heading, so login lands them there.
    if (pathname !== "/") url.searchParams.set("next", pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
