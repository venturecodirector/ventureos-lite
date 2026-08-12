import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/env";

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
    name: "Venture OS Lite",
    short_name: "Venture OS",
    start_url: `${base}/`,
    scope: `${base}/`,
    display: "standalone",
    background_color: "#00051D",
    theme_color: "#00051D",
    icons: [
      // Full-bleed brand canvas with the mark inside the maskable safe zone
      // (~55% of the width), so an aggressive circular crop cannot clip it —
      // which is what lets one file serve both "any" and "maskable". Listed as
      // two entries rather than the space-separated `purpose` the spec also
      // allows, because Next's Manifest type only models single-value purposes.
      { src: `${base}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `${base}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: `${base}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `${base}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: `${base}/favicon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" },
      // Flat single-colour cut of the same mark, for surfaces that recolour the
      // icon themselves (notification badges, monochrome shelves) and would
      // otherwise flatten the gradient into mud.
      {
        src: `${base}/favicon-solid.svg`,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "monochrome",
      },
    ],
  };
}
