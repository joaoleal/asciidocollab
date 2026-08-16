/**
 * @file The vertical metrics a face carries, and the line box the renderer builds out of them.
 *
 * ## Why this exists
 *
 * A theme's `line-height` is not the height of a line. The renderer advances a baseline by
 * `font.height + leading`, where `font.height` is the FONT FILE's own height and `leading` is
 * `(theme_line_height - 1) x font_size` — that is `calc_line_metrics` in the gem's prawn extensions
 * (`leading = line_height * font_size - font_size`) meeting `Prawn::Text::Formatted::Box`, which
 * moves each baseline down by `line_height + leading` where the line's height is `Prawn::Font#height`.
 * The gem's own default theme says so out loud: "The Noto font family has a built-in line height of
 * 1.36 … a line of text will occupy a height of 15.78pt" for 10.5pt text at its 1.143 line height.
 *
 * CSS `line-height` is the whole box instead, so the same number produces 12pt where the page
 * produces 15.78pt — a page of text that is a fifth too tight. `line-height: normal` is not the way
 * out: the browser and prawn read different metric tables, and measured against these very files
 * Chrome's normal is 1.49 for M+ 1mn where prawn reads 1.09. The only faithful answer is to know each
 * face's own height as a number and set the box explicitly.
 *
 * ## Which numbers
 *
 * `Prawn::Font#height_at` is `(ascender - descender + line_gap) / 1000 x size`, over values prawn
 * scales into a 1000-unit em and truncates (`Integer(value * 1000.0 / units_per_em)`). The three raw
 * values are ttfunk's choice: an OS/2 typographic value when that table exists, declares a version
 * above zero and the value is non-zero, and otherwise `hhea` — decided per field, so a font whose
 * `sTypoLineGap` is zero takes its gap from `hhea` while its ascender still comes from OS/2.
 *
 * The ascender and the descender are kept apart from their sum, because the renderer uses them
 * separately and so does this preview. `Prawn::Text::Formatted::Fragment#top` is `baseline +
 * ascender` and `#bottom` is `baseline - descender`, and everything drawn around a run of text is
 * measured from those two: the tint behind a codespan, the box around a key cap, a highlight's
 * extent, and the amount a superscript is raised by. None of that can be had from the height.
 *
 * ## Why the browser needs telling
 *
 * A browser reads the same file and arrives at DIFFERENT numbers. Skia's FreeType port takes `hhea`
 * unless the font sets the OS/2 `USE_TYPO_METRICS` flag, where ttfunk prefers the OS/2 typographic
 * values whenever they exist — and the two disagree in the gem's own catalogue: M+ 1mn declares
 * `hhea` 1075/-320 against OS/2 typographic 860/-140, so the box a browser paints behind a codespan
 * is 1.395em tall where the renderer's is 1.0em. That is not a rounding difference; it is a third
 * again as much tint, top and bottom.
 *
 * Override descriptors are the answer: CSS lets an `@font-face` declare the metrics the browser must
 * use, so the preview hands it the renderer's own and the disagreement stops existing. There are two
 * readings of those metrics and the file is registered twice, once under each — {@link
 * faceLineOverrides} for the registration the page's text is laid out in, {@link faceBoxOverrides}
 * for the one a box is painted against. A browser too old for the descriptors ignores them and draws
 * what it drew before, which is the honest degradation.
 *
 * ## Where they come from
 *
 * Catalogue faces carry theirs in the committed manifest `packages/asciidoc-pdf` generates from the
 * gem, so nothing reads a font file to lay out a page. A project's own face is read here from the
 * bytes the browser already holds — the same bytes it is about to draw with — which is why this
 * parser exists at all and why it adds no dependency.
 */

import manifest from '@asciidocollab/asciidoc-pdf/assets/fonts/manifest.json';
// The stand-ins' `browser.json`, for the reason `font-faces.ts` sets out beside the same import: the
// manifest carries the evidence the conversion is auditable by, and none of it is read here.
import base14Manifest from '@asciidocollab/asciidoc-pdf/assets/base14-fonts/browser.json';
import type { AppearanceDiagnostic } from '@asciidocollab/shared';
import { FACE_STYLES } from './font-faces';
import type { FaceMetricOverrides, FaceRegistration, FaceStyle, FontPlan } from './font-faces';

/** The metrics one face carries, in the font's own design units. */
export interface FaceMetrics {
  /** Design units per em, which every other value here is measured in. */
  readonly unitsPerEm: number;
  /** Distance above the baseline, positive. */
  readonly ascender: number;
  /** Distance below the baseline, negative in every real font. */
  readonly descender: number;
  /** The gap the font's designer recommends between one line and the next. */
  readonly lineGap: number;
  /**
   * How far the `x` glyph advances — the one horizontal measurement the renderer takes off a face.
   *
   * It is here because two constructs are laid out with it and nothing else can supply it. A list's
   * marker is set one `rendered_width_of_char 'x'` clear of its text (`converter.rb:1712`), and a
   * callout list's marker column is that same width beside the glyph (`converter.rb:1418`). CSS has
   * no unit for the advance of a nominated glyph — `ch` is the advance of `0`, a different number in
   * every proportional face — so a preview that wanted the gutter the page has had to know this one.
   *
   * Absent for a face whose `x` cannot be read, which is a face the gutter falls back on the
   * stylesheet's own default for.
   */
  readonly xAdvance?: number;
}

