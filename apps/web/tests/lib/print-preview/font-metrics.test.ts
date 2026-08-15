import { readFileSync } from 'node:fs';
import path from 'node:path';
import manifest from '@asciidocollab/asciidoc-pdf/assets/fonts/manifest.json';
import { planFontFaces } from '@/lib/print-preview/font-faces';
import {
  faceBox,
  faceBoxOverrides,
  faceLineOverrides,
  faceStyleOf,
  parseFaceMetrics,
  resolveFaceMetrics,
} from '@/lib/print-preview/font-metrics';
import type { FaceMetrics } from '@/lib/print-preview/font-metrics';

/** The metrics of a face this preview has none for, for the assertions that need a stand-in. */
const NO_METRICS = { unitsPerEm: 0, ascender: 0, descender: 0, lineGap: 0 };

/** A project's own face, as the fidelity anchor ships one: a plain TrueType file. */
const PROJECT_FONT = path.join(
  __dirname,
  '../../../e2e/pdf-parity/print-fidelity/fixtures/project-font/source/project-mono-regular.ttf',
);

/** One family the theme's catalogue declares a project file for. */
function projectRequirement(file: string) {
  return [
    {
      family: 'Project Mono',
      declaredFaces: { normal: file },
      declaredByTheme: true,
    },
  ];
}

/** The code point the renderer measures a list's marker gutter with. */
const X = 0x00_78;

/**
 * One table of a font built here, and how the file's directory should describe it.
 *
 * The two declared fields exist so a table can be described as being somewhere it is not, or as
 * being longer than it is — the two shapes a truncated or corrupt file arrives in.
 */
interface SyntheticTable {
  /** The four-character tag. */
  readonly tag: string;
  /** The table's own bytes. */
  readonly data: Uint8Array;
  /** The offset to write into the directory, when it must differ from where the table really sits. */
  readonly declaredOffset?: number;
  /** The length to write into the directory, when it must differ from the table's own length. */
  readonly declaredLength?: number;
}

/**
 * A table's bytes, with each field written at the offset the OpenType specification puts it.
 *
 * @param length - The table's length in bytes.
 * @param fields - Offset and value of each 16-bit field. Values wrap, so `0xFF_FF` writes as written.
 * @param wide - Offset and value of each 32-bit field.
 * @returns The table's bytes.
 */
function tableBytes(
  length: number,
  fields: ReadonlyArray<readonly [number, number]>,
  wide: ReadonlyArray<readonly [number, number]> = [],
): Uint8Array {
  const data = new Uint8Array(length);
  const view = new DataView(data.buffer);
  for (const [offset, value] of fields) view.setInt16(offset, value);
  for (const [offset, value] of wide) view.setUint32(offset, value);
  return data;
}

/** A `head`, which carries the em every other metric is measured in. */
function headTable(unitsPerEm: number): SyntheticTable {
  return { tag: 'head', data: tableBytes(54, [[18, unitsPerEm]]) };
}

/** An `hhea`, the table ttfunk falls back to for any field OS/2 does not supply. */
function hheaTable(
  ascender: number,
  descender: number,
  lineGap: number,
  longMetrics = 2,
): SyntheticTable {
  return {
    tag: 'hhea',
    data: tableBytes(36, [
      [4, ascender],
      [6, descender],
      [8, lineGap],
      [34, longMetrics],
    ]),
  };
}

/** An `OS/2` at the version it declares, carrying the three typographic values ttfunk prefers. */
function os2Table(
  version: number,
  ascender: number,
  descender: number,
  lineGap: number,
): SyntheticTable {
  return {
    tag: 'OS/2',
    data: tableBytes(96, [
      [0, version],
      [68, ascender],
      [70, descender],
      [72, lineGap],
    ]),
  };
}

/**
 * An `hmtx` of long horizontal metrics, one advance each.
 *
 * @param advances - One advance per long metric; the left-side bearing beside each stays zero.
 * @param trailingBearings - How many bearing-only entries follow, as a font with more glyphs than
 *   long metrics carries.
 * @returns The table.
 */
function hmtxTable(advances: readonly number[], trailingBearings = 0): SyntheticTable {
  return {
    tag: 'hmtx',
    data: tableBytes(
      advances.length * 4 + trailingBearings * 2,
      advances.map((advance, index) => [index * 4, advance] as const),
    ),
  };
}

/** How the one segment of the `cmap` built below states its mapping. */
interface CmapShape {
  /** The code point the segment covers. */
  readonly codePoint: number;
  /** The glyph it maps to. */
  readonly glyph: number;
  /**
   * `delta` states the mapping as an `idDelta`; `array` states it through the `idRangeOffset`
   * indirection, which is the shape a real font takes wherever its glyphs are not contiguous.
   */
  readonly through: 'array' | 'delta';
  /** The subtable format to declare. Anything but 4 is a table this parser will not read. */
  readonly format?: number;
  /** An `idRangeOffset` of the test's own choosing, to point the lookup somewhere it cannot go. */
  readonly rangeOffset?: number;
  /** More encoding records than the table holds, to run its own directory past its end. */
  readonly declaredSubtables?: number;
  /** Cut the table's bytes short while its directory entry still claims the whole length. */
  readonly truncateTo?: number;
  /**
   * A `segCountX2` of the test's own choosing, in place of twice the segments the table really holds.
   *
   * It is a count of BYTES, so a file may declare an odd one — which halves to a fraction and puts
   * every array of the subtable at a fractional offset.
   */
  readonly declaredSegmentBytes?: number;
}

/** A `cmap` whose one format-4 subtable maps a single code point. */
function cmapTable(shape: CmapShape): SyntheticTable {
  const subtable = 12;
  const segments = 2;
  const endCodes = subtable + 14;
  const startCodes = endCodes + segments * 2 + 2;
  const deltas = startCodes + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  const glyphArray = rangeOffsets + segments * 2;
  const length = glyphArray + 2;
  const indirect = shape.through === 'array';
  const data = tableBytes(
    length,
    [
      [2, shape.declaredSubtables ?? 1],
      // One Windows/BMP encoding record, whose subtable sits immediately after it.
      [4, 3],
      [6, 1],
      [subtable, shape.format ?? 4],
      [subtable + 2, length - subtable],
      [subtable + 6, shape.declaredSegmentBytes ?? segments * 2],
      [endCodes, shape.codePoint],
      // The terminator segment every format-4 subtable ends with.
      [endCodes + 2, 0xFF_FF],
      [startCodes, shape.codePoint],
      [startCodes + 2, 0xFF_FF],
      [deltas, indirect ? 0 : (shape.glyph - shape.codePoint) & 0xFF_FF],
      [deltas + 2, 1],
      [rangeOffsets, shape.rangeOffset ?? (indirect ? segments * 2 : 0)],
      [glyphArray, shape.glyph],
    ],
    [[subtable - 4, subtable]],
  );
  return {
    tag: 'cmap',
    ...(shape.truncateTo === undefined
      ? { data }
      : { data: data.slice(0, shape.truncateTo), declaredLength: length }),
  };
}

