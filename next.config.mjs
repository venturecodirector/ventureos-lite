import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server bundle for the Docker `app` image.
  output: "standalone",
  reactStrictMode: true,
  // Pin the trace root to this project (a stray lockfile in $HOME otherwise
  // makes Next infer the wrong root and mis-trace the standalone bundle).
  outputFileTracingRoot: __dirname,
  // Keep native/Node-only server libs out of the webpack bundle (BullMQ pulls
  // optional Redis-client backends that must not be bundled).
  serverExternalPackages: ["bullmq", "ioredis", "playwright", "playwright-core"],
};

export default nextConfig;