/** Prawn measures every font in a 1000-unit em before it does anything else with it. */
const PRAWN_EM = 1000;

/**
 * The three vertical measurements the renderer takes off a face, each as a multiple of the font size.
 *
 * Every one of them is prawn's: `Font#ascender` is `@ascender / 1000.0 * size`, `Font#descender` is
 * `-@descender / 1000.0 * size` — positive, because prawn negates the font's own sign — and
 * `Font#height_at` is their difference plus the line gap.
 */
export interface FaceBox {
  /** The face's own line height, which is prawn's `Font#height_at` divided by the size. */
  readonly lineHeight: number;
  /** How far the face reaches above the baseline. */
  readonly ascender: number;
  /** How far it reaches below, as a positive number, which is the sign prawn uses. */
  readonly descender: number;
  /** The gap the face's designer asks for between one line and the next. */
  readonly lineGap: number;
  /**
   * How far the `x` glyph advances, which is the width a list's marker gutter is measured in.
   *
   * The same truncation as the three above, and for the same reason: prawn scales every width into
   * a 1000-unit em and takes the integer (`Integer(hmtx.widths[gid] * scale_factor)` in its TTF
   * font), so a preview that rounded instead would be a fraction of a point off the page's own gap.
   *
   * Absent for a face whose `x` this preview could not read.
   */
  readonly xAdvance?: number;
}

/**
 * The face's box, as the renderer measures it.
 *
 * The truncation is prawn's and is kept: `Integer(2189 * 1000.0 / 2048)` is 1068, not 1069, and three
 * truncations are worth about a thousandth of an em — below anything visible on their own, and not
 * worth being different from the renderer over.
 *
 * @param metrics - The face's design-unit metrics.
 * @returns The box, or undefined when the metrics cannot describe a line.
 */
export function faceBox(metrics: FaceMetrics): FaceBox | undefined {
  const { unitsPerEm, ascender, descender, lineGap, xAdvance } = metrics;
  if (!Number.isFinite(unitsPerEm) || unitsPerEm <= 0) return undefined;
  // Hoisted and multiplied where prawn multiplies and then divides (`Integer(value * 1000.0 / upem)`),
  // which for a non-dyadic em can put the two a single ULP apart on either side of an integer: at
  // `unitsPerEm` 901 a value of 901 truncates to 999 here and to 1000 there. Swept over every em from
  // 16 to 16384 against every metric a face can carry, no standard em mismatches — 128, 256, 512, 1000,
  // 1024, 2000, 2048, 4096, 8192 and 16384 are all exact, the division being either exact or by a power
  // of two — so it is unreachable with any real font and worth a thousandth of an em where it is not.
  // Left as it is deliberately; there is nothing here to fix.
  const scale = PRAWN_EM / unitsPerEm;
  const scaled = (value: number): number => (Number.isFinite(value) ? Math.trunc(value * scale) : 0);
  const box = {
    lineHeight: (scaled(ascender) - scaled(descender) + scaled(lineGap)) / PRAWN_EM,
    ascender: scaled(ascender) / PRAWN_EM,
    descender: -scaled(descender) / PRAWN_EM,
    lineGap: scaled(lineGap) / PRAWN_EM,
    // Left off rather than zeroed for a face with no `x`: a zero gutter is a marker touching its
    // text, while an absent one lets the stylesheet's own fallback stand.
    ...(xAdvance !== undefined && Number.isFinite(xAdvance) && xAdvance > 0
      ? { xAdvance: scaled(xAdvance) / PRAWN_EM }
      : {}),
  };
  return box.lineHeight > 0 ? box : undefined;
}

/**
 * Format one metric as the percentage of the em an `@font-face` override descriptor takes.
 *
 * @param ratio - The metric as a multiple of the font size.
 * @returns The percentage, with no trailing zeros to make a diff of two of them noisy.
 */
function overridePercentage(ratio: number): string {
  return `${Number((ratio * 100).toFixed(4))}%`;
}

/**
 * The metrics to hand the browser for the registration a BOX is painted against.
 *
 * The three numbers are the face's own, as prawn reads them. What these descriptors are FOR is the
 * box a browser draws behind an inline run of text: that box is the content area, whose height is the
 * ascent plus the descent the browser believes in, and the renderer's is `fragment.height` — the
 * ascent plus the descent PRAWN believes in. State the second and the two are the same box. The line
 * gap is no part of that height, which is why it stays where the face put it here and is folded
 * differently in {@link faceLineOverrides}.
 *
 * A negative percentage is not expressible, so a face whose metrics come out below zero is left
 * un-overridden rather than declared wrong. No real text face is one.
 *
 * @param metrics - The face's design-unit metrics.
 * @returns The override descriptors, or undefined when the face cannot supply them.
 */
