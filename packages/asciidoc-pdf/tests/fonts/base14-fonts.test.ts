/**
 * @file The committed base-14 stand-ins really do carry the export's own measurements.
 *
 * `generate-base14-fonts.mjs` makes a claim that nothing else in the repository can check: that a
 * typeface which is not Helvetica advances exactly as Helvetica does, and that the line box the
 * preview sets is the one prawn computes rather than the one the stand-in's designer intended. Both
 * halves of that are re-derived here from the committed evidence — the AFM files the generator copies
 * out of prawn, and prawn's own WinAnsi table beside them — and compared against what the manifest
 * says and against what the WOFF2 files actually contain.
 *
 * Everything read here is committed, so this runs on a clean checkout with no gem and no wasm build.
 * The complementary check is the generator's own `--check`, which re-reads the live gem and byte-
 * compares; between them, a metric that moved in prawn and a manifest edited by hand are both loud.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Font, woff2 } from 'fonteditor-core';

/** Where the committed stand-ins and their evidence live. */
const ASSETS = path.join(__dirname, '../../assets/base14-fonts');

/**
 * Where the files the stand-ins were converted FROM live.
 *
 * Committed for the same reason the AFMs are — nothing here fetches anything — which is what makes
 * the conversion checkable from a clean checkout rather than only from a job that has the gem.
 */
const VENDOR = path.join(__dirname, '../../vendor/base14');

/** The module that writes the synthetic `GPOS`, which one check below drives directly. */
const GPOS_BUILDER = path.join(__dirname, '../../scripts/gpos-kerning.mjs');

/** The WOFF2 codec's wasm, resolved the way the generator resolves it. */
const WOFF2_WASM = path.join(
  require.resolve('fonteditor-core').replace(/fonteditor-core\/.*$/, 'fonteditor-core'),
  'woff2/woff2.wasm',
);

/** What one face records in the manifest. */
interface ManifestFace {
  readonly name: string;
  readonly file: string;
  readonly source: string;
  readonly sourceHash: string;
  readonly afm: string;
  readonly bytes: number;
  readonly hash: string;
  readonly encodedBytes: number;
  readonly widthsHash: string;
  readonly divergences: readonly {
    readonly code: number;
    readonly glyph: string;
    readonly afm: number;
    readonly substitute: number | null;
  }[];
  /**
   * What the AFM's kerning cost to transcribe, for the twelve text faces; absent for the symbolic two.
   *
   * Self-reported by the generator, which is why both numbers are re-derived below rather than read.
   */
  readonly kerning?: {
    readonly pairs: number;
    readonly unmapped: number;
  };
  readonly metrics: {
    readonly unitsPerEm: number;
    readonly ascender: number;
    readonly descender: number;
    readonly lineGap: number;
    readonly xAdvance?: number;
  };
}

/** The committed manifest. */
interface Base14Manifest {
  readonly prawnVersion: string;
  readonly faces: readonly ManifestFace[];
  readonly families: readonly { readonly family: string; readonly faces: Record<string, string> }[];
  readonly licences: readonly string[];
  readonly metricSources: readonly string[];
}

const manifest = JSON.parse(readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8')) as Base14Manifest;

/** The part of the manifest the browser is given, which is a separate committed file. */
const browserSlice = JSON.parse(readFileSync(path.join(ASSETS, 'browser.json'), 'utf8')) as {
  readonly faces: readonly { readonly name: string; readonly file: string; readonly metrics: unknown }[];
  readonly families: Base14Manifest['families'];
};

/** Prawn's WinAnsi table, as the generator copied it out of `Prawn::Encoding::WinAnsi::CHARACTERS`. */
const WIN_ANSI = JSON.parse(readFileSync(path.join(ASSETS, 'winansi.json'), 'utf8')) as string[];

/** The two faces prawn marks `CharacterSet Special`, whose bytes go through the font's own encoding. */
const SYMBOLIC = new Set(['Symbol', 'ZapfDingbats']);

/** The four style keys prawn's family table uses. */
const STYLES = ['normal', 'bold', 'italic', 'bold_italic'] as const;

/** `Prawn::Fonts::AFM#normalize_encoding` is `text.encode('windows-1252')` and nothing else. */
const WINDOWS_1252 = new TextDecoder('windows-1252');

/** Every byte on which a stand-in is known not to advance the way the export does. */
interface Divergence {
  readonly code: number;
  readonly glyph: string;
  readonly afm: number;
  readonly substitute: number | null;
}

/**
 * The measured divergences, written out here rather than taken from the manifest.
 *
 * The manifest's own list is generated from the very files it is a claim about, so a stand-in that
 * was wrong in some new way would be recorded as divergent and then agree with its own record. This
 * table is the independent side of that comparison: 24 bytes across the twelve text faces, none
 * across the two symbolic ones, each with both numbers. Anything else — a stand-in swapped, a
 * wrapper that mis-orders `hmtx`, a byte that silently stopped being reachable — is a difference from
 * this, and no amount of regeneration can make it agree.
 *
 * The three kinds, and why each is left as it is rather than corrected, are set out on
 * `faceDivergences` in `scripts/generate-base14-fonts.mjs`. In short: `trademark`, `exclamdown`,
 * `questiondown`, `oslash` and `logicalnot` are drawn to a different width by the stand-in's own
 * designer; `ydieresis` at 0x9F is prawn's table naming the lower-case glyph where WinAnsiEncoding
 * puts the capital, so the stand-in matches the PAGE and prawn's line breaking does not; and the
 * no-break space at 0xA0 is a glyph of its own in Termes and the space glyph in the AFM.
 */
const MEASURED_DIVERGENCES: Readonly<Record<string, readonly Divergence[]>> = {
  Courier: [],
  'Courier-Bold': [],
  'Courier-BoldOblique': [{ code: 153, glyph: 'trademark', afm: 600, substitute: 648 }],
  'Courier-Oblique': [{ code: 153, glyph: 'trademark', afm: 600, substitute: 652 }],
  Helvetica: [
    { code: 159, glyph: 'ydieresis', afm: 500, substitute: 667 },
    { code: 161, glyph: 'exclamdown', afm: 333, substitute: 278 },
    { code: 191, glyph: 'questiondown', afm: 611, substitute: 556 },
    { code: 248, glyph: 'oslash', afm: 611, substitute: 556 },
  ],
  'Helvetica-Bold': [{ code: 159, glyph: 'ydieresis', afm: 556, substitute: 667 }],
  'Helvetica-BoldOblique': [
    { code: 153, glyph: 'trademark', afm: 1000, substitute: 1015 },
    { code: 159, glyph: 'ydieresis', afm: 556, substitute: 667 },
  ],
  'Helvetica-Oblique': [
    { code: 159, glyph: 'ydieresis', afm: 500, substitute: 667 },
    { code: 161, glyph: 'exclamdown', afm: 333, substitute: 278 },
    { code: 191, glyph: 'questiondown', afm: 611, substitute: 556 },
  ],
  Symbol: [],
  'Times-Bold': [
    { code: 159, glyph: 'ydieresis', afm: 500, substitute: 722 },
    { code: 160, glyph: 'space', afm: 250, substitute: 333 },
  ],
  'Times-BoldItalic': [
    { code: 153, glyph: 'trademark', afm: 1000, substitute: 1012 },
    { code: 159, glyph: 'ydieresis', afm: 444, substitute: 611 },
    { code: 160, glyph: 'space', afm: 250, substitute: 333 },
    { code: 172, glyph: 'logicalnot', afm: 606, substitute: 570 },
  ],
  'Times-Italic': [
    { code: 153, glyph: 'trademark', afm: 980, substitute: 1009 },
    { code: 159, glyph: 'ydieresis', afm: 444, substitute: 556 },
    { code: 160, glyph: 'space', afm: 250, substitute: 333 },
    { code: 161, glyph: 'exclamdown', afm: 389, substitute: 333 },
  ],
  'Times-Roman': [
    { code: 159, glyph: 'ydieresis', afm: 500, substitute: 722 },
    { code: 160, glyph: 'space', afm: 250, substitute: 333 },
  ],
  ZapfDingbats: [],
};

/**
 * Which glyph names the AFM's kern pairs name that the stand-in has no glyph for, and how often.
 *
 * The independent side of the manifest's `kerning.unmapped`, which is a bare count the generator
 * writes about its own output. Derived below from the AFM and the stand-in's own charset and compared
 * against this — so a stand-in swapped for a cut with a different glyph complement, or a generator
 * that started dropping pairs for some other reason, is a difference from a table nothing regenerates.
 *
 * Four glyph names across the twelve text faces, not the three the generator's own comment claimed
 * until these counts were derived: `Tcommaaccent` in every one of them, `scommaaccent` and
 * `tcommaaccent` in most, and `Scommaaccent` in the upright and oblique Helveticas alone. None of the
 * four is in prawn's WinAnsi table either (`afm.rb:234-237` keys the kern table by WinAnsi code), so
 * no byte of a PDF content stream could have applied those pairs.
 */
const UNMAPPED_KERN_GLYPHS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  Courier: {},
  'Courier-Bold': {},
  'Courier-BoldOblique': {},
  'Courier-Oblique': {},
  Helvetica: { Tcommaaccent: 98, Scommaaccent: 2, scommaaccent: 5, tcommaaccent: 5 },
  'Helvetica-Bold': { Tcommaaccent: 96, scommaaccent: 6, tcommaaccent: 4 },
  'Helvetica-BoldOblique': { Tcommaaccent: 96, scommaaccent: 6, tcommaaccent: 4 },
  'Helvetica-Oblique': { Tcommaaccent: 98, Scommaaccent: 2, scommaaccent: 5, tcommaaccent: 5 },
  Symbol: {},
  'Times-Bold': { Tcommaaccent: 100, scommaaccent: 1 },
  'Times-BoldItalic': { Tcommaaccent: 99, scommaaccent: 1, tcommaaccent: 1 },
  'Times-Italic': { Tcommaaccent: 96, scommaaccent: 5, tcommaaccent: 1 },
  'Times-Roman': { Tcommaaccent: 100, scommaaccent: 1, tcommaaccent: 1 },
  ZapfDingbats: {},
};

