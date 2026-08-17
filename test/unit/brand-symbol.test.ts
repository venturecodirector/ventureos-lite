import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { VENTURE_BRAND } from "../../src/modules/workspaces/brand";
import {
  SYMBOL_BBOX,
  SYMBOL_PATH,
  ICON_CORNER_RATIO,
  ICON_PADDING_RATIO,
  APPLE_PADDING_RATIO,
  MASKABLE_GLYPH_RATIO,
  MASKABLE_SAFE_DIAMETER_RATIO,
  fitSymbol,
  fitSymbolToWidth,
  maskableSafeZoneFits,
  brandPlateSvg,
  brandMaskableSvg,
  brandMonochromeSvg,
  brandSocialCardSvg,
} from "../../src/modules/workspaces/brand-symbol";

/**
 * The icon set (brand item 7).
 *
 * These tests exist because icon bugs are invisible in review and permanent
 * afterwards. Nobody notices that the maskable icon is 2% too big until an
 * Android homescreen crops the logo, and by then it is cached on every installed
 * device. So the geometry is MEASURED off the rendered pixels here rather than
 * argued about: the bounding box the module claims, the centring, the safe zone
 * under an actual circular crop, and the fact that the gradient survived
 * rasterisation at all.
 */
const PUBLIC = join(__dirname, "..", "..", "public");
const ASSETS = join(__dirname, "..", "..", "assets", "brand");

