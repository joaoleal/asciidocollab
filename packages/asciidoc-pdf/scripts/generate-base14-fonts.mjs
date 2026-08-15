#!/usr/bin/env node
/**
 * Convert metric-compatible stand-ins for the PDF base-14 core fonts to WOFF2, so a browser can draw
 * the one family of pages it otherwise could not draw at all.
 *
 * ## Why these fourteen are a different problem from the gem's own faces
 *
 * `generate-catalogue-fonts.mjs` beside this one has a font FILE to convert: the gem ships Noto Serif
 * and M+ 1mn, and the preview is handed the very bytes the renderer embeds. The base fourteen —
 * Helvetica, Times-Roman and Courier in four faces each, plus Symbol and ZapfDingbats — have no file
 * anywhere. Prawn carries only their AFM METRICS (`prawn-2.4.0/data/fonts/*.afm`) and embeds nothing:
 * `Prawn::Fonts::AFM#register` writes a font dictionary of `Type`, `Subtype` and `BaseFont` and no
 * font program at all (`afm.rb:157-167`), because a PDF viewer is required to supply these fourteen
 * itself. So the export's own appearance is not reproducible by copying a file; there is no file.
 *
 * What IS reproducible is the measurement. Every one of the fourteen has an exact published metric
 * set, and typefaces exist that were drawn to it. This script packages those.
 *
 * ## Which stand-ins, and what was measured
 *
 * The twelve text faces are TeX Gyre (GUST Font License) — Heros for Helvetica, Termes for Times,
 * Cursor for Courier — all at 1000 units per em, the AFM's own unit, so no scaling remainder enters.
 * Symbol and ZapfDingbats are pdf.js's FoxitSymbol and FoxitDingbats (BSD-3-Clause, PDFium Authors).
 * Those two are bare CFF font programs, so their `hmtx` is written here from the AFM — and their own
 * charstrings, which nothing here reads, independently carry the same width for all 190 and all 202
 * glyphs, which is why they were chosen over a stand-in that would have had to be re-metricked.
 *
 * The comparison this script re-runs on every generation is the operative one: for every byte a PDF
 * content stream can carry, the advance the stand-in gives the character that byte decodes to, against
 * the advance the AFM gives the glyph that byte selects. 2592 of 2616 comparisons across the twelve
 * text faces are exact, and 391 of 391 across the two symbolic ones. The two dozen that are not are
 * recorded per face in the manifest as `divergences`, with both numbers, rather than rounded away —
 * they are the honest edge of the claim and a reviewer should be able to see them.
 *
 * Rejected: URW's base-35 is a perfect match and is AGPL-3, whose font exception covers embedding a
 * face in a document and not serving the file itself. Liberation and Croscore are metric-compatible
 * with Arial and Times New Roman, which are not these.
 *
 * ## The vertical metrics are the AFM's, not the stand-in's
 *
 * This is the trap the whole file is arranged around. Prawn does NOT read an AFM font's line box from
 * any sfnt table — there is no sfnt. `afm.rb:75-77` is `@ascender = attributes['ascender'].to_i`,
 * `@descender = attributes['descender'].to_i`, `@line_gap = (bbox[3] - bbox[1]) - (ascender -
 * descender)`. Recording what TeX Gyre Heros' own `hhea` says would set every line on the page at the
 * wrong pitch, because that is not the number the export advances a baseline by. So the manifest
 * carries prawn's three, computed here from the AFM by prawn's own formula.
 *
 * Symbol and ZapfDingbats declare no `Ascender` and no `Descender` at all, so `to_i` reads 0 for both
 * and the WHOLE of the line is line gap — 1.303em for Symbol, 0.963em for ZapfDingbats. Any code that
 * assumes an AFM face has a non-zero ascender places those two wrongly; the manifest states the zeros.
 *
 * ## Which family names the preview registers them under
 *
 * Prawn's, read out of prawn rather than guessed. `Prawn::Document#font_families` (`font.rb:171-194`)
 * declares exactly three composite families, each mapping four styles onto four of the fourteen
 * names; `Prawn::Fonts::AFM::BUILT_INS` (`afm.rb:22-27`) lists all fourteen, and `find_font`
 * (`font.rb:237-243`) looks a name up in the family table FIRST and otherwise passes it straight to
 * the font, style and all. So `font-family: Helvetica-Oblique` is a legal thing for a theme to say,
 * and its bold is Helvetica-Oblique again — the requested style is discarded, not synthesised. Symbol
 * and ZapfDingbats resolve the same way: there is no bold Symbol, only Symbol.
 *
 * That is why the manifest's `families` maps all four styles of the eleven non-composite names onto
 * one face. A preview that registered only `normal` for them would have the browser synthesise a
 * slant or a weight the page does not have.
 *
 * ## What is committed
 *
 * Fourteen WOFF2 faces, the fourteen AFMs the metrics were taken from with Adobe's own notice beside
 * them, both stand-in licences, and a manifest recording per face a content hash, a hash of the file
 * it was converted from, a hash of the width table it was checked against, the divergences and the
 * metrics above. The stand-ins' own source files are committed separately, under `vendor/base14/`,
 * because neither an OS font package nor a transitive dependency of another workspace is reproducible
 * at build time — and nothing here fetches anything, at build time or run time.
 *
 * Beside the manifest, {@link BROWSER_SLICE}: the four fields of it a browser reads, and nothing
 * else. See its own comment for why that is a second file rather than a smaller first one.
 *
 * Run `pnpm --filter @asciidocollab/asciidoc-pdf generate:base14-fonts`. The output is generated —
 * never hand-edit it. It is built into a staging directory and swapped in only once all fourteen
 * converted, so an input this cannot read leaves the committed faces untouched rather than destroyed.
 *
 * `--check` regenerates into a temporary directory and compares, changing nothing. That is what CI
 * runs, in the one job that has the gem: the AFMs are read live from prawn, so a gem bump that moved
 * a metric shows up here as a byte difference rather than as a page that quietly sets lines wrong.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { woff2 } from 'fonteditor-core';
import { buildSfnt, glyphNamesOf } from './sfnt-from-cff.mjs';
import { gposKerning } from './gpos-kerning.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const GEM_ROOT = join(PACKAGE_ROOT, 'ruby/.wasm-build/vendor/bundle/ruby/3.3.0/gems');
const VENDOR_DIR = join(PACKAGE_ROOT, 'vendor/base14');
const OUTPUT_DIR = join(PACKAGE_ROOT, 'assets/base14-fonts');

/** Adobe's notice, which its own terms require to travel with the AFM files it covers. */
const AFM_NOTICE = 'MustRead.html';