/** One parsed AFM: the attributes prawn reads, the width of each named glyph, and the built-in codes. */
interface ParsedAfm {
  readonly attributes: Record<string, string>;
  readonly widths: Map<string, number>;
  readonly codes: Map<number, string>;
  /** `KPX left right adjustment`, in file order — the only kern record prawn reads. */
  readonly kernPairs: readonly (readonly [string, string, number])[];
}

/**
 * Parse one AFM the way prawn parses it.
 *
 * Deliberately a second implementation rather than an import of the generator's: a test that reused
 * the generator's reader would agree with it about a misreading, and the AFM is the authority both
 * sides of this comparison rest on.
 *
 * @param name - The AFM's file name inside the committed assets.
 * @returns The attributes, the widths by glyph name, the glyph at each built-in code, and the KPX
 *   records the export kerns with.
 */
function parseAfm(name: string): ParsedAfm {
  const attributes: Record<string, string> = {};
  const widths = new Map<string, number>();
  const codes = new Map<number, string>();
  const kernPairs: [string, string, number][] = [];
  let inCharMetrics = false;

  for (const line of readFileSync(path.join(ASSETS, name), 'latin1').split(/\r\n|[\n\r]/)) {
    if (line.startsWith('StartCharMetrics')) {
      inCharMetrics = true;
      continue;
    }
    if (line.startsWith('EndCharMetrics')) {
      inCharMetrics = false;
      continue;
    }
    if (inCharMetrics) {
      const glyph = /\bN\s+(\.?\w+)\s*;/.exec(line)?.[1];
      if (glyph === undefined) continue;
      widths.set(glyph, Number(/\bWX\s+(\d+)\s*;/.exec(line)?.[1] ?? 0));
      const code = Number(/^C\s+(-?\d+)\s*;/.exec(line)?.[1] ?? -1);
      if (code >= 0) codes.set(code, glyph);
      continue;
    }
    // Matched by its own keyword rather than by a section, which is the same test prawn's own reader
    // applies (`parse_afm` dispatches on the line, `afm.rb:183-241`): `KPX` appears nowhere but inside
    // `StartKernPairs`, and the attribute pattern below cannot match one.
    const kern = /^KPX\s+(\S+)\s+(\S+)\s+(-?\d+)/.exec(line);
    if (kern !== null) {
      kernPairs.push([kern[1], kern[2], Number(kern[3])]);
      continue;
    }
    const attribute = /^(Ascender|Descender|FontBBox|CharacterSet)\s+(.*)/.exec(line);
    if (attribute !== null) attributes[attribute[1]] = attribute[2];
  }
  return { attributes, widths, codes, kernPairs };
}

/**
 * Which glyph each byte of a string set in this face selects, and how wide the export makes it.
 *
 * An ordinary AFM font is written into the PDF with `Encoding: WinAnsiEncoding`; one whose
 * `CharacterSet` is `Special` gets no `Encoding` key at all and keeps its own (`afm.rb:157-167`).
 *
 * @param afm - The parsed AFM.
 * @param symbolic - Whether this is Symbol or ZapfDingbats.
 * @returns Byte → the glyph it selects and the width the export gives it.
 */
function encodedWidths(afm: ParsedAfm, symbolic: boolean): Map<number, { glyph: string; width: number }> {
  const table = new Map<number, { glyph: string; width: number }>();
  if (symbolic) {
    for (const code of [...afm.codes.keys()].toSorted((a, b) => a - b)) {
      const glyph = afm.codes.get(code) as string;
      table.set(code, { glyph, width: afm.widths.get(glyph) ?? 0 });
    }
    return table;
  }
  for (let code = 0; code < 256; code += 1) {
    const glyph = WIN_ANSI[code];
    if (glyph === '.notdef') continue;
    const width = afm.widths.get(glyph);
    if (width === undefined) continue;
    table.set(code, { glyph, width });
  }
  return table;
}