export function faceBoxOverrides(metrics: FaceMetrics): FaceMetricOverrides | undefined {
  const box = faceBox(metrics);
  if (box === undefined || box.ascender < 0 || box.descender < 0 || box.lineGap < 0) return undefined;
  return {
    ascentOverride: overridePercentage(box.ascender),
    descentOverride: overridePercentage(box.descender),
    lineGapOverride: overridePercentage(box.lineGap),
  };
}

/**
 * The metrics to hand the browser for the registration the page's TEXT is laid out in.
 *
 * Same file, same glyphs, same widths, and one number moved: the face's line gap is declared as part
 * of the ASCENT rather than as a gap of its own. That is not a fudge, it is where the renderer puts
 * it. `calc_line_metrics` builds a block's top padding as `half_leading + font.line_gap`
 * (`asciidoctor-pdf-2.3.24/lib/asciidoctor/pdf/ext/prawn/extensions.rb:415-422`) and hands it to
 * `typeset_formatted_text` as `initial_gap` (`converter.rb:4697-4698`; `converter.rb:4682` is the
 * same handover in `typeset_text`, the plain-string path beside it), so the WHOLE gap sits above the
 * first baseline of every block and none of it below the last. CSS distributes it evenly instead:
 * half-leading is `(line-height - (ascent + descent)) / 2` at each end, so a face with a line gap
 * lands its first baseline half a gap too high.
 *
 * Declaring `ascent + line_gap` makes the browser's own arithmetic produce the renderer's. The
 * content box becomes the face's full `Font#height`, so the half-leading CSS derives collapses to
 * `leading / 2` — prawn's `half_leading` exactly — and the first baseline lands at `leading / 2 +
 * (ascender + line_gap) x size`, which is `padding_top + ascender`. The distance between consecutive
 * baselines does not move: the line box is an explicit length, and the same length either way.
 *
 * Measured on the base-14 anchor, whose Times-Bold heading face has the first substantial line gap of
 * any anchor (0.253 em against Noto Serif's 0): the reference sets its first baseline 61.27pt below
 * the page edge, and the preview 57.75pt — 3.52pt high, which is half of 0.253 x 27pt plus the pixel
 * grid. With the gap folded the two agree.
 *
 * `line-gap-override` then goes to zero, because the gap is spoken for: that descriptor feeds
 * `line-height: normal` alone, and a face that declared its gap twice would be a third of a line too
 * tall wherever this preview has no line box of its own to state.
 *
 * @param metrics - The face's design-unit metrics.
 * @returns The override descriptors, or undefined when the face cannot supply them.
 */
export function faceLineOverrides(metrics: FaceMetrics): FaceMetricOverrides | undefined {
  const box = faceBox(metrics);
  if (box === undefined || box.ascender < 0 || box.descender < 0 || box.lineGap < 0) return undefined;
  return {
    ascentOverride: overridePercentage(box.ascender + box.lineGap),
    descentOverride: overridePercentage(box.descender),
    lineGapOverride: overridePercentage(0),
  };
}

/**
 * The four-byte versions a plain sfnt file starts with: TrueType outlines, PostScript outlines
 * (`OTTO`), and the older Apple spelling of the first (`true`). Anything else — a WOFF or WOFF2
 * wrapper, a font collection — is a container whose tables cannot be read without unpacking it.
 */
const SFNT_VERSIONS = new Set([0x00_01_00_00, 0x4F_54_54_4F, 0x74_72_75_65]);

/** Byte offsets of the fields read out of each table, from the OpenType specification. */
const HEAD_UNITS_PER_EM = 18;
const HHEA_ASCENDER = 4;
const HHEA_DESCENDER = 6;
const HHEA_LINE_GAP = 8;
const OS2_VERSION = 0;
const OS2_TYPO_ASCENDER = 68;
const OS2_TYPO_DESCENDER = 70;
const OS2_TYPO_LINE_GAP = 72;
const HHEA_NUMBER_OF_H_METRICS = 34;
const CMAP_TABLE_COUNT = 2;
const CMAP_RECORD_SIZE = 8;

/**
 * The most format-4 segments one `cmap` lookup may step through, across every subtable it tries.
 *
 * A font file is untrusted input — any collaborator may put one in a project — and the two loops that
 * read a character map are nested with nothing relating their bounds to each other: a `cmap` declares
 * up to 65535 encoding records, and each one names a subtable that may declare up to 32767 segments.
 * Their PRODUCT is a little over two thousand million steps, and every one of them is a `DataView`
 * read on the main thread. Built deliberately — 65535 records all naming one subtable of 32767
 * segments whose end codes all sit below `x`, in a 768 KB file — that measured 1672 ms of frozen UI
 * per face, and a family may plan four.
 *
 * So the budget is over the whole lookup rather than per subtable, which is the only bound that
 * cannot be multiplied by the other loop. 100000 is three times the most segments a format-4 subtable
 * can declare at all, so no real font can reach it: the search stops at the first segment whose end
 * code is not below the code point, which for `x` is the first or second segment of any Latin face,
 * and even a subtable that spent a segment on every block of the plane could be walked in full.
 * Exhausting it therefore means the file is not one this reader can answer for, which is reported the
 * way every other unreadable table is — no advance, and the stylesheet's own gutter stands.
 */
