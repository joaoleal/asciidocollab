#!/usr/bin/env node
/**
 * Extract the renderer's own admonition icons as SVG, so the Print preview draws the glyphs the PDF
 * draws rather than lookalikes.
 *
 * The renderer picks each admonition's icon out of a Font Awesome face shipped inside `prawn-icon`,
 * by name (`far-lightbulb`, `fas-info-circle`, …), and inks it in a colour and at a size that live in
 * the converter's own `AdmonitionIcons` table. All three — glyph, colour, size — are read from the
 * gem here, because all three are things a hand-drawn approximation gets subtly wrong: a bulb that is
 * filled where the renderer's is outlined reads as a different document, not a different rendering.
 *
 * ## Why this script lives here
 *
 * Same reason as {@link file://./generate-catalogue-fonts.mjs}: the gem tree is under
 * `ruby/.wasm-build/`, which is gitignored build output. This package owns the gem, converts from it
 * into a COMMITTED directory it publishes, and `apps/web` consumes only that. Nothing outside this
 * package reads `.wasm-build`.
 *
 * ## What is committed
 *
 * One SVG per admonition kind, a `manifest.json` recording the gem and icon-font versions with a
 * content hash per file, and the icon font's licence. The SVGs carry a path and nothing else — no
 * fill — because the colour is the theme's to choose at render time; the stylesheet paints them as a
 * mask.
 *
 * Run `pnpm --filter @asciidocollab/asciidoc-pdf generate:admonition-icons` after a gem bump. It
 * generates into a staging directory and replaces the committed tree only once the whole set exists,
 * so a gem this cannot read leaves the assets untouched instead of destroying them. `--check`
 * regenerates into a temporary directory and compares, changing nothing; that is what CI runs, in the
 * one job that has the gem.
 */

import { createHash } from 'node:crypto';
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Font } from 'fonteditor-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const GEM_ROOT = join(PACKAGE_ROOT, 'ruby/.wasm-build/vendor/bundle/ruby/3.3.0/gems');
const OUTPUT_DIR = join(PACKAGE_ROOT, 'assets/admonition-icons');

/** The icon sets `prawn-icon` ships, and the file each one's face lives in. */
const ICON_SETS = { far: 'fa-regular.ttf', fas: 'fa-solid.ttf', fab: 'fa-brands.ttf' };

/**
 * The converter's built-in icon table, as Ruby source.
 *
 * Parsed rather than restated so a gem bump that recolours or renames an icon shows up as a changed
 * asset instead of as a silent disagreement between the two renderings. A format change fails loudly
 * here rather than producing four icons and a missing one.
 */
const ICON_TABLE = /^\s*(?<type>\w+):\s*\{\s*name:\s*'(?<name>[\w-]+)',\s*stroke_color:\s*'(?<color>[\dA-Fa-f]{6})',\s*size:\s*(?<size>[\d.]+)\s*\}/gm;

/** The kinds this package publishes an icon for; the renderer draws no others. */
const ADMONITION_TYPES = ['caution', 'important', 'note', 'tip', 'warning'];

/**
 * The vendored Asciidoctor-PDF gem, and the `prawn-icon` gem whose fonts it draws from.
 *
 * @returns Both gem directories and their versions.
 */