/**
 * The advance the renderer measures a list's marker gutter with, or undefined when it measures none.
 *
 * Positive or nothing. `AFM#compute_width_of` sums `@glyph_table[byte]`, which prawn builds from the
 * WinAnsi glyph name (`afm.rb:224-227`) and which is zero for a face with no such glyph — and a zero
 * gutter is a marker touching its text, not a measurement, so both the generator and the preview
 * treat it as no answer at all.
 *
 * @param afm - The parsed AFM.
 * @returns The advance of the glyph byte 0x78 selects, or undefined when there is none to state.
 */
function gutterWidth(afm: ParsedAfm): number | undefined {
  const width = afm.widths.get(WIN_ANSI[0x78]);
  return width !== undefined && width > 0 ? width : undefined;
}

/**
 * The face bytes as an sfnt again, which is what a browser decodes a WOFF2 into before reading it.
 *
 * Memoised because the WOFF2 decode is the expensive step here and eight of the checks below want the
 * same fourteen files. The cache holds the decoded bytes and nothing derived from them, so no check
 * can observe another's work.
 */
const decodedFaces = new Map<string, Buffer>();

/**
 * @param file - The WOFF2's file name inside the committed assets.
 * @returns Its bytes as a plain sfnt.
 */
function decodeFace(file: string): Buffer {
  const cached = decodedFaces.get(file);
  if (cached !== undefined) return cached;
  const bytes = readFileSync(path.join(ASSETS, file));
  const sfnt = Buffer.from(
    woff2.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  );
  decodedFaces.set(file, sfnt);
  return sfnt;
}

/** What a font says about itself, in the tables a browser actually consults. */
interface MeasuredFace {
  /** Design units per em. */
  readonly unitsPerEm: number;
  /**
   * The advance the face gives a code point, or undefined for one it cannot draw.
   *
   * @param code - A Unicode code point.
   * @returns The advance in design units.
   */
  readonly advanceOf: (code: number) => number | undefined;
}

/**
 * Read `head`, `cmap` and `hmtx` straight out of an sfnt.
 *
 * A hand-written reader rather than `fonteditor-core`'s font model, for two reasons and not for the
 * sake of writing one. The first is that its OpenType/CFF reader reports advances from the
 * CHARSTRINGS and not from `hmtx`, and `hmtx` is what an OpenType consumer uses — so a wrapper that
 * built `hmtx` wrongly would look perfect through that library and be wrong in every browser. The
 * second is independence: the generator uses a reader of its own, and a test that shared one could
 * only confirm that both agreed about a misreading.
 *
 * @param sfnt - The whole font file.
 * @returns Its em and its advances.
 */
function measure(sfnt: Buffer): MeasuredFace {
  const tables = new Map<string, number>();
  for (let index = 0; index < sfnt.readUInt16BE(4); index += 1) {
    const at = 12 + index * 16;
    tables.set(sfnt.toString('latin1', at, at + 4), sfnt.readUInt32BE(at + 8));
  }
  const head = tables.get('head') as number;
  const hmtx = tables.get('hmtx') as number;
  const cmap = tables.get('cmap') as number;
  const metricCount = sfnt.readUInt16BE((tables.get('hhea') as number) + 34);

  let subtable = 0;
  for (let index = 0; index < sfnt.readUInt16BE(cmap + 2); index += 1) {
    const record = cmap + 4 + index * 8;
    if (sfnt.readUInt16BE(record) === 3 && sfnt.readUInt16BE(record + 2) === 1) {
      subtable = cmap + sfnt.readUInt32BE(record + 4);
    }
  }
  expect(sfnt.readUInt16BE(subtable)).toBe(4);

  const segments = sfnt.readUInt16BE(subtable + 6) / 2;
  const ends = subtable + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;

  const glyphOf = (code: number): number => {
    for (let segment = 0; segment < segments; segment += 1) {
      if (sfnt.readUInt16BE(ends + segment * 2) < code) continue;
      const start = sfnt.readUInt16BE(starts + segment * 2);
      if (start > code) return 0;
      const delta = sfnt.readUInt16BE(deltas + segment * 2);
      const range = sfnt.readUInt16BE(ranges + segment * 2);
      if (range === 0) return (code + delta) & 0xFF_FF;
      const glyph = sfnt.readUInt16BE(ranges + segment * 2 + range + (code - start) * 2);
      return glyph === 0 ? 0 : (glyph + delta) & 0xFF_FF;
    }
    return 0;
  };

  return {
    unitsPerEm: sfnt.readUInt16BE(head + 18),
    advanceOf: (code) => {
      const glyph = glyphOf(code);
      // Past the last full metric a face repeats the final advance, which is how a monospaced font
      // states one width for every glyph.
      return glyph === 0 ? undefined : sfnt.readUInt16BE(hmtx + Math.min(glyph, metricCount - 1) * 4);
    },
  };
}

/** One table's place in a font file. */
interface TableRecord {
  readonly offset: number;
  readonly length: number;
}

/**
 * The sfnt table directory, in the order the file lists it.
 *
 * A `Map` and not a lookup function, because two things below need the ORDER as well as the contents:
 * the directory must be sorted by tag, and which tables are present is itself an assertion.
 *
 * @param sfnt - The whole font file.
 * @returns Tag to record, in file order.
 */
function tableRecords(sfnt: Buffer): Map<string, TableRecord> {
  const tables = new Map<string, TableRecord>();
  for (let index = 0; index < sfnt.readUInt16BE(4); index += 1) {
    const at = 12 + index * 16;
    tables.set(sfnt.toString('latin1', at, at + 4), {
      offset: sfnt.readUInt32BE(at + 8),
      length: sfnt.readUInt32BE(at + 12),
    });
  }
  return tables;
}

/**
 * Each glyph's own name, indexed by glyph id, out of the CFF charset the published file carries.
 *
 * Read by `fonteditor-core` rather than by a reader written here or by the generator's. That is the
 * one shared reader in this file and it is a deliberate exception to the rule the AFM parser above
 * states: a CFF charset is an INDEX plus a Top DICT plus 391 predefined strings, and the alternatives
 * were to copy Appendix A of the CFF specification into a test or to import the very module whose
 * output is under test. A third party's decoder is neither.
 *
 * What it cannot hide is a glyph ORDER that moved, which is the failure that would matter: the ids
 * these names are attached to are the ids the `cmap` and `hmtx` are indexed by, and those are pinned
 * independently, byte by byte, by the advance round trip above.
 *
 * @param sfnt - The whole font file.
 * @returns Glyph name by glyph id.
 */
function glyphNames(sfnt: Buffer): string[] {
  // A copy rather than a view: the reader takes ownership of what it is given, and the decoded sfnt
  // is memoised and read again by every other check. `Buffer.from` also narrows the type — a Node
  // buffer's `.buffer` is `ArrayBufferLike`, which may be shared, and the reader takes neither.
  const font = Font.create(Buffer.from(sfnt).buffer, { type: 'otf' });
  return font.get().glyf.map((glyph) => glyph.name);
}

