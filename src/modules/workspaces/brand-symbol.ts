import type { WorkspaceBrand } from "./brand";

/**
 * The brand symbol, and every icon built from it.
 *
 * ── WHY THIS IS A MODULE AND NOT NINE HAND-DRAWN FILES ──────────────────────
 *
 * An icon set is nine renderings of one shape at different paddings, on
 * different backgrounds, for platforms with different masking rules. Drawn by
 * hand they drift: the favicon ends up optically larger than the touch icon, the
 * maskable one gets clipped on Android, and nobody notices until a phone
 * homescreen shows a cropped logo. Here the shape is stated once, the padding
 * ratios are named constants, and the geometry is computed — so "the 512 and the
 * 192 are the same drawing" is arithmetic rather than a hope, and a test can
 * check the maskable safe zone instead of a human squinting at it.
 *
 * ── THE SOURCE ARTWORK ──────────────────────────────────────────────────────
 *
 * `assets/brand/symbol-gradient.svg` (the symbol filled with the brand gradient,
 * on transparent) and `assets/brand/symbol-gradient-on-plate.svg` (the same
 * symbol in white on a full-bleed gradient rectangle). Their path data is
 * identical apart from the opening move: the two files place the same glyph at
 * different offsets inside a 835.3 × 946.4 viewBox — 11.5 right and 48 up in the
 * second — and NEITHER centres it. So the path is kept verbatim (it is authored
 * artwork; retyping its coordinates would be a way to introduce a silent
 * distortion) and positioned by transform from its measured bounding box, which
 * is what makes every icon below optically centred rather than centred-as-drawn.
 */

/**
 * The glyph, exactly as authored in "Logó csomag_Szimbólum Gradient.svg".
 *
 * Do not reformat or "simplify" this. It is traced artwork, and the bounding box
 * below was measured from these very coordinates — editing one without the other
 * silently shifts every icon.
 */
export const SYMBOL_PATH =
  "M383.5,249.1v134.7s12.7,0,12.7,0h12s132.9-182.5,132.9-182.5h221.2v118.6l-373.9,508.2h-162.6v-237.3c0-75.6-61.3-137-137-137h-15.9v-252.5h262.8c26.4,0,47.8,21.4,47.8,47.8Z";

/** The viewBox the artwork was authored in, kept for provenance. */
export const SYMBOL_SOURCE_VIEWBOX = { width: 835.3, height: 946.4 } as const;

/**
 * The glyph's own bounding box inside that viewBox, walked from the path above.
 *
 * The source file corroborates it: its gradient is declared in `userSpaceOnUse`
 * from x1=72.9 to x2=762.3 — the designer spanned the gradient across exactly
 * this box, which is an independent confirmation of the left and right edges. A
 * unit test re-derives all four edges by rasterising and measuring the alpha
 * channel, so a wrong number here fails rather than merely looking slightly off.
 */
export const SYMBOL_BBOX = { x: 72.9, y: 201.3, width: 689.4, height: 626.8 } as const;

/** Wider than tall (1.1:1), so width is what constrains a square icon. */
export const SYMBOL_ASPECT = SYMBOL_BBOX.width / SYMBOL_BBOX.height;

// ---- the ratios every icon is built from ------------------------------------

/**
 * Corner radius of the rounded-square app icon, as a fraction of its side.
 *
 * 18% sits between the platforms rather than imitating one: iOS's squircle is
 * ~22.4% and Android's adaptive shelf ~12%, and both apply their OWN mask to the
 * icons that need it (apple-touch-icon, maskable). This radius is for the
 * surfaces where nobody masks anything and a bare square would look unfinished —
 * a browser tab, a bookmark bar, a desktop PWA shortcut.
 */
export const ICON_CORNER_RATIO = 0.18;

/** Padding on the constraining axis for the standard rounded icon. */
export const ICON_PADDING_RATIO = 0.2;

/**
 * Padding for the Apple touch icon, deliberately tighter than the standard one.
 *
 * iOS crops the icon to its own squircle, which eats the corners — so the same
 * 20% would read as noticeably smaller than every neighbouring app on the
 * homescreen.
 */
export const APPLE_PADDING_RATIO = 0.15;

