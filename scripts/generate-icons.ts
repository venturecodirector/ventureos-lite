/**
 * Rasterise the icon set from the brand symbol.  `npx tsx scripts/generate-icons.ts`
 *
 * Run by hand, not at build time: the outputs are committed, because a favicon
 * that depends on a native image library being installed is a favicon that
 * eventually goes missing on somebody's machine. Re-run it when the symbol or the
 * seed brand colours change, and commit what it writes.
 *
 * RASTERISER: sharp 0.34 (libvips + librsvg). librsvg is what makes the gradient
 * come out as a gradient — several lighter SVG rasterisers silently drop
 * `userSpaceOnUse` gradient coordinates and render a flat fill, which is why the
 * generated PNGs get sampled for a left-to-right colour ramp at the end of this
 * script rather than eyeballed.
 *
 * Geometry lives in `src/modules/workspaces/brand-symbol.ts` and is shared with
 * the tests, so what is asserted is what is drawn.
 */
import sharp from "sharp";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { VENTURE_BRAND } from "../src/modules/workspaces/brand";
import {
  brandPlateSvg,
  brandMaskableSvg,
  brandMonochromeSvg,
  brandSocialCardSvg,
  ICON_PADDING_RATIO,
  APPLE_PADDING_RATIO,
  MASKABLE_GLYPH_RATIO,
  maskableSafeZoneFits,
} from "../src/modules/workspaces/brand-symbol";

const PUBLIC = join(__dirname, "..", "public");

/**
 * The seed brand supplies the colours. Not literals: a white-labelled
 * deployment regenerates its own set by passing its own brand here, and this is
 * the DEFAULT set rather than the only possible one.
 */
const BRAND = VENTURE_BRAND;

/**
 * The 16px raster is drawn tighter than the rest.
 *
 * At 16px, 20% padding leaves the glyph 9.6px wide and the shape stops reading
 * as anything. The .ico is only ever used by browsers that refused the SVG, so
 * it never appears next to the 20% version and the inconsistency is invisible;
 * an unreadable tab icon would not be.
 */
const SMALL_RASTER_PADDING = 0.12;

async function png(svg: string, size: number, opaque = false): Promise<Buffer> {
  let pipeline = sharp(Buffer.from(svg)).resize(size, size, { fit: "fill" });
  // iOS renders an alpha channel in a touch icon as black. The plate is already
  // full-bleed, so flattening only drops the unused channel.
  if (opaque) pipeline = pipeline.flatten({ background: BRAND.canvas });
  return pipeline.png({ compressionLevel: 9 }).toBuffer();
}

/**
 * An .ico containing PNG images, which sharp cannot write and every browser
 * since IE9 can read.
 *
 * ICONDIR (6 bytes) + one 16-byte ICONDIRENTRY per image + the PNG payloads.
 * A dimension byte of 0 means 256, which is why nothing here goes above 48.
 */
function buildIco(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((img, i) => {
    const at = i * 16;
    directory.writeUInt8(img.size >= 256 ? 0 : img.size, at + 0); // width
    directory.writeUInt8(img.size >= 256 ? 0 : img.size, at + 1); // height
    directory.writeUInt8(0, at + 2); // palette size, 0 for truecolour
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(img.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += img.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.data)]);
}

/**
 * Confirm a rendered PNG actually carries the gradient.
 *
 * Samples the plate near the left and right edges, at the vertical midpoint but
 * off-centre horizontally enough to miss the glyph. A rasteriser that dropped the
 * gradient renders both samples identical, and this is the check that catches it
 * before it reaches a homescreen.
 */
async function reportGradient(label: string, file: string): Promise<void> {
  const { data, info } = await sharp(join(PUBLIC, file)).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const at = (fx: number, fy: number) => {
    const x = Math.round(info.width * fx);
    const y = Math.round(info.height * fy);
    const i = (y * info.width + x) * info.channels;
    return [data[i]!, data[i + 1]!, data[i + 2]!] as const;
  };
  const hex = (c: readonly number[]) =>
    `#${c.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  const left = at(0.06, 0.5);
  const right = at(0.94, 0.5);
  const delta = Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]) + Math.abs(left[2] - right[2]);
  console.log(
    `    gradient ${label}: left ${hex(left)} → right ${hex(right)}  ` +
      (delta > 24 ? `Δ${delta} ✓` : `Δ${delta} ✗ FLAT — the rasteriser dropped it`),
  );
}

async function main(): Promise<void> {
  // Fail loudly rather than shipping a clipped maskable icon.
  if (!maskableSafeZoneFits(512, MASKABLE_GLYPH_RATIO)) {
    throw new Error(
      `glyph at ${MASKABLE_GLYPH_RATIO} of the width leaves the maskable safe circle`,
    );
  }

  const written: string[] = [];
  const write = (name: string, data: Buffer | string) => {
    writeFileSync(join(PUBLIC, name), data);
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    written.push(`${name} (${bytes.toLocaleString()} B)`);
  };

  // ---- vector ------------------------------------------------------------
  // 512 as the authoring box: the SVG scales, but the corner radius and padding
  // are computed from the side, so a round number keeps the numbers readable.
  write("favicon.svg", brandPlateSvg(BRAND, { size: 512 }));
  write("mask-icon.svg", brandMonochromeSvg(512));

  // ---- .ico --------------------------------------------------------------
  const icoSizes = [16, 32, 48];
  const icoImages = await Promise.all(
    icoSizes.map(async (size) => ({
      size,
      data: await png(
        brandPlateSvg(BRAND, {
          size: 512,
          padding: size <= 16 ? SMALL_RASTER_PADDING : ICON_PADDING_RATIO,
        }),
        size,
      ),
    })),
  );
  write("favicon.ico", buildIco(icoImages));

  // ---- raster ------------------------------------------------------------
  // No rounding: iOS applies its own squircle mask, and pre-rounding it would
  // show the plate's corners cut twice.
  write(
    "apple-touch-icon.png",
    await png(
      brandPlateSvg(BRAND, { size: 512, padding: APPLE_PADDING_RATIO, cornerRatio: 0 }),
      180,
      true,
    ),
  );

  for (const size of [192, 512]) {
    write(`icon-${size}.png`, await png(brandPlateSvg(BRAND, { size: 512 }), size));
    write(`icon-${size}-maskable.png`, await png(brandMaskableSvg(BRAND, 512), size, true));
  }

  write(
    "og-image.png",
    await sharp(Buffer.from(brandSocialCardSvg(BRAND)))
      .resize(1200, 630, { fit: "fill" })
      .flatten({ background: BRAND.canvas })
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );

  // ---- stale ------------------------------------------------------------
  // Superseded by mask-icon.svg, which serves both Safari's pinned tab and the
  // manifest's monochrome slot.
  for (const stale of ["favicon-solid.svg"]) {
    const path = join(PUBLIC, stale);
    if (existsSync(path)) {
      unlinkSync(path);
      console.log(`  removed stale ${stale}`);
    }
  }

  console.log(`  wrote ${written.length} files:`);
  for (const w of written) console.log(`    ${w}`);

  console.log("  visual checks:");
  await reportGradient("favicon (48px sample of the 512 plate)", "icon-512.png");
  await reportGradient("maskable", "icon-512-maskable.png");
  await reportGradient("apple touch", "apple-touch-icon.png");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