/** Alpha (or, on an opaque plate, whiteness) bounding box of a rendered image. */
async function measure(
  input: Buffer | string,
  size: number,
  mode: "alpha" | "white",
  height = size,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const { data, info } = await sharp(input)
    .resize(size, height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * ch;
      const hit =
        mode === "alpha"
          ? data[i + ch - 1]! > 128
          : data[i]! > 200 && data[i + 1]! > 200 && data[i + 2]! > 200;
      if (!hit) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { x: minX, y: minY, width: maxX + 1 - minX, height: maxY + 1 - minY };
}

describe("the symbol's declared bounding box", () => {
  /**
   * GUARDS EVERY OTHER NUMBER IN THE MODULE. `SYMBOL_BBOX` was walked from the
   * path by hand, and every icon is positioned from it — a wrong edge here
   * shifts all nine files off-centre in a way that looks almost right.
   */
  it("is where the rendered pixels actually are", async () => {
    // Rendered at the ARTWORK's aspect ratio, not into a square. A square target
    // makes SVG's default xMidYMid letterbox the drawing and offset x by 40 user
    // units — which is how the first version of this test "found" a wrong box.
    const width = 1000;
    const height = Math.round((width * 946.4) / 835.3);
    // The raw path in its authored viewBox, no transform — so this measures the
    // artwork, not the module's placement of it.
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 835.3 946.4"><path fill="#000" d="${SYMBOL_PATH}"/></svg>`;
    const box = await measure(Buffer.from(svg), width, "alpha", height);
    // One uniform scale for both axes, which is the point of the aspect match.
    const toUser = (v: number) => (v / width) * 835.3;

    /**
     * Tolerance in USER UNITS, not decimal places.
     *
     * The measurement counts any pixel more than half covered, so a soft edge
     * lands the box up to a pixel out on each side — about 1.7 user units on a
     * dimension at this render scale. 2 is therefore the tightest honest bound;
     * `toBeCloseTo(…, 0)` means ±0.5 and rejected a correct box by 0.06 of a
     * pixel. It is still two orders of magnitude below the ~40-unit error that a
     * genuinely wrong edge produces.
     */
    const near = (actual: number, expected: number, what: string) =>
      expect(Math.abs(actual - expected), `${what}: ${actual.toFixed(2)} vs ${expected}`)
        .toBeLessThan(2);

    near(toUser(box.x), SYMBOL_BBOX.x, "left edge");
    near(toUser(box.width), SYMBOL_BBOX.width, "width");
    near(toUser(box.y), SYMBOL_BBOX.y, "top edge");
    near(toUser(box.height), SYMBOL_BBOX.height, "height");
  });

  it("agrees with the gradient span the designer declared", () => {
    // The source file's gradient runs userSpaceOnUse from x1=72.9 to x2=762.3 —
    // an independent statement of the glyph's left and right edges.
    expect(SYMBOL_BBOX.x).toBeCloseTo(72.9, 1);
    expect(SYMBOL_BBOX.x + SYMBOL_BBOX.width).toBeCloseTo(762.3, 1);
  });

  it("matches the two source files still in the repo", () => {
    for (const f of ["symbol-gradient.svg", "symbol-gradient-on-plate.svg"]) {
      expect(existsSync(join(ASSETS, f)), f).toBe(true);
    }
    // The path is quoted verbatim from the first file; if someone replaces the
    // artwork without regenerating, this is what says so.
    const source = readFileSync(join(ASSETS, "symbol-gradient.svg"), "utf8");
    expect(source).toContain(SYMBOL_PATH);
  });
});

describe("fitting the symbol into a square", () => {
  it("fills the padded box on the constraining axis and centres the slack", () => {
    const size = 512;
    const fit = fitSymbol(size, 0.2);
    // Wider than tall, so width is what the padding bites into.
    expect(fit.width).toBeCloseTo(size * 0.6, 3);
    expect(fit.height).toBeLessThan(fit.width);
    // Centred both ways: equal margins.
    const left = fit.tx + SYMBOL_BBOX.x * fit.scale;
    const top = fit.ty + SYMBOL_BBOX.y * fit.scale;
    expect(left).toBeCloseTo((size - fit.width) / 2, 3);
    expect(top).toBeCloseTo((size - fit.height) / 2, 3);
  });

  it("scales linearly, so the 192 and the 512 are one drawing", () => {
    const small = fitSymbol(192, ICON_PADDING_RATIO);
    const large = fitSymbol(512, ICON_PADDING_RATIO);
    expect(large.width / small.width).toBeCloseTo(512 / 192, 6);
    expect(large.height / small.height).toBeCloseTo(512 / 192, 6);
  });

  it("expresses a width ratio as the equivalent padding", () => {
    expect(fitSymbolToWidth(512, 0.58).width).toBeCloseTo(512 * 0.58, 3);
    expect(fitSymbolToWidth(512, 0.6)).toEqual(fitSymbol(512, 0.2));
  });
});

describe("the maskable safe zone", () => {
  it("contains the glyph at the ratio actually shipped", () => {
    expect(maskableSafeZoneFits(512, MASKABLE_GLYPH_RATIO)).toBe(true);
  });

  /**
   * THE REASON THE RATIO IS 0.58 AND NOT 0.6. If this ever starts passing, the
   * safe-zone maths changed and the shipped ratio should be revisited.
   */
  it("does NOT contain it at the round 0.6 — which is why 0.58 is shipped", () => {
    expect(maskableSafeZoneFits(512, 0.6)).toBe(false);
  });

  it("survives a real 80% circular crop with no white touching the edge", async () => {
    const size = 512;
    const svg = brandMaskableSvg(VENTURE_BRAND, size);
    const radius = (size * MASKABLE_SAFE_DIAMETER_RATIO) / 2;
    const mask = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
        `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="#fff"/></svg>`,
    );
    const cropped = await sharp(Buffer.from(svg))
      .resize(size, size)
      .composite([{ input: mask, blend: "dest-in" }])
      .png()
      .toBuffer();

    // Every white pixel that survived must sit inside the circle. If the glyph
    // poked out, the crop would have sliced it and the surviving white would run
    // right up to the circle's boundary.
    const box = await measure(cropped, size, "white");
    const corners = [
      [box.x, box.y],
      [box.x + box.width, box.y],
      [box.x, box.y + box.height],
      [box.x + box.width, box.y + box.height],
    ];
    for (const [x, y] of corners) {
      const d = Math.hypot(x! - size / 2, y! - size / 2);
      expect(d, `glyph corner at ${d.toFixed(1)}px vs safe radius ${radius}`).toBeLessThan(radius);
    }
  });
});

