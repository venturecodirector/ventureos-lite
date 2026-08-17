import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/env";
import { VENTURE_BRAND } from "@/modules/workspaces/brand";

/**
 * PWA manifest, served at /manifest.webmanifest.
 *
 * `start_url` / `scope` / `id` are absolute against APP_URL (the root of
 * ventureco.agency) rather than relative. That is deliberate: the same Next app
 * also answers on audit./quote./meet., and an origin-relative manifest would
 * make those prospect-facing pages installable as "Venture OS". With an
 * absolute app-origin scope the browser treats the manifest as out of scope on
 * the public subdomains and offers no install there, while the app root
 * installs normally.
 *
 * Dynamic so the host comes from runtime env, never baked in at build time.
 */
export const dynamic = "force-dynamic";

export default function manifest(): MetadataRoute.Manifest {
  const base = appUrl();
  return {
    id: `${base}/`,
    name: "Venture OS",
    short_name: "Venture OS",
    start_url: `${base}/`,
    scope: `${base}/`,
    display: "standalone",
    // From the seed brand rather than a literal, so a white-labelled deployment
    // that regenerated its icon set gets a splash screen matching them. The
    // manifest is origin-wide and served before anyone signs in, so it can only
    // ever carry the DEFAULT brand — there is no active workspace at this point.
    background_color: VENTURE_BRAND.canvas,
    theme_color: VENTURE_BRAND.canvas,
    icons: [
      // "any" and "maskable" are SEPARATE FILES, drawn differently.
      //
      // They used to be one: a full-bleed plate with the mark pulled in far
      // enough to survive a circular crop. That is safe on Android and wrong
      // everywhere else — a desktop PWA and a bookmark shelf apply no mask, so
      // the icon they show is a square with a small logo adrift in it. The
      // "any" file is therefore the rounded plate with the mark at its normal
      // size, and only the maskable one pays for the safe zone.
      //
      // Two entries per size rather than a space-separated `purpose`, which the
      // spec also allows, because Next's Manifest type models one purpose each.
      { src: `${base}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `${base}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: `${base}/icon-192-maskable.png`,
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: `${base}/icon-512-maskable.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      { src: `${base}/favicon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" },
      // Flat single-colour cut of the same mark, for surfaces that recolour the
      // icon themselves (notification badges, monochrome shelves) and would
      // otherwise flatten the gradient into mud. The same file Safari uses for a
      // pinned tab — both want exactly one opaque colour on transparent.
      {
        src: `${base}/mask-icon.svg`,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "monochrome",
      },
    ],
  };
}