function locateGems() {
  if (!existsSync(GEM_ROOT)) {
    throw new Error(
      `The gems are not vendored at ${GEM_ROOT}. Build the wasm engine first ` +
        '(pnpm --filter @asciidocollab/asciidoc-pdf build:wasm).',
    );
  }
  const names = readdirSync(GEM_ROOT);
  const find = (prefix) => {
    const matches = names.filter((name) => name.startsWith(prefix));
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one ${prefix}* gem under ${GEM_ROOT}, found ${matches.length}.`);
    }
    return { directory: join(GEM_ROOT, matches[0]), version: matches[0].replace(prefix, '') };
  };
  return { converter: find('asciidoctor-pdf-'), icons: find('prawn-icon-') };
}

/**
 * Read the converter's admonition icon table.
 *
 * @param converterSource - The converter's Ruby source.
 * @returns Admonition kind → the icon's name, colour and size.
 */
function parseIconTable(converterSource) {
  const start = converterSource.indexOf('AdmonitionIcons = {');
  if (start < 0) throw new Error("The converter's AdmonitionIcons table could not be found.");
  // Up to the line that closes the table — not to the first `}`, which closes the first entry.
  const block = converterSource.slice(start).split(/^\s*\}\s*$/m)[0];

  const icons = {};
  for (const match of block.matchAll(ICON_TABLE)) {
    const { type, name, color, size } = match.groups;
    icons[type] = { name, strokeColor: color.toUpperCase(), sizePt: Number(size) };
  }
  const missing = ADMONITION_TYPES.filter((type) => icons[type] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `The converter's AdmonitionIcons table did not yield ${missing.join(', ')} — has its format changed?`,
    );
  }
  // BOTH directions, like the highlight-CSS generator's vocabulary check. Only the missing half was
  // checked, so a gem that added a sixth admonition kind would have passed `--check` in silence: the
  // five listed here would still convert, the staged directory would match the committed one exactly,
  // and this package would go on publishing an icon set with a hole in it while the export drew the
  // glyph the preview has no file for.
  const surplus = Object.keys(icons).filter((type) => !ADMONITION_TYPES.includes(type));
  if (surplus.length > 0) {
    throw new Error(
      `The converter's AdmonitionIcons table carries ${surplus.join(', ')}, which this package does not publish. ` +
        'Add them to ADMONITION_TYPES (and to whatever draws them) rather than shipping a set with a hole in it.',
    );
  }
  return icons;
}

/**
 * The codepoint `prawn-icon` maps one icon name to, within its set.
 *
 * Its legend is a flat YAML mapping of name to the single character, so it is read by scanning rather
 * than by adding a YAML parser to a package that deliberately has almost no dependencies.
 *
 * @param legendText - The set's legend document.
 * @param icon - The icon's name without its set prefix.
 * @returns The codepoint.
 */
function codepointOf(legendText, icon) {
  const line = legendText.split('\n').find((candidate) => new RegExp(`^\\s+${icon}:\\s`).test(candidate));
  const character = line === undefined ? undefined : /^\s+[\w-]+:\s*"(.*)"\s*$/.exec(line)?.[1];
  if (character === undefined || character.length === 0) {
    throw new Error(`prawn-icon's legend has no entry for ${icon}.`);
  }
  return character.codePointAt(0);
}

/** The XML entities the SVG writer's own encoder emits, and what each stands for. */
const XML_ENTITIES = { amp: 0x26, lt: 0x3c, gt: 0x3e, quot: 0x22, apos: 0x27 };

/**
 * The code points one `<glyph>` element's `unicode` attribute stands for.
 *
 * The writer spells a code point either as itself or as a numeric character reference, so the
 * attribute is decoded rather than compared as text — comparing text would mean restating the
 * writer's own encoding rule here, which is the kind of duplicate that goes stale silently. An entity
 * this does not model throws: a glyph whose identity could not be read is not a glyph to fall back to
 * a positional guess about.
 *
 * @param value - The attribute's value, as written.
 * @returns The code points it denotes.
 */
