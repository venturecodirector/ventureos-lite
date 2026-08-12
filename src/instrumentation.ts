/**
 * Next.js boot hook. Runs once per server process, before the first request.
 *
 * Its only job is the environment gate: a container that is missing or has
 * malformed configuration must die immediately with a readable list, not serve
 * half-working pages (e.g. quote links pointing at localhost, or cold mail
 * silently falling back to the transactional domain).
 */
export async function register(): Promise<void> {
  // Edge chunks get their own `register()` pass — the Node process is the one
  // that owns configuration, and `next build` must not need production secrets.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.SKIP_ENV_VALIDATION === "1") return;

  const { checkEnvAtBoot } = await import("./lib/env");
  // Fatal in production; a printed warning in dev, so a developer with a
  // half-filled .env is told exactly what is missing without being blocked.
  checkEnvAtBoot("app");
}
