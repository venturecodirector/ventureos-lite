import { test, expect } from "@playwright/test";

/**
 * The icon set, served (brand item 7).
 *
 * The unit tests prove the files are drawn right and that the middleware's public
 * list names them. This proves the two facts meet: that a browser with NO SESSION
 * gets the actual bytes rather than a redirect to /login. That is the failure
 * mode worth a test — a favicon is fetched while the login page is on screen, and
 * an install prompt reads the manifest's icons before anyone has signed in, so an
 * icon behind the auth perimeter installs the PWA with a blank tile and nothing
 * anywhere reports an error.
 */

// Signed out, deliberately: that is the condition under test.
test.use({ storageState: { cookies: [], origins: [] } });

const ICONS: { path: string; type: RegExp }[] = [
  { path: "/favicon.svg", type: /svg/ },
  { path: "/favicon.ico", type: /icon|image/ },
  { path: "/mask-icon.svg", type: /svg/ },
  { path: "/apple-touch-icon.png", type: /png/ },
  { path: "/icon-192.png", type: /png/ },
  { path: "/icon-512.png", type: /png/ },
  { path: "/icon-192-maskable.png", type: /png/ },
  { path: "/icon-512-maskable.png", type: /png/ },
  { path: "/og-image.png", type: /png/ },
];

for (const { path, type } of ICONS) {
  test(`${path} is served to a signed-out browser`, async ({ request }) => {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), `${path} did not answer 200`).toBe(200);
    expect(res.headers()["content-type"] ?? "").toMatch(type);
    // A /login redirect body would also be "200" through some proxies; the byte
    // count is what distinguishes a real image from an HTML page.
    expect((await res.body()).byteLength).toBeGreaterThan(300);
  });
}

test("the manifest lists separate any and maskable icons, all of which exist", async ({
  request,
}) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  const manifest = await res.json();

  expect(manifest.name).toBe("Venture OS");
  expect(manifest.theme_color.toUpperCase()).toBe("#00051D");
  expect(manifest.background_color.toUpperCase()).toBe("#00051D");

  const purposes = (p: string) =>
    manifest.icons.filter((i: { purpose?: string }) => i.purpose === p);
  // Separate files, not one file doing both jobs — the "any" icon is drawn at
  // full size and only the maskable one pays for the safe zone.
  const any = purposes("any").map((i: { src: string }) => i.src);
  const maskable = purposes("maskable").map((i: { src: string }) => i.src);
  expect(maskable.length).toBeGreaterThanOrEqual(2);
  for (const src of maskable) expect(any).not.toContain(src);
  expect(purposes("monochrome").length).toBe(1);

  // Every src actually resolves, signed out.
  for (const icon of manifest.icons) {
    const path = new URL(icon.src).pathname;
    const got = await request.get(path, { maxRedirects: 0 });
    expect(got.status(), `${path} from the manifest`).toBe(200);
  }
});

test("the document head wires up the icons, the mask icon and the social card", async ({
  page,
}) => {
  // The login page: signed out is where these tags have to be right.
  await page.goto("/login");

  await expect(page.locator('link[rel="icon"][href*="favicon.svg"]')).toHaveCount(1);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  await expect(page.locator('link[rel="mask-icon"]')).toHaveCount(1);
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);

  // og:image must be ABSOLUTE — a crawler has no page to resolve it against.
  const og = page.locator('meta[property="og:image"]');
  await expect(og).toHaveCount(1);
  const url = await og.getAttribute("content");
  expect(url).toMatch(/^https?:\/\//);
  expect(url).toContain("/og-image.png");

  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    /#00051D/i,
  );
});