const MAX_CMAP_SEGMENT_STEPS = 100_000;

/** How much of the segment budget one lookup has left, shared across every subtable it tries. */
interface SegmentBudget {
  /** Segments this lookup may still step through. */
  steps: number;
}

/** The code point whose advance the renderer measures a list's marker gutter with. */
const GUTTER_CODE_POINT = 0x00_78;

/** Where one table sits in the file. */
interface TableRecord {
  /** Byte offset from the start of the file. */
  readonly offset: number;
  /** Length in bytes. */
  readonly length: number;
}

/**
 * The table directory of an sfnt file, or undefined when the bytes are not one.
 *
 * @param view - The whole file.
 * @returns Tag to record, or undefined when this is not a readable sfnt.
 */
function sfntTables(view: DataView): Map<string, TableRecord> | undefined {
  if (view.byteLength < 12) return undefined;
  // A WOFF or WOFF2 wrapper compresses its tables, so nothing can be read out of one without
  // decompressing — which is the case this returns nothing for rather than guessing.
  if (!SFNT_VERSIONS.has(view.getUint32(0))) return undefined;
  const count = view.getUint16(4);
  const tables = new Map<string, TableRecord>();
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    if (record + 16 > view.byteLength) return undefined;
    const name = String.fromCodePoint(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3),
    );
    tables.set(name, { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) });
  }
  return tables;
}

/** Read a signed 16-bit field, or undefined when it lies outside the table it is claimed to be in. */
function int16At(view: DataView, table: TableRecord | undefined, offset: number): number | undefined {
  if (table === undefined || offset + 2 > table.length) return undefined;
  const at = table.offset + offset;
  if (at + 2 > view.byteLength) return undefined;
  return view.getInt16(at);
}

/** Read an unsigned 16-bit field, with the same bounds check. */
function uint16At(view: DataView, table: TableRecord | undefined, offset: number): number | undefined {
  if (table === undefined || offset + 2 > table.length) return undefined;
  const at = table.offset + offset;
  if (at + 2 > view.byteLength) return undefined;
  return view.getUint16(at);
}

/**
 * The glyph one BMP code point maps to, out of a `cmap` subtable in format 4.
 *
 * Format 4 alone, and deliberately: the one code point this reads is `x`, which is in the Basic
 * Multilingual Plane, and every font that can set Latin text carries a format-4 subtable covering
 * it. A format-12 reader would be more code for a case that cannot arise here.
 *
 * @param view - The whole file.
 * @param at - Byte offset of the subtable.
 * @param end - One past the last byte of the `cmap` TABLE, which every array read here must lie in —
 *   as must the subtable's own declared length, whichever of the two is nearer.
 * @param codePoint - The code point to look up.
 * @param budget - How many segments this lookup may still step through, spent as it steps.
 * @returns The glyph index, or undefined when the subtable does not cover it.
 */