/**
 * Glyph width as a fraction of a MASKABLE icon's side.
 *
 * A maskable icon must survive an arbitrary mask, and the guaranteed-visible
 * region is only the central circle of 80% diameter — radius 0.4·side. The glyph
 * box is 1.1:1, so at width w its half-diagonal is 0.5·w·√(1+(1/1.0999)²) =
 * 0.676·w, which reaches the safe radius at w ≈ 0.592.
 *
 * Hence 0.58 and not the round 0.6: 0.6 puts the box corners at radius 0.405 —
 * just OUTSIDE the safe circle. It would almost certainly still look fine, since
 * the glyph does not fill its own corners, but "almost certainly" is how a
 * clipped logo ships. `maskableSafeZoneFits` asserts the margin.
 */
export const MASKABLE_GLYPH_RATIO = 0.58;

/** The maskable safe zone from the spec: a centred circle, 80% of the side. */
export const MASKABLE_SAFE_DIAMETER_RATIO = 0.8;

// ---- geometry ---------------------------------------------------------------

export interface FitTransform {
  scale: number;
  tx: number;
  ty: number;
  /** The glyph's rendered size, which is what the safe-zone check needs. */
  width: number;
  height: number;
}

/**
 * Place the glyph inside a `size × size` square, contained and centred.
 *
 * `padding` is a fraction of the side taken off EACH edge, so the content box is
 * `size·(1 - 2·padding)`. Contained rather than stretched: the glyph keeps its
 * aspect ratio and the slack lands on the short axis, which for this shape means
 * a little extra room above and below.
 */
export function fitSymbol(size: number, padding: number): FitTransform {
  const content = size * (1 - 2 * padding);
  const scale = Math.min(content / SYMBOL_BBOX.width, content / SYMBOL_BBOX.height);
  const width = SYMBOL_BBOX.width * scale;
  const height = SYMBOL_BBOX.height * scale;
  return {
    scale,
    // Translate the measured box to the origin first, then centre it.
    tx: (size - width) / 2 - SYMBOL_BBOX.x * scale,
    ty: (size - height) / 2 - SYMBOL_BBOX.y * scale,
    width,
    height,
  };
}

/** The same, sized by the glyph's WIDTH rather than by a padding. */
export function fitSymbolToWidth(size: number, widthRatio: number): FitTransform {
  // A width ratio r is the same as padding (1 - r)/2 on the constraining axis.
  return fitSymbol(size, (1 - widthRatio) / 2);
}

/**
 * Does a glyph of this width fit the maskable safe circle?
 *
 * Checked against the box's half-diagonal — its worst case — because a mask is
 * applied by the platform and there is no second chance at it.
 */
export function maskableSafeZoneFits(size: number, widthRatio: number): boolean {
  const fit = fitSymbolToWidth(size, widthRatio);
  const halfDiagonal = Math.hypot(fit.width, fit.height) / 2;
  return halfDiagonal <= (size * MASKABLE_SAFE_DIAMETER_RATIO) / 2;
}

// ---- SVG builders ----------------------------------------------------------

const GRADIENT_ID = "brand-symbol-gradient";

/**
 * The gradient, in the orientation the official artwork uses.
 *
 * Left-to-right, and the stops run gradientTo → gradientFrom. That looks
 * backwards and is not: `brand.gradientFrom/To` are ordered for the 135° CSS
 * gradient the UI uses (dark → light), while the supplied symbol files run the
 * light purple in on the LEFT horizontally. Same two colours, and reproducing
 * the official asset wins over matching a CSS declaration's argument order.
 */
function gradientDef(brand: WorkspaceBrand, x2: number): string {
  return (
    `<linearGradient id="${GRADIENT_ID}" x1="0" y1="0" x2="${round(x2)}" y2="0" ` +
    `gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${brand.gradientTo}"/>` +
    `<stop offset="1" stop-color="${brand.gradientFrom}"/>` +
    `</linearGradient>`
  );
}

/** Three decimals: enough for sub-pixel placement at 1024px, no float noise. */
function round(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function glyph(fill: string, fit: FitTransform): string {
  return (
    `<g transform="translate(${round(fit.tx)} ${round(fit.ty)}) scale(${round(fit.scale)})">` +
    `<path fill="${fill}" d="${SYMBOL_PATH}"/></g>`
  );
}

function svg(width: number, height: number, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">${body}</svg>`
  );
}

