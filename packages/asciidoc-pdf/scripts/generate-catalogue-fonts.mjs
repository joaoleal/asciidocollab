#!/usr/bin/env node
/**
 * Convert the vendored gem's own typefaces to WOFF2, so a browser can draw the page the renderer
 * draws.
 *
 * The Print preview's whole claim is that its line lengths are the PDF's. That is a claim about
 * metrics, and metrics belong to a font FILE, not to a family name — a differently-built copy of
 * "Noto Serif" sets different lines. So the browser is given the gem's own subsetted faces,
 * repackaged: WOFF2 is a lossless recompression of the same sfnt, glyph for glyph and metric for
 * metric, which is what makes "the same font" true rather than approximately true.
 *
 * ## Why this script lives here
 *
 * The gem's font directory is under `ruby/.wasm-build/`, which is gitignored build output. A build
 * step in `apps/web` reading it would reach into this package's internals rather than a published
 * surface, and on a clean checkout where the wasm build has not run it would produce nothing at all
 * — a silent, environment-dependent difference in what the preview looks like. So the conversion is
 * owned by the package that owns the gem, writes into a COMMITTED directory this package publishes,
 * and `apps/web` consumes that path. Nothing outside this package reads `.wasm-build`.
 *
 * ## Which families are converted
 *
 * Whichever the gem's default theme names in its font catalogue — read out of the gem's own
 * `data/themes/default-theme.yml` here, which is the same document `packages/shared` commits a
 * verbatim copy of as `default-theme.generated.ts`. Reading the gem's copy rather than that one
 * keeps this package pointing only at its own contents; they cannot disagree, because one is a copy
 * of the other.
 *
 * A family is never scoped by "which family a fixture happened to exercise": the anchor set is small
 * by design, so a fixture missing a family is not evidence the default theme cannot reach it, and an
 * unconverted family would ship behind a passing suite.
 *
 * ## What is committed
 *
 * The WOFF2 faces, a `manifest.json` recording the gem version, a content hash per face and the four
 * vertical metrics the renderer reads out of that face, and the gem's own licence and about files.
 * The hashes are what make a stale or hand-edited face detectable rather than merely unlikely; a CI
 * check regenerates and compares against them.
 *
 * ## Why the metrics are recorded here
 *
 * The renderer's line box is NOT the theme's line height. Prawn advances a baseline by
 * `font.height + leading`, where `font.height` is the font file's OWN height
 * (`(ascender - descender + line_gap) / units_per_em`) and `leading` is
 * `(theme_line_height - 1) x font_size` — see `calc_line_metrics` in the gem's prawn extensions and
 * `Prawn::Font#height_at`. A browser's `line-height` is the whole box instead, and its `normal`
 * keyword reads a different metric table again, so the only way for the preview to set lines the
 * width apart the page does is to know the face's own height as a number.
 *
 * Which numbers those are is ttfunk's choice, not a free one: `TTFunk::File#ascent`/`#descent`/
 * `#line_gap` take the OS/2 typographic value when the table exists, declares a version above 0 and
 * that value is non-zero, and otherwise fall back — field by field — to `hhea`. Prawn then scales
 * each into a 1000-unit em and TRUNCATES it (`Integer(value * scale_factor)`). The raw numbers are
 * recorded here and the arithmetic lives in one place in `apps/web`, so the generator stays a reader
 * and a face that changes shows up as a manifest diff.
 *
 * Run `pnpm --filter @asciidocollab/asciidoc-pdf generate:catalogue-fonts` after a gem bump. The
 * output is generated — never hand-edit it. It is built into a staging directory and swapped in only
 * once the whole catalogue converted, so a gem this cannot read leaves the committed faces untouched
 * instead of destroying them.
 *
 * `--check` regenerates into a temporary directory and compares, changing nothing. That is what CI
 * runs, in the one job that has the gem: committed assets that no longer match the gem it is claimed
 * they came from is exactly the failure a content hash exists to make loud.
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
import { Font, woff2 } from 'fonteditor-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const GEM_ROOT = join(PACKAGE_ROOT, 'ruby/.wasm-build/vendor/bundle/ruby/3.3.0/gems');
const OUTPUT_DIR = join(PACKAGE_ROOT, 'assets/fonts');

/** The catalogue's style keys, in the order a manifest entry lists them. */
const STYLES = ['normal', 'bold', 'italic', 'bold_italic'];