describe("the generated SVGs", () => {
  it("rounds the standard plate and leaves the maskable one square", () => {
    const plate = brandPlateSvg(VENTURE_BRAND, { size: 512 });
    expect(plate).toContain(`rx="${512 * ICON_CORNER_RATIO}"`);
    expect(brandMaskableSvg(VENTURE_BRAND, 512)).not.toContain("rx=");
  });

  it("takes its colours from the brand, never from a literal", () => {
    const other = {
      ...VENTURE_BRAND,
      gradientFrom: "#112233",
      gradientTo: "#445566",
      canvas: "#0A0A0A",
    };
    const plate = brandPlateSvg(other, { size: 256 });
    expect(plate).toContain("#112233");
    expect(plate).toContain("#445566");
    expect(plate).not.toContain(VENTURE_BRAND.gradientFrom);
    expect(brandSocialCardSvg(other)).toContain("#0A0A0A");
  });

  it("reproduces the official gradient orientation — light purple on the left", async () => {
    // The supplied artwork runs gradientTo → gradientFrom left to right. Getting
    // this backwards is invisible in code review and obvious on a homescreen.
    const size = 64;
    const { data, info } = await sharp(Buffer.from(brandMaskableSvg(VENTURE_BRAND, size)))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = (x: number) => {
      const i = (Math.floor(info.height / 2) * info.width + x) * info.channels;
      return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! };
    };
    const left = px(1);
    const right = px(size - 2);
    // #7427C6 on the left is lighter and redder than #310B59 on the right.
    expect(left.r).toBeGreaterThan(right.r);
    expect(left.b).toBeGreaterThan(right.b);
  });

  it("gives the monochrome cut one colour and no background", () => {
    const mono = brandMonochromeSvg(512);
    expect(mono).not.toContain("<rect");
    expect(mono).not.toContain("linearGradient");
    expect((mono.match(/fill="/g) ?? []).length).toBe(1);
  });

  it("puts the social card on the brand canvas at 1200×630", () => {
    const card = brandSocialCardSvg(VENTURE_BRAND);
    expect(card).toContain('width="1200"');
    expect(card).toContain('height="630"');
    expect(card).toContain(VENTURE_BRAND.canvas);
  });
});

describe("the files that actually ship", () => {
  const expected: { file: string; size: number | null; opaque: boolean }[] = [
    { file: "favicon.svg", size: null, opaque: false },
    { file: "mask-icon.svg", size: null, opaque: false },
    { file: "apple-touch-icon.png", size: 180, opaque: true },
    { file: "icon-192.png", size: 192, opaque: false },
    { file: "icon-512.png", size: 512, opaque: false },
    { file: "icon-192-maskable.png", size: 192, opaque: true },
    { file: "icon-512-maskable.png", size: 512, opaque: true },
  ];

  for (const { file, size, opaque } of expected) {
    it(`ships ${file}${size ? ` at ${size}×${size}` : ""}`, async () => {
      const path = join(PUBLIC, file);
      expect(existsSync(path), `${file} is missing`).toBe(true);
      if (size === null) return;
      const meta = await sharp(path).metadata();
      expect(meta.width).toBe(size);
      expect(meta.height).toBe(size);
      if (opaque) {
        // A transparent Apple touch icon renders black on iOS; a maskable icon
        // with holes shows the shelf through them.
        const stats = await sharp(path).stats();
        expect(stats.isOpaque, `${file} has transparency`).toBe(true);
      }
    });
  }

  it("ships an og:image at exactly 1200×630", async () => {
    const meta = await sharp(join(PUBLIC, "og-image.png")).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(630);
  });

  it("no longer ships the superseded favicon-solid.svg", () => {
    expect(existsSync(join(PUBLIC, "favicon-solid.svg"))).toBe(false);
  });

  it("carries a real gradient in the rasters, not a flat fill", async () => {
    for (const file of ["icon-512.png", "icon-512-maskable.png", "apple-touch-icon.png"]) {
      const { data, info } = await sharp(join(PUBLIC, file))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const at = (fx: number) => {
        const x = Math.round(info.width * fx);
        const y = Math.round(info.height * 0.5);
        const i = (y * info.width + x) * info.channels;
        return [data[i]!, data[i + 1]!, data[i + 2]!];
      };
      const l = at(0.06);
      const r = at(0.94);
      const delta = Math.abs(l[0]! - r[0]!) + Math.abs(l[1]! - r[1]!) + Math.abs(l[2]! - r[2]!);
      expect(delta, `${file} looks flat — the rasteriser dropped the gradient`).toBeGreaterThan(24);
    }
  });

  it("packs 16, 32 and 48 into the .ico, each a PNG", () => {
    const b = readFileSync(join(PUBLIC, "favicon.ico"));
    expect(b.readUInt16LE(0)).toBe(0); // reserved
    expect(b.readUInt16LE(2)).toBe(1); // type: icon
    const count = b.readUInt16LE(4);
    expect(count).toBe(3);
    const sizes: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const at = 6 + i * 16;
      sizes.push(b.readUInt8(at) || 256);
      const offset = b.readUInt32LE(at + 12);
      const length = b.readUInt32LE(at + 8);
      expect(offset + length).toBeLessThanOrEqual(b.length);
      // PNG magic — the whole point of PNG-in-ICO rather than a BMP payload.
      expect(b.subarray(offset, offset + 4).toString("hex")).toBe("89504e47");
    }
    expect(sizes).toEqual([16, 32, 48]);
  });

  it("draws the touch icon larger than the tab icon, as intended", async () => {
    // 15% padding vs 20%: on a homescreen the icon is cropped to a squircle, so
    // the same padding would read as smaller than every app beside it.
    expect(APPLE_PADDING_RATIO).toBeLessThan(ICON_PADDING_RATIO);
    const apple = await measure(join(PUBLIC, "apple-touch-icon.png"), 512, "white");
    const standard = await measure(join(PUBLIC, "icon-512.png"), 512, "white");
    expect(apple.width).toBeGreaterThan(standard.width);
  });

  it("draws the maskable glyph smaller than the standard one", async () => {
    const maskable = await measure(join(PUBLIC, "icon-512-maskable.png"), 512, "white");
    const standard = await measure(join(PUBLIC, "icon-512.png"), 512, "white");
    expect(maskable.width).toBeLessThan(standard.width);
    expect(maskable.width / 512).toBeCloseTo(MASKABLE_GLYPH_RATIO, 1);
  });
});

describe("every icon is reachable without a session", () => {
  /**
   * A browser fetches the favicon while displaying the LOGIN page, and an
   * install prompt reads the manifest's icons before anybody has signed in. An
   * icon behind the auth middleware answers with a redirect to /login, and the
   * PWA installs with a blank tile.
   */
  const middleware = readFileSync(join(__dirname, "..", "..", "src", "middleware.ts"), "utf8");
  const manifest = readFileSync(
    join(__dirname, "..", "..", "src", "app", "manifest.ts"),
    "utf8",
  );
  const layout = readFileSync(join(__dirname, "..", "..", "src", "app", "layout.tsx"), "utf8");

  const referenced = [
    ...new Set(
      [...`${manifest}\n${layout}`.matchAll(/["'`/$}]+(\/[a-z0-9-]+\.(?:png|svg|ico))/gi)].map(
        (m) => m[1]!,
      ),
    ),
  ];

  it("finds the icon references it means to check", () => {
    expect(referenced.length).toBeGreaterThanOrEqual(8);
  });

  for (const path of referenced) {
    it(`allows ${path} through the middleware and ships the file`, () => {
      expect(middleware.includes(`"${path}"`), `${path} is not a public prefix`).toBe(true);
      expect(existsSync(join(PUBLIC, path.slice(1))), `${path} does not exist`).toBe(true);
    });
  }
});