/** A `GPOS` table, decoded far enough to say whether it is the one the generator claims to write. */
interface DecodedGpos {
  /** The table's own length, from the directory. */
  readonly length: number;
  /** Major and minor version. */
  readonly version: readonly [number, number];
  /** Where the three lists start, as the header states them. */
  readonly listOffsets: { readonly script: number; readonly feature: number; readonly lookup: number };
  /** One past the last byte each list occupies, derived from the list's own contents. */
  readonly listEnds: { readonly script: number; readonly feature: number; readonly lookup: number };
  /** Every script, with its default language system. */
  readonly scripts: readonly {
    readonly tag: string;
    readonly langSysCount: number;
    readonly defaultLangSys: {
      readonly lookupOrder: number;
      readonly requiredFeatureIndex: number;
      readonly featureIndices: readonly number[];
    } | null;
  }[];
  /** Every feature, with the lookups it names. */
  readonly features: readonly {
    readonly tag: string;
    readonly featureParams: number;
    readonly lookupIndices: readonly number[];
  }[];
  /** Every lookup, with its type, its flags and where its subtables start. */
  readonly lookups: readonly {
    readonly type: number;
    readonly flag: number;
    readonly subtables: readonly number[];
  }[];
  /** The one pair-adjustment subtable, decoded. */
  readonly pairPos: {
    readonly at: number;
    readonly format: number;
    readonly valueFormat1: number;
    readonly valueFormat2: number;
    readonly pairSetCount: number;
    readonly coverage: {
      readonly format: number;
      readonly glyphs: readonly number[];
    };
    /** Where each PairSet begins, relative to the subtable. */
    readonly pairSetOffsets: readonly number[];
    /** `[firstGlyph, secondGlyph, xAdvance]`, in the order the table lists them. */
    readonly pairs: readonly (readonly [number, number, number])[];
    /** One past the last byte any part of the subtable occupies, relative to the subtable's start. */
    readonly extent: number;
  };
}

/**
 * Decode a `GPOS` from its bytes.
 *
 * A hand-written walk of the table for the same reason `measure` above is one: what is under test is
 * a table this repository writes by hand, and a library that repaired or normalised a malformed one
 * on the way past would make the test pass on a file no browser can read. Every offset is followed
 * from the byte that states it, and every list's END is derived from its own contents rather than
 * from the next list's start — which is what makes the header's three offsets checkable at all.
 *
 * Shaped for the one table the generator writes: one lookup with one subtable. A file with more would
 * fail the assertions below rather than be silently half-read.
 *
 * @param sfnt - The whole font file.
 * @param record - The `GPOS` table's place in it.
 * @returns The decoded table.
 */
function decodeGpos(sfnt: Buffer, record: TableRecord): DecodedGpos {
  const gpos = sfnt.subarray(record.offset, record.offset + record.length);
  const script = gpos.readUInt16BE(4);
  const feature = gpos.readUInt16BE(6);
  const lookup = gpos.readUInt16BE(8);

  const scriptCount = gpos.readUInt16BE(script);
  let scriptEnd = script + 2 + scriptCount * 6;
  const scripts = [];
  for (let index = 0; index < scriptCount; index += 1) {
    const at = script + 2 + index * 6;
    const table = script + gpos.readUInt16BE(at + 4);
    const defaultOffset = gpos.readUInt16BE(table);
    const langSysCount = gpos.readUInt16BE(table + 2);
    scriptEnd = Math.max(scriptEnd, table + 4 + langSysCount * 6);
    let defaultLangSys = null;
    if (defaultOffset !== 0) {
      const langSys = table + defaultOffset;
      const featureCount = gpos.readUInt16BE(langSys + 4);
      defaultLangSys = {
        lookupOrder: gpos.readUInt16BE(langSys),
        requiredFeatureIndex: gpos.readUInt16BE(langSys + 2),
        featureIndices: Array.from({ length: featureCount }, (_, k) =>
          gpos.readUInt16BE(langSys + 6 + k * 2),
        ),
      };
      scriptEnd = Math.max(scriptEnd, langSys + 6 + featureCount * 2);
    }
    scripts.push({ tag: gpos.toString('latin1', at, at + 4), langSysCount, defaultLangSys });
  }

  const featureCount = gpos.readUInt16BE(feature);
  let featureEnd = feature + 2 + featureCount * 6;
  const features = [];
  for (let index = 0; index < featureCount; index += 1) {
    const at = feature + 2 + index * 6;
    const table = feature + gpos.readUInt16BE(at + 4);
    const lookupCount = gpos.readUInt16BE(table + 2);
    featureEnd = Math.max(featureEnd, table + 4 + lookupCount * 2);
    features.push({
      tag: gpos.toString('latin1', at, at + 4),
      featureParams: gpos.readUInt16BE(table),
      lookupIndices: Array.from({ length: lookupCount }, (_, k) => gpos.readUInt16BE(table + 4 + k * 2)),
    });
  }

  const lookupCount = gpos.readUInt16BE(lookup);
  const lookups = [];
  for (let index = 0; index < lookupCount; index += 1) {
    const table = lookup + gpos.readUInt16BE(lookup + 2 + index * 2);
    const subtableCount = gpos.readUInt16BE(table + 4);
    lookups.push({
      type: gpos.readUInt16BE(table),
      flag: gpos.readUInt16BE(table + 2),
      subtables: Array.from({ length: subtableCount }, (_, k) => table + gpos.readUInt16BE(table + 6 + k * 2)),
    });
  }

  const at = lookups[0].subtables[0];
  const coverageAt = at + gpos.readUInt16BE(at + 2);
  const coverageCount = gpos.readUInt16BE(coverageAt + 2);
  const coverage = {
    format: gpos.readUInt16BE(coverageAt),
    glyphs: Array.from({ length: coverageCount }, (_, k) => gpos.readUInt16BE(coverageAt + 4 + k * 2)),
  };
  const pairSetCount = gpos.readUInt16BE(at + 8);
  const pairSetOffsets = Array.from({ length: pairSetCount }, (_, k) => gpos.readUInt16BE(at + 10 + k * 2));
  const pairs: [number, number, number][] = [];
  // The subtable's own header and its coverage are part of its extent as much as its PairSets are: a
  // table whose last PairSet ended early would otherwise "fit" while the coverage ran past the end.
  let extent = Math.max(10 + pairSetCount * 2, coverageAt - at + 4 + coverageCount * 2);
  for (const [index, offset] of pairSetOffsets.entries()) {
    const set = at + offset;
    const count = gpos.readUInt16BE(set);
    for (let k = 0; k < count; k += 1) {
      pairs.push([coverage.glyphs[index], gpos.readUInt16BE(set + 2 + k * 4), gpos.readInt16BE(set + 4 + k * 4)]);
    }
    extent = Math.max(extent, offset + 2 + count * 4);
  }

  return {
    length: record.length,
    version: [gpos.readUInt16BE(0), gpos.readUInt16BE(2)],
    listOffsets: { script, feature, lookup },
    listEnds: {
      script: scriptEnd,
      feature: featureEnd,
      // The lookup list is last and its own end is the subtable's, which is what makes "the header
      // accounts for every byte" a statement about the whole table rather than about its first half.
      lookup: at + extent,
    },
    scripts,
    features,
    lookups,
    pairPos: {
      at,
      format: gpos.readUInt16BE(at),
      valueFormat1: gpos.readUInt16BE(at + 4),
      valueFormat2: gpos.readUInt16BE(at + 6),
      pairSetCount,
      coverage,
      pairSetOffsets,
      pairs,
      extent,
    },
  };
}