function codepointsOfAttribute(value) {
  const points = [];
  let rest = value;
  while (rest !== '') {
    const entity = /^&(?:#x([\da-f]+)|#(\d+)|(\w+));/i.exec(rest);
    if (entity === null) {
      points.push(rest.codePointAt(0));
      rest = rest.slice(String.fromCodePoint(rest.codePointAt(0)).length);
      continue;
    }
    if (entity[3] !== undefined) {
      const named = XML_ENTITIES[entity[3].toLowerCase()];
      if (named === undefined) throw new Error(`Unmodelled XML entity &${entity[3]}; in a glyph's unicode attribute.`);
      points.push(named);
    } else {
      points.push(Number.parseInt(entity[1] ?? entity[2], entity[1] === undefined ? 10 : 16));
    }
    rest = rest.slice(entity[0].length);
  }
  return points;
}

/**
 * The one element of a list, or an error naming what was expected instead.
 *
 * @param candidates - Everything that matched.
 * @param what - What was being looked for, for the message.
 * @returns The single match.
 */
function only(candidates, what) {
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one ${what}, found ${candidates.length}.`);
  }
  return candidates[0];
}

/**
 * Extract one glyph's outline from a face.
 *
 * Both halves are keyed off the CODE POINT, never off position in the subset. A subset holds the
 * requested glyph and `.notdef`, and nothing says the requested one comes second: a face whose
 * `.notdef` carries an outline, or one whose `post` table names no glyph so `.notdef` cannot be
 * recognised by name, would otherwise hand back the wrong shape or the wrong advance — and silently,
 * because the manifest's hash is a hash of whatever was produced and would simply agree with itself.
 *
 * @param facePath - The TTF to read.
 * @param codepoint - The glyph's codepoint.
 * @returns The outline's path data and the face's own metrics.
 */
function extractGlyph(facePath, codepoint) {
  const bytes = readFileSync(facePath);
  const font = Font.create(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
    type: 'ttf',
    subset: [codepoint],
    hinting: false,
  });
  const where = `U+${codepoint.toString(16).toUpperCase()} in ${facePath}`;

  // The outline comes from the SVG writer, which is the only path serialiser this dependency exposes;
  // the metrics come from the parsed face, because the SVG writer omits a per-glyph advance and
  // falls back to the font's, which for an icon face is not the icon's own width.
  const written = [...font.write({ type: 'svg' }).matchAll(/<glyph\s([^>]*?)\s*\/>/g)]
    .map((element) => ({
      unicode: /\bunicode="([^"]*)"/.exec(element[1])?.[1],
      path: /\bd="([^"]*)"/.exec(element[1])?.[1],
    }))
    .filter(
      (glyph) =>
        glyph.unicode !== undefined &&
        glyph.path !== undefined &&
        codepointsOfAttribute(glyph.unicode).includes(codepoint),
    );
  const glyph = only(written, `outline for ${where}`);

  const parsed = font.get();
  const outline = only(
    parsed.glyf.filter((candidate) => candidate.unicode?.includes(codepoint) === true),
    `glyph mapped from ${where}`,
  );
  if (!(outline.advanceWidth > 0)) throw new Error(`The glyph for ${where} advances by ${outline.advanceWidth}.`);

  return {
    path: glyph.path,
    ascent: parsed.hhea.ascent,
    // Negative in every face that has anything below the baseline, which is how `hhea` states it.
    descent: parsed.hhea.descent,
    advance: outline.advanceWidth,
  };
}

/**
 * One glyph as a standalone SVG.
 *
 * Font outlines are y-up from the baseline; SVG is y-down from the top edge. The transform is that
 * change of frame and nothing else — the outline's own coordinates are untouched, so the shape is the
 * face's, not a redrawing of it. No `fill` is set: the stylesheet uses the file as a mask and paints
 * it in the theme's colour.
 *
 * The box's HEIGHT is the face's own vertical extent, `ascent - descent`, and not its em size. Those
 * are equal in the Font Awesome faces prawn-icon ships today (512 = 448 − −64), and it was the em
 * size that used to be written — which is a coincidence dressed as a rule. A face whose ascent and
 * descent do not add up to one em would have had every glyph clipped at the bottom of its own box,
 * and nothing would have said so: `--check` compares the generated SVG with the committed one, so the
 * manifest's hash would simply have agreed with the clipped output. Reading both metrics states the
 * box the outline actually occupies, and leaves today's files byte-identical.
 *
 * @param glyph - The outline and the face's metrics.
 * @returns The SVG document.
 */
function svgDocument(glyph) {
  const { path, ascent, descent, advance } = glyph;
  if (!(ascent > descent)) {
    throw new Error(`A face reports ascent ${ascent} and descent ${descent}, which bound no box.`);
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${advance} ${ascent - descent}">` +
    `<path transform="translate(0 ${ascent}) scale(1 -1)" d="${path}"/>` +
    '</svg>\n'
  );
}

/** The content hash a manifest entry records, so a hand-edited icon is detectable. */
function hashOf(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
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
    if (!readFileSync(join(committed, name)).equals(readFileSync(join(fresh, name)))) {
      differences.push(`${name} differs from what the gem produces`);
    }
  }
  for (const name of [...committedNames].toSorted()) {
    if (!freshNames.has(name)) differences.push(`${name} is committed but the gem no longer produces it`);
  }
  return differences;
}