/** Licence and attribution files the gem ships beside its fonts; all of them are carried across. */
const LICENCE_PREFIXES = ['LICENSE-', 'ABOUT-'];

const require = createRequire(import.meta.url);

/**
 * Locate the WOFF2 codec's wasm inside `fonteditor-core`.
 *
 * Its `exports` map forbids resolving a package.json subpath, so the asset is found by walking up
 * from the resolved entry point — the same approach the web app's own copy step uses.
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
 * The vendored Asciidoctor-PDF gem: where it is, and which version it is.
 *
 * @returns The gem's directory and version string.
 */
function locateGem() {
  if (!existsSync(GEM_ROOT)) {
    throw new Error(
      `The asciidoctor-pdf gem is not vendored at ${GEM_ROOT}. Build the wasm engine first ` +
        '(pnpm --filter @asciidocollab/asciidoc-pdf build:wasm).',
    );
  }
  const gems = readdirSync(GEM_ROOT).filter((name) => name.startsWith('asciidoctor-pdf-'));
  if (gems.length !== 1) {
    throw new Error(`Expected exactly one asciidoctor-pdf gem under ${GEM_ROOT}, found ${gems.length}.`);
  }
  return { directory: join(GEM_ROOT, gems[0]), version: gems[0].replace('asciidoctor-pdf-', '') };
}

/**
 * The font catalogue the gem's default theme declares.
 *
 * Parsed by scanning the `font: catalog:` block rather than by loading a YAML parser: the block is a
 * fixed two-level mapping of family name to style-keyed file paths, and the alternative is a
 * dependency in a package whose whole point is having very few.
 *
 * @param themeText - The default theme document.
 * @returns Family name → style → the file name the catalogue gives it.
 */