/** Every face whose AFM states kern pairs at all, which is the set that should carry a `GPOS`. */
const KERNED_FACES = manifest.faces.filter((face) => parseAfm(face.afm).kernPairs.length > 0);

/**
 * The kern pairs the generator is supposed to have emitted, derived from the AFM and the charset.
 *
 * The generator's own rule, restated: a `KPX` record is carried when the stand-in draws BOTH of the
 * glyphs it names and the adjustment is not zero. Note that the criterion is the stand-in's charset
 * and not prawn's encoding — Times-Roman's AFM has 2073 records, 1971 of which name two glyphs TeX
 * Gyre Termes draws while only 935 name two glyphs prawn's WinAnsi table can select.
 *
 * @param face - The manifest entry, for its AFM and its file.
 * @returns The pairs that should be in the `GPOS`, and the unmapped glyph names with their counts.
 */
/**
 * One pair list as sorted `first second adjustment` strings, so two of them compare as multisets.
 *
 * Sorted lists rather than sets, deliberately: a PairSet listing the same second glyph twice is
 * undefined behaviour in a reader, and a comparison through a `Set` would call such a table equal to
 * the same table without the duplicate.
 *
 * @param pairs - The pairs to canonicalise.
 * @returns One string per pair, sorted.
 */
function canonicalPairs(pairs: readonly (readonly [number, number, number])[]): string[] {
  return pairs.map((pair) => pair.join(' ')).toSorted();
}

const expectedKerningByFace = new Map<
  string,
  { pairs: [number, number, number][]; unmapped: Record<string, number> }
>();

function expectedKerning(face: ManifestFace): {
  pairs: [number, number, number][];
  unmapped: Record<string, number>;
} {
  const cached = expectedKerningByFace.get(face.name);
  if (cached !== undefined) return cached;
  const afm = parseAfm(face.afm);
  const names = glyphNames(decodeFace(face.file));
  const ids = new Map<string, number>();
  // First wins, which is the generator's rule for a name the charset lists twice.
  for (const [id, name] of names.entries()) {
    if (!ids.has(name)) ids.set(name, id);
  }

  const pairs: [number, number, number][] = [];
  const unmapped: Record<string, number> = {};
  for (const [left, right, adjustment] of afm.kernPairs) {
    const first = ids.get(left);
    const second = ids.get(right);
    if (first === undefined || second === undefined) {
      for (const name of [left, right]) {
        if (!ids.has(name)) unmapped[name] = (unmapped[name] ?? 0) + 1;
      }
      continue;
    }
    if (adjustment === 0) continue;
    pairs.push([first, second, adjustment]);
  }
  const derived = { pairs, unmapped };
  expectedKerningByFace.set(face.name, derived);
  return derived;
}

beforeAll(async () => {
  await woff2.init(readFileSync(WOFF2_WASM).buffer);
});

