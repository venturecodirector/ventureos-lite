import { chromium } from "playwright";

/**
 * The one headless-Chrome print pipeline (CLAUDE.md): HTML template -> PDF.
 * Reused for audits now, and quotes/contracts/certificates later. Worker-only
 * (never imported by the web process).
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
  } finally {
    await browser.close();
  }
}
