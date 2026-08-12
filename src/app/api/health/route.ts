import { prismaUnsafe } from "@/lib/db";

/**
 * Container healthcheck. Deliberately unauthenticated and free of tenant data:
 * it reports only whether this process can serve and reach its database.
 *
 * Used by the Docker HEALTHCHECK and by Caddy's upstream health probe.
 *
 * The probe counts workspaces: a real database round-trip that touches the
 * tenancy ROOT table rather than any tenant-scoped business table, so it needs
 * neither a workspace context nor an exception to the raw-SQL ban (CLAUDE.md
 * hard rule #1). The count is discarded — nothing about the data is exposed.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await prismaUnsafe.workspace.count();
  } catch {
    return Response.json(
      { status: "error", database: "unreachable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return Response.json(
    { status: "ok", database: "ok", ms: Date.now() - started },
    { headers: { "cache-control": "no-store" } },
  );
}