function glyphInFormat4(
  view: DataView,
  at: number,
  end: number,
  codePoint: number,
  budget: SegmentBudget,
): number | undefined {
  if (at + 14 > end) return undefined;
  // Format and length are adjacent 16-bit fields, read as one 32-bit word rather than as two reads.
  // Not a cleverness: both are wanted for every subtable this walks — the format to decide whether to
  // read it at all, the length to bound it below — and the worst file there is holds 65535 subtables,
  // so a second read here is a read added to the worst case. Fused, bounding each subtable by its own
  // length costs nothing that was not already being paid.
  const header = view.getUint32(at);
  if (header >>> 16 !== 4) return undefined;
  // Floored, because `segCountX2` is a count of BYTES and a file may declare an odd one. Left as a
  // fraction it put all four of the subtable's arrays at fractional offsets, which `DataView`
  // truncates without saying so — every field was then read one byte into the field beside it.
  const segments = Math.floor(view.getUint16(at + 6) / 2);
  const endCodes = at + 14;
  const startCodes = endCodes + segments * 2 + 2;
  const deltas = startCodes + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  // How many bytes this subtable's four segment arrays need, past its own start.
  const arrays = 16 + segments * 8;
  // Against the `cmap`'s OWN declared end and not the file's, AND against this subtable's own declared
  // length. Bounded by the file, a subtable that claims more segments than its table holds walks into
  // whatever table happens to follow `cmap` and answers with an advance derived from unrelated bytes —
  // a wrong number arrived at without any error, which is worse than no number at all. Bounded by the
  // `cmap` alone, the same thing happens one level down: `cmap` holds its subtables END TO END, so one
  // declaring 16 bytes while claiming two segments reads its `startCode`, `idDelta` and
  // `idRangeOffset` out of the NEXT subtable's header — and a neighbour's `language`, `searchRange`
  // and `rangeShift` are small non-negative numbers that read as a perfectly plausible mapping.
  //
  // The declared length is enforced only where the field could have stated the truth. It is 16 bits,
  // so a subtable whose arrays alone need more than 65535 bytes cannot describe its own size at all —
  // no real font is one, format 12 being where that coverage goes, but a synthetic one is — and there
  // the table's end stands, exactly as it did before. Clamped rather than substituted, so a length of
  // zero, or one longer than the whole `cmap`, is never a WIDER bound than the table's own end.
  //
  // Written as a comparison and not as `Math.min`, which is not free at this depth: the call is made
  // once per subtable, and against the worst file there is — 65535 records naming 65535 distinct
  // subtables, in 2 MB — it measured 8.2 ms of the 21 ms the whole parse took, for an answer the
  // comparison gives in nothing measurable.
  const declaredEnd = at + (header & 0xFF_FF);
  const limit = arrays > 0xFF_FF || declaredEnd > end ? end : declaredEnd;
  if (at + arrays > limit) return undefined;

  for (let segment = 0; segment < segments; segment += 1) {
    // Spent here rather than counted per subtable: see {@link MAX_CMAP_SEGMENT_STEPS}.
    if (budget.steps <= 0) return undefined;
    budget.steps -= 1;
    if (view.getUint16(endCodes + segment * 2) < codePoint) continue;
    if (view.getUint16(startCodes + segment * 2) > codePoint) return undefined;
    const delta = view.getUint16(deltas + segment * 2);
    const rangeOffset = view.getUint16(rangeOffsets + segment * 2);
    let mapped: number;
    if (rangeOffset === 0) {
      mapped = (codePoint + delta) % 0x1_00_00;
    } else {
      const glyphAt =
        rangeOffsets + segment * 2 + rangeOffset + (codePoint - view.getUint16(startCodes + segment * 2)) * 2;
      if (glyphAt + 2 > limit) return undefined;
      const glyph = view.getUint16(glyphAt);
      // The specification's own rule for this branch: a zero in the glyph array is not offset by the
      // delta. Kept as a zero rather than returned here, so that the one refusal below covers both.
      mapped = glyph === 0 ? 0 : (glyph + delta) % 0x1_00_00;
    }
    // One rule, whichever branch reached it: glyph 0 is `.notdef`, and this code point is one the face
    // does not cover. The glyph array reaches it as a literal; `idDelta` reaches it as arithmetic, a
    // segment whose delta is the two's complement of its own start mapping that start to zero. Checked
    // on the array branch alone, the delta branch handed `.notdef`'s `hmtx` advance back as a real
    // measurement, and every list and callout-list marker gutter in the face was set from the width of
    // a box the reader never sees rather than from the stylesheet's own default.
    return mapped === 0 ? undefined : mapped;
  }
  return undefined;
}

/**
 * The advance of one code point's glyph, in design units.
 *
 * Read straight out of `cmap` and `hmtx` rather than through a font library, for the same reason the
 * vertical metrics above are: the bytes are already held, and a dependency that decoded them would
 * be a second opinion about a file the browser is about to draw with.
 *
 * @param view - The whole file.
 * @param tables - The file's table directory.
 * @param codePoint - The code point to measure.
 * @returns The advance in design units, or undefined when it cannot be read.
 */
function advanceOf(
  view: DataView,
  tables: ReadonlyMap<string, TableRecord>,
  codePoint: number,
): number | undefined {
  const cmap = tables.get('cmap');
  const hmtx = tables.get('hmtx');
  const numberOfHMetrics = uint16At(view, tables.get('hhea'), HHEA_NUMBER_OF_H_METRICS);
  if (cmap === undefined || hmtx === undefined || numberOfHMetrics === undefined || numberOfHMetrics === 0) {
    return undefined;
  }

  const subtables = uint16At(view, cmap, CMAP_TABLE_COUNT) ?? 0;
  // The table's own end, clamped to the file's: a directory entry may claim a length the bytes do not
  // hold, and reading up to the claimed one would be reading past the file.
  const end = Math.min(cmap.offset + cmap.length, view.byteLength);
  const budget: SegmentBudget = { steps: MAX_CMAP_SEGMENT_STEPS };
  // Every subtable already tried. A real font points several encoding records at ONE subtable — the
  // Windows and the Unicode encodings of the same map are the usual pair — and reading it a second
  // time cannot answer differently, so the repeat is pure waste. It is also the whole of the hostile
  // shape: 65535 records naming one subtable is how this loop and the one inside come to multiply.
  const tried = new Set<number>();
  let glyph: number | undefined;
  for (let index = 0; index < subtables && glyph === undefined; index += 1) {
    const record = cmap.offset + 4 + index * CMAP_RECORD_SIZE;
    if (record + CMAP_RECORD_SIZE > end) break;
    const at = cmap.offset + view.getUint32(record + 4);
    if (tried.has(at)) continue;
    tried.add(at);
    glyph = glyphInFormat4(view, at, end, codePoint, budget);
    // The budget is spent and nothing was found: the records still to come cannot be afforded either,
    // and this face simply has no advance that this reader can state.
    if (budget.steps <= 0) break;
  }
  if (glyph === undefined) return undefined;

  // A font may declare fewer horizontal metrics than glyphs; every glyph past the last one advances
  // as that one does, which is what the trailing left-side-bearing array in `hmtx` is for.
  const entry = Math.min(glyph, numberOfHMetrics - 1) * 4;
  return uint16At(view, hmtx, entry);
}

