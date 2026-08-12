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
      {
        src: `${base}/icon.svg`,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: `${base}/icon.svg`,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