/**
 * Prawn's WinAnsi table, committed beside the AFMs.
 *
 * The metrics alone do not say which glyph a byte selects — the AFMs' own `C` codes are Standard
 * Encoding, which is a different table again — so a check that the committed faces really carry the
 * export's advances needs prawn's mapping as well as prawn's widths. Copied out of the gem for the
 * same reason the AFMs are: it makes the package's own tests answerable on a clean checkout, while
 * `--check` keeps the copy honest wherever the gem is present.
 */
const WIN_ANSI_TABLE = 'winansi.json';

/** The licences of the stand-ins, carried from `vendor/base14` to the published assets. */
const LICENCES = ['GUST-FONT-LICENSE.txt', 'LICENSE_FOXIT'];

/**
 * The part of the manifest a browser reads, written as a file of its own.
 *
 * The manifest is two things at once, and only one of them is for a browser. The preview needs each
 * face's `name`, `file` and `metrics`, and the `families` table — about 4 KB minified. The rest is
 * EVIDENCE: the content hashes, the source hash, the byte counts, the width-table hash, the AFM the
 * widths came from, the two dozen divergences with both numbers each, the prawn version. That is what
 * makes the claim auditable and it is what `--check` and `tests/fonts` read; it is also two thirds of
 * a 15 KB JSON file, and every byte of it was reaching every user's browser, because the application
 * imports the manifest as a module and a bundler cannot drop fields from inside an array of objects.
 *
 * Two files rather than one trimmed one, and rather than a build-time transform. Trimming would throw
 * the evidence away, which is the whole point of recording it. A transform in the application's build
 * would put the decision about what a font manifest contains inside a webpack configuration, a long
 * way from the generator that decides everything else about it, and would be verified only by
 * building the application. Two committed files are verified the way everything else here is: this
 * writes both, `--check` byte-compares both, and `tests/fonts` re-derives this one from the manifest,
 * so they cannot drift without something going red.
 */
const BROWSER_SLICE = 'browser.json';

/**
 * Which file stands in for which of the fourteen.
 *
 * A `.cff` extension where pdf.js writes `.pfb`: those two files are not Type 1 despite the name.
 * Their first four bytes are `01 00 04 02`, a CFF header, and their Name INDEX reads
 * `ChromSymbolOTF` and `ChromDingbatsOTF`. The extension is corrected where the file is vendored so
 * that what it is, is what it is called; {@link convertSymbolic} wraps them in an sfnt.
 */
const SUBSTITUTES = {
  Helvetica: 'texgyreheros-regular.otf',
  'Helvetica-Bold': 'texgyreheros-bold.otf',
  'Helvetica-Oblique': 'texgyreheros-italic.otf',
  'Helvetica-BoldOblique': 'texgyreheros-bolditalic.otf',
  'Times-Roman': 'texgyretermes-regular.otf',
  'Times-Bold': 'texgyretermes-bold.otf',
  'Times-Italic': 'texgyretermes-italic.otf',
  'Times-BoldItalic': 'texgyretermes-bolditalic.otf',
  Courier: 'texgyrecursor-regular.otf',
  'Courier-Bold': 'texgyrecursor-bold.otf',
  'Courier-Oblique': 'texgyrecursor-italic.otf',
  'Courier-BoldOblique': 'texgyrecursor-bolditalic.otf',
  Symbol: 'FoxitSymbol.cff',
  ZapfDingbats: 'FoxitDingbats.cff',
};

/** The two faces prawn marks `CharacterSet Special`, whose text is encoded by the font's own table. */
const SYMBOLIC = new Set(['Symbol', 'ZapfDingbats']);

/**
 * Every AFM width is stated in a 1000-unit em; the format has no other option.
 *
 * Asserted against each stand-in rather than assumed of it, because it is what lets a width in the
 * AFM and an advance in the font file be compared as plain integers.
 */
const AFM_UNITS_PER_EM = 1000;

/** The code point whose advance the renderer measures a list's marker gutter with. */
const GUTTER_CODE = 0x00_78;

const require = createRequire(import.meta.url);

/**
 * Decode one byte of a PDF content stream the way prawn encodes one.
 *
 * `Prawn::Fonts::AFM#normalize_encoding` is `text.encode('windows-1252')` (`afm.rb:111-121`), so a byte
 * in the stream and a character in the browser meet through that codec and no other. It is not
 * Latin-1: byte 0x80 is the euro sign and 0x92 a right single quote.
 */
const WINDOWS_1252 = new TextDecoder('windows-1252');

/**
 * Locate the WOFF2 codec's wasm inside `fonteditor-core`.
 *
 * Its `exports` map forbids resolving a package.json subpath, so the asset is found by walking up
 * from the resolved entry point — the same approach `generate-catalogue-fonts.mjs` uses.
 *
 * @returns The absolute path of `woff2.wasm`.
 */
function locateWoff2Wasm() {
  let directory = dirname(require.resolve('fonteditor-core'));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(directory, 'woff2/woff2.wasm');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Could not locate fonteditor-core/woff2/woff2.wasm — is the dependency installed?');
}

/**
 * The vendored prawn gem: where it is, and which version it is.
 *
 * Prawn rather than Asciidoctor-PDF, because prawn is what owns both halves of this — the AFM files
 * and the family table the preview registers them under.
 *
 * @returns The gem's directory and version string.
 */
function locatePrawn() {
  if (!existsSync(GEM_ROOT)) {
    throw new Error(
      `The gems are not vendored at ${GEM_ROOT}. Build the wasm engine first ` +
        '(pnpm --filter @asciidocollab/asciidoc-pdf build:wasm).',
    );
  }
  const gems = readdirSync(GEM_ROOT).filter((name) => /^prawn-\d/.test(name));
  if (gems.length !== 1) {
    throw new Error(`Expected exactly one prawn gem under ${GEM_ROOT}, found ${gems.length}.`);
  }
  return { directory: join(GEM_ROOT, gems[0]), version: gems[0].replace('prawn-', '') };
}