function parseFontCatalogue(themeText) {
  const catalogue = new Map();
  const lines = themeText.split('\n');
  let inCatalogue = false;
  let family = null;

  for (const line of lines) {
    if (/^font:\s*$/.test(line)) {
      inCatalogue = false;
      continue;
    }
    if (/^ {2}catalog:\s*$/.test(line)) {
      inCatalogue = true;
      continue;
    }
    if (!inCatalogue) continue;
    // Any key at or above the catalogue's own indentation ends the block.
    if (/^\S/.test(line) || /^ {2}\S/.test(line)) break;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const familyMatch = /^ {4}([^\s#][^:]*):\s*$/.exec(line);
    if (familyMatch !== null) {
      family = familyMatch[1].trim();
      catalogue.set(family, {});
      continue;
    }
    const faceMatch = /^ {6}(\w+):\s*(\S+)\s*$/.exec(line);
    if (faceMatch !== null && family !== null) {
      // `GEM_FONTS_DIR/notoserif-regular-subset.ttf` — only the file name is of interest, because the
      // directory is resolved here rather than by the renderer.
      catalogue.get(family)[faceMatch[1]] = faceMatch[2].slice(faceMatch[2].lastIndexOf('/') + 1);
    }
  }

  if (catalogue.size === 0) {
    throw new Error("The default theme's font catalogue could not be read — has the gem's format changed?");
  }
  return catalogue;
}

/** A stable, lower-kebab file name for one family's face, independent of the gem's own naming. */
function outputName(family, style) {
  const slug = family
    .toLowerCase()
    .replaceAll('+', 'plus')
    .replaceAll(/[^a-z\d]+/g, '-')
    .replaceAll(/^-|-$/g, '');
  return `${slug}-${style.replaceAll('_', '-')}.woff2`;
}

/** The content hash a manifest entry records, so a hand-edited face is detectable. */
function hashOf(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
}

/** The character the renderer measures a list's marker gutter with. */
const GUTTER_CHAR = 0x00_78;

/**
 * The metrics the renderer reads out of one face, in the font's own design units.
 *
 * The selection rule for the three vertical ones is ttfunk's, reproduced field by field: an OS/2
 * typographic value counts only when the table exists, its version is above zero, and the value is
 * non-zero; otherwise that one field comes from `hhea`. Reproducing it per field rather than per
 * table matters — a font whose OS/2 declares ascender and descender but leaves `sTypoLineGap` at
 * zero takes its line gap from `hhea`, and that gap is a whole line's worth of difference on a page
 * of text.
 *
 * The fourth is horizontal and is here for one reason: the renderer measures the gap between a list
 * marker and its text as `rendered_width_of_char 'x'` in the face the marker is drawn in
 * (`converter.rb:1712`), and a callout list's marker column as that same width beside the glyph
 * (`converter.rb:1418`). CSS has no unit for the advance of an arbitrary glyph — `ch` is the advance
 * of `0`, which is a different number in every proportional face — so the one the renderer really
 * reads has to be recorded here.
 *
 * @param ttf - The face's raw sfnt bytes.
 * @param source - The face's file name, for the message when it cannot be read.
 * @returns The units per em, the three vertical metrics and the gutter advance.
 */
function faceMetrics(ttf, source) {
  const font = Font.create(ttf, { type: 'ttf' }).get();
  const head = font.head;
  const hhea = font.hhea;
  const os2 = font['OS/2'];
  if (head === undefined || hhea === undefined) {
    throw new Error(`${source} carries no head or hhea table, so its line height cannot be read.`);
  }
  const typographic = os2 !== undefined && Number(os2.version) > 0;
  const pick = (typographicValue, hheaValue) =>
    typographic && typographicValue !== undefined && typographicValue !== 0
      ? typographicValue
      : hheaValue;
  const gutterGlyph = font.glyf?.[font.cmap?.[GUTTER_CHAR]];
  const metrics = {
    unitsPerEm: head.unitsPerEm,
    ascender: pick(os2?.sTypoAscender, hhea.ascent),
    descender: pick(os2?.sTypoDescender, hhea.descent),
    lineGap: pick(os2?.sTypoLineGap, hhea.lineGap),
    // Omitted rather than guessed for a face with no `x` — a subset that dropped it cannot say how
    // wide one would have been, and the preview's own fallback is the honest answer there.
    ...(typeof gutterGlyph?.advanceWidth === 'number' ? { xAdvance: gutterGlyph.advanceWidth } : {}),
  };
  if (!(metrics.unitsPerEm > 0) || !Number.isFinite(metrics.ascender)) {
    throw new Error(`${source} has no usable vertical metrics.`);
  }
  return metrics;
}

async function main() {
  const check = process.argv.includes('--check');
  const gem = locateGem();
  const fontsDirectory = join(gem.directory, 'data/fonts');
  const themeText = readFileSync(join(gem.directory, 'data/themes/default-theme.yml'), 'utf8');
  const catalogue = parseFontCatalogue(themeText);

  await woff2.init(readFileSync(locateWoff2Wasm()).buffer);

  // Every face is converted into a staging directory and the committed tree is replaced only once the
  // whole catalogue is there. A face the gem ships with unreadable metrics, or a family it declares
  // with no usable face, is a failure this script is supposed to have — and it must leave the
  // committed assets exactly as they were rather than deleted or half-converted. The staging
  // directory is a sibling of the output, so the swap is a rename within one filesystem; `--check`
  // stages in the system temp directory instead, because it swaps nothing.
  const target = check
    ? mkdtempSync(join(tmpdir(), 'catalogue-fonts-'))
    : mkdtempSync(`${OUTPUT_DIR}.staging-`);

  try {
    const families = [];
    // Sorted by CODE UNIT, not by `localeCompare`. What `--check` compares is bytes, so the order the
    // families are written in has to be a property of their names and of nothing else; `localeCompare`
    // consults the runtime's collation and its default locale, both of which are the environment's to
    // change. Two runners could then disagree about the order of two families whose names differ only
    // in case or in an accent, and the check would report a drift no one introduced. Today's two
    // families cannot flip either way — this is the sort being made incapable of it rather than a
    // change to what is emitted.
    for (const family of [...catalogue.keys()].toSorted()) {
      const faces = catalogue.get(family);
      const converted = {};
      for (const style of STYLES) {
        const source = faces[style];
        if (source === undefined) continue;
        const ttf = readFileSync(join(fontsDirectory, source));
        const bytes = Buffer.from(
          woff2.encode(ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength)),
        );
        const file = outputName(family, style);
        writeFileSync(join(target, file), bytes);
        converted[style] = {
          file,
          source,
          bytes: bytes.length,
          hash: hashOf(bytes),
          // Read from the gem's TTF rather than from the WOFF2 written beside it: WOFF2 is a lossless
          // recompression of the same sfnt, so the numbers are identical, and reading the input keeps
          // this a statement about what the gem ships.
          metrics: faceMetrics(ttf, source),
        };
      }
      if (Object.keys(converted).length === 0) {
        throw new Error(`The default theme's catalogue declares ${family} with no usable face.`);
      }
      families.push({ family, faces: converted });
    }

    const licences = readdirSync(fontsDirectory)
      .filter((name) => LICENCE_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .toSorted();
    for (const licence of licences) {
      copyFileSync(join(fontsDirectory, licence), join(target, licence));
    }

    const manifest = {
      // Everything here is derived from the gem; the version is what a drift check compares first.
      gemVersion: gem.version,
      generatedBy: 'scripts/generate-catalogue-fonts.mjs',
      families,
      licences,
    };
    writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const faceCount = families.reduce((total, entry) => total + Object.keys(entry.faces).length, 0);
    if (check) {
      const differences = compareDirectories(OUTPUT_DIR, target);
      if (differences.length > 0) {
        console.error(
          'The committed catalogue fonts do not match the vendored gem:\n' +
            differences.map((line) => `  - ${line}`).join('\n') +
            '\n\nRun: pnpm --filter @asciidocollab/asciidoc-pdf generate:catalogue-fonts',
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `The committed catalogue fonts match asciidoctor-pdf ${gem.version} (${faceCount} faces, ${families.length} families).`,
      );
      return;
    }

    // The old directory goes only now, with the new one complete beside it: a face dropped from the
    // catalogue must LEAVE the published assets, or the manifest and the directory would disagree
    // about what this package ships.
    //
    // The mode is set BEFORE the rename because the staging directory carries `mkdtempSync`'s, which
    // is 0700 — private to whoever ran the generator — and a rename keeps it. The published directory
    // would then be one no other user, and no container running as another UID, could list; its
    // sibling `assets/rouge` is 0755 because an ordinary `mkdirSync` made it. Assets this package
    // publishes are world-readable, like every other file in the checkout.
    chmodSync(target, 0o755);
    rmSync(OUTPUT_DIR, { recursive: true, force: true });
    renameSync(target, OUTPUT_DIR);
    console.log(
      `Wrote ${faceCount} faces across ${families.length} families from asciidoctor-pdf ${gem.version} to ${OUTPUT_DIR}`,
    );
  } finally {
    // A no-op once the rename above has moved it; what it clears is the staging tree left by a throw.
    rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Compare the committed assets against a freshly generated set, byte for byte.
 *
 * Comparing the whole directory rather than only the manifest is deliberate: a manifest and a font
 * file are two things that can disagree, and the manifest is the one that is easy to edit by hand.
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
    if (!a.equals(b)) differences.push(`${name} differs from what the gem produces`);
  }
  for (const name of [...committedNames].toSorted()) {
    if (!freshNames.has(name)) differences.push(`${name} is committed but the gem no longer produces it`);
  }
  return differences;
}

await main();