function main() {
  const check = process.argv.includes('--check');
  const gems = locateGems();
  const converterSource = readFileSync(
    join(gems.converter.directory, 'lib/asciidoctor/pdf/converter.rb'),
    'utf8',
  );
  const table = parseIconTable(converterSource);

  // Everything is generated into a staging directory and the committed tree is replaced only once the
  // whole set exists. Every failure below is one this script is SUPPOSED to have — an icon set the
  // gem renamed, a legend entry that moved, a glyph that cannot be identified — and each of them must
  // leave the committed assets exactly as they were rather than deleted or half-written. The staging
  // directory is a sibling of the output, so the swap is a rename within one filesystem; `--check`
  // stages in the system temp directory instead, because it swaps nothing.
  const target = check
    ? mkdtempSync(join(tmpdir(), 'admonition-icons-'))
    : mkdtempSync(`${OUTPUT_DIR}.staging-`);

  try {
    const icons = [];
    const licences = new Set();
    for (const type of ADMONITION_TYPES) {
      const { name, strokeColor, sizePt } = table[type];
      const separator = name.indexOf('-');
      const set = name.slice(0, separator);
      const iconName = name.slice(separator + 1);
      const faceFile = ICON_SETS[set];
      if (faceFile === undefined) throw new Error(`Unknown icon set ${set} for the ${type} admonition.`);

      const setDirectory = join(gems.icons.directory, 'data/fonts', set);
      const codepoint = codepointOf(readFileSync(join(setDirectory, `${set}.yml`), 'utf8'), iconName);
      const document = svgDocument(extractGlyph(join(setDirectory, faceFile), codepoint));
      const file = `${type}.svg`;
      writeFileSync(join(target, file), document);
      icons.push({
        type,
        file,
        icon: name,
        codepoint: `U+${codepoint.toString(16).toUpperCase()}`,
        strokeColor,
        sizePt,
        hash: hashOf(Buffer.from(document)),
      });

      for (const licence of readdirSync(setDirectory).filter((entry) => entry.startsWith('LICENSE'))) {
        const published = `LICENSE-${set}`;
        copyFileSync(join(setDirectory, licence), join(target, published));
        licences.add(published);
      }
    }

    const manifest = {
      gemVersion: gems.converter.version,
      iconGemVersion: gems.icons.version,
      generatedBy: 'scripts/generate-admonition-icons.mjs',
      icons,
      licences: [...licences].toSorted(),
    };
    writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    if (check) {
      const differences = compareDirectories(OUTPUT_DIR, target);
      if (differences.length > 0) {
        console.error(
          'The committed admonition icons do not match the vendored gem:\n' +
            differences.map((line) => `  - ${line}`).join('\n') +
            '\n\nRun: pnpm --filter @asciidocollab/asciidoc-pdf generate:admonition-icons',
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `The committed admonition icons match asciidoctor-pdf ${gems.converter.version} ` +
          `(${icons.length} icons from prawn-icon ${gems.icons.version}).`,
      );
      return;
    }

    // The old tree goes only now, with the new one complete beside it: an icon dropped from the
    // converter's table must LEAVE the published assets, or the manifest and the directory would
    // disagree about what this package ships.
    //
    // The mode is set BEFORE the rename because the staging directory carries `mkdtempSync`'s, which
    // is 0700 — private to whoever ran the generator — and a rename keeps it. The published directory
    // would then be one no other user, and no container running as another UID, could list; its
    // sibling `assets/rouge` is 0755 because an ordinary `mkdirSync` made it. Assets this package
    // publishes are world-readable, like every other file in the checkout.
    chmodSync(target, 0o755);
    rmSync(OUTPUT_DIR, { recursive: true, force: true });
    renameSync(target, OUTPUT_DIR);
    console.log(`Wrote ${icons.length} admonition icons from asciidoctor-pdf ${gems.converter.version} to ${OUTPUT_DIR}`);
  } finally {
    // A no-op once the rename above has moved it; what it clears is the staging tree left by a throw.
    rmSync(target, { recursive: true, force: true });
  }
}

main();