describe('the committed base-14 stand-ins', () => {
  it('covers each of prawn’s fourteen built-in fonts exactly once', () => {
    expect(manifest.faces.map((face) => face.name)).toStrictEqual([
      'Courier',
      'Courier-Bold',
      'Courier-BoldOblique',
      'Courier-Oblique',
      'Helvetica',
      'Helvetica-Bold',
      'Helvetica-BoldOblique',
      'Helvetica-Oblique',
      'Symbol',
      'Times-Bold',
      'Times-BoldItalic',
      'Times-Italic',
      'Times-Roman',
      'ZapfDingbats',
    ]);
  });

  it.each(manifest.faces.map((face) => [face.name, face] as const))(
    '%s is the file the manifest says it is',
    (_name, face) => {
      const bytes = readFileSync(path.join(ASSETS, face.file));
      expect(bytes.length).toBe(face.bytes);
      expect(`sha256-${createHash('sha256').update(bytes).digest('hex')}`).toBe(face.hash);
    },
  );

  it.each(manifest.faces.map((face) => [face.name, face] as const))(
    '%s is still derivable from the vendored file it was converted from',
    (_name, face) => {
      // The manifest used to name the source and nothing more, so nothing pinned the BYTES: replacing
      // a vendored OTF with another cut of the same typeface left every string here correct while the
      // committed WOFF2 quietly stopped being what that file produces. CI could not see it either —
      // the path filter that runs `--check` did not watch `vendor/` — so the only way it surfaced was
      // for somebody to regenerate by hand.
      const source = readFileSync(path.join(VENDOR, face.source));
      expect(`sha256-${createHash('sha256').update(source).digest('hex')}`).toBe(face.sourceHash);
    },
  );

  it.each(manifest.faces.map((face) => [face.name, face] as const))(
    '%s records the line box prawn builds from the AFM, not the one the stand-in carries',
    (name, face) => {
      const afm = parseAfm(face.afm);
      const bbox = (afm.attributes['FontBBox'] as string).trim().split(/\s+/).map(Number);
      // `afm.rb:75-77`. `to_i` on an attribute the AFM does not declare is zero, which is what Symbol
      // and ZapfDingbats get for both.
      const ascender = Number.parseInt(afm.attributes['Ascender'] ?? '0', 10) || 0;
      const descender = Number.parseInt(afm.attributes['Descender'] ?? '0', 10) || 0;

      expect(face.metrics).toStrictEqual({
        unitsPerEm: 1000,
        ascender,
        descender,
        lineGap: bbox[3] - bbox[1] - (ascender - descender),
        // `rendered_width_of_char 'x'` goes through prawn's WinAnsi glyph table for every AFM font
        // (`afm.rb:224-227`), including the symbolic pair — whose metrics hold no glyph called `x`,
        // so the renderer measures nothing and the manifest records nothing.
        //
        // A zero is the same answer as an absence and is recorded the same way, which is the
        // generator's rule (`gutterAdvance`) and the preview's (`faceBox` in `font-metrics.ts`, which
        // drops a non-positive `xAdvance`). A gem shipping a zero-width `x` would otherwise be a face
        // the generator correctly recorded nothing for and this expected a zero from.
        ...(gutterWidth(afm) === undefined ? {} : { xAdvance: gutterWidth(afm) }),
      });
      expect(SYMBOLIC.has(name)).toBe(afm.attributes['CharacterSet'] === 'Special');
    },
  );

  it('gives Symbol and ZapfDingbats a line that is all gap', () => {
    // Stated on its own because it is the trap the whole arrangement exists around: prawn reads zero
    // for both ends of these two, so any code that assumes an AFM face has a non-zero ascender places
    // them wrongly. 1.303em and 0.963em are the heights the export sets their lines at.
    const symbol = manifest.faces.find((face) => face.name === 'Symbol') as ManifestFace;
    const dingbats = manifest.faces.find((face) => face.name === 'ZapfDingbats') as ManifestFace;
    expect(symbol.metrics).toStrictEqual({
      unitsPerEm: 1000,
      ascender: 0,
      descender: 0,
      lineGap: 1303,
    });
    expect(dingbats.metrics).toStrictEqual({
      unitsPerEm: 1000,
      ascender: 0,
      descender: 0,
      lineGap: 963,
    });
  });

  it.each(manifest.faces.map((face) => [face.name, face] as const))(
    '%s was measured against the width table the AFM and prawn’s encoding produce',
    (name, face) => {
      const table = encodedWidths(parseAfm(face.afm), SYMBOLIC.has(name));
      const canonical = [...table.entries()].map(
        ([code, entry]) => `${code} ${entry.glyph} ${entry.width}`,
      );
      expect(table.size).toBe(face.encodedBytes);
      expect(`sha256-${createHash('sha256').update(canonical.join('\n')).digest('hex')}`).toBe(
        face.widthsHash,
      );
    },
  );

  it.each(manifest.faces.map((face) => [face.name, face] as const))(
    '%s survives the WOFF2 round trip advancing exactly as the export does',
    (name, face) => {
      const font = measure(decodeFace(face.file));
      expect(font.unitsPerEm).toBe(face.metrics.unitsPerEm);

      const table = encodedWidths(parseAfm(face.afm), SYMBOLIC.has(name));
      const divergences = new Map(MEASURED_DIVERGENCES[name].map((entry) => [entry.code, entry]));
      const unmet = new Set(divergences.keys());

      for (const [code, entry] of table) {
        const character = WINDOWS_1252.decode(Uint8Array.of(code)).codePointAt(0) as number;
        const advance = font.advanceOf(character);
        const divergence = divergences.get(code);
        if (divergence === undefined) {
          expect({ code, glyph: entry.glyph, advance }).toStrictEqual({
            code,
            glyph: entry.glyph,
            advance: entry.width,
          });
          continue;
        }
        // A recorded divergence is an assertion in its own right: the face must be exactly as far out
        // as the manifest says, in exactly that direction. A stand-in that drifted back towards the
        // AFM would fail here just as loudly as one that drifted away.
        unmet.delete(code);
        expect({ glyph: entry.glyph, afm: entry.width, substitute: advance ?? null }).toStrictEqual({
          glyph: divergence.glyph,
          afm: divergence.afm,
          substitute: divergence.substitute,
        });
      }
      // No stale entries: a divergence for a byte the face does not encode would be a claim about
      // nothing, and would quietly excuse a real mismatch if the tables ever moved.
      expect([...unmet]).toStrictEqual([]);
    },
  );

  it.each([
    ['Symbol', 'symbol.woff2', 7],
    ['ZapfDingbats', 'zapfdingbats.woff2', 2],
  ] as const)(
    '%s states each glyph’s own left side bearing rather than a zero',
    (_name, file, originGlyphs) => {
      // The two symbolic faces are the only ones whose sfnt is built here rather than recompressed,
      // so they are the only ones whose `hmtx` could say something the outlines do not. Every bearing
      // used to be written as a zero — the claim that all 191 and all 203 glyphs begin exactly on
      // their origin, which is a claim about a face nobody has ever drawn. They are now each glyph's
      // own `xMin`, run out of its charstring by the wrapper.
      //
      // Checked here against the only two things the committed file can be held to on its own: a
      // bearing cannot lie outside the face's own bounding box, and only a glyph that draws nothing
      // or starts flush on its origin can be zero. There are seven such glyphs in Symbol and two in
      // ZapfDingbats, counted from the vendored outlines — which the source hash above pins. The
      // exact derivation is checked where it can be: the generator refuses to write these files at
      // all unless the bounds it computes reproduce the CFF's own declared `FontBBox`.
      const sfnt = decodeFace(file);
      const tables = new Map<string, number>();
      for (let index = 0; index < sfnt.readUInt16BE(4); index += 1) {
        const at = 12 + index * 16;
        tables.set(sfnt.toString('latin1', at, at + 4), sfnt.readUInt32BE(at + 8));
      }
      const head = tables.get('head') as number;
      const hmtx = tables.get('hmtx') as number;
      const metrics = sfnt.readUInt16BE((tables.get('hhea') as number) + 34);
      const xMin = sfnt.readInt16BE(head + 36);
      const xMax = sfnt.readInt16BE(head + 40);

      const bearings: number[] = [];
      for (let glyph = 0; glyph < metrics; glyph += 1) {
        bearings.push(sfnt.readInt16BE(hmtx + glyph * 4 + 2));
      }
      expect({
        outsideTheBox: bearings.filter((lsb) => lsb < xMin || lsb > xMax).length,
        onTheOrigin: bearings.filter((lsb) => lsb === 0).length,
      }).toStrictEqual({ outsideTheBox: 0, onTheOrigin: originGlyphs });
    },
  );

  it.each(manifest.faces.map((face) => [face.name, face] as const))(
    '%s records the divergences that were measured, and no others',
    (name, face) => {
      expect(face.divergences).toStrictEqual(MEASURED_DIVERGENCES[name]);
    },
  );

  it('is metric-compatible on all but two dozen of the three thousand bytes it covers', () => {
    // The headline number, stated once so that a change to it has to be made deliberately rather than
    // absorbed face by face. 3007 bytes across the fourteen; 24 of them divergent, none of them in a
    // symbolic face.
    const covered = manifest.faces.reduce((total, face) => total + face.encodedBytes, 0);
    const divergent = manifest.faces.reduce((total, face) => total + face.divergences.length, 0);
    expect([covered, divergent]).toStrictEqual([3007, 24]);
  });

  it('maps every family prawn resolves onto a face that is committed', () => {
    const names = new Set(manifest.faces.map((face) => face.name));
    for (const family of manifest.families) {
      expect(Object.keys(family.faces)).toStrictEqual([...STYLES]);
      for (const style of STYLES) expect(names.has(family.faces[style])).toBe(true);
    }
    expect(manifest.families.map((entry) => entry.family)).toStrictEqual([
      ...manifest.faces.map((face) => face.name),
    ]);
  });

  it('resolves every style of a name outside prawn’s family table to one face', () => {
    // `find_font` only consults the requested style for a name the family table holds
    // (`font.rb:238-242`), so the other eleven have no bold and no italic — a bold Symbol is Symbol.
    const composites = new Set(['Courier', 'Helvetica', 'Times-Roman']);
    for (const family of manifest.families) {
      const resolved = new Set(STYLES.map((style) => family.faces[style]));
      expect([family.family, resolved.size]).toStrictEqual([
        family.family,
        composites.has(family.family) ? 4 : 1,
      ]);
      if (!composites.has(family.family)) expect([...resolved]).toStrictEqual([family.family]);
    }
  });

  it('hands the browser exactly the manifest’s own answers, and none of the evidence', () => {
    // Two committed files stating the same metrics is a drift hazard, and this is what makes it not
    // one: the slice a browser imports has to be the manifest projected, field for field. It exists
    // because the evidence beside those fields — the hashes, the byte counts, the AFM names, the two
    // dozen divergences — is two thirds of the manifest and was being shipped to every reader of a
    // Print preview, which cannot use any of it.
    expect(browserSlice).toStrictEqual({
      faces: manifest.faces.map((face) => ({
        name: face.name,
        file: face.file,
        metrics: face.metrics,
      })),
      families: manifest.families,
    });
    // Named rather than derived, so that a field added to a face has to be admitted to the browser
    // deliberately rather than by a projection that widened on its own.
    for (const face of browserSlice.faces) {
      expect(Object.keys(face)).toStrictEqual(['name', 'file', 'metrics']);
    }
  });

  it('publishes the licences its sources require and keeps the metric evidence out of them', () => {
    expect(manifest.licences).toStrictEqual(['GUST-FONT-LICENSE.txt', 'LICENSE_FOXIT']);
    for (const file of [...manifest.licences, ...manifest.metricSources]) {
      expect(readFileSync(path.join(ASSETS, file)).length).toBeGreaterThan(0);
    }
    // Adobe's own terms require its notice to travel with the AFM files it covers, so it is listed
    // beside them rather than left to the directory to imply.
    expect(manifest.metricSources).toContain('MustRead.html');
    expect(manifest.metricSources).toContain('winansi.json');
    for (const face of manifest.faces) expect(manifest.metricSources).toContain(face.afm);
  });
});