/**
 * What has already been read out of one array of bytes.
 *
 * The parse is a pure function of the bytes, and the bytes are the ones the asset cache holds: one
 * `Uint8Array` per path, handed back as the same instance until they are replaced. So instance
 * identity is exactly the identity a memo needs, and the same file is never read twice.
 *
 * It is worth having because of how often the question is asked. `resolveAppearance` builds a fresh
 * `fonts` array on every call, so the plan the preview's metrics are keyed on changes identity on
 * every keystroke in a theme document — and every one of those re-read every project face from raw
 * bytes, on the thread painting the editor, between the key going down and the character appearing.
 *
 * A `WeakMap` rather than a keyed cache: a font is held here only as long as something else holds the
 * same array, so switching project empties this alongside the asset cache instead of retaining every
 * font the session ever opened. Entries are found with `has`, because "read, and there are no
 * metrics" is a real answer that a missing entry would otherwise be indistinguishable from.
 */
const metricsByBytes = new WeakMap<Uint8Array, FaceMetrics | undefined>();

/**
 * Read the metrics the renderer would read out of a font file.
 *
 * The selection is ttfunk's, per field: the OS/2 typographic value when that table exists, declares a
 * version above zero and the value is non-zero, otherwise `hhea`. Anything that is not a plain sfnt —
 * a WOFF or WOFF2 wrapper, a collection, a truncated file — returns undefined rather than a guess,
 * because a guessed line height is a page laid out wrong with nothing to say so.
 *
 * Total, by construction, because a font file is untrusted input: every path through this ends in
 * metrics or in undefined. It cannot hang — see {@link MAX_CMAP_SEGMENT_STEPS} — and it cannot throw,
 * the outer guard here being what makes that true of a shape nobody thought of rather than only of
 * the ones the bounds checks name.
 *
 * @param bytes - The font file.
 * @returns Its metrics, or undefined when they cannot be read.
 */
export function parseFaceMetrics(bytes: Uint8Array): FaceMetrics | undefined {
  if (metricsByBytes.has(bytes)) return metricsByBytes.get(bytes);
  let metrics: FaceMetrics | undefined;
  try {
    metrics = readFaceMetrics(bytes);
  } catch {
    // A `DataView` read outside its own range throws, and so does a view over a detached buffer.
    // Both are a file this reader has no metrics for, which is a thing it can say.
    metrics = undefined;
  }
  metricsByBytes.set(bytes, metrics);
  return metrics;
}

/**
 * The parse itself, without the memo or the guard around it.
 *
 * @param bytes - The font file.
 * @returns Its metrics, or undefined when they cannot be read.
 */
