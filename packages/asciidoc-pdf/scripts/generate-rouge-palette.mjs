#!/usr/bin/env node
/**
 * Read the renderer's own syntax-highlighting palette out of the vendored gems, so the preview can
 * paint source code the colours the export inks it.
 *
 * ## Why this script lives here
 *
 * Same reason as the catalogue fonts: the gems live under `ruby/.wasm-build/`, which is gitignored
 * build output. A step in `apps/web` reading it would reach into this package's internals, and on a
 * clean checkout where the wasm build has not run it would produce nothing at all — a silent,
 * environment-dependent difference in what the preview looks like. So the package that owns the gem
 * reads it, writes into a COMMITTED directory it publishes, and `apps/web` consumes that path.
 * Nothing outside this package reads `.wasm-build`, at build time or at run time.
 *
 * ## How it reads them
 *
 * By running rouge, not by parsing it: this locates the gems and hands them to
 * `rouge-palette-dump.rb`, which requires rouge and asks it for its token taxonomy, its lexer
 * registry and the theme's styles. Ruby 3.3 is a prerequisite of the vendored bundle existing at all
 * (`build-wasm.sh` installs it with host bundler), and CI runs this check in the one job that has
 * both — `pdf-wasm`, after `ruby/setup-ruby`.
 *
 * This replaced a text parser, which is worth recording because the parser was wrong: an `aliases`
 * list broken across a comment line (rouge's `rust.rb`) ended the list early, so six names rouge
 * really does resolve were missing from the inventory. A DSL is not reliably readable as text, and
 * nothing here has to be — the gem is right there.
 *
 * ## What is emitted, and why each part
 *
 *   - `tokens` — rouge's whole taxonomy in declaration order. A theme styles INTERIOR nodes and lets
 *     the leaves inherit (`Rouge::Theme.get_own_style` walks a token's ancestor chain from the most
 *     specific end), so a palette listing only the tokens a theme mentions could not answer "what
 *     colour is `Literal::String::Double`" — a token every lexer emits and no theme names. A token's
 *     parent is its qualified name minus the last segment.
 *
 *   - `lexers` — every name a document may declare that the export finds a lexer for. The palette
 *     answers "what colour is this token"; this answers the question before it, whether the export
 *     highlights the listing AT ALL. highlight.js's grammars and rouge's lexers do not cover the same
 *     languages, and where rouge has none `converter.rb` falls through to `PlainText` and prints the
 *     block in one colour. A preview claiming to show the exported page has to know that.
 *
 *   - `themes[].styles` — `bold` and `italic` as well as `fg`/`bg`, because the converter turns all
 *     of them into Prawn text attributes (`.../ext/rouge/formatters/prawn.rb`, `create_fragment`). A
 *     palette recording only the hue would describe a page the renderer does not draw.
 *
 * ## Which themes are emitted
 *
 * {@link THEMES} — one today, `asciidoctor_pdf_default`, because that is the palette the export gets.
 * It is NOT fixed by this package: `converter.rb:1193` passes the document's `rouge-style` attribute
 * to the formatter and `prawn.rb:32` falls back to `AsciidoctorPDFDefault` only when that attribute
 * names no theme rouge knows. `rouge-style` is not among `PINNED_ATTRIBUTE_KEYS` in
 * `packages/shared/src/render-config/config.ts`, so a project's custom attributes — or a document
 * header — can put a different palette in play. The output is therefore keyed by theme name rather
 * than flattened, and adding a second palette is one entry in {@link THEMES}.
 *
 * Run `pnpm --filter @asciidocollab/asciidoc-pdf generate:rouge-palette` after a gem bump. The output
 * is generated — never hand-edit it. `--check` regenerates into memory and compares, changing
 * nothing: a committed palette that no longer matches the gem it claims to come from is exactly the
 * drift this exists to make loud.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const GEM_ROOT = join(PACKAGE_ROOT, 'ruby/.wasm-build/vendor/bundle/ruby/3.3.0/gems');
const DUMP_SCRIPT = join(HERE, 'rouge-palette-dump.rb');
const OUTPUT_DIR = join(PACKAGE_ROOT, 'assets/rouge');
const OUTPUT_FILE = join(OUTPUT_DIR, 'palette.json');

/**
 * The themes emitted, and where each one's class is defined relative to its gem.
 *
 * `gem` is the gem-directory PREFIX, matched against what is actually vendored, so the version is
 * read from the checkout rather than restated here.
 */
