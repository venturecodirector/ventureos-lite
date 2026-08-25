import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prismaUnsafe } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

/**
 * The report file (playbook-v4 P12/2c).
 *
 * Reachable only for a PUBLISHED report, and the path comes from the database
 * rather than from the request — the slug names a row, the row names a file.
 * A route that joined a user-supplied path onto FILES_DIR would be a directory
 * traversal wearing a download button.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const report = await prismaUnsafe.sectorReport.findUnique({
    where: { slug },
    select: { status: true, pdfPath: true, title: true },
  });
  if (!report || report.status !== "published" || !report.pdfPath) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const bytes = await readFile(join(FILES_DIR, report.pdfPath));
    const name = report.title.replace(/[^\p{L}\p{N} .-]/gu, "").slice(0, 80) || "riport";
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${name}.pdf"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