function readFaceMetrics(bytes: Uint8Array): FaceMetrics | undefined {
  let view: DataView;
  try {
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch {
    return undefined;
  }
  const tables = sfntTables(view);
  if (tables === undefined) return undefined;

  const unitsPerEm = uint16At(view, tables.get('head'), HEAD_UNITS_PER_EM);
  const hhea = tables.get('hhea');
  const hheaAscender = int16At(view, hhea, HHEA_ASCENDER);
  const hheaDescender = int16At(view, hhea, HHEA_DESCENDER);
  const hheaLineGap = int16At(view, hhea, HHEA_LINE_GAP);
  if (unitsPerEm === undefined || unitsPerEm <= 0 || hheaAscender === undefined) return undefined;

  const os2 = tables.get('OS/2');
  const typographic = (uint16At(view, os2, OS2_VERSION) ?? 0) > 0;
  const preferred = (offset: number, fallback: number | undefined): number => {
    if (!typographic) return fallback ?? 0;
    const value = int16At(view, os2, offset);
    return value !== undefined && value !== 0 ? value : (fallback ?? 0);
  };

  const xAdvance = advanceOf(view, tables, GUTTER_CODE_POINT);

  return {
    unitsPerEm,
    ascender: preferred(OS2_TYPO_ASCENDER, hheaAscender),
    descender: preferred(OS2_TYPO_DESCENDER, hheaDescender),
    lineGap: preferred(OS2_TYPO_LINE_GAP, hheaLineGap),
    ...(xAdvance === undefined ? {} : { xAdvance }),
  };
}

/** The manifest's own spelling of each face style. */
const MANIFEST_STYLE: Readonly<Record<FaceStyle, string>> = {
  normal: 'normal',
  bold: 'bold',
  italic: 'italic',
  boldItalic: 'bold_italic',
};

/** Family → face style → the metrics the gem's own file carries, out of the committed manifest. */
const CATALOGUE_METRICS: ReadonlyMap<string, ReadonlyMap<FaceStyle, FaceMetrics>> = new Map(
  manifest.families.map((entry) => {
    const byStyle = new Map<FaceStyle, FaceMetrics>();
    for (const style of FACE_STYLES) {
      const face: { metrics?: FaceMetrics } | undefined = Reflect.get(
        entry.faces,
        MANIFEST_STYLE[style],
      );
      if (face?.metrics !== undefined) byStyle.set(style, face.metrics);
    }
    return [entry.family, byStyle];
  }),
);

/**
 * Family → face style → the metrics the RENDERER reads for one of the base fourteen.
 *
 * Not the stand-in file's own, and the difference is the whole reason this map exists separately. A
 * base-14 face has no font file in the export at all, so prawn takes its line box from the AFM's
 * attributes: `@ascender = attributes['ascender'].to_i`, `@descender = attributes['descender'].to_i`,
 * `@line_gap = (bbox[3] - bbox[1]) - (ascender - descender)` (`afm.rb:75-77`). TeX Gyre Heros' own
 * `hhea` says something else entirely, and laying the page out with it would put every line at the
 * wrong pitch.
 *
 * Symbol and ZapfDingbats declare no ascender and no descender, so `to_i` reads zero for both and the
 * entire line is line gap — 1.303em and 0.963em. The zeros are the renderer's, and are recorded as
 * such: {@link faceBoxOverrides} then declares a zero ascent for the metric-bearing registration,
 * which is what makes a box painted behind a run of Symbol the same zero-height box the export
 * paints. The text registration declares the whole of that gap as the ascent instead, which is where
 * the renderer puts it for the purpose of placing a line — see {@link faceLineOverrides}.
 */
const SUBSTITUTE_METRICS: ReadonlyMap<string, ReadonlyMap<FaceStyle, FaceMetrics>> = (() => {
  // The manifest states each face once and then names it from every family and style that resolves to
  // it — eleven of the fourteen resolve all four styles to one face — so the join happens here rather
  // than in the committed data.
  const byName = new Map(base14Manifest.faces.map((face) => [face.name, face.metrics]));
  return new Map(
    base14Manifest.families.map((entry) => {
      const byStyle = new Map<FaceStyle, FaceMetrics>();
      for (const style of FACE_STYLES) {
        const name: string = Reflect.get(entry.faces, MANIFEST_STYLE[style]);
        const metrics = byName.get(name);
        if (metrics !== undefined) byStyle.set(style, metrics);
      }
      return [entry.family, byStyle];
    }),
  );
})();

/** The renderer's single font-style keyword, split into the face it selects. */
export function faceStyleOf(fontStyle: string | undefined): FaceStyle {
  switch (fontStyle) {
    case 'bold': {
      return 'bold';
    }
    case 'bold_italic': {
      return 'boldItalic';
    }
    case 'italic':
    case 'normal_italic': {
      return 'italic';
    }
    default: {
      return 'normal';
    }
  }
}

/**
 * The box of the face a family and a style resolve to, as multiples of the font size.
 *
 * @param family - The family name the theme's catalogue uses, or undefined for none.
 * @param fontStyle - The renderer's font-style keyword, or undefined for upright regular.
 * @returns The box, or undefined when this preview has no metrics for that face.
 */
export type FaceBoxLookup = (
  family: string | undefined,
  fontStyle: string | undefined,
) => FaceBox | undefined;

/** A lookup that knows nothing, so a caller with no fonts still gets the stylesheet's own defaults. */
export const NO_FACE_METRICS: FaceBoxLookup = () => undefined;

/** What one family's metrics resolved to, and what could not be resolved. */
export interface FaceMetricsResult {
  /** The box of each family and style the plan can supply. */
  readonly boxOf: FaceBoxLookup;
  /**
   * The `@font-face` override descriptors for one planned face, keyed the way a face is planned.
   *
   * Separate from {@link boxOf} because it answers a different question: that one is asked by family
   * name, for a construct the theme names a family for, while this one is asked per FACE — the bold
   * file and the italic file carry metrics of their own and are registered as separate faces.
   *
   * One lookup for both registrations rather than two lookups, so that wiring the loader up cannot
   * supply one and forget the other — which would leave a page laid out from one metric model and
   * painted from the second.
   *
   * @param family - The family the face belongs to.
   * @param style - Which of the four faces it is.
   * @param registration - Which of the face's two registrations the descriptors are for.
   * @returns The overrides, or undefined when this preview has no metrics for that face.
   */
  readonly overridesOf: (
    family: string,
    style: FaceStyle,
    registration: FaceRegistration,
  ) => FaceMetricOverrides | undefined;
  /** One per family whose own file the preview could not read metrics out of. */
  readonly diagnostics: readonly AppearanceDiagnostic[];
}

/**
 * The diagnostic for a project face whose file loads but whose metrics cannot be read.
 *
 * The family is named by `resource` alone. A family name reaches here from the theme document — a
 * project file any collaborator can write — and although it is bounded to 64 characters of
 * `[\w +.-]`, so it can carry no markup, those characters spell a sentence perfectly well. What the
 * message says is this application's, said in its own words; what it is ABOUT is the resource. See
 * `font-faces.ts`'s `unavailable` for the same rule at the other three-quarters of it.
 *
 * @param family - The family whose file could not be measured.
 * @returns The diagnostic to report.
 */
function unreadableMetrics(family: string): AppearanceDiagnostic {
  return {
    severity: 'warning',
    code: 'theme-font-unavailable',
    message:
      'The vertical metrics of this font could not be read from the file the project supplies, so ' +
      'the spacing between lines set in it is approximate. The typeface itself is the right one.',
    resource: family,
  };
}

/**
 * Resolve the box of every face a font plan covers.
 *
 * A catalogue face's metrics come from the committed manifest; a project face's are read from the
 * bytes the browser is drawing with. A family with neither is left unanswered rather than given the
 * body font's height — the stylesheet's own literal fallback then applies, and the substituted-font
 * diagnostic the plan already carries is what tells a reader the appearance is approximate.
 *
 * @param plan - The faces the appearance needs, as planned.
 * @param getAssetBytes - The bytes of one project asset, or undefined when they are not held.
 * @returns The two lookups, and one diagnostic per project face whose metrics could not be read.
 */
export function resolveFaceMetrics(
  plan: FontPlan,
  getAssetBytes: (path: string) => Uint8Array | undefined,
): FaceMetricsResult {
  const byFamily = new Map<string, Map<FaceStyle, FaceBox>>();
  // Keyed by family and style joined on a separator no family name can contain. Written as the escape
  // `\u0000` and never as the character itself: a NUL byte in the source makes the whole file binary to
  // `file(1)` and to GNU grep, so every `grep -rn` over this directory silently skipped all 530 lines
  // of it while looking exactly like a search that found nothing here.
  const overridesByFace = new Map<string, Readonly<Record<FaceRegistration, FaceMetricOverrides>>>();
  const unreadable = new Set<string>();

  for (const face of plan.faces) {
    let metrics: FaceMetrics | undefined;
    if (face.source === 'project') {
      const bytes = face.assetPath === undefined ? undefined : getAssetBytes(face.assetPath);
      // Bytes that have not arrived yet are not bytes that cannot be read: the loader retries as
      // assets settle, and reporting here would warn about every project font on its way in.
      if (bytes === undefined) continue;
      metrics = parseFaceMetrics(bytes);
      if (metrics === undefined) unreadable.add(face.family);
    } else if (face.source === 'substitute') {
      // Read from the manifest and never from the file, which is the point of the whole arrangement:
      // the file is a stand-in and its own vertical metrics are its designer's, not the renderer's.
      metrics = SUBSTITUTE_METRICS.get(face.family)?.get(face.style);
    } else {
      metrics = CATALOGUE_METRICS.get(face.family)?.get(face.style);
    }
    const box = metrics === undefined ? undefined : faceBox(metrics);
    // Both registrations or neither. They are two readings of one set of numbers behind one guard, so
    // a face that can supply one can supply the other, and a face that can supply neither is left
    // with the browser's own reading in both places rather than in one of the two.
    const text = metrics === undefined ? undefined : faceLineOverrides(metrics);
    const painted = metrics === undefined ? undefined : faceBoxOverrides(metrics);
    if (box === undefined) continue;
    const styles = byFamily.get(face.family) ?? new Map<FaceStyle, FaceBox>();
    styles.set(face.style, box);
    byFamily.set(face.family, styles);
    if (text !== undefined && painted !== undefined) {
      overridesByFace.set(`${face.family}\u0000${face.style}`, { text, box: painted });
    }
  }

  return {
    boxOf: (family, fontStyle) => {
      if (family === undefined) return undefined;
      const styles = byFamily.get(family);
      if (styles === undefined) return undefined;
      // A family that declares no face for the style asked for is drawn by the renderer in the face
      // it does have, so its metrics are the ones the line is set with.
      return styles.get(faceStyleOf(fontStyle)) ?? styles.get('normal');
    },
    // Per face and never per family: a face with no metrics of its own must be registered with NO
    // overrides rather than with another face's, because a declared-but-wrong ascent moves every line
    // it sets while an absent one only leaves the browser's own reading in place.
    overridesOf: (family, style, registration) =>
      overridesByFace.get(`${family}\u0000${style}`)?.[registration],
    diagnostics: [...unreadable].map((family) => unreadableMetrics(family)),
  };
}