/**
 * Prawn's WinAnsi table: the glyph each byte of an ordinary AFM string selects.
 *
 * Read out of `Prawn::Encoding::WinAnsi::CHARACTERS` rather than out of the PDF specification's own
 * WinAnsiEncoding, because what is being reproduced is what the renderer DOES. The two differ: at
 * 0x9F the specification says `Ydieresis` and prawn's table says `ydieresis`. See
 * {@link faceDivergences} for what that costs and why it is left alone.
 *
 * @param prawnDirectory - The gem's root.
 * @returns 256 glyph names, indexed by byte.
 */
function readWinAnsi(prawnDirectory) {
  const text = readFileSync(join(prawnDirectory, 'lib/prawn/encoding.rb'), 'utf8');
  const block = /class WinAnsi[^\n]*\n\s*CHARACTERS = %w\[([\s\S]*?)]\.freeze/.exec(text);
  if (block === null) throw new Error("Prawn's WinAnsi CHARACTERS table could not be read.");
  const names = block[1].split(/\s+/).filter((name) => name !== '');
  if (names.length !== 256) {
    throw new Error(`Prawn's WinAnsi table has ${names.length} entries, not 256.`);
  }
  return names;
}

/**
 * The fourteen names prawn will load an AFM for, and the three families that map styles onto them.
 *
 * Both read out of the gem. A hard-coded copy of either would be a second statement of something
 * prawn already says, and the failure it invites is silent: a family this preview registers but the
 * renderer does not resolve draws the page in a face the export never used.
 *
 * @param prawnDirectory - The gem's root.
 * @returns The built-in font names, and family name → style → built-in name for the three composites.
 */
function readFamilyTable(prawnDirectory) {
  const afm = readFileSync(join(prawnDirectory, 'lib/prawn/fonts/afm.rb'), 'utf8');
  const builtInBlock = /BUILT_INS = %w\[([\s\S]*?)]\.freeze/.exec(afm);
  if (builtInBlock === null) throw new Error("Prawn's BUILT_INS list could not be read.");
  const builtIns = builtInBlock[1].split(/\s+/).filter((name) => name !== '');

  const font = readFileSync(prawnDirectory + '/lib/prawn/font.rb', 'utf8');
  const familiesBlock = /def font_families\n([\s\S]*?)\n {4}end\n/.exec(font);
  if (familiesBlock === null) throw new Error("Prawn's font_families table could not be read.");
  const composites = new Map();
  for (const entry of familiesBlock[1].matchAll(/'([^']+)' => \{([^}]*)\}/g)) {
    const styles = {};
    for (const style of entry[2].matchAll(/(\w+): '([^']+)'/g)) styles[style[1]] = style[2];
    composites.set(entry[1], styles);
  }

  if (builtIns.length !== 14 || composites.size !== 3) {
    throw new Error(
      `Prawn declares ${builtIns.length} built-in fonts and ${composites.size} families; ` +
        'the base-14 set is 14 and 3. Has the gem changed?',
    );
  }
  return { builtIns, composites };
}

/**
 * Parse one AFM, the way prawn parses it.
 *
 * Only the four things the renderer reads are taken: the generic attributes (which is where the
 * ascender, the descender and the font bounding box live), the width of each named glyph, the kern
 * pairs `compute_width_of` adds to a run's advance (`afm.rb:87-97`), and — for the symbolic pair —
 * which code the font's own encoding puts each glyph at. `parse_afm` (`afm.rb:183-241`) reads more;
 * nothing else here needs it.
 *
 * @param path - The AFM file.
 * @returns Attributes by lower-cased key, widths by glyph name, kern pairs, and glyph name by code.
 */
function parseAfm(path) {
  // Latin-1: an AFM is a 7-bit document whose comments may carry a stray high byte, and no decoder
  // that can fail is worth introducing for a file whose content of interest is all ASCII.
  const text = readFileSync(path, 'latin1');
  const attributes = {};
  const widths = new Map();
  const codes = new Map();
  const kernPairs = [];
  const section = [];

  for (const line of text.split(/\r\n|[\n\r]/)) {
    const start = /^Start(\w+)/.exec(line);
    if (start !== null) {
      section.push(start[1]);
      continue;
    }
    if (/^End(\w+)/.test(line)) {
      section.pop();
      continue;
    }
    if (section.at(-1) === 'CharMetrics') {
      if (!/^CH?\s/.test(line)) continue;
      const name = /\bN\s+(\.?\w+)\s*;/.exec(line)?.[1];
      if (name === undefined) continue;
      widths.set(name, Number(/\bWX\s+(\d+)\s*;/.exec(line)?.[1] ?? 0));
      const code = Number(/^C\s+(-?\d+)\s*;/.exec(line)?.[1] ?? -1);
      if (code >= 0) codes.set(code, name);
      continue;
    }
    if (section.at(-1) === 'KernPairs') {
      // `KPX left right adjustment`, which is the only kern record prawn reads. `compute_width_of`
      // (`afm.rb:87-97`) subtracts the numbers `kern` (`afm.rb:261-283`) interleaves, and `kern`
      // emits `-k` for each pair it finds (`afm.rb:268`) — so the KPX adjustment, negative in nearly
      // every record, is ADDED to the run's advance. The table it looks the pair up in is keyed by
      // WinAnsi CODE rather than by glyph name (`afm.rb:234-237`), which is why a pair naming a glyph
      // prawn's encoding does not select can never be applied by the export at all.
      const pair = /^KPX\s+(\S+)\s+(\S+)\s+(-?\d+)/.exec(line);
      if (pair !== null) kernPairs.push([pair[1], pair[2], Number(pair[3])]);
      continue;
    }
    // Kerning and composite sections carry no attribute lines; skipping them keeps a `KPX` pair from
    // being mistaken for one.
    if (section.length > 1) continue;
    const attribute = /^(\w+)\s+(.*)/.exec(line);
    if (attribute !== null) attributes[attribute[1].toLowerCase()] = attribute[2];
  }

  if (widths.size === 0 || attributes.fontbbox === undefined) {
    throw new Error(`${path} could not be read as an AFM.`);
  }
  return { attributes, widths, codes, kernPairs };
}