/**
 * Pure white for the glyph on a coloured plate.
 *
 * Not `brand.ink`: ink is body-text colour, and a workspace that softened it to
 * a grey would get a muddy logo. White on the gradient is contrast, not
 * identity — the same reason the templates are allowed `#FFFFFF`.
 */
const PLATE_GLYPH = "#FFFFFF";

export interface PlateOptions {
  size: number;
  padding?: number;
  /** Corner radius as a fraction of the side. 0 = a bare square. */
  cornerRatio?: number;
}

/**
 * The app icon: white symbol on the brand gradient.
 *
 * One builder for the favicon, the .ico rasters, the Apple touch icon and both
 * PWA icons — they differ only in size, padding and whether the corners are
 * rounded, which is exactly what the arguments are.
 */
export function brandPlateSvg(brand: WorkspaceBrand, opts: PlateOptions): string {
  const { size } = opts;
  const padding = opts.padding ?? ICON_PADDING_RATIO;
  const cornerRatio = opts.cornerRatio ?? ICON_CORNER_RATIO;
  const r = size * cornerRatio;
  const plate =
    r > 0
      ? `<rect width="${size}" height="${size}" rx="${round(r)}" ry="${round(r)}" fill="url(#${GRADIENT_ID})"/>`
      : `<rect width="${size}" height="${size}" fill="url(#${GRADIENT_ID})"/>`;
  return svg(
    size,
    size,
    `<defs>${gradientDef(brand, size)}</defs>${plate}${glyph(PLATE_GLYPH, fitSymbol(size, padding))}`,
  );
}

/** The maskable variant: full-bleed plate, glyph inside the safe circle. */
export function brandMaskableSvg(brand: WorkspaceBrand, size: number): string {
  return svg(
    size,
    size,
    `<defs>${gradientDef(brand, size)}</defs>` +
      `<rect width="${size}" height="${size}" fill="url(#${GRADIENT_ID})"/>` +
      glyph(PLATE_GLYPH, fitSymbolToWidth(size, MASKABLE_GLYPH_RATIO)),
  );
}

/**
 * The symbol alone, filled with the gradient, on transparent — the first of the
 * two supplied files, recentred. For surfaces that provide their own background.
 */
export function brandSymbolSvg(brand: WorkspaceBrand, size: number, padding = 0): string {
  const fit = fitSymbol(size, padding);
  return svg(
    size,
    size,
    `<defs>${gradientDef(brand, size)}</defs>${glyph(`url(#${GRADIENT_ID})`, fit)}`,
  );
}

/**
 * A single-colour cut, on transparent.
 *
 * Serves two consumers with one file: Safari's pinned-tab mask icon (which
 * demands exactly this — one opaque colour, no background, Safari recolours it)
 * and the manifest's `purpose: "monochrome"` slot, for shelves and notification
 * badges that would otherwise flatten the gradient into a single muddy tone.
 * Nearly edge-to-edge, because both consumers render it very small.
 */
export function brandMonochromeSvg(size: number, color = "#000000"): string {
  return svg(size, size, glyph(color, fitSymbol(size, 0.04)));
}

/**
 * The social card: the gradient symbol on the brand canvas.
 *
 * No text. A link preview is rendered at wildly different sizes by every
 * platform that consumes it, the title and description come from the page's own
 * meta tags anyway, and baking a wordmark in would mean shipping a font to the
 * rasteriser and re-rendering it per workspace.
 */
export function brandSocialCardSvg(
  brand: WorkspaceBrand,
  width = 1200,
  height = 630,
): string {
  // Sized off the SHORT edge so the symbol is never wider than the card is tall.
  // 0.18 rather than the icons' 0.20: a link preview is often rendered at a
  // fraction of its native size in a chat list, and at 0.26 the mark read as
  // adrift in the middle of a large dark rectangle.
  const box = Math.min(width, height);
  const fit = fitSymbol(box, 0.18);
  return svg(
    width,
    height,
    `<defs>${gradientDef(brand, box)}</defs>` +
      `<rect width="${width}" height="${height}" fill="${brand.canvas}"/>` +
      `<g transform="translate(${round((width - box) / 2)} ${round((height - box) / 2)})">` +
      glyph(`url(#${GRADIENT_ID})`, fit) +
      `</g>`,
  );
}