const THEMES = [
  {
    name: 'asciidoctor_pdf_default',
    gem: 'asciidoctor-pdf-',
    file: 'lib/asciidoctor/pdf/ext/rouge/themes/asciidoctor_pdf_default.rb',
    why: 'the palette every export gets, because the convert never sets `rouge-style`',
  },
];

/** The theme a render falls back to; see `prawn.rb`'s `initialize`. */
const FALLBACK_THEME = 'asciidoctor_pdf_default';

/** Style keys the Prawn formatter acts on. Anything else in a `style` declaration is an error. */
const STYLE_KEYS = new Set(['fg', 'bg', 'bold', 'italic', 'underline']);

/**
 * Locate one vendored gem by directory prefix.
 *
 * @param prefix - The gem directory's name prefix, including its trailing hyphen.
 * @returns The gem's directory, and the version segment of its name.
 */
function locateGem(prefix) {
  if (!existsSync(GEM_ROOT)) {
    throw new Error(
      `The gems are not vendored at ${GEM_ROOT}. Build the wasm engine first ` +
        '(pnpm --filter @asciidocollab/asciidoc-pdf build:wasm).',
    );
  }
  const found = readdirSync(GEM_ROOT).filter((name) => name.startsWith(prefix));
  if (found.length !== 1) {
    throw new Error(`Expected exactly one ${prefix}* gem under ${GEM_ROOT}, found ${found.length}.`);
  }
  return { directory: join(GEM_ROOT, found[0]), name: found[0] };
}

/**
 * Run the dump against the vendored gems.
 *
 * @param config - `rougeLib` and the theme files to load, as the Ruby script expects them.
 * @returns The parsed dump.
 */
function dump(config) {
  const result = spawnSync('ruby', [DUMP_SCRIPT], { input: JSON.stringify(config), encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      'This needs Ruby 3.3 on PATH to load the vendored rouge (CI: ruby/setup-ruby; locally: the ' +
        'same toolchain that vendored the gems).',
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`rouge-palette-dump.rb failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

/**
 * Check one token's style against what the Prawn formatter models.
 *
 * Rouge's `style` DSL takes an open hash, so a theme can set an option the export cannot draw. That
 * is an error rather than a dropped key: a palette quietly missing what a theme said is the failure
 * this file exists to prevent.
 *
 * @param qualname - The token being styled, for the message.
 * @param style - The style as rouge holds it.
 * @returns The same style, with colours lowercased.
 */
function checkStyle(qualname, style) {
  const checked = {};
  for (const [key, value] of Object.entries(style)) {
    if (!STYLE_KEYS.has(key)) {
      throw new Error(`A theme sets the style option \`${key}\` on ${qualname}, which the Prawn formatter does not model.`);
    }
    if (value === true) {
      checked[key] = true;
      continue;
    }
    if (typeof value === 'string' && /^#[\da-f]{3,6}$/i.test(value)) {
      checked[key] = value.toLowerCase();
      continue;
    }
    throw new Error(`Unmodelled style value for \`${key}\` on ${qualname}: ${JSON.stringify(value)}`);
  }
  return checked;
}

/**
 * Build the palette document.
 *
 * @returns The document to write, and a one-line summary of what went into it.
 */