/**
 * The line box prawn builds out of one AFM, in the AFM's own 1000-unit em.
 *
 * `afm.rb:75-77`, unchanged: the ascender and the descender are whatever the attributes say, read
 * through `to_i` so an absent one is zero, and the line gap is whatever the bounding box has left
 * over. It is not the stand-in's `hhea`, and it is not the stand-in's `OS/2` — see the file header.
 *
 * @param afm - The parsed AFM.
 * @param name - The face name, for the message when the bounding box will not parse.
 * @returns The three metrics and the bounding box they came from.
 */
function prawnLineBox(afm, name) {
  const bbox = afm.attributes.fontbbox.trim().split(/\s+/).map(Number);
  if (bbox.length !== 4 || bbox.some((value) => !Number.isInteger(value))) {
    throw new Error(`${name} declares a FontBBox this cannot read: ${afm.attributes.fontbbox}`);
  }
  // `to_i` on a missing attribute is 0, which is exactly what Symbol and ZapfDingbats get.
  const ascender = Number.parseInt(afm.attributes.ascender ?? '0', 10) || 0;
  const descender = Number.parseInt(afm.attributes.descender ?? '0', 10) || 0;
  return { bbox, ascender, descender, lineGap: bbox[3] - bbox[1] - (ascender - descender) };
}

/**
 * Which glyph each byte of a string set in this face selects, and how wide the export makes it.
 *
 * The two halves of the base fourteen are encoded differently and the difference is prawn's own.
 * `AFM#register` writes `Encoding: WinAnsiEncoding` for an ordinary face and omits the key entirely
 * for one whose `CharacterSet` is `Special` (`afm.rb:157-167`), which leaves Symbol and ZapfDingbats
 * on the font's own built-in encoding. So a text face's byte 0x61 draws `a` and Symbol's draws
 * `alpha`, and each takes the width of the glyph it drew.
 *
 * @param afm - The parsed AFM.
 * @param winAnsi - Prawn's WinAnsi table.
 * @param symbolic - Whether this is one of the two special-character faces.
 * @returns Byte → the glyph it selects and the width the export gives it, sorted by byte.
 */
function encodedWidths(afm, winAnsi, symbolic) {
  const table = new Map();
  if (symbolic) {
    for (const code of [...afm.codes.keys()].toSorted((a, b) => a - b)) {
      const glyph = afm.codes.get(code);
      table.set(code, { glyph, width: afm.widths.get(glyph) ?? 0 });
    }
    return table;
  }
  for (let code = 0; code < 256; code += 1) {
    const glyph = winAnsi[code];
    if (glyph === '.notdef') continue;
    const width = afm.widths.get(glyph);
    if (width === undefined) continue;
    table.set(code, { glyph, width });
  }
  return table;
}

/**
 * A hash of the width table a face was checked against.
 *
 * Recorded because it is the claim that JOINS the two things the other hashes pin separately: the
 * `hash` field pins the WOFF2 bytes, the committed AFM copy pins the metrics, and this pins the
 * statement that the first was measured against the second. A hand-edited manifest is the failure
 * mode a hash exists for, and the width table is the field most worth editing by hand.
 *
 * @param table - Byte → glyph and width.
 * @returns The hash.
 */
function widthsHashOf(table) {
  const canonical = [...table.entries()].map(([code, entry]) => `${code} ${entry.glyph} ${entry.width}`);
  return `sha256-${createHash('sha256').update(canonical.join('\n')).digest('hex')}`;
}