/**
 * A `cmap` of many encoding records, every one of them naming ONE format-4 subtable of many segments.
 *
 * This is the shape a hostile font takes. Neither of the two loops that read a character map bounded
 * the other, so the walk was their product: 65535 records naming a subtable of 32767 segments, none
 * of which covers the code point sought, is a little over two thousand million `DataView` reads.
 *
 * @param records - How many encoding records to declare, and to hold.
 * @param segments - How many segments the one subtable declares, and holds. Every one of them ends
 *   below any code point worth looking up, so the search steps through all of them.
 * @param covered - A code point the LAST segment maps, for the case where the walk is long but the
 *   answer is genuinely there; omitted for a subtable that covers nothing.
 * @returns The table.
 */
function wideCmapTable(
  records: number,
  segments: number,
  covered?: { readonly codePoint: number; readonly glyph: number },
): SyntheticTable {
  const subtable = 4 + records * 8;
  const endCodes = subtable + 14;
  const startCodes = endCodes + segments * 2 + 2;
  const deltas = startCodes + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  const length = rangeOffsets + segments * 2;
  const data = new Uint8Array(length);
  const view = new DataView(data.buffer);
  view.setUint16(2, records);
  for (let index = 0; index < records; index += 1) {
    const record = 4 + index * 8;
    view.setUint16(record, 3);
    view.setUint16(record + 2, 1);
    view.setUint32(record + 4, subtable);
  }
  view.setUint16(subtable, 4);
  view.setUint16(subtable + 2, length - subtable);
  view.setUint16(subtable + 6, segments * 2);
  for (let segment = 0; segment < segments; segment += 1) {
    // An end code below every code point worth looking up: the search steps past this segment and on
    // to the next, which is the branch that has to be walked all the way to be walked at all.
    view.setUint16(endCodes + segment * 2, 1);
    view.setUint16(startCodes + segment * 2, 0);
  }
  if (covered !== undefined) {
    const last = segments - 1;
    view.setUint16(endCodes + last * 2, covered.codePoint);
    view.setUint16(startCodes + last * 2, covered.codePoint);
    view.setUint16(deltas + last * 2, (covered.glyph - covered.codePoint) & 0xFF_FF);
  }
  return { tag: 'cmap', data };
}

/**
 * A `cmap` whose every encoding record names a DISTINCT format-4 subtable of its own.
 *
 * The other end of the hostile shape from {@link wideCmapTable}. That one is defeated by remembering
 * which subtables have been tried; this one cannot be, because no subtable is ever repeated — 65535
 * records naming 65535 subtables is a 2 MB file whose cost is bounded by nothing but the per-record
 * work itself. Each subtable is well formed and covers one code point below any worth looking up, so
 * every one of them is read in full and every one of them answers nothing.
 *
 * @param records - How many records, and how many subtables.
 * @returns The table.
 */
function distinctSubtableCmap(records: number): SyntheticTable {
  // Fourteen bytes of header and one segment's four arrays: the smallest a real format-4 subtable is.
  const subtableSize = 24;
  const first = 4 + records * 8;
  const data = new Uint8Array(first + records * subtableSize);
  const view = new DataView(data.buffer);
  view.setUint16(2, records);
  for (let index = 0; index < records; index += 1) {
    const record = 4 + index * 8;
    const at = first + index * subtableSize;
    // A record per encoding, each naming an address of its own — which is what the de-duplication of
    // already-tried subtables cannot collapse.
    view.setUint16(record, 3);
    view.setUint16(record + 2, index);
    view.setUint32(record + 4, at);
    // Format, its own honest length, and one segment.
    view.setUint16(at, 4);
    view.setUint16(at + 2, subtableSize);
    view.setUint16(at + 6, 2);
    // The segment's end code, below every code point worth looking up: stepped past, and then the
    // subtable is out of segments and the next record's is tried. Its start code stays zero.
    view.setUint16(at + 14, 1);
  }
  return { tag: 'cmap', data };
}

/**
 * A `cmap` of two format-4 subtables, the first of which declares a length its own arrays run past.
 *
 * `cmap` holds its subtables end to end, so a subtable that understates its length overruns into the
 * NEXT one's header — still inside the `cmap`, so a bound taken at the table's end lets it through.
 * The bytes it then reads as segment arrays are the neighbour's `language`, `searchRange` and
 * `rangeShift` fields, which are small non-negative numbers that read perfectly plausibly as a
 * mapping: `startCode` 0, `idDelta` 4, `idRangeOffset` 0.
 *
 * The first subtable claims 16 bytes — its header and one end code, and no more — while declaring two
 * segments, whose arrays need 32. The second is an ordinary, honest subtable mapping `x`.
 *
 * @returns The table, and the two advances that tell the readings apart.
 */
function overrunningSubtableCmap(): {
  readonly cmap: SyntheticTable;
  /** The glyph the overrun fabricates out of the second subtable's header. */
  readonly fabricatedGlyph: number;
  /** The glyph the second subtable really maps `x` to. */
  readonly honestGlyph: number;
} {
  const first = 20;
  const second = 36;
  const length = 68;
  const data = new Uint8Array(length);
  const view = new DataView(data.buffer);
  view.setUint16(2, 2);
  // Two encoding records, each naming a subtable of its own.
  view.setUint16(4, 3);
  view.setUint16(6, 1);
  view.setUint32(8, first);
  view.setUint16(12, 0);
  view.setUint16(14, 3);
  view.setUint32(16, second);

  // The first subtable: format, a length that stops at its neighbour, `language`, a `segCountX2` of
  // two segments, the three binary-search constants, and then one end code — which is all the length
  // it declares has room for.
  view.setUint16(first, 4);
  view.setUint16(first + 2, second - first);
  view.setUint16(first + 6, 4);
  view.setUint16(first + 8, 4);
  view.setUint16(first + 10, 1);
  view.setUint16(first + 12, 0);
  view.setUint16(first + 14, X);

  // The second: the same header, honestly sized, then two segments — one mapping `x` and the
  // terminator every format-4 subtable ends with.
  const endCodes = second + 14;
  const startCodes = endCodes + 6;
  const deltas = startCodes + 4;
  const rangeOffsets = deltas + 4;
  const honestGlyph = 3;
  view.setUint16(second, 4);
  view.setUint16(second + 2, length - second);
  view.setUint16(second + 6, 4);
  view.setUint16(second + 8, 4);
  view.setUint16(second + 10, 1);
  view.setUint16(second + 12, 0);
  view.setUint16(endCodes, X);
  view.setUint16(endCodes + 2, 0xFF_FF);
  view.setUint16(startCodes, X);
  view.setUint16(startCodes + 2, 0xFF_FF);
  view.setUint16(deltas, (honestGlyph - X) & 0xFF_FF);
  view.setUint16(deltas + 2, 1);
  view.setUint16(rangeOffsets, 0);
  view.setUint16(rangeOffsets + 2, 0);

  // What the first subtable's arrays land on: `startCode` from the second's `language`, `idDelta`
  // from its `searchRange`, `idRangeOffset` from its `rangeShift`.
  return { cmap: { tag: 'cmap', data }, fabricatedGlyph: (X + 4) % 0x1_00_00, honestGlyph };
}