function build() {
  const rouge = locateGem('rouge-');
  const gems = new Set([rouge.name]);
  const wantedThemes = THEMES.map((wanted) => {
    const gem = locateGem(wanted.gem);
    gems.add(gem.name);
    return { ...wanted, gem: gem.name, file: join(gem.directory, wanted.file), source: `${gem.name}/${wanted.file}` };
  });

  const dumped = dump({
    rougeLib: join(rouge.directory, 'lib'),
    themes: wantedThemes.map(({ name, file }) => ({ name, file })),
  });

  const themes = {};
  for (const wanted of wantedThemes) {
    const parsed = dumped.themes[wanted.name];
    // A theme inheriting from another theme inherits its styles (`Rouge::Theme.styles` is an
    // InheritableHash over `superclass.styles`). `CSSTheme` declares none, so a theme extending it
    // stands alone — which is what makes the styles reported here the whole truth about its palette,
    // and why the pastie theme it is described as "a variation on" contributes nothing to it.
    if (parsed.superclass !== 'Rouge::CSSTheme') {
      throw new Error(
        `${wanted.name} extends ${parsed.superclass} rather than Rouge::CSSTheme; inherited styles are not modelled.`,
      );
    }
    const styles = {};
    for (const [qualname, style] of Object.entries(parsed.styles)) styles[qualname] = checkStyle(qualname, style);
    themes[wanted.name] = { source: wanted.source, why: wanted.why, styles };
  }

  if (!(FALLBACK_THEME in themes)) {
    throw new Error(`The fallback theme ${FALLBACK_THEME} is not among the emitted themes.`);
  }

  const document = {
    generatedBy: 'scripts/generate-rouge-palette.mjs',
    gems: [...gems].toSorted(),
    tokens: dumped.tokens,
    lexers: dumped.lexers,
    fallbackTheme: FALLBACK_THEME,
    themes,
  };
  const styleCount = Object.values(themes).reduce((total, theme) => total + Object.keys(theme.styles).length, 0);
  return {
    document,
    summary:
      `${document.tokens.length} tokens, ${document.lexers.length} lexer names, ` +
      `${Object.keys(themes).length} theme(s), ${styleCount} styles`,
  };
}

/**
 * Compare the committed output DIRECTORY against what this script produces.
 *
 * The three sibling generators (`generate-catalogue-fonts.mjs`, `generate-admonition-icons.mjs`,
 * `generate-base14-fonts.mjs`) all compare `assets/<name>/` as a whole and report anything committed
 * that the sources no longer produce — "is committed but is no longer produced". This one compared a
 * single named file, so `assets/rouge/` could grow a `stray.json` (a bad merge, a rename that left
 * the old name behind, a hand-written file) and `--check` stayed green while `apps/web` was free to
 * read it as though it came from the gems. `assets/rouge/` is this script's output directory and
 * nothing else writes it, so everything in it is either produced here or is drift.
 *
 * @param produced - `file name → exact contents` this run derived from the gems.
 * @returns One line per difference; empty when the directory is exactly what the gems produce.
 */
function compareOutputDirectory(produced) {
  if (!existsSync(OUTPUT_DIR)) return [`${OUTPUT_DIR} does not exist`];
  const differences = [];
  const committedNames = new Set(readdirSync(OUTPUT_DIR));

  for (const name of [...produced.keys()].toSorted()) {
    if (!committedNames.has(name)) {
      differences.push(`${name} is missing from the committed assets`);
      continue;
    }
    if (readFileSync(join(OUTPUT_DIR, name), 'utf8') !== produced.get(name)) {
      differences.push(`${name} does not match the vendored gems`);
    }
  }
  for (const name of [...committedNames].toSorted()) {
    if (!produced.has(name)) differences.push(`${name} is committed but is no longer produced`);
  }
  return differences;
}

function main() {
  const check = process.argv.includes('--check');
  const { document, summary } = build();
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const produced = new Map([['palette.json', text]]);

  if (check) {
    const differences = compareOutputDirectory(produced);
    if (differences.length > 0) {
      console.error(
        `The committed rouge assets do not match the vendored gems (${document.gems.join(', ')}):\n` +
          `  ${differences.join('\n  ')}\n\n` +
          'Run: pnpm --filter @asciidocollab/asciidoc-pdf generate:rouge-palette\n' +
          `(a file that is "no longer produced" is not regenerated — delete it from ${OUTPUT_DIR}).`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`The committed rouge palette matches ${document.gems.join(', ')} (${summary}).`);
    return;
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const [name, contents] of produced) writeFileSync(join(OUTPUT_DIR, name), contents);
  // Deliberately NOT deleted here, unlike the siblings' staged-directory swap. Those stage a whole
  // tree and rename it into place, so a stray disappears as a side effect of the swap; this script
  // writes one file in place, and silently deleting a neighbour it did not create would be a much
  // larger promise than "regenerate the palette". `--check` names the stray and says to remove it.
  const strays = readdirSync(OUTPUT_DIR).filter((name) => !produced.has(name));
  console.log(`Wrote ${OUTPUT_FILE} from ${document.gems.join(', ')} (${summary}).`);
  if (strays.length > 0) {
    console.log(`WARNING: ${OUTPUT_DIR} also holds files this script does not produce: ${strays.join(', ')}.`);
  }
}

main();