/** The content hash a manifest entry records, so a hand-edited face is detectable. */
function hashOf(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * What a browser will measure a face by: `head`, `cmap` and `hmtx`, read straight out of the sfnt.
 *
 * Read here rather than through `fonteditor-core`'s font model, and that is not a preference. Its
 * OpenType/CFF reader reports each glyph's advance from the CHARSTRING, not from `hmtx` — measured by
 * writing an `hmtx` a unit wider than the charstrings and watching it report the charstrings — while
 * an OpenType consumer, browsers included, takes the advance from `hmtx`. A generator that measured
 * the table nobody reads could publish a face whose advances were all wrong and record that they were
 * all right.
 *
 * @param sfnt - A whole sfnt file.
 * @returns Its units per em, and the advance it gives a code point, or undefined for one it cannot draw.
 */
function sfntAdvances(sfnt) {
  const tables = new Map();
  for (let index = 0; index < sfnt.readUInt16BE(4); index += 1) {
    const at = 12 + index * 16;
    tables.set(sfnt.toString('latin1', at, at + 4), sfnt.readUInt32BE(at + 8));
  }
  const head = tables.get('head');
  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  const cmap = tables.get('cmap');
  if (head === undefined || hhea === undefined || hmtx === undefined || cmap === undefined) {
    throw new Error('The font is missing one of head, hhea, hmtx or cmap.');
  }
  const metricCount = sfnt.readUInt16BE(hhea + 34);

  // The Windows/Unicode-BMP subtable, which is the one a browser looks for first and the only one
  // every face here carries in common. Required rather than searched for and shrugged at: a face
  // whose advances could not be read is a face this script must not publish.
  let subtable;
  for (let index = 0; index < sfnt.readUInt16BE(cmap + 2); index += 1) {
    const record = cmap + 4 + index * 8;
    if (sfnt.readUInt16BE(record) === 3 && sfnt.readUInt16BE(record + 2) === 1) {
      subtable = cmap + sfnt.readUInt32BE(record + 4);
    }
  }
  if (subtable === undefined || sfnt.readUInt16BE(subtable) !== 4) {
    throw new Error('The font carries no Windows/Unicode format 4 character map.');
  }

  const segments = sfnt.readUInt16BE(subtable + 6) / 2;
  const ends = subtable + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;

  const glyphOf = (code) => {
    for (let segment = 0; segment < segments; segment += 1) {
      if (sfnt.readUInt16BE(ends + segment * 2) < code) continue;
      if (sfnt.readUInt16BE(starts + segment * 2) > code) return 0;
      const delta = sfnt.readUInt16BE(deltas + segment * 2);
      const range = sfnt.readUInt16BE(ranges + segment * 2);
      if (range === 0) return (code + delta) & 0xFF_FF;
      const glyph = sfnt.readUInt16BE(
        ranges + segment * 2 + range + (code - sfnt.readUInt16BE(starts + segment * 2)) * 2,
      );
      return glyph === 0 ? 0 : (glyph + delta) & 0xFF_FF;
    }
    return 0;
  };

  return {
    unitsPerEm: sfnt.readUInt16BE(head + 18),
    advanceOf(code) {
      const glyph = glyphOf(code);
      if (glyph === 0) return undefined;
      // Past the last full metric a face repeats the final advance, which is how a monospaced font
      // states one width for every glyph.
      return sfnt.readUInt16BE(hmtx + Math.min(glyph, metricCount - 1) * 4);
    },
  };
}

/**
 * Where the stand-in does not give a byte the advance the export gives it.
 *
 * There are two dozen across the twelve text faces and none across the two symbolic ones, and they
 * fall into three kinds, all recorded rather than corrected:
 *
 *  - **`trademark`, `exclamdown`, `questiondown`, `oslash`, `logicalnot`.** The stand-in's designer
 *    drew that glyph to a different width. This is the residue of substitution and there is nothing
 *    to do about it short of editing the outlines, which would make the file a derived work and the
 *    conversion no longer lossless.
 *  - **`ydieresis` at 0x9F.** WinAnsiEncoding puts CAPITAL Ydieresis there; prawn's table says the
 *    lower case one (`encoding.rb`, index 159). So the viewer draws capital Y-dieresis at the
 *    stand-in's 667 while prawn measured the lower-case 500 — the export's own page has the wide
 *    glyph and prawn's line breaking does not know it. The stand-in matches the PAGE, which is what
 *    the preview is of.
 *  - **The no-break space at 0xA0, in Times only.** WinAnsiEncoding maps it to `space`; TeX Gyre
 *    Termes gives `uni00A0` a glyph of its own, a third wider. The other eight text faces map it to
 *    the same glyph as the space and agree.
 *
 * @param table - Byte → glyph and the width the export gives it.
 * @param measured - The stand-in's own `cmap` and `hmtx`, as {@link sfntAdvances} reads them.
 * @returns One entry per byte where the two disagree, or where the stand-in has no glyph at all.
 */
function faceDivergences(table, measured) {
  const divergences = [];
  for (const [code, entry] of table) {
    const character = WINDOWS_1252.decode(Uint8Array.of(code)).codePointAt(0);
    const advance = measured.advanceOf(character);
    if (advance === entry.width) continue;
    divergences.push({
      code,
      glyph: entry.glyph,
      afm: entry.width,
      // Null rather than absent for a character the stand-in cannot draw at all: the browser then
      // falls back to another face for that one character, which is a different failure from a
      // width that is merely a few units out, and the manifest should not have to be read twice to
      // tell them apart.
      substitute: advance ?? null,
    });
  }
  return divergences;
}

/**
 * The tables of one sfnt, by tag.
 *
 * @param sfnt - A whole sfnt file.
 * @returns Tag → where the table is and how long it is.
 */
function tablesOf(sfnt) {
  const tables = new Map();
  for (let index = 0; index < sfnt.readUInt16BE(4); index += 1) {
    const at = 12 + index * 16;
    tables.set(sfnt.toString('latin1', at, at + 4), {
      offset: sfnt.readUInt32BE(at + 8),
      length: sfnt.readUInt32BE(at + 12),
    });
  }
  return tables;
}

/** An sfnt table checksum: the sum of its 32-bit words, zero-padded to a whole word. */
function tableChecksum(bytes) {
  const padded = Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
  let sum = 0;
  for (let at = 0; at < padded.length; at += 4) sum = (sum + padded.readUInt32BE(at)) >>> 0;
  return sum;
}

/** What `head.checkSumAdjustment` is subtracted from. */
const CHECKSUM_ADJUSTMENT_BASE = 0xB1_B0_AF_BA;

/**
 * Write an sfnt back out with some tables dropped and some added.
 *
 * Everything else crosses byte for byte: the tables are copied, not re-encoded, so the outlines, the
 * character map and the advance widths are the file's own. Only the directory is rebuilt — sorted by
 * tag as the specification requires, each table aligned to a word — and `head.checkSumAdjustment` is
 * recomputed, because it is a checksum of the whole file and the whole file has moved.
 *
 * @param source - The sfnt to rewrite.
 * @param drop - Tags to leave out.
 * @param add - Tag → bytes, for tables to put in.
 * @returns The rewritten sfnt.
 */
function rewriteSfnt(source, drop, add) {
  const entries = [];
  for (const [tag, table] of tablesOf(source)) {
    if (drop.has(tag)) continue;
    entries.push({ tag, data: source.subarray(table.offset, table.offset + table.length) });
  }
  for (const [tag, data] of Object.entries(add)) entries.push({ tag, data });
  entries.sort((left, right) => (left.tag < right.tag ? -1 : 1));

  const count = entries.length;
  const selector = Math.floor(Math.log2(count));
  const directory = Buffer.alloc(12 + count * 16);
  source.copy(directory, 0, 0, 4);
  directory.writeUInt16BE(count, 4);
  directory.writeUInt16BE(16 * 2 ** selector, 6);
  directory.writeUInt16BE(selector, 8);
  directory.writeUInt16BE(count * 16 - 16 * 2 ** selector, 10);

  const chunks = [directory];
  let offset = directory.length;
  entries.forEach((entry, index) => {
    const at = 12 + index * 16;
    directory.write(entry.tag, at, 4, 'latin1');
    directory.writeUInt32BE(tableChecksum(entry.data), at + 4);
    directory.writeUInt32BE(offset, at + 8);
    directory.writeUInt32BE(entry.data.length, at + 12);
    const padding = (4 - (entry.data.length % 4)) % 4;
    chunks.push(entry.data);
    if (padding > 0) chunks.push(Buffer.alloc(padding));
    offset += entry.data.length + padding;
  });

  const font = Buffer.concat(chunks);
  const headAt = font.readUInt32BE(12 + entries.findIndex((entry) => entry.tag === 'head') * 16 + 8);
  font.writeUInt32BE(0, headAt + 8);
  font.writeUInt32BE((CHECKSUM_ADJUSTMENT_BASE - tableChecksum(font)) >>> 0, headAt + 8);
  return font;
}

/**
 * Convert one of the twelve text faces: the OTF recompressed, with the AFM's own kerning in place of
 * the stand-in's own layout tables.
 *
 * WOFF2 carries PostScript outlines as well as TrueType ones, so the CFF table goes across whole and
 * every glyph, advance and character mapping in the published file is TeX Gyre's own — converting to
 * TrueType first would be a third smaller and would replace every cubic curve with a quadratic
 * approximation, which is the one thing that would make this a modified font rather than a
 * repackaged one.
 *
 * ## What is NOT carried across, and why the recompression stopped being lossless
 *
 * `GSUB` and the stand-in's own `GPOS`. Both describe things the export does not do, and a browser
 * doing them is a page whose lines are a different length from the PDF's:
 *
 *  - `Prawn::Fonts::AFM#compute_width_of` sums `@glyph_table[byte]` and then adds the KERN PAIRS from
 *    the AFM's own `StartKernPairs` section (`afm.rb:87-97`, over the table built at `afm.rb:234-237`
 *    and looked up by `kern` at `afm.rb:261-283`), and asciidoctor-pdf leaves kerning on
 *    — `default_kerning theme.base_font_kerning != 'none'` (`converter.rb:406`). TeX Gyre Termes'
 *    `GPOS` is a richer table than Adobe's KPX list and disagrees with it: measured on the base-14
 *    anchor, the browser set `words.` 26.59pt wide where the page sets it 26.84pt, and `Tables`
 *    2586/1000 em where the AFM says 2666 - 80. Turning kerning OFF is not the answer either — the
 *    AFM's own pairs are worth up to 3.3% of a word's width in this very document (`Term`, `Tables`),
 *    against a fidelity tolerance of 0.5%.
 *  - `GSUB` would ligate. Prawn maps a byte to a glyph and looks its width up; there is no
 *    substitution step anywhere in it, so `first` is `f i r s t` in the PDF and would have been the
 *    `fi` ligature in the preview — 1541/1000 em against the export's 1591.
 *
 * So the published face carries a `GPOS` built from the AFM's `KPX` records and no `GSUB`, and what
 * a browser measures with it is what prawn measures. The trade is stated rather than hidden: these
 * twelve are no longer a byte-for-byte repackaging of what GUST published, and the manifest records
 * per face how many pairs went in and how many the stand-in has no glyph for.
 *
 * @param source - The OTF's bytes.
 * @param afm - The parsed AFM, for its kern pairs.
 * @param name - The face name, for a failure message.
 * @returns The WOFF2 bytes, the sfnt they were made from, and what the kerning transcription cost.
 */
function convertText(source, afm, name) {
  const cff = tablesOf(source).get('CFF ');
  if (cff === undefined) throw new Error(`${name}: the stand-in carries no CFF table.`);
  const names = glyphNamesOf(source.subarray(cff.offset, cff.offset + cff.length));
  const glyphIds = new Map();
  // First wins: a name that appears twice in the charset is the same outline under an alias, and the
  // lower glyph id is the one the character map points at.
  names.forEach((glyph, id) => {
    if (!glyphIds.has(glyph)) glyphIds.set(glyph, id);
  });

  const pairs = [];
  let unmapped = 0;
  for (const [left, right, adjustment] of afm.kernPairs) {
    const first = glyphIds.get(left);
    const second = glyphIds.get(right);
    // A pair naming a glyph the stand-in does not draw kerns nothing, here or in the export. Across
    // the twelve text faces the unmapped pairs name FOUR glyphs between them — `Tcommaaccent` (783
    // pairs), `scommaaccent` (30), `tcommaaccent` (21) and `Scommaaccent` (4, in the two upright and
    // oblique Helveticas alone) — and prawn's WinAnsi table selects none of the four, so no byte of a
    // PDF content stream can put them next to anything. This comment said "three glyphs" and named
    // the first three until the counts were derived rather than recalled; `Scommaaccent` had been
    // there all along. Counted rather than ignored, because a count that stopped being about those
    // four is the signal that something moved — and `tests/fonts/base14-fonts.test.ts` now re-derives
    // the names AND their per-face counts from the AFM and the stand-in's own charset, so the count
    // recorded in the manifest is checked rather than merely reported.
    //
    // The criterion is the STAND-IN's charset and not prawn's encoding, and the two are far apart:
    // Times-Roman's AFM has 2073 KPX records, 1971 of which name two glyphs TeX Gyre Termes draws
    // (those are the ones emitted) while only 935 name two glyphs prawn's WinAnsi table can select.
    // The other 1036 are carried anyway. They are pairs the browser can apply and the export cannot,
    // but the text that would show the difference is text the export cannot set at all: an AFM font
    // encodes to windows-1252 or raises (`normalize_encoding`, `afm.rb:111-121`), so no content
    // stream reaches those glyphs. Dropping them would mean deciding here which of the AFM's own
    // records to transcribe, which is the derivation this whole table exists to avoid.
    if (first === undefined || second === undefined) {
      unmapped += 1;
      continue;
    }
    if (adjustment === 0) continue;
    pairs.push([first, second, adjustment]);
  }

  const rewritten = rewriteSfnt(
    source,
    new Set(['GPOS', 'GSUB']),
    pairs.length === 0 ? {} : { GPOS: gposKerning(pairs) },
  );
  const woff = Buffer.from(
    woff2.encode(rewritten.buffer.slice(rewritten.byteOffset, rewritten.byteOffset + rewritten.byteLength)),
  );
  return { woff, sfnt: rewritten, kerning: { pairs: pairs.length, unmapped } };
}

/**
 * One integer attribute an AFM must declare, or a failure naming the face that does not.
 *
 * Distinct from the `to_i`-shaped reads above, which are prawn's own and whose zero for an absent
 * attribute is the renderer's answer. Nothing reads these two through prawn — they go into the sfnt —
 * so an absent one is not a zero, it is an AFM this script cannot wrap.
 *
 * @param afm - The parsed AFM.
 * @param key - The attribute's lower-cased name.
 * @param name - The face name, for the message.
 * @returns The attribute as an integer.
 */
function requiredMetric(afm, key, name) {
  const value = Number.parseInt(afm.attributes[key] ?? '', 10);
  if (!Number.isInteger(value)) throw new Error(`${name}: the AFM declares no ${key}.`);
  return value;
}

/**
 * Convert one of the two symbolic faces: a bare CFF, wrapped in an sfnt and then recompressed.
 *
 * The wrapper's own reasoning is in `sfnt-from-cff.mjs`. What is decided HERE is what goes into it:
 * the advance of every glyph, taken from the AFM by the name the CFF's charset gives that glyph, and
 * a character map built from the font's built-in encoding — byte 0x61 to `alpha`, through the same
 * Windows-1252 decode the renderer's own string encoding is the inverse of.
 *
 * @param source - The bare CFF's bytes.
 * @param afm - The parsed AFM.
 * @param lineBox - Prawn's line box for this face, whose bounding box the sfnt's vertical metrics come from.
 * @param name - The built-in font name, for messages.
 * @returns The WOFF2 bytes and the wrapped sfnt, for measuring.
 */
function convertSymbolic(source, afm, lineBox, name) {
  const names = glyphNamesOf(source);
  const glyphIds = new Map(names.map((glyph, id) => [glyph, id]));
  const missing = names.filter((glyph) => glyph !== '.notdef' && !afm.widths.has(glyph));
  if (missing.length > 0) {
    throw new Error(`${name}: the stand-in has glyphs the AFM does not name: ${missing.join(', ')}`);
  }

  const advances = names.map((glyph) => afm.widths.get(glyph) ?? 0);
  const cmap = new Map();
  for (const [code, glyph] of afm.codes) {
    const glyphId = glyphIds.get(glyph);
    if (glyphId === undefined) {
      throw new Error(`${name}: the AFM encodes ${glyph} at ${code}, and the stand-in has no such glyph.`);
    }
    cmap.set(WINDOWS_1252.decode(Uint8Array.of(code)).codePointAt(0), glyphId);
  }

  const sfnt = buildSfnt({
    cff: source,
    postScriptName: name,
    unitsPerEm: AFM_UNITS_PER_EM,
    advances,
    cmap,
    bbox: lineBox.bbox,
    ascender: lineBox.bbox[3],
    descender: lineBox.bbox[1],
    // Required rather than defaulted: an AFM that stated neither would leave the wrapper writing an
    // underline of zero thickness through the baseline, which is what it did before these were passed.
    underlinePosition: requiredMetric(afm, 'underlineposition', name),
    underlineThickness: requiredMetric(afm, 'underlinethickness', name),
  });
  const woff = Buffer.from(woff2.encode(sfnt.buffer.slice(sfnt.byteOffset, sfnt.byteOffset + sfnt.byteLength)));
  return { woff, sfnt };
}

/** A stable, lower-kebab file name for one of the fourteen. */
function outputName(builtIn) {
  return `${builtIn.toLowerCase().replaceAll(/[^a-z\d]+/g, '-')}.woff2`;
}

/** The four style keys prawn's family table uses, in the order a manifest entry lists them. */
const STYLES = ['normal', 'bold', 'italic', 'bold_italic'];

/**
 * Every style of one family maps onto the same face, unless prawn's own table says otherwise.
 *
 * Written out in {@link STYLES} order rather than in the order the gem's source happens to list them,
 * so a reformat of prawn's own file cannot reorder the manifest.
 *
 * @param builtIn - One of the fourteen names.
 * @param composites - Prawn's three composite families.
 * @returns Style key → built-in name.
 */
function familyStyles(builtIn, composites) {
  // `find_font` never reaches the style for a name the family table does not hold (`font.rb:238-242`),
  // so all four requests resolve to that one face — including a bold or italic Symbol, which is
  // simply Symbol.
  const composite = composites.get(builtIn);
  return Object.fromEntries(STYLES.map((style) => [style, composite?.[style] ?? builtIn]));
}

/**
 * The advance the renderer measures a list's marker gutter with, or undefined when it measures none.
 *
 * `rendered_width_of_char 'x'` (`converter.rb:1712`) reaches `AFM#compute_width_of`, which sums
 * `@glyph_table[byte]` — and prawn builds that table by looking each byte's WINANSI glyph name up in
 * the AFM (`afm.rb:224-227`), for every AFM font including the two symbolic ones. Symbol's metrics
 * hold no glyph called `x`, so the lookup yields zero and the export sets a dingbat marker flush
 * against its text. Reported as undefined rather than as zero, exactly as the catalogue generator
 * omits it for a subset with no `x`: a zero gutter is a marker touching its text, and the
 * stylesheet's own default is the better answer for a measurement the renderer does not really make.
 *
 * @param afm - The parsed AFM.
 * @param winAnsi - Prawn's WinAnsi table.
 * @returns The advance, or undefined when prawn measures nothing.
 */
function gutterAdvance(afm, winAnsi) {
  const width = afm.widths.get(winAnsi[GUTTER_CODE]);
  return width !== undefined && width > 0 ? width : undefined;
}

async function main() {
  const check = process.argv.includes('--check');
  const prawn = locatePrawn();
  const afmDirectory = join(prawn.directory, 'data/fonts');
  const winAnsi = readWinAnsi(prawn.directory);
  const { builtIns, composites } = readFamilyTable(prawn.directory);

  const unknown = builtIns.filter((name) => SUBSTITUTES[name] === undefined);
  if (unknown.length > 0) {
    throw new Error(`Prawn declares built-in fonts this script has no stand-in for: ${unknown.join(', ')}`);
  }

  await woff2.init(readFileSync(locateWoff2Wasm()).buffer);

  // Staged and swapped in only once all fourteen are there, for the reason
  // `generate-catalogue-fonts.mjs` sets out: a stand-in this cannot read must leave the committed
  // faces as they were rather than deleted or half-converted. `--check` stages in the system temp
  // directory instead, because it swaps nothing.
  const target = check
    ? mkdtempSync(join(tmpdir(), 'base14-fonts-'))
    : mkdtempSync(`${OUTPUT_DIR}.staging-`);

  try {
    const faces = [];
    // Sorted by code unit, so the manifest's order is a property of the names and of nothing else —
    // `localeCompare` would consult the runtime's collation and let two runners disagree about an
    // order neither of them chose.
    for (const builtIn of [...builtIns].toSorted()) {
      const symbolic = SYMBOLIC.has(builtIn);
      const afmName = `${builtIn}.afm`;
      const afm = parseAfm(join(afmDirectory, afmName));
      if (symbolic !== (afm.attributes.characterset === 'Special')) {
        throw new Error(`${builtIn}: the AFM's CharacterSet disagrees with this script's symbolic set.`);
      }
      const lineBox = prawnLineBox(afm, builtIn);
      const sourceName = SUBSTITUTES[builtIn];
      const source = readFileSync(join(VENDOR_DIR, sourceName));

      const { woff, sfnt, kerning } = symbolic
        ? convertSymbolic(source, afm, lineBox, builtIn)
        : convertText(source, afm, builtIn);
      const measured = sfntAdvances(sfnt);
      if (measured.unitsPerEm !== AFM_UNITS_PER_EM) {
        throw new Error(
          `${sourceName} is drawn on a ${measured.unitsPerEm}-unit em; an AFM's widths are ` +
            `per ${AFM_UNITS_PER_EM} and the two must be the same number to be comparable.`,
        );
      }

      const table = encodedWidths(afm, winAnsi, symbolic);
      const gutter = gutterAdvance(afm, winAnsi);
      const file = outputName(builtIn);
      writeFileSync(join(target, file), woff);
      faces.push({
        name: builtIn,
        file,
        source: sourceName,
        // The bytes the face was converted FROM, not merely their file name. A name pins nothing: the
        // vendored stand-ins are committed, so a pull request can replace `texgyreheros-regular.otf`
        // with a different cut of the same typeface and leave every string in this manifest correct
        // while the committed WOFF2 stops being derivable from the file it names. Recorded here so
        // that the mismatch is visible from the committed artifacts alone — `tests/fonts` re-hashes
        // `vendor/base14` against this, on any checkout, with no gem and no CI path filter involved.
        sourceHash: hashOf(source),
        afm: afmName,
        bytes: woff.length,
        hash: hashOf(woff),
        encodedBytes: table.size,
        widthsHash: widthsHashOf(table),
        divergences: faceDivergences(table, measured),
        // How much of the AFM's kern list the published face carries. Absent for the two symbolic
        // faces, whose AFMs declare no kern pairs at all and whose sfnt is built rather than
        // rewritten. See {@link convertText}.
        ...(kerning === undefined ? {} : { kerning }),
        metrics: {
          unitsPerEm: AFM_UNITS_PER_EM,
          ascender: lineBox.ascender,
          descender: lineBox.descender,
          lineGap: lineBox.lineGap,
          ...(gutter === undefined ? {} : { xAdvance: gutter }),
        },
      });
      copyFileSync(join(afmDirectory, afmName), join(target, afmName));
    }

    copyFileSync(join(afmDirectory, AFM_NOTICE), join(target, AFM_NOTICE));
    writeFileSync(join(target, WIN_ANSI_TABLE), `${JSON.stringify(winAnsi, null, 2)}\n`);
    for (const licence of LICENCES) copyFileSync(join(VENDOR_DIR, licence), join(target, licence));

    const manifest = {
      // The AFMs and the family table are prawn's, and the version is what a drift check compares first.
      prawnVersion: prawn.version,
      generatedBy: 'scripts/generate-base14-fonts.mjs',
      faces,
      families: [...builtIns].toSorted().map((builtIn) => ({
        family: builtIn,
        faces: familyStyles(builtIn, composites),
      })),
      licences: LICENCES,
      // Kept apart from `licences` because these are NOT served: the AFMs are what the widths were
      // measured against and what the tests re-measure them against, and shipping half a megabyte of
      // metrics to a browser that reads none of it would be absurd. Adobe's notice travels with them
      // because its own terms say it must.
      metricSources: [...faces.map((face) => face.afm).toSorted(), AFM_NOTICE, WIN_ANSI_TABLE],
    };
    writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    // Projected from the manifest that was just built, never assembled a second time from the parts:
    // a slice built independently is a second chance to state a metric differently.
    writeFileSync(
      join(target, BROWSER_SLICE),
      `${JSON.stringify(
        {
          faces: manifest.faces.map((face) => ({
            name: face.name,
            file: face.file,
            metrics: face.metrics,
          })),
          families: manifest.families,
        },
        null,
        2,
      )}\n`,
    );

    const divergent = faces.reduce((total, face) => total + face.divergences.length, 0);
    const compared = faces.reduce((total, face) => total + face.encodedBytes, 0);
    if (check) {
      const differences = compareDirectories(OUTPUT_DIR, target);
      if (differences.length > 0) {
        console.error(
          'The committed base-14 stand-ins do not match the vendored sources:\n' +
            differences.map((line) => `  - ${line}`).join('\n') +
            '\n\nRun: pnpm --filter @asciidocollab/asciidoc-pdf generate:base14-fonts',
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `The committed base-14 stand-ins match prawn ${prawn.version} ` +
          `(${faces.length} faces, ${compared - divergent}/${compared} advances exact).`,
      );
      return;
    }

    // The mode is set before the rename because `mkdtempSync` makes a 0700 directory and a rename
    // keeps it; assets this package publishes are world-readable like everything else in a checkout.
    chmodSync(target, 0o755);
    rmSync(OUTPUT_DIR, { recursive: true, force: true });
    renameSync(target, OUTPUT_DIR);
    console.log(
      `Wrote ${faces.length} base-14 stand-ins for prawn ${prawn.version} to ${OUTPUT_DIR} ` +
        `(${compared - divergent}/${compared} advances exact, ${divergent} recorded as divergences).`,
    );
  } finally {
    // A no-op once the rename above has moved it; what it clears is the staging tree left by a throw.
    rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Compare the committed assets against a freshly generated set, byte for byte.
 *
 * @param committed - The committed asset directory.
 * @param fresh - A freshly generated directory.
 * @returns One line per difference; empty when the two are identical.
 */
function compareDirectories(committed, fresh) {
  if (!existsSync(committed)) return ['the committed assets directory does not exist'];
  const differences = [];
  const committedNames = new Set(readdirSync(committed));
  const freshNames = new Set(readdirSync(fresh));

  for (const name of [...freshNames].toSorted()) {
    if (!committedNames.has(name)) {
      differences.push(`${name} is missing from the committed assets`);
      continue;
    }
    const a = readFileSync(join(committed, name));
    const b = readFileSync(join(fresh, name));
    if (!a.equals(b)) differences.push(`${name} differs from what the sources produce`);
  }
  for (const name of [...committedNames].toSorted()) {
    if (!freshNames.has(name)) differences.push(`${name} is committed but is no longer produced`);
  }
  return differences;
}

await main();