/**
 * How many `DataView` reads one call makes.
 *
 * That is the whole cost of walking a character map, and counting it is what makes "this file is not
 * read twice" and "these records name one subtable, so it is read once" statements a test can hold
 * rather than a stopwatch's opinion.
 *
 * Every width is counted and not the 16-bit ones alone. A subtable's format and its length are
 * adjacent fields read as a single 32-bit word, and an encoding record's subtable offset is another —
 * so a measure that counted halves only would have reported a walk getting cheaper each time a pair of
 * fields was fused, while the machine did exactly as much work as before.
 *
 * @param run - What to measure.
 * @returns The number of reads it made.
 */
function readsDuring(run: () => void): number {
  let reads = 0;
  const uint8 = DataView.prototype.getUint8;
  const uint16 = DataView.prototype.getUint16;
  const uint32 = DataView.prototype.getUint32;
  const spies = [
    jest
      .spyOn(DataView.prototype, 'getUint8')
      .mockImplementation(function (this: DataView, offset: number): number {
        reads += 1;
        return uint8.call(this, offset);
      }),
    jest
      .spyOn(DataView.prototype, 'getUint16')
      .mockImplementation(function (this: DataView, offset: number, littleEndian?: boolean): number {
        reads += 1;
        return uint16.call(this, offset, littleEndian);
      }),
    jest
      .spyOn(DataView.prototype, 'getUint32')
      .mockImplementation(function (this: DataView, offset: number, littleEndian?: boolean): number {
        reads += 1;
        return uint32.call(this, offset, littleEndian);
      }),
  ];
  try {
    run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return reads;
}

/**
 * A whole sfnt file: the version, the table directory, and the tables.
 *
 * @param tables - The tables, written in the order given.
 * @param options - The sfnt version to declare, and a table count to declare in place of the real one.
 * @returns The file's bytes.
 */
function syntheticFont(
  tables: readonly SyntheticTable[],
  options: { readonly version?: number; readonly declaredTableCount?: number } = {},
): Uint8Array {
  const directory = 12 + tables.length * 16;
  const bytes = new Uint8Array(
    directory + tables.reduce((total, table) => total + table.data.length, 0),
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, options.version ?? 0x00_01_00_00);
  view.setUint16(4, options.declaredTableCount ?? tables.length);
  let at = directory;
  for (const [index, table] of tables.entries()) {
    const record = 12 + index * 16;
    for (let character = 0; character < 4; character += 1) {
      view.setUint8(record + character, table.tag.codePointAt(character) ?? 0);
    }
    view.setUint32(record + 8, table.declaredOffset ?? at);
    view.setUint32(record + 12, table.declaredLength ?? table.data.length);
    bytes.set(table.data, at);
    at += table.data.length;
  }
  return bytes;
}

/** The tables of a complete, readable font, any of which one case below replaces or drops. */
interface FontShape {
  /** The `head`, or null for a file that carries none. */
  readonly head?: SyntheticTable | null;
  /** The `hhea`, or null for a file that carries none. */
  readonly hhea?: SyntheticTable | null;
  /** An `OS/2`, which the readable default deliberately has none of. */
  readonly os2?: SyntheticTable;
  /** The `hmtx`, or null for a file that carries none. */
  readonly hmtx?: SyntheticTable | null;
  /** The `cmap`, or null for a file that carries none. Written last, so it ends the file. */
  readonly cmap?: SyntheticTable | null;
  /** An sfnt version other than plain TrueType outlines. */
  readonly version?: number;
  /** A table count other than the number of tables actually written. */
  readonly declaredTableCount?: number;
}

/**
 * A complete, readable TrueType file, with one table replaced by the case under test.
 *
 * Its metrics are 880/-120/100 in a 1000-unit em, and its `x` advances 500. Every refusal below is
 * one edit away from this file, which is what makes each of them a statement about that edit rather
 * than about the rest of the bytes.
 *
 * @param shape - What to change.
 * @returns The file's bytes.
 */
function fontOf(shape: FontShape = {}): Uint8Array {
  const tables = [
    shape.head === undefined ? headTable(1000) : shape.head,
    shape.hhea === undefined ? hheaTable(880, -120, 100) : shape.hhea,
    shape.os2 ?? null,
    shape.hmtx === undefined ? hmtxTable([0, 500]) : shape.hmtx,
    shape.cmap === undefined ? cmapTable({ codePoint: X, glyph: 1, through: 'delta' }) : shape.cmap,
  ].filter((table): table is SyntheticTable => table !== null);
  return syntheticFont(tables, {
    ...(shape.version === undefined ? {} : { version: shape.version }),
    ...(shape.declaredTableCount === undefined
      ? {}
      : { declaredTableCount: shape.declaredTableCount }),
  });
}

describe('the line box the renderer builds from a face', () => {
  test("it is the font's own height, scaled and truncated the way prawn scales it", () => {
    // `Prawn::Font#height_at` is `(ascender - descender + line_gap) / 1000`, over values prawn maps
    // into a 1000-unit em with `Integer(value * 1000.0 / units_per_em)` — which truncates.
    expect(
      faceBox({ unitsPerEm: 2048, ascender: 2189, descender: -600, lineGap: 0 })?.lineHeight,
    ).toBeCloseTo(1.36, 6);
    expect(
      faceBox({ unitsPerEm: 1000, ascender: 860, descender: -140, lineGap: 90 })?.lineHeight,
    ).toBeCloseTo(1.09, 6);
  });

  test('the ascender and the descender are kept apart, in the sign prawn gives each', () => {
    // `Prawn::Font#ascender` is `@ascender / 1000.0 * size` and `#descender` is `-@descender / …`,
    // so both come out positive; every box the renderer paints around a run of text is measured from
    // the pair rather than from their sum. Noto Serif: 2189/-600 in a 2048-unit em, truncated.
    const box = faceBox({ unitsPerEm: 2048, ascender: 2189, descender: -600, lineGap: 0 });
    expect(box?.ascender).toBeCloseTo(1.068, 6);
    expect(box?.descender).toBeCloseTo(0.292, 6);
    expect(box?.lineGap).toBeCloseTo(0, 6);
  });

  test("the box registration's descriptors state the renderer's numbers, as percentages of the em", () => {
    // M+ 1mn is the case that makes overriding necessary at all: its `hhea` says 1075/-320 where the
    // OS/2 typographic values prawn reads say 860/-140, so a browser left to its own reading paints a
    // codespan's tint 1.395em deep where the export paints 1.0em.
    expect(faceBoxOverrides({ unitsPerEm: 1000, ascender: 860, descender: -140, lineGap: 90 })).toEqual({
      ascentOverride: '86%',
      descentOverride: '14%',
      lineGapOverride: '9%',
    });
    expect(faceBoxOverrides({ unitsPerEm: 2048, ascender: 2189, descender: -600, lineGap: 0 })).toEqual({
      ascentOverride: '106.8%',
      descentOverride: '29.2%',
      lineGapOverride: '0%',
    });
  });

  test("the text registration declares the face's line gap as part of its ascent", () => {
    // `calc_line_metrics` puts the WHOLE line gap above a block's first baseline —
    // `padding_top = half_leading + font.line_gap` — and none of it below the last, where CSS would
    // split it evenly between the two. Declaring `ascender + line_gap` as the ascent is what makes
    // the browser's own half-leading arithmetic come out at prawn's, and `line-gap-override` then has
    // to be zero or `line-height: normal` would count the gap twice.
    //
    // Times-Roman, whose AFM line gap is 216 of a 1000-unit em, is the face this was measured on: the
    // base-14 anchor's first baseline sat 3.52pt above the reference's without it.
    expect(faceLineOverrides({ unitsPerEm: 1000, ascender: 683, descender: -217, lineGap: 216 })).toEqual({
      ascentOverride: '89.9%',
      descentOverride: '21.7%',
      lineGapOverride: '0%',
    });
    // A face whose gap is zero is registered identically either way, which is why the gem's own
    // catalogue could not tell the two apart.
    const metrics = { unitsPerEm: 2048, ascender: 2189, descender: -600, lineGap: 0 };
    expect(faceLineOverrides(metrics)).toEqual(faceBoxOverrides(metrics));
  });

  test('a face whose metrics cannot describe a box is registered with no overrides at all', () => {
    // A negative percentage is not a valid descriptor, and a declared-but-wrong metric would deform
    // every box drawn against the face — where an absent one only leaves the browser's own reading
    // in place.
    expect(faceBoxOverrides(NO_METRICS)).toBeUndefined();
    expect(faceBoxOverrides({ unitsPerEm: 1000, ascender: -50, descender: -140, lineGap: 0 })).toBeUndefined();
    expect(faceLineOverrides(NO_METRICS)).toBeUndefined();
    expect(faceLineOverrides({ unitsPerEm: 1000, ascender: -50, descender: -140, lineGap: 0 })).toBeUndefined();
  });

  test("the `x` advance is scaled and truncated the way prawn scales every width", () => {
    // A list's marker gutter is `rendered_width_of_char 'x'`, and prawn measures a character as
    // `Integer(hmtx.widths[gid] * scale_factor)` in a 1000-unit em before applying the size — the same
    // truncation as the three vertical metrics, and worth a fifth of a point at body size.
    // Noto Serif advances 1184 units of a 2048-unit em for `x`; M+ 1mn advances 500 of 1000.
    expect(
      faceBox({ unitsPerEm: 2048, ascender: 2189, descender: -600, lineGap: 0, xAdvance: 1184 })?.xAdvance,
    ).toBeCloseTo(0.578, 6);
    expect(
      faceBox({ unitsPerEm: 1000, ascender: 860, descender: -140, lineGap: 90, xAdvance: 500 })?.xAdvance,
    ).toBeCloseTo(0.5, 6);
  });

  test('a face with no `x` of its own leaves the gutter unanswered rather than closing it', () => {
    // Absent, not zero: a zero gutter is a marker touching its text, while an absent one lets the
    // stylesheet's own fallback stand.
    //
    // The box itself is asserted to exist first, and every negative assertion here does the same. An
    // absent field of an absent box is absent too, so `f(...)?.xAdvance` alone stays green against a
    // regression that stops answering at all — which is the whole page's line height gone, reported by
    // a test whose subject is one gutter.
    const noAdvance = faceBox({ unitsPerEm: 2048, ascender: 2189, descender: -600, lineGap: 0 });
    expect(noAdvance).toBeDefined();
    expect(noAdvance?.xAdvance).toBeUndefined();
    const zeroAdvance = faceBox({
      unitsPerEm: 2048,
      ascender: 2189,
      descender: -600,
      lineGap: 0,
      xAdvance: 0,
    });
    expect(zeroAdvance).toBeDefined();
    expect(zeroAdvance?.xAdvance).toBeUndefined();
  });

  test("the gem's own catalogue records the advance the renderer measures a gutter with", () => {
    const noto = manifest.families.find((family) => family.family === 'Noto Serif');
    const mono = manifest.families.find((family) => family.family === 'M+ 1mn');
    expect(faceBox(noto?.faces.normal.metrics ?? NO_METRICS)?.xAdvance).toBeCloseTo(0.578, 6);
    expect(faceBox(mono?.faces.normal.metrics ?? NO_METRICS)?.xAdvance).toBeCloseTo(0.5, 6);
  });

  test('a face with no usable em is left unanswered rather than given a guessed height', () => {
    expect(faceBox({ unitsPerEm: 0, ascender: 800, descender: -200, lineGap: 0 })).toBeUndefined();
    expect(faceBox({ unitsPerEm: 1000, ascender: 0, descender: 0, lineGap: 0 })).toBeUndefined();
  });

  test('a metric that is not a number contributes nothing rather than poisoning the box', () => {
    // Every line height on the page is a length built from this, so one NaN is not one wrong
    // construct: `NaNpx` is a declaration the browser throws away, which reverts the WHOLE page to
    // the stylesheet's own fallback — the appearance this arithmetic exists to replace, arrived at
    // silently. Dropping the field leaves a line box that is short by its gap and nothing else.
    const box = faceBox({
      unitsPerEm: 1000,
      ascender: 860,
      descender: -140,
      lineGap: Number.NaN,
    });
    expect(box?.lineHeight).toBeCloseTo(1, 6);
    expect(box?.lineGap).toBe(0);
  });

  test("the gem's own faces are the ones its default theme says they are", () => {
    // The theme document records "The Noto font family has a built-in line height of 1.36" beside the
    // arithmetic it derives its own line height from, so this is the gem's own claim about its fonts.
    const noto = manifest.families.find((family) => family.family === 'Noto Serif');
    expect(noto).toBeDefined();
    expect(faceBox(noto?.faces.normal.metrics ?? NO_METRICS)?.lineHeight).toBeCloseTo(1.36, 6);
  });
});

describe('reading a face out of the bytes the browser draws with', () => {
  test('a plain TrueType file gives up the four metrics the renderer reads', () => {
    const metrics = parseFaceMetrics(new Uint8Array(readFileSync(PROJECT_FONT)));
    expect(metrics).toBeDefined();
    expect(metrics?.unitsPerEm).toBeGreaterThan(0);
    expect(faceBox(metrics ?? NO_METRICS)?.lineHeight).toBeGreaterThan(0.5);
    // And the fifth, read out of the file's own `cmap` and `hmtx` rather than out of the manifest:
    // a project supplies its face as bytes, and the gutter of every list set in it comes from here.
    expect(metrics?.xAdvance).toBeGreaterThan(0);
    expect(faceBox(metrics ?? NO_METRICS)?.xAdvance).toBeGreaterThan(0.1);
  });

  test('a wrapper whose tables are compressed is refused rather than guessed at', () => {
    // A WOFF2 file starts with `wOF2` and holds its tables Brotli-compressed. Reading a length out of
    // it would produce a number, and a number here is a page laid out wrong with nothing to say so.
    const woff2 = new Uint8Array(readFileSync(
      path.join(__dirname, '../../../../../packages/asciidoc-pdf/assets/fonts/noto-serif-normal.woff2'),
    ));
    expect(parseFaceMetrics(woff2)).toBeUndefined();
  });

  test('bytes that are not a font at all are refused', () => {
    expect(parseFaceMetrics(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(parseFaceMetrics(new TextEncoder().encode('not a font, just some text'))).toBeUndefined();
  });

  test('the complete file the refusals below are one edit from is itself read', () => {
    // The anchor for everything in the two describes that follow: each of those changes ONE table of
    // this file, so a refusal there is a statement about that change and not about the rest of it.
    const metrics = parseFaceMetrics(fontOf());
    expect(metrics).toEqual({
      unitsPerEm: 1000,
      ascender: 880,
      descender: -120,
      lineGap: 100,
      xAdvance: 500,
    });
  });
});

describe('a font file this parser will not guess at', () => {
  // Every case here is a malformed or unsupported file, and no real face is one — which is why they
  // are built rather than found. What each is worth is the same: a number read out of these bytes
  // would be a page laid out wrong with nothing on it to say so, where a refusal leaves the
  // stylesheet's own defaults standing and the substituted-font diagnostic beside them.

  test('a font collection is refused rather than read as the face at its front', () => {
    // `ttcf` is a directory of OFFSETS to whole fonts, not a table directory. Read as one, its header
    // yields a plausible table count and records that are really font offsets — so the metrics would
    // come from whatever the file happens to hold at those addresses.
    expect(parseFaceMetrics(fontOf({ version: 0x74_74_63_66 }))).toBeUndefined();
  });

  test('a table directory that runs past the end of the file is refused', () => {
    // Without the per-record bounds check the walk reads a record from beyond the buffer, which is a
    // RangeError thrown out of a function whose whole contract is to return undefined instead.
    expect(parseFaceMetrics(fontOf({ declaredTableCount: 64 }))).toBeUndefined();
  });

  test('a table whose directory entry points outside the file is refused', () => {
    const outside = 0xFF_FF_FF;
    expect(
      parseFaceMetrics(fontOf({ head: { ...headTable(1000), declaredOffset: outside } })),
    ).toBeUndefined();
    expect(
      parseFaceMetrics(fontOf({ hhea: { ...hheaTable(880, -120, 100), declaredOffset: outside } })),
    ).toBeUndefined();
  });

  test('a table shorter than the field it is asked for is refused', () => {
    // The bound is the TABLE's own length, not the file's: a `head` cut off before its em still sits
    // inside the file, and reading offset 18 out of it would take two bytes of whatever follows it.
    expect(
      parseFaceMetrics(fontOf({ head: { ...headTable(1000), declaredLength: 10 } })),
    ).toBeUndefined();
    expect(
      parseFaceMetrics(fontOf({ hhea: { ...hheaTable(880, -120, 100), declaredLength: 4 } })),
    ).toBeUndefined();
  });

  test('a file with no em, or an em of zero, is refused', () => {
    // A zero em is the one that has to be caught here: it divides into prawn's 1000-unit scale as
    // Infinity, so every metric comes out NaN — and a default em would measure a 2048-unit face as
    // though it were half as tall.
    expect(parseFaceMetrics(fontOf({ head: null }))).toBeUndefined();
    expect(parseFaceMetrics(fontOf({ head: headTable(0) }))).toBeUndefined();
  });

  test('a file with no readable ascender is refused rather than given one', () => {
    expect(parseFaceMetrics(fontOf({ hhea: null }))).toBeUndefined();
  });
});

describe('which table each of the three vertical metrics comes from', () => {
  test('an OS/2 below version 1 is not read at all, and hhea supplies all three', () => {
    // ttfunk takes a typographic value only when the table "exists, declares a version above zero and
    // the value is non-zero". A version-0 OS/2 is 78 bytes and its `sTypo*` fields are INSIDE it, so
    // reading them is possible and wrong — and the two tables disagree by a third of an em in the
    // gem's own catalogue, which is the whole depth of the tint behind a codespan.
    const metrics = parseFaceMetrics(
      fontOf({ hhea: hheaTable(1075, -320, 0), os2: os2Table(0, 860, -140, 90) }),
    );
    expect(metrics?.ascender).toBe(1075);
    expect(metrics?.descender).toBe(-320);
    expect(metrics?.lineGap).toBe(0);
  });

  test('each of the three is decided on its own, so a zero typographic gap falls back to hhea', () => {
    // The case the module's own header names: a font whose `sTypoLineGap` is zero takes its gap from
    // `hhea` while its ascender still comes from OS/2. Choosing one table for all three would set
    // every line in the face by 0.1em, which over a page of body text is a line and a half.
    const metrics = parseFaceMetrics(
      fontOf({ hhea: hheaTable(1075, -320, 100), os2: os2Table(1, 860, -140, 0) }),
    );
    expect(metrics?.ascender).toBe(860);
    expect(metrics?.descender).toBe(-140);
    expect(metrics?.lineGap).toBe(100);
  });

  test('a typographic value the OS/2 is too short to hold falls back the same way', () => {
    // Not the same thing as a zero: the table declares a version that promises the field and then
    // stops before it. The fallback has to be `hhea` rather than the two bytes that follow the table.
    const metrics = parseFaceMetrics(
      fontOf({
        hhea: hheaTable(1075, -320, 100),
        os2: { ...os2Table(1, 860, -140, 90), declaredLength: 70 },
      }),
    );
    expect(metrics?.ascender).toBe(860);
    expect(metrics?.lineGap).toBe(100);
  });

  test('a field neither table can supply is zero, not another table\'s bytes', () => {
    // An `hhea` cut off after its descender, with and without an OS/2 that also cannot supply the
    // gap. Zero is the neutral value — a face with no gap sets its lines at its own height — and it
    // is what the alternative, reading past the table, is being refused in favour of.
    const short = { ...hheaTable(880, -120, 100), declaredLength: 8 };
    expect(parseFaceMetrics(fontOf({ hhea: short }))?.lineGap).toBe(0);
    expect(parseFaceMetrics(fontOf({ hhea: short, os2: os2Table(1, 860, -140, 0) }))?.lineGap).toBe(0);
  });
});

describe('the `x` advance a list\'s marker gutter is measured with', () => {
  // Absent is the answer to every failure here, and never zero: a zero gutter is a marker touching
  // its text, while an absent one lets the stylesheet's own fallback stand. And never at the cost of
  // the line — a face whose `cmap` cannot be followed still sets its lines at the right height.

  test('a file that cannot answer for `x` still describes a line, and leaves the gutter alone', () => {
    for (const shape of [
      // No character map at all, and no metrics to look one up in.
      { cmap: null },
      { hmtx: null },
      // A font that declares no long horizontal metrics has no advance for any glyph.
      { hhea: hheaTable(880, -120, 100, 0) },
      // A `cmap` too short to hold even its own count of encoding records.
      { cmap: { ...cmapTable({ codePoint: X, glyph: 1, through: 'delta' }), declaredLength: 2 } },
      // A subtable in a format this parser does not read. Read as format 4 anyway, a format-12
      // subtable's group array would be walked as segments and yield some other glyph's advance.
      { cmap: cmapTable({ codePoint: X, glyph: 1, through: 'delta', format: 12 }) },
      // A subtable whose segment arrays are cut off after its header.
      { cmap: cmapTable({ codePoint: X, glyph: 1, through: 'delta', truncateTo: 32 }) },
      // A `cmap` claiming more encoding records than it holds: the walk must stop at the file's end
      // rather than read a subtable offset from past it.
      {
        cmap: cmapTable({
          codePoint: X,
          glyph: 1,
          through: 'delta',
          format: 12,
          declaredSubtables: 8,
        }),
      },
    ] satisfies FontShape[]) {
      const metrics = parseFaceMetrics(fontOf(shape));
      expect(metrics?.ascender).toBe(880);
      expect(metrics?.xAdvance).toBeUndefined();
    }
  });

  test('a font whose character map does not cover `x` leaves the gutter unanswered', () => {
    // Not glyph 0: a code point outside every segment maps to `.notdef`, and taking its advance would
    // set every list's marker gutter from a box the reader never sees.
    const metrics = parseFaceMetrics(
      fontOf({ cmap: cmapTable({ codePoint: 0x01_00, glyph: 1, through: 'delta' }) }),
    );
    expect(metrics?.ascender).toBe(880);
    expect(metrics?.xAdvance).toBeUndefined();
  });

  test('a segment that maps through its glyph array is followed through it', () => {
    // The two ways format 4 states a mapping. Applying the `idDelta` to a segment that has an
    // `idRangeOffset` instead reads the delta field of a segment that is deliberately zero there, so
    // it would answer with the code point itself as a glyph index — a different glyph's advance,
    // arrived at without any error.
    const metrics = parseFaceMetrics(
      fontOf({
        cmap: cmapTable({ codePoint: X, glyph: 1, through: 'array' }),
        hmtx: hmtxTable([0, 500]),
      }),
    );
    expect(metrics?.xAdvance).toBe(500);
  });

  test('a glyph of zero is `.notdef`, and is refused however the segment states it', () => {
    // Format 4 states a mapping two ways, and glyph 0 means the same thing in both: the face does not
    // cover this code point. The glyph array reaches it as a literal zero; `idDelta` reaches it as
    // arithmetic, a segment whose delta is the two's complement of its own start mapping that start
    // to zero — `(0x78 + 0xFF88) % 0x10000` is 0. Checked on the array branch alone, the delta branch
    // handed `.notdef`'s advance back as a real one, and every list and callout-list marker gutter in
    // the face was set from a box the reader never sees instead of from the stylesheet's own default.
    for (const through of ['array', 'delta'] as const) {
      const metrics = parseFaceMetrics(
        fontOf({
          cmap: cmapTable({ codePoint: X, glyph: 0, through }),
          // A `.notdef` that advances nothing like the face's `x` does, so accepting it is visible as
          // a number rather than as a zero that could have come from anywhere.
          hmtx: hmtxTable([600, 500]),
        }),
      );
      expect(metrics).toBeDefined();
      expect(metrics?.xAdvance).toBeUndefined();
    }
  });

  test('a glyph array that points outside the file is refused', () => {
    const metrics = parseFaceMetrics(
      fontOf({
        cmap: cmapTable({ codePoint: X, glyph: 1, through: 'array', rangeOffset: 0xFF_00 }),
      }),
    );
    expect(metrics).toBeDefined();
    expect(metrics?.xAdvance).toBeUndefined();
  });

  test('a character map built to be walked forever is bounded rather than walked', () => {
    // A font file is untrusted input: any collaborator may put one in a project. `cmap` declares up
    // to 65535 encoding records, each naming a subtable of up to 32767 segments, and nothing related
    // the two bounds — so the walk was their PRODUCT, two thousand million `DataView` reads on the
    // thread that renders the editor. This very shape, in 768 KB, measured 1882 ms per face, and a
    // family plans up to four of them.
    const bytes = fontOf({ cmap: wideCmapTable(65_535, 32_767) });
    const started = performance.now();
    const metrics = parseFaceMetrics(bytes);
    const elapsed = performance.now() - started;
    // The vertical metrics are still read. A character map nobody can follow costs the marker gutter
    // and nothing else — which is the same answer a truncated one gives.
    expect(metrics?.ascender).toBe(880);
    expect(metrics?.xAdvance).toBeUndefined();
    // Two orders of magnitude below what it cost, and three above what it now costs.
    expect(elapsed).toBeLessThan(500);
  });

  test('a character map of thousands of DISTINCT subtables costs a fixed amount per record', () => {
    // The hostile shape the de-duplication above cannot touch, and so the strongest one there is: no
    // subtable is named twice, so every record is a subtable that must really be read. What bounds it
    // is that reading one is a fixed amount of work — a format, a length, a segment count and one
    // segment — with the shared segment budget underneath in case a subtable declares more.
    //
    // Counted rather than timed: a read count is the same number on any machine, and a product term
    // creeping back in is a change in this number long before it is a change in the clock.
    const records = 65_535;
    const bytes = fontOf({ cmap: distinctSubtableCmap(records) });
    let metrics: FaceMetrics | undefined;
    const reads = readsDuring(() => {
      metrics = parseFaceMetrics(bytes);
    });
    // The vertical metrics are still read: a character map nobody can follow costs the marker gutter
    // and nothing else.
    expect(metrics?.ascender).toBe(880);
    expect(metrics?.xAdvance).toBeUndefined();
    // Four reads per record and no more, whatever the file says: the record's subtable offset, the
    // subtable's format and length as one word, its segment count, and its one segment's end code.
    // Nothing multiplied by anything, and nothing that a bigger declaration can grow. The remainder is
    // the file's own directory and the two vertical-metric tables, which is a fixed cost.
    expect(reads).toBeGreaterThan(records * 4);
    expect(reads).toBeLessThan(records * 4 + 64);
  });

  test('a subtable with tens of thousands of real segments is still answered', () => {
    // The other side of the bound, and the reason it is a large number rather than a small one: a
    // face covering many scripts states its coverage in thousands of segments, and a reader that gave
    // up before reaching `x` would lose the gutter for exactly the fonts most likely to need it.
    const metrics = parseFaceMetrics(
      fontOf({
        cmap: wideCmapTable(1, 20_000, { codePoint: X, glyph: 1 }),
        hmtx: hmtxTable([0, 500]),
      }),
    );
    expect(metrics?.xAdvance).toBe(500);
  });

  test('encoding records naming one subtable read it once, not once each', () => {
    // Several records pointing at one subtable is what a real font does — the Windows and the Unicode
    // encodings of the same map are the usual pair — and reading it a second time cannot answer
    // differently. It is also the whole of the hostile shape above.
    const many = fontOf({ cmap: wideCmapTable(40, 2000) });
    const reads = readsDuring(() => {
      parseFaceMetrics(many);
    });
    // One walk of two thousand segments, and not forty of them.
    expect(reads).toBeLessThan(4000);
    expect(reads).toBeGreaterThan(1999);
  });

  test('an odd segment-count declaration is a count of segments, not a fractional one', () => {
    // `segCountX2` is a count of BYTES, and a file may declare an odd one. Halved and left as a
    // fraction it put all four of the subtable's arrays at fractional offsets, which `DataView`
    // truncates without saying so — every field then read one byte into the field beside it.
    const metrics = parseFaceMetrics(
      fontOf({
        cmap: cmapTable({ codePoint: X, glyph: 1, through: 'delta', declaredSegmentBytes: 5 }),
      }),
    );
    expect(metrics?.xAdvance).toBe(500);
  });

  test('a subtable that overruns its own table is refused, not read out of the table beside it', () => {
    // Bounded by the FILE rather than by the `cmap`'s own declared length, a subtable claiming more
    // segments than its table holds walks into whatever table happens to follow it and answers with
    // an advance derived from unrelated bytes — a wrong gutter, arrived at without any error.
    const cmap = cmapTable({ codePoint: X, glyph: 1, through: 'delta' });
    const bytes = syntheticFont([
      headTable(1000),
      hheaTable(880, -120, 100),
      { ...cmap, declaredLength: 30 },
      hmtxTable([0, 500]),
    ]);
    const metrics = parseFaceMetrics(bytes);
    expect(metrics?.ascender).toBe(880);
    expect(metrics?.xAdvance).toBeUndefined();
  });

  test('a subtable that overruns its OWN length is refused, not read out of the one beside it', () => {
    // The same defect as the case above, one level down. `cmap` holds its subtables end to end, so a
    // subtable declaring 16 bytes while claiming two segments reads its `startCode`, `idDelta` and
    // `idRangeOffset` arrays out of the NEXT subtable's header — inside the `cmap`, so the table's own
    // end lets it through — and a neighbour's `language`, `searchRange` and `rangeShift` read as a
    // perfectly plausible mapping. The gutter of every list in the face then comes from another map's
    // binary-search constants.
    const { cmap, fabricatedGlyph, honestGlyph } = overrunningSubtableCmap();
    const advances = Array.from({ length: 130 }, () => 0);
    advances[fabricatedGlyph] = 640;
    advances[honestGlyph] = 900;
    const metrics = parseFaceMetrics(
      fontOf({ cmap, hhea: hheaTable(880, -120, 100, advances.length), hmtx: hmtxTable(advances) }),
    );
    expect(metrics).toBeDefined();
    expect(metrics?.ascender).toBe(880);
    // 640 is the advance of the glyph the overrun fabricates, and the whole point of the case: the
    // honest subtable beside it is still read, so the gutter is answered — with the right number.
    expect(metrics?.xAdvance).toBe(900);
  });

  test('a glyph past the last long metric advances as that one does', () => {
    // What the trailing left-side-bearing array in `hmtx` is for: a font may declare fewer horizontal
    // metrics than glyphs, and every glyph past the last one repeats it. Without the clamp the entry
    // lands in that bearing array — a bearing returned as an advance, or nothing at all.
    const metrics = parseFaceMetrics(
      fontOf({
        cmap: cmapTable({ codePoint: X, glyph: 3, through: 'delta' }),
        hmtx: hmtxTable([0, 500], 2),
      }),
    );
    expect(metrics?.xAdvance).toBe(500);
  });
});

describe('reading one file once', () => {
  // The parse is a pure function of the bytes, and it was paid per keystroke. `resolveAppearance`
  // builds a fresh `fonts` array on every call, so the plan the preview's metrics are keyed on
  // changes identity whenever the theme document is typed in — and every one of those re-read every
  // project face from raw bytes, on the thread painting the editor, between the key going down and
  // the character appearing.

  test('the same array of bytes is read once, however often it is asked about', () => {
    const bytes = new Uint8Array(readFileSync(PROJECT_FONT));
    const first = parseFaceMetrics(bytes);
    expect(first?.xAdvance).toBeGreaterThan(0);
    expect(
      readsDuring(() => {
        parseFaceMetrics(bytes);
      }),
    ).toBe(0);
    expect(parseFaceMetrics(bytes)).toBe(first);

    // A different array is a different question: identity is what the asset cache preserves while the
    // bytes are unchanged, and what it stops preserving when they are replaced.
    const replaced = new Uint8Array(bytes);
    expect(
      readsDuring(() => {
        parseFaceMetrics(replaced);
      }),
    ).toBeGreaterThan(0);
    expect(parseFaceMetrics(replaced)).toEqual(first);
  });

  test('a read that fails in a way nobody predicted is no metrics, not a thrown editor', () => {
    // A font file is untrusted input, and this function runs inside a `useMemo` on the thread that
    // renders the preview, with no error boundary between it and the page — so a throw here replaces
    // the editor with nothing. The bounds checks make every KNOWN shape return undefined; this pins
    // the promise for the shape nobody thought of, which is the only thing an outer guard can be
    // tested for. Driven by making the one primitive the parse is built out of fail.
    const real = DataView.prototype.getUint16;
    const spy = jest.spyOn(DataView.prototype, 'getUint16').mockImplementation(() => {
      throw new RangeError('Offset is outside the bounds of the DataView');
    });
    try {
      expect(parseFaceMetrics(fontOf())).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    // And the real reader is unharmed by the substitution, so this says nothing about the next test.
    expect(DataView.prototype.getUint16).toBe(real);
  });

  test('a file with no metrics is remembered as one, rather than read again each time', () => {
    // "Read, and there are nothing but unreadable tables in it" is an answer, and the expensive one:
    // a file that yields nothing is the file whose whole character map was walked to find that out.
    const bytes = fontOf({ head: null });
    expect(parseFaceMetrics(bytes)).toBeUndefined();
    expect(
      readsDuring(() => {
        parseFaceMetrics(bytes);
      }),
    ).toBe(0);
  });
});

describe("the renderer's font-style keyword and the face it selects", () => {
  test('each keyword picks the file the renderer would draw with', () => {
    expect(faceStyleOf(undefined)).toBe('normal');
    expect(faceStyleOf('bold')).toBe('bold');
    expect(faceStyleOf('italic')).toBe('italic');
    expect(faceStyleOf('normal_italic')).toBe('italic');
    expect(faceStyleOf('bold_italic')).toBe('boldItalic');
  });
});

describe('resolving the metrics a whole appearance needs', () => {
  test('a catalogue family is answered from the committed manifest, with no file read', () => {
    const plan = planFontFaces([{ family: 'Noto Serif', declaredFaces: {}, declaredByTheme: false }]);
    const { boxOf, overridesOf, diagnostics } = resolveFaceMetrics(plan, () => undefined);
    expect(diagnostics).toEqual([]);
    expect(boxOf('Noto Serif', undefined)?.lineHeight).toBeCloseTo(1.36, 6);
    expect(boxOf('Noto Serif', 'bold')?.lineHeight).toBeCloseTo(1.36, 6);
    expect(overridesOf('Noto Serif', 'normal', 'box')).toEqual({
      ascentOverride: '106.8%',
      descentOverride: '29.2%',
      lineGapOverride: '0%',
    });
    // Noto Serif's line gap is zero, so the two registrations agree — which is exactly why no anchor
    // built on the gem's own catalogue could witness the difference between them.
    expect(overridesOf('Noto Serif', 'normal', 'text')).toEqual(
      overridesOf('Noto Serif', 'normal', 'box'),
    );
  });

  test('a family with no metrics is left unanswered, so the stylesheet keeps its own default', () => {
    const plan = planFontFaces([{ family: 'Nowhere', declaredFaces: {}, declaredByTheme: true }]);
    const { boxOf, overridesOf } = resolveFaceMetrics(plan, () => undefined);
    expect(boxOf('Nowhere', undefined)).toBeUndefined();
    expect(boxOf(undefined, undefined)).toBeUndefined();
    expect(overridesOf('Nowhere', 'normal', 'text')).toBeUndefined();
    expect(overridesOf('Nowhere', 'normal', 'box')).toBeUndefined();
  });

  test("a project's own file is read from the bytes it is drawn with", () => {
    const plan = planFontFaces(projectRequirement('project-mono-regular.ttf'), 'theme/x.yml');
    const bytes = new Uint8Array(readFileSync(PROJECT_FONT));
    const { boxOf, overridesOf, diagnostics } = resolveFaceMetrics(plan, () => bytes);
    expect(diagnostics).toEqual([]);
    expect(boxOf('Project Mono', undefined)?.lineHeight).toBeGreaterThan(0.5);
    expect(overridesOf('Project Mono', 'normal', 'text')?.ascentOverride).toMatch(/^\d+(\.\d+)?%$/);
    expect(overridesOf('Project Mono', 'normal', 'box')?.ascentOverride).toMatch(/^\d+(\.\d+)?%$/);
  });

  test('a project file whose metrics cannot be read is reported, not silently approximated', () => {
    const plan = planFontFaces(projectRequirement('project-mono-regular.ttf'), 'theme/x.yml');
    const { boxOf, diagnostics } = resolveFaceMetrics(plan, () => new Uint8Array([9, 9, 9, 9]));
    expect(boxOf('Project Mono', undefined)).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('theme-font-unavailable');
    expect(diagnostics[0].resource).toBe('Project Mono');
  });

  test('a project file that has not arrived yet is not a file that could not be read', () => {
    const plan = planFontFaces(projectRequirement('project-mono-regular.ttf'), 'theme/x.yml');
    const { diagnostics } = resolveFaceMetrics(plan, () => undefined);
    expect(diagnostics).toEqual([]);
  });

  test('a face whose box is real but whose metrics are not percentages lays lines out and declares nothing', () => {
    // A negative line gap is a box the renderer builds without complaint and a descriptor CSS has no
    // spelling for. The two answers must part company here: the line box is still the renderer's, and
    // the overrides are left off so the browser keeps its own reading of the file. Declaring the
    // negative instead makes the browser drop all three descriptors, which silently returns the tint
    // behind every codespan to the disagreement this preview exists to end.
    const plan = planFontFaces(projectRequirement('project-mono-regular.ttf'), 'theme/x.yml');
    const bytes = fontOf({ hhea: hheaTable(900, -100, -50) });
    const { boxOf, overridesOf, diagnostics } = resolveFaceMetrics(plan, () => bytes);
    expect(diagnostics).toEqual([]);
    expect(boxOf('Project Mono', undefined)?.lineHeight).toBeCloseTo(0.95, 6);
    expect(overridesOf('Project Mono', 'normal', 'text')).toBeUndefined();
    expect(overridesOf('Project Mono', 'normal', 'box')).toBeUndefined();
  });

  test('a family with no face for the style asked for is measured in the face it does have', () => {
    // The renderer draws a bold run of a family that ships only an upright file in that upright file,
    // so those are the metrics the line is set with. Answering undefined instead would leave every
    // bold construct in a project font without a line box at all.
    const plan = planFontFaces(projectRequirement('project-mono-regular.ttf'), 'theme/x.yml');
    const { boxOf } = resolveFaceMetrics(plan, () => fontOf());
    expect(boxOf('Project Mono', 'bold')?.lineHeight).toBeCloseTo(1.1, 6);
    expect(boxOf('Project Mono', 'bold')).toEqual(boxOf('Project Mono', undefined));
  });
});