/**
 * The layout tables, which are the one part of these files that is WRITTEN rather than repackaged.
 *
 * Everything above is about advances: a byte of a PDF content stream, the glyph it selects, and the
 * width the two sides give it. None of it can see a kern, because a kern is not in `hmtx` — and the
 * published faces carry a synthetic `GPOS` built here out of the AFM's `KPX` records precisely
 * BECAUSE the stand-in's own kerning disagrees with Adobe's. Until these existed, the words `GPOS`,
 * `GSUB` and `kern` appeared nowhere in this file: the table could have been structurally broken, or
 * absent, or the stand-in's own, and every check above would still have passed.
 *
 * The generator's `--check` is no substitute. It re-derives the bytes and compares them, so it pins
 * whatever the generator currently writes — a malformed `GPOS` included, forever and byte-exactly.
 * What is checked here is the other question: whether what it writes is the table it claims.
 */
describe('the kerning the stand-ins were given', () => {
  it.each(manifest.faces.map((face) => [face.name, face] as const))(
    '%s lists its tables in tag order and ships no GSUB',
    (_name, face) => {
      const tags = [...tableRecords(decodeFace(face.file)).keys()];
      // Sorted by tag, which the OpenType specification requires of the directory and which a reader
      // that binary-searches it depends on. Compared against the file's own list sorted, so a face
      // that gained a table is covered without this naming one.
      expect(tags).toStrictEqual([...tags].toSorted());
      // No `GSUB`, in any face. Prawn maps a byte to a glyph and looks its width up; there is no
      // substitution step anywhere in it, so a browser that ligated `fi` would set a word the export
      // sets wider. The stand-ins' own `GSUB` is dropped by the generator and none is written back.
      expect(tags).not.toContain('GSUB');
    },
  );

  it('carries a GPOS in exactly the faces whose AFM has kern pairs, and in no others', () => {
    // The four Courier faces are the case that makes this worth stating: a monospaced typeface kerns
    // nothing, their AFMs hold no `KPX` record at all, and the generator writes no `GPOS` rather than
    // an empty one — a `PairPos` covering no glyph is a table a reader must still parse. The two
    // symbolic faces are built by a different path entirely and have no `KPX` either.
    const withGpos = manifest.faces
      .filter((face) => tableRecords(decodeFace(face.file)).has('GPOS'))
      .map((face) => face.name);
    expect(withGpos).toStrictEqual(KERNED_FACES.map((face) => face.name));
    expect(manifest.faces.filter((face) => parseAfm(face.afm).kernPairs.length === 0).map((f) => f.name))
      .toStrictEqual(['Courier', 'Courier-Bold', 'Courier-BoldOblique', 'Courier-Oblique', 'Symbol', 'ZapfDingbats']);
  });

  it.each(KERNED_FACES.map((face) => [face.name, face] as const))(
    '%s wires one DFLT script to one kern feature to one pair-adjustment lookup',
    (_name, face) => {
      const record = tableRecords(decodeFace(face.file)).get('GPOS') as TableRecord;
      const gpos = decodeGpos(decodeFace(face.file), record);

      expect(gpos.version).toStrictEqual([1, 0]);
      // One script, `DFLT`, whose DEFAULT language system is the one that carries the feature. A
      // browser shaping Latin text finds no `latn` script here and falls back to the default one, so
      // a table that put its feature in a named LangSys instead would kern nothing at all.
      expect(gpos.scripts).toStrictEqual([
        {
          tag: 'DFLT',
          langSysCount: 0,
          defaultLangSys: {
            lookupOrder: 0,
            // `0xFFFF` is the specification's "no required feature", which is what this must say: a
            // required feature index of 0 would name the kern feature as mandatory rather than
            // optional, and is the value a reader of an uninitialised field would find.
            requiredFeatureIndex: 0xFF_FF,
            featureIndices: [0],
          },
        },
      ]);
      expect(gpos.features).toStrictEqual([{ tag: 'kern', featureParams: 0, lookupIndices: [0] }]);
      // Lookup type 2 is pair adjustment. No flags, because none of the ones there are apply: nothing
      // here marks a glyph, and a right-to-left flag on a kern is a different table.
      expect(gpos.lookups).toStrictEqual([{ type: 2, flag: 0, subtables: [gpos.pairPos.at] }]);
    },
  );

  it.each(KERNED_FACES.map((face) => [face.name, face] as const))(
    '%s accounts for every byte of its GPOS from the header down',
    (_name, face) => {
      const record = tableRecords(decodeFace(face.file)).get('GPOS') as TableRecord;
      const gpos = decodeGpos(decodeFace(face.file), record);

      // The three lists sit end to end after a ten-byte header, and each one's start is where the
      // previous one's contents END — derived from those contents, not from the offset being checked.
      // An offset that named the wrong list, or a list written at the wrong length, moves one of these.
      expect(gpos.listOffsets.script).toBe(10);
      expect(gpos.listOffsets.feature).toBe(gpos.listEnds.script);
      expect(gpos.listOffsets.lookup).toBe(gpos.listEnds.feature);
      // And nothing is left over: the last byte the lookup list reaches is the last byte of the table
      // the directory declares. A table longer than its contents would carry unreachable bytes; one
      // shorter would have a reader walking past its end.
      expect(gpos.listEnds.lookup).toBe(gpos.length);
      // Every PairSet offset lands inside the subtable rather than merely being non-zero.
      for (const offset of gpos.pairPos.pairSetOffsets) {
        expect(offset).toBeGreaterThanOrEqual(10 + gpos.pairPos.pairSetCount * 2);
        expect(offset).toBeLessThan(gpos.pairPos.extent);
      }
      // The 16-bit-offset limit the generator guards against, observed as slack rather than assumed:
      // the largest subtable in the corpus is Helvetica's, at about a sixth of what can be addressed.
      expect(gpos.pairPos.extent).toBeLessThanOrEqual(0xFF_FF);
    },
  );

  it.each(KERNED_FACES.map((face) => [face.name, face] as const))(
    '%s states its pairs as a format-1 PairPos adjusting the first glyph only',
    (_name, face) => {
      const record = tableRecords(decodeFace(face.file)).get('GPOS') as TableRecord;
      const { pairPos } = decodeGpos(decodeFace(face.file), record);

      expect({
        format: pairPos.format,
        // `0x0004` is XAdvance and nothing else. Any other bit set means the value records are a
        // different SIZE, so every PairSet after the first would be read at the wrong stride — the
        // failure that produces plausible-looking kerns for the wrong glyph pairs.
        valueFormat1: pairPos.valueFormat1,
        // Nothing is adjusted on the second glyph, which is how prawn applies a KPX record: the
        // offset goes between the two, spent on the advance of the first.
        valueFormat2: pairPos.valueFormat2,
        coverageFormat: pairPos.coverage.format,
      }).toStrictEqual({ format: 1, valueFormat1: 0x00_04, valueFormat2: 0, coverageFormat: 1 });
      // One PairSet per covered glyph, in the same order: the coverage index IS the PairSet index.
      expect(pairPos.pairSetCount).toBe(pairPos.coverage.glyphs.length);
      expect(pairPos.pairSetCount).toBe(pairPos.pairSetOffsets.length);
    },
  );

  it.each(KERNED_FACES.map((face) => [face.name, face] as const))(
    '%s orders its coverage and its pair sets the way a binary search needs',
    (_name, face) => {
      const record = tableRecords(decodeFace(face.file)).get('GPOS') as TableRecord;
      const { pairPos } = decodeGpos(decodeFace(face.file), record);

      // Both orders are load-bearing rather than tidy. A reader looks a glyph up in the coverage and
      // its neighbour up in the PairSet by binary search, so an unsorted list does not fail — it
      // silently MISSES kerns, which is the shape of defect no rendering test would name.
      expect(pairPos.coverage.glyphs).toStrictEqual([...pairPos.coverage.glyphs].toSorted((a, b) => a - b));
      expect(new Set(pairPos.coverage.glyphs).size).toBe(pairPos.coverage.glyphs.length);

      const seconds = new Map<number, number[]>();
      for (const [first, second] of pairPos.pairs) {
        const list = seconds.get(first);
        if (list === undefined) seconds.set(first, [second]);
        else list.push(second);
      }
      const unsorted = [...seconds.entries()].filter(
        ([, list]) => list.some((value, index) => index > 0 && list[index - 1] >= value),
      );
      expect(unsorted).toStrictEqual([]);
    },
  );

  it.each(KERNED_FACES.map((face) => [face.name, face] as const))(
    '%s kerns exactly the pairs the AFM states, at exactly the AFM’s own adjustments',
    (_name, face) => {
      const record = tableRecords(decodeFace(face.file)).get('GPOS') as TableRecord;
      const { pairPos } = decodeGpos(decodeFace(face.file), record);
      const expected = expectedKerning(face);

      // Compared as sorted lists of the three numbers rather than as sets, so a duplicated pair is a
      // difference: a PairSet listing the same second glyph twice is undefined behaviour, and a
      // comparison through a `Set` would call it equal to the same table without the duplicate.
      expect(pairPos.pairs.length).toBe(expected.pairs.length);
      expect(canonicalPairs(pairPos.pairs)).toStrictEqual(canonicalPairs(expected.pairs));
      // The self-reported count in the manifest, against the derivation rather than against itself.
      expect(face.kerning?.pairs).toBe(expected.pairs.length);
    },
  );

  it.each(manifest.faces.map((face) => [face.name, face] as const))(
    '%s records the KPX records it could not carry, and they name the glyphs it cannot draw',
    (name, face) => {
      const derived = SYMBOLIC.has(name) ? { unmapped: {} } : expectedKerning(face);
      // The names AND their counts, against a table nothing regenerates — the manifest carries only a
      // total, so a stand-in that lost one glyph and gained another could keep the total exactly.
      expect(derived.unmapped).toStrictEqual(UNMAPPED_KERN_GLYPHS[name]);
      const total = Object.values(UNMAPPED_KERN_GLYPHS[name]).reduce((sum, count) => sum + count, 0);
      // The symbolic pair go through a different conversion and record no kerning at all, which is a
      // different fact from recording zero.
      expect(face.kerning).toStrictEqual(
        SYMBOLIC.has(name) ? undefined : { pairs: expectedKerning(face).pairs.length, unmapped: total },
      );
    },
  );

  it('drops the same four glyph names across the whole corpus, and no fifth', () => {
    // The headline, stated once so a change to it is deliberate. `Tcommaaccent` dominates because the
    // Adobe metrics kern it against most of the lower case; the other three are a handful each.
    const across = new Map<string, number>();
    for (const face of manifest.faces) {
      for (const [glyph, count] of Object.entries(UNMAPPED_KERN_GLYPHS[face.name])) {
        across.set(glyph, (across.get(glyph) ?? 0) + count);
      }
    }
    expect([...across.entries()].toSorted()).toStrictEqual([
      ['Scommaaccent', 4],
      ['Tcommaaccent', 783],
      ['scommaaccent', 30],
      ['tcommaaccent', 21],
    ]);
  });

  it('refuses, by name, to write a subtable its own offsets could not address', () => {
    // The generator's one unreachable-in-practice guard, exercised on a pair list no font has: the
    // largest committed subtable is Helvetica's 11 KB of the 64 KB a 16-bit offset can reach, so
    // nothing in the corpus comes near it and only a synthetic input can.
    //
    // It is checked because it was BROKEN and could not be seen: the check sat after the loop that
    // writes the PairSet offsets, and `Buffer.writeUInt16BE` refuses a value above 65535 itself — so
    // the first offset past the limit threw Node's `ERR_OUT_OF_RANGE`, naming a buffer and no face,
    // and the sentence below could never be produced. Spawned rather than imported because the
    // builder is an ES module and this suite is CommonJS.
    const probe = `
      import { gposKerning } from ${JSON.stringify(pathToFileURL(GPOS_BUILDER).href)};
      const pairs = [];
      for (let first = 0; first < 7000; first += 1) pairs.push([first, 1, -10]);
      try {
        gposKerning(pairs);
        console.log('NO ERROR');
      } catch (error) {
        console.log(error.message);
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      'A PairPos subtable of 70014 bytes cannot be addressed by 16-bit offsets.',
    );
  });
});
