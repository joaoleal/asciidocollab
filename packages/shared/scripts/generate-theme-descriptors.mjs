#!/usr/bin/env node
/**
 * Generate the Asciidoctor-PDF theme-key descriptor catalogue from the vendored gem.
 *
 * The theme editor needs to know which keys exist, what kind of value each takes and what the
 * renderer's default is. Upstream publishes no machine-readable schema for that (research R3), and a
 * hand-written list of ~400 keys would be wrong within one gem bump — offering keys the renderer no
 * longer recognises and missing the ones it gained. So the structural facts are DERIVED from the gem
 * that is already vendored in-repo and already baked into the wasm the app renders with.
 *
 * THREE sources, because the first two alone are not the same thing as "what the renderer accepts":
 *
 *   base-theme.yml     the structural floor, flat keys
 *   default-theme.yml  the effective default, nested — and the file a new theme is seeded from
 *   lib/**\/*.rb        every `@theme.<key>` the converter READS
 *
 * The third was missing, and its absence was a real defect rather than a gap in coverage. A theme
 * file only contains the keys it SETS; a key whose default lives in Ruby (`@theme.foo || fallback`)
 * appears in neither YAML file and so was absent from the catalogue — which meant the editor
 * underlined it as unrecognised in a theme that renders perfectly. `running-content.start-at` and
 * `page.numbering.start-at` were reported that way; the sweep found 138 such keys, including
 * `toc.dot-leader.*`, `toc.hanging-indent` and `page.column-gap`, which this repo's OWN shipped
 * extensions read. The converter is the authority on what it accepts, so it is now consulted.
 *
 * Prose descriptions cannot be derived (the YAML carries no documentation), so they live in the
 * hand-maintained `theme-descriptions.ts` table keyed by the SAME key this script emits. That table
 * is checked against this output by a test: describing a key the gem no longer has fails the build
 * rather than decaying quietly, which is what keeps the split honest.
 *
 * Run `pnpm --filter @asciidocollab/shared generate:theme-descriptors` after a gem bump. The output
 * is generated — never hand-edit it.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const GEM_ROOT = join(
  REPO_ROOT,
  'packages/asciidoc-pdf/ruby/.wasm-build/vendor/bundle/ruby/3.3.0/gems',
);
const OUTPUT = join(HERE, '..', 'src/render-config/theme-descriptors.generated.ts');
/**
 * A verbatim copy of the gem's default theme, committed alongside the descriptors.
 *
 * A newly created theme is seeded from this (FR-010), and it must be a COPY of the file the renderer
 * actually applies rather than a synthesis — otherwise "start from the default theme" would be
 * approximately true, and an author's first edit would be against a document that never matched what
 * they saw. The gem is gitignored, so without committing this the seed would be unavailable on every
 * fresh clone.
 */
const DEFAULT_THEME_OUTPUT = join(HERE, '..', 'src/render-config/default-theme.generated.ts');
/**
 * The named page-size table, in PDF points.
 *
 * `page.size: A4` is a name, not a measurement, and nothing in either theme file says how wide A4
 * is — the table lives in prawn's `PDF::Core::PageGeometry::SIZES`, which the converter looks the
 * name up in and falls back to `A4` when it misses. Hand-copying ~50 entries is exactly the kind of
 * table that goes stale silently at the next bump, so it is derived from the same vendored gem tree
 * as everything else here.
 */
const PAGE_SIZES_OUTPUT = join(HERE, '..', 'src/print-appearance/page-sizes.generated.ts');
/**
 * The theme loader's deprecated-spelling tables.
 *
 * The loader rewrites a handful of category and key spellings on the way in, so the export applies
 * settings written the old way. Which spellings those are is a pair of Ruby literals that has grown
 * between releases; deriving them is what keeps the preview reading the same theme the export does.
 */
const DEPRECATED_KEYS_OUTPUT = join(HERE, '..', 'src/print-appearance/deprecated-keys.generated.ts');

/** `'A4' => [595.28, 841.89],` — one entry of prawn's page-geometry table. */
const PAGE_SIZE_ENTRY = /^\s*'([^']+)'\s*=>\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*]/;

/**
 * Sub-trees whose CHILDREN are author-supplied names rather than theme settings. `font.catalog` maps
 * font family names to files, so descending would emit a descriptor for whatever fonts the default
 * theme happens to ship — keys no other project has. The container itself is a real setting.
 */
const OPAQUE_SUBTREES = new Set(['font.catalog', 'font.fallbacks']);

/**
 * Enumerated value sets, keyed by the key SUFFIX they apply to. These are the one thing neither theme
 * file states: a YAML value of `portrait` reveals that `portrait` is legal, never that `landscape`
 * is. Taken from the Asciidoctor-PDF theming guide for the version vendored above.
 */
const KEYWORD_SETS = [
  // MOST SPECIFIC FIRST: `keywordsFor` returns the first suffix that matches, so the generic
  // `text-align` entry below would otherwise shadow the caption-specific one and `inherit` — which
  // the gem explicitly honours for captions (converter.rb: `align == 'inherit' ? …`) and nowhere
  // else — would keep being reported as an error on a working theme.
  ['caption.align', ['left', 'center', 'right', 'justify', 'inherit']],
  ['caption.text-align', ['left', 'center', 'right', 'justify', 'inherit']],
  ['text-align', ['left', 'center', 'right', 'justify']],
  ['text-transform', ['none', 'uppercase', 'lowercase', 'capitalize']],
  ['text-decoration', ['none', 'underline', 'line-through']],
  ['font-style', ['normal', 'bold', 'italic', 'bold_italic', 'normal_italic']],
  ['page.layout', ['portrait', 'landscape']],
  ['page.initial-zoom', ['Fit', 'FitH', 'FitV']],
  // The gem's `PageModes` map, in full (converter.rb). `thumbs` and the three `fullscreen …`
  // combinations are as real as the rest — omitting them marked working themes with a hard error.
  ['page.mode', ['outline', 'none', 'thumbs', 'fullscreen', 'fullscreen outline', 'fullscreen none', 'fullscreen thumbs']],
  ['vertical-align', ['top', 'middle', 'bottom']],
  ['valign', ['top', 'middle', 'bottom']],
  ['align', ['left', 'center', 'right', 'justify']],
  ['border-style', ['solid', 'dashed', 'dotted', 'double']],
];

/**
 * Container paths that exist only in the converter's code, never in a shipped theme file.
 *
 * A flat Ruby key is segmented by matching it against container paths the YAML demonstrates (see
 * {@link dottedFromFlat}), which works for every category some shipped theme happens to nest. These
 * four categories are set by NO shipped theme at all, so there is no evidence to match and their
 * keys would be dropped — including `running-content.start-at`, which is what sent an author here.
 *
 * Listed rather than guessed, and each is a documented upstream category. The round-trip assertion
 * below is what keeps the list honest: whatever segmentation these produce must flatten back to the
 * exact key the converter reads, or generation fails.
 */
const CODE_ONLY_CONTAINERS = ['running-content', 'section', 'svg', 'page.numbering'];

/** Key suffixes whose value is a colour, whatever the YAML happens to hold. */
const COLOUR_SUFFIXES = ['color', 'colour'];
/** Key suffixes whose value names a font family from the catalogue. */
const FONT_SUFFIXES = ['font-family', 'font'];
/**
 * Key suffixes whose value is a length. Asciidoctor-PDF accepts a bare number (points) or a unit
 * string here, so the KEY — not the value — is what identifies the kind.
 */
const MEASUREMENT_SUFFIXES = [
  'margin',
  'margin-inner',
  'margin-outer',
  'padding',
  'width',
  'height',
  'size',
  'offset',
  'radius',
  'indent',
  'spacing',
  'rhythm',
  'gap',
  // Font sizes accept a unit (`1.2em`, `12pt`) as readily as a bare point count, so they are lengths
  // rather than plain numbers even where the default theme happens to write one.
  'font-size',
];

/** A `$variable` reference or a theme function call — the value says nothing about its own kind. */
const COMPUTED_VALUE = /^\s*(\$|round\(|ceil\(|floor\()/;
/** A bare 6-digit hex colour, with or without the leading `#` Asciidoctor-PDF makes optional. */
const HEX_COLOUR = /^#?[\da-f]{6}$/i;
/** A length with an explicit unit. */
const MEASUREMENT = /^-?\d+(\.\d+)?(in|mm|cm|pt|px|em|rem|vw|vh|%)$/i;

/**
 * Locate the vendored asciidoctor-pdf gem's theme directory, so a version bump needs no edit here.
 *
 * The gem lives under a gitignored build directory, so it is ABSENT on a fresh clone and in every CI
 * job that does not build the wasm engine. The generated catalogue is committed precisely so those
 * environments still have one; see the `--if-available` handling at the bottom of this file.
 */
function findGemThemeDirectory() {
  if (!existsSync(GEM_ROOT)) {
    throw new Error(
      `The asciidoctor-pdf gem is not vendored at ${GEM_ROOT}. Build the wasm engine first ` +
        '(packages/asciidoc-pdf/ruby/build-wasm.sh) — the catalogue is derived from the gem the app renders with.',
    );
  }
  const gems = readdirSync(GEM_ROOT).filter((name) => name.startsWith('asciidoctor-pdf-'));
  if (gems.length !== 1) {
    throw new Error(
      `Expected exactly one vendored asciidoctor-pdf gem, found ${gems.length}: ${gems.join(', ')}. ` +
        'Two versions means the catalogue could be derived from a gem the app does not render with.',
    );
  }
  return { directory: join(GEM_ROOT, gems[0], 'data/themes'), version: gems[0].replace('asciidoctor-pdf-', '') };
}

/** The directories under {@link GEM_ROOT} whose names start with `prefix`, as full paths. */
function gemDirectories(prefix) {
  return readdirSync(GEM_ROOT)
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(GEM_ROOT, name));
}

/**
 * Which of the files this script reads are not there, so that "available" can mean what the
 * generation NEEDS rather than what a directory is called.
 *
 * `--if-available` used to ask only whether {@link GEM_ROOT} existed, and every other input was
 * discovered by reading it. A tree that exists and is incomplete is exactly the state an interrupted
 * or half-restored wasm build leaves behind — which is the state the flag exists for — and against
 * one the generation threw: an empty tree failed with "Expected exactly one vendored asciidoctor-pdf
 * gem, found 0", and a tree holding the asciidoctor-pdf gem but no `pdf-core-*` failed with a raw
 * `ENOENT`. Either one fails the `prebuild` hook, so nothing in the workspace builds — from a
 * directory whose whole point is that the build does not depend on it.
 *
 * Every path the generation reads is listed here rather than only the two that happened to break.
 * A missing input is an ABSENT gem tree; anything else — two versions of a gem, a file present whose
 * contents no longer parse — is drift, and drift still fails loudly, under `--if-available` as much
 * as without it, because keeping a stale catalogue over a gem the app renders with is the defect
 * `--check` was added to end.
 *
 * @returns The missing paths, in the order they would have been read; empty when the tree is whole.
 */
function missingGemInputs() {
  let pdf;
  let core;
  try {
    if (!existsSync(GEM_ROOT)) return [GEM_ROOT];
    pdf = gemDirectories('asciidoctor-pdf-');
    core = gemDirectories('pdf-core-');
  } catch {
    // `GEM_ROOT` is there but is not a readable directory: nothing can be derived from it either.
    return [GEM_ROOT];
  }
  const missing = [];
  // Only NONE is absence. Two versions of a gem is an ambiguity about which one the app renders
  // with, and `findGemThemeDirectory` and `buildPageSizes` refuse it in either mode — a skip there
  // would leave the catalogue derived from a gem nobody chose.
  if (pdf.length === 0) missing.push(join(GEM_ROOT, 'asciidoctor-pdf-*'));
  else if (pdf.length === 1) {
    for (const relative of [
      'data/themes/default-theme.yml',
      'data/themes/base-theme.yml',
      'lib',
      'lib/asciidoctor/pdf/theme_loader.rb',
    ]) {
      if (!existsSync(join(pdf[0], relative))) missing.push(join(pdf[0], relative));
    }
  }
  if (core.length === 0) missing.push(join(GEM_ROOT, 'pdf-core-*'));
  else if (core.length === 1 && !existsSync(join(core[0], 'lib/pdf/core/page_geometry.rb'))) {
    missing.push(join(core[0], 'lib/pdf/core/page_geometry.rb'));
  }
  return missing;
}

/** Normalize a YAML key segment to the hyphenated form the theming guide documents. */
function normalizeSegment(segment) {
  return String(segment).replaceAll('_', '-');
}

/**
 * Convert base-theme.yml's flat `a_b_c` key into the dotted form, using the container paths already
 * derived from default-theme.yml to find the segment boundaries.
 *
 * A flat key alone is genuinely ambiguous: `title_page_text_align` could be `title.page.text-align`
 * or `title-page.text-align`, because the flat form uses `_` both to nest AND inside a single
 * segment. Splitting on `_` therefore cannot work. Instead each known container path is flattened
 * the same way the gem flattens it, and the longest one that prefixes this key wins — which decides
 * the boundary by evidence rather than by guess. A key matching no container is reported, never
 * split speculatively, because a mis-split key would offer completion for a setting the renderer
 * does not have.
 */
function dottedFromFlat(flatKey, containers) {
  const flatten_ = (path) => path.replaceAll('.', '_').replaceAll('-', '_');
  // A few base-theme keys carry a literal hyphen inside a segment (`role_line-through_...`), so both
  // sides are compared hyphen-blind. The substitution is 1:1, so offsets survive it and the leaf can
  // still be sliced out of the ORIGINAL key with its own hyphens intact.
  const comparable = flatten_(flatKey);
  let best = null;
  for (const container of containers) {
    const prefix = `${flatten_(container)}_`;
    if (!comparable.startsWith(prefix)) continue;
    if (best === null || prefix.length > flatten_(best).length + 1) best = container;
  }
  if (best === null) return null;
  const leaf = flatKey.slice(flatten_(best).length + 1);
  return `${best}.${normalizeSegment(leaf)}`;
}

/** Walk a parsed theme into `dotted key → raw value`, plus the set of container paths seen. */
function flatten(node, prefix, out, containers) {
  for (const [rawKey, value] of Object.entries(node)) {
    const key = prefix === '' ? normalizeSegment(rawKey) : `${prefix}.${normalizeSegment(rawKey)}`;
    const isBranch = value !== null && typeof value === 'object' && !Array.isArray(value);
    if (isBranch && !OPAQUE_SUBTREES.has(key)) {
      containers.add(key);
      flatten(value, key, out, containers);
    } else {
      out.set(key, value);
    }
  }
}

/** The enumerated values legal for `key`, or null when it is not a keyword setting. */
function keywordsFor(key) {
  for (const [suffix, values] of KEYWORD_SETS) {
    if (key === suffix || key.endsWith(`.${suffix}`)) return values;
  }
  return null;
}

/**
 * True when `key`'s final segment is, or ends with, one of `suffixes`.
 *
 * The hyphen case is the one that matters: `heading.font-color` and `code.background-color` are both
 * colours, and matching only on a whole segment or a dot boundary would miss every one of them.
 */
function hasSuffix(key, suffixes) {
  const last = key.slice(key.lastIndexOf('.') + 1);
  return suffixes.some((suffix) => last === suffix || last.endsWith(`-${suffix}`));
}

/**
 * Infer what kind of value a key takes.
 *
 * Key-driven first, value-driven second. The default theme is full of `$base-font-size * 1.25` and
 * `round(...)`, so the value frequently says nothing about its own kind — but `heading.font-color` is
 * a colour whatever expression currently computes it.
 */
function inferValueKind(key, value) {
  if (keywordsFor(key) !== null) return 'keyword';
  if (hasSuffix(key, COLOUR_SUFFIXES)) return 'colour';
  if (hasSuffix(key, FONT_SUFFIXES)) return 'font';
  if (typeof value === 'boolean') return 'boolean';
  if (hasSuffix(key, MEASUREMENT_SUFFIXES)) return 'measurement';

  const text = value === null || value === undefined ? '' : String(value);
  if (COMPUTED_VALUE.test(text)) return 'measurement';
  if (Array.isArray(value)) {
    return value.every((entry) => MEASUREMENT.test(String(entry)) || typeof entry === 'number')
      ? 'measurement'
      : 'string';
  }
  if (typeof value === 'number') return 'number';
  if (MEASUREMENT.test(text)) return 'measurement';
  if (HEX_COLOUR.test(text)) return 'colour';
  return 'string';
}

/** Render a value back to the text an author would type for it, or null when it has no default. */
function defaultText(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  // An opaque sub-tree (the font catalogue) has no single value an author would type; offering
  // `[object Object]` as its default would be worse than offering nothing.
  if (typeof value === 'object') return null;
  return String(value);
}

/**
 * Every theme key the converter reads, as the flat snake_case name Ruby uses.
 *
 * Reads are `@theme.<key>` / `theme.<key>`, which also matches ordinary methods on the theme object
 * (`to_h`, `dup`, `style_for`). Those are not filtered by a denylist — they are filtered by having no
 * container that could segment them, which is a property of being a key rather than a list to
 * maintain. Dynamically-composed reads (`@theme[%(#{category}_font_color)]`) cannot be recovered from
 * source and are simply not found; they are all under categories the YAML already covers.
 *
 * @param gemRoot - The vendored gem's directory.
 * @returns The distinct flat key names, sorted.
 */
function scanCodeReadKeys(gemRoot) {
  const found = new Set();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.rb')) {
        for (const match of readFileSync(full, 'utf8').matchAll(/(?:@theme|theme)\.([a-z][a-z0-9_]*)/g)) {
          found.add(match[1]);
        }
      }
    }
  };
  walk(join(gemRoot, 'lib'));
  return [...found].sort();
}

/** Build the descriptor list from the gem's two theme files. */
function buildDescriptors(themeDirectory, gemRoot) {
  const defaults = parse(readFileSync(join(themeDirectory, 'default-theme.yml'), 'utf8')) ?? {};
  const base = parse(readFileSync(join(themeDirectory, 'base-theme.yml'), 'utf8')) ?? {};

  const values = new Map();
  const containers = new Set();
  flatten(defaults, '', values, containers);
  for (const container of CODE_ONLY_CONTAINERS) containers.add(container);

  // base-theme.yml is flat, and carries a handful of keys default-theme.yml never sets. Fold in the
  // ones whose dotted form is unambiguous; report the rest rather than guess a segmentation.
  const unmapped = [];
  for (const [flatKey, value] of Object.entries(base)) {
    const dotted = dottedFromFlat(flatKey, containers);
    if (dotted === null) {
      unmapped.push(flatKey);
      continue;
    }
    if (!values.has(dotted)) values.set(dotted, value);
  }

  // The converter's own reads. These carry no value — their default lives in Ruby, not in a theme
  // file — so they are added as keys WITHOUT a `defaultValue`, and their kind is inferred from the
  // key alone, which is what `inferValueKind` does first for every key anyway.
  const flattenKey = (path) => path.replaceAll('.', '_').replaceAll('-', '_');
  const known = new Set([...values.keys()].map(flattenKey));
  const codeOnly = new Set();
  for (const flatKey of scanCodeReadKeys(gemRoot)) {
    if (known.has(flatKey)) continue;
    const dotted = dottedFromFlat(flatKey, containers);
    // No container can segment it: either an ordinary method on the theme object, or a category no
    // shipped theme demonstrates and CODE_ONLY_CONTAINERS does not name. Neither may be guessed at.
    if (dotted === null) continue;
    // THE assertion that makes a derived key real rather than invented. The renderer flattens a
    // theme by joining nested keys with `_`, so `a.b-c` and `a.b.c` are the same key to it — which
    // means the segmentation chosen here is free to be wrong in a way nothing else would notice.
    // Requiring the round trip pins it: whatever dotted form is emitted MUST flatten back to the
    // exact name the converter reads, or this key is not the key it looks like.
    if (flattenKey(dotted) !== flatKey) {
      throw new Error(
        `Segmentation of the code-read key '${flatKey}' produced '${dotted}', which flattens to ` +
          `'${flattenKey(dotted)}'. The renderer would not resolve it to the same setting.`,
      );
    }
    if (!values.has(dotted)) {
      values.set(dotted, undefined);
      codeOnly.add(dotted);
    }
  }

  const descriptors = [...values.entries()]
    .map(([key, value]) => {
      const permitted = keywordsFor(key);
      return {
        key,
        category: key.slice(0, key.indexOf('.') === -1 ? key.length : key.indexOf('.')),
        valueKind: inferValueKind(key, value),
        ...(permitted === null ? {} : { permittedValues: permitted }),
        ...(defaultText(value) === null ? {} : { defaultValue: defaultText(value) }),
      };
    })
    // Sorted by CODE UNIT, not by `localeCompare` — the same rule, for the same reason, as
    // `generate-catalogue-fonts.mjs:276` and `generate-base14-fonts.mjs:927`. What `--check` compares
    // is the emitted TEXT, so the order the descriptors are written in has to be a property of their
    // keys and of nothing else; `localeCompare` consults the runtime's collation and its default
    // locale, both of which are the environment's to change.
    //
    // This one was not hypothetical. Czech collates `ch` as a SINGLE element that sorts after `h`, so
    // under `LC_ALL=cs_CZ.UTF-8` `heading.chapter-break-before` sorts after `heading.font-color` and
    // `--check` exits 1 on an unmodified checkout — a drift report about a locale rather than about
    // the gems. `LC_ALL=C` exited 0 on the same tree. A check whose verdict depends on the runner's
    // language is not a check.
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // D1: a duplicate key would make completion ambiguous about which descriptor applies.
  const seen = new Set();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.key)) throw new Error(`Duplicate theme key derived: ${descriptor.key}`);
    seen.add(descriptor.key);
  }

  return { descriptors, unmapped, codeOnlyCount: codeOnly.size };
}

/** Emit the generated TypeScript module. */
function emit(descriptors, version, unmapped) {
  const body = descriptors
    .map((descriptor) => `  ${JSON.stringify(descriptor)},`)
    .join('\n');
  return `/**
 * @file GENERATED — do not edit.
 *
 * Derived from asciidoctor-pdf ${version}'s own \`base-theme.yml\` and \`default-theme.yml\` by
 * \`packages/shared/scripts/generate-theme-descriptors.mjs\`. Regenerate after a gem bump:
 *
 *     \`pnpm --filter @asciidocollab/shared generate:theme-descriptors\`
 *
 * Prose descriptions are NOT here — they live in the hand-maintained \`theme-descriptions.ts\` and
 * are merged in \`theme-catalogue.ts\`.
 *${
   unmapped.length === 0
     ? ''
     : `\n * Flat base-theme keys with no unambiguous dotted form (not offered):\n *   ${unmapped.join(', ')}\n *`
 }
 */

import type { GeneratedThemeDescriptor } from './theme-descriptor-types';

/** The asciidoctor-pdf release these descriptors were derived from. */
export const THEME_DESCRIPTOR_GEM_VERSION = '${version}';

/** Every theme key the vendored renderer recognises, with its derived kind and default. */
export const GENERATED_THEME_DESCRIPTORS: readonly GeneratedThemeDescriptor[] = [
${body}
];
`;
}

/** Emit the gem's default theme verbatim as a TypeScript string module. */
function emitDefaultTheme(themeText, version) {
  // A template literal keeps the file readable in a diff, so a gem bump shows what actually changed
  // in the theme rather than one opaque re-encoded blob.
  const escaped = themeText.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');
  return `/**
 * @file GENERATED — do not edit.
 *
 * A verbatim copy of asciidoctor-pdf ${version}'s \`default-theme.yml\`, the file a newly created
 * project theme is seeded from. Regenerate with:
 *
 *     \`pnpm --filter @asciidocollab/shared generate:theme-descriptors\`
 */

/** The asciidoctor-pdf release this theme was copied from. */
export const DEFAULT_THEME_GEM_VERSION = '${version}';

/** The gem's default theme, byte-for-byte. */
export const DEFAULT_THEME_YAML = \`${escaped}\`;
`;
}

/**
 * Read the loader's two deprecated-spelling tables out of the vendored asciidoctor-pdf gem.
 *
 * `ThemeLoader#process_entry` REWRITES a key before storing it (`theme_loader.rb:167-176`): a
 * deprecated category becomes its current name, and a deprecated key becomes the key that replaced
 * it. Both are silent as far as the produced PDF is concerned — the export applies the setting — so
 * a preview that does not perform the same rewrite shows a different page and reports nothing.
 *
 * The tables are DERIVED rather than transcribed for the same reason the descriptors are: the key
 * table is not a list at all in the source, it is one literal pair plus a suffix rename applied over
 * a prefix list, and the prefix list gained entries between gem releases. A hand-copied subset would
 * be a subset of one release forever.
 *
 * @param gemDirectory - The vendored asciidoctor-pdf gem's root.
 * @returns The category table, the key table, and the role-key rename rule.
 */
function buildDeprecatedKeys(gemDirectory) {
  const source = readFileSync(join(gemDirectory, 'lib/asciidoctor/pdf/theme_loader.rb'), 'utf8');
  /** `'old' => 'new'` — one pair of either table's Ruby literal. */
  const pair = /'([\da-z_]+)'\s*=>\s*'([\da-z_]+)'/g;

  const categoryLine = lineDeclaring(source, 'DeprecatedCategoryKeys');
  const categories = [...categoryLine.matchAll(pair)].map((match) => [match[1], match[2]]);

  const keyLine = lineDeclaring(source, 'DeprecatedKeys');
  // Everything before `.tap` is the literal hash; the block after it is the generated half.
  const tapAt = keyLine.indexOf('.tap');
  const keys = [...keyLine.slice(0, tapAt).matchAll(pair)].map((match) => [match[1], match[2]]);
  const prefixes = /%w\(([^)]*)\)/.exec(keyLine.slice(tapAt));
  // `accum[%(#{prefix}_align)] = %(#{prefix}_text_align)` — the two interpolated templates, read
  // rather than assumed, so a release that renamed a different suffix is followed rather than missed.
  const rename = /accum\[%\(#\{prefix\}([\da-z_]+)\)\]\s*=\s*%\(#\{prefix\}([\da-z_]+)\)/.exec(
    keyLine.slice(tapAt),
  );
  if (prefixes === null || rename === null) {
    throw new Error(
      'ThemeLoader::DeprecatedKeys is no longer a prefix list with an interpolated rename — ' +
        'the preview would silently stop following the loader on every key it generates.',
    );
  }
  for (const prefix of prefixes[1].split(/\s+/).filter((entry) => entry !== '')) {
    keys.push([`${prefix}${rename[1]}`, `${prefix}${rename[2]}`]);
  }

  // The loader's one rule that is not a table: a `role_…_align` key is renamed by regex rather than
  // by lookup, because role names are author-chosen and cannot be enumerated.
  const roleRule = /RoleAlignKeyRx\s*=\s*\/(.+?)\/\s*$/m.exec(source);
  if (roleRule === null) throw new Error('ThemeLoader::RoleAlignKeyRx is gone; the role rename cannot be followed.');

  if (categories.length === 0 || keys.length === 0) {
    throw new Error('One of the theme loader’s deprecated-spelling tables parsed empty — the literals changed shape.');
  }
  return { categories, keys, roleSuffix: roleRule[1], roleReplacement: rename[2] };
}

/** The single source line declaring a Ruby constant, which is where each of these tables lives. */
function lineDeclaring(source, constant) {
  const line = source.split('\n').find((entry) => entry.trimStart().startsWith(`${constant} =`));
  if (line === undefined) throw new Error(`ThemeLoader::${constant} is gone from the vendored gem.`);
  return line;
}

/** Emit the deprecated-spelling tables as a TypeScript module. */
function emitDeprecatedKeys(tables, version) {
  const entries = (pairs) => pairs.map(([from, to]) => `  ${from}: '${to}',`).join('\n');
  return `/**
 * @file GENERATED — do not edit.
 *
 * The spellings asciidoctor-pdf ${version}'s \`ThemeLoader\` still honours, read from
 * \`lib/asciidoctor/pdf/theme_loader.rb\` by
 * \`packages/shared/scripts/generate-theme-descriptors.mjs\`. Regenerate after a gem bump:
 *
 *     \`pnpm --filter @asciidocollab/shared generate:theme-descriptors\`
 *
 * \`process_entry\` renames a key BEFORE storing it, and says nothing while doing so. The export
 * therefore applies \`sidebar: title: align\` exactly as if it had been written \`text-align\`, and a
 * resolver that keeps the written spelling drops the setting instead — showing a page the export
 * will not produce, with an empty diagnostics list.
 */

/** Categories the loader renames whole, applied to a mapping's own key. */
export const DEPRECATED_THEME_CATEGORIES: Readonly<Record<string, string>> = {
${entries(tables.categories)}
};

/** Individual settings the loader renames, applied to a leaf key. */
export const DEPRECATED_THEME_KEYS: Readonly<Record<string, string>> = {
${entries(tables.keys)}
};

/**
 * The suffix a \`role_…\` key's alignment is renamed by, which is a rule rather than a table because
 * role names are the author's own.
 */
export const ROLE_ALIGN_SUFFIX = /${tables.roleSuffix}/;

/** What {@link ROLE_ALIGN_SUFFIX} is replaced with. */
export const ROLE_ALIGN_REPLACEMENT = '${tables.roleReplacement}';
`;
}

/**
 * Read prawn's named page-size table out of the vendored `pdf-core` gem.
 *
 * Parsed line-by-line from the Ruby literal rather than by evaluating anything: the literal is a
 * flat list of `'NAME' => [w, h]` pairs, and a regex over it either matches an entry or does not.
 *
 * @returns The table (name → [width, height] in points) and the pdf-core version it came from.
 */
function buildPageSizes() {
  const gems = readdirSync(GEM_ROOT).filter((name) => name.startsWith('pdf-core-'));
  if (gems.length !== 1) {
    throw new Error(
      `Expected exactly one vendored pdf-core gem, found ${gems.length}: ${gems.join(', ')}. ` +
        'Two versions means the page-size table could come from a gem the app does not render with.',
    );
  }
  const source = readFileSync(join(GEM_ROOT, gems[0], 'lib/pdf/core/page_geometry.rb'), 'utf8');
  // Only the SIZES literal — the file opens with a doc comment listing the same dimensions in prose,
  // and matching those would silently double the table with commented-out values.
  const literal = source.slice(source.indexOf('SIZES = {'), source.indexOf('}.freeze'));
  const sizes = [];
  for (const line of literal.split('\n')) {
    const match = PAGE_SIZE_ENTRY.exec(line);
    if (match !== null) sizes.push([match[1], Number(match[2]), Number(match[3])]);
  }
  if (sizes.length === 0) {
    throw new Error('No page sizes parsed from pdf-core page_geometry.rb — the literal has changed shape.');
  }
  if (!sizes.some(([name]) => name === 'A4')) {
    throw new Error('The page-size table has no A4 entry, which the converter falls back to.');
  }
  return { sizes, version: gems[0].replace('pdf-core-', '') };
}

/** Emit the named page-size table as a TypeScript module. */
function emitPageSizes(sizes, version) {
  const body = sizes.map(([name, width, height]) => `  '${name}': [${width}, ${height}],`).join('\n');
  return `/**
 * @file GENERATED — do not edit.
 *
 * prawn's named page-size table (\`PDF::Core::PageGeometry::SIZES\`) from pdf-core ${version}, as
 * vendored beneath asciidoctor-pdf, emitted by
 * \`packages/shared/scripts/generate-theme-descriptors.mjs\`. Regenerate after a gem bump:
 *
 *     \`pnpm --filter @asciidocollab/shared generate:theme-descriptors\`
 *
 * A theme writes \`page.size: A4\`, which is a name; the converter looks it up here and falls back to
 * A4 when the name is not one of these. Every dimension is in PDF points (1/72 inch).
 */

/** The pdf-core release this table was read from. */
export const PAGE_SIZE_GEM_VERSION = '${version}';

/** Portrait width and height, in points, for every page size the renderer recognises by name. */
export const NAMED_PAGE_SIZES_PT: Readonly<Record<string, readonly [number, number]>> = {
${body}
};

/** The size the renderer falls back to when a theme names one it does not recognise. */
export const FALLBACK_PAGE_SIZE_NAME = 'A4';
`;
}

/**
 * Everything this script derives from the gems, as `path → the text that belongs there`.
 *
 * One function for both modes, deliberately: a `--check` that re-derived the outputs by a different
 * route than the writer takes would be checking two implementations against each other rather than
 * the committed file against the gem, and could pass while the generator emitted something else.
 *
 * @returns The four generated modules, and a summary line for the log.
 */
function buildAll() {
  const { directory, version } = findGemThemeDirectory();
  const gemDirectory = join(directory, '..', '..');
  const { descriptors, unmapped, codeOnlyCount } = buildDescriptors(directory, gemDirectory);
  const { sizes, version: pageSizeVersion } = buildPageSizes();
  const deprecated = buildDeprecatedKeys(gemDirectory);
  return {
    files: new Map([
      [OUTPUT, emit(descriptors, version, unmapped)],
      [
        DEFAULT_THEME_OUTPUT,
        emitDefaultTheme(readFileSync(join(directory, 'default-theme.yml'), 'utf8'), version),
      ],
      [PAGE_SIZES_OUTPUT, emitPageSizes(sizes, pageSizeVersion)],
      [DEPRECATED_KEYS_OUTPUT, emitDeprecatedKeys(deprecated, version)],
    ]),
    summary:
      `${descriptors.length} theme descriptors (${codeOnlyCount} read from converter source, ` +
      `not set by any shipped theme) from asciidoctor-pdf ${version}` +
      `\n${sizes.length} named page sizes from pdf-core ${pageSizeVersion}` +
      `\n${deprecated.categories.length} deprecated categories and ${deprecated.keys.length} ` +
      `deprecated keys from asciidoctor-pdf ${version}` +
      (unmapped.length === 0
        ? ''
        : `\n  ${unmapped.length} flat base-theme keys skipped: ${unmapped.join(', ')}`),
  };
}

/**
 * The whole of this script's command line.
 *
 * Both flags used to be looked for with `argv.includes`, which asks whether the exact string is
 * present and says nothing about the rest. `--check=true` is therefore not `--check`, not any other
 * known flag either, and fell through to the branch that WRITES — the one mode a caller who typed
 * `--check` was asking this script not to enter — and exited 0, reporting success for a check that
 * never ran. Nothing passes that form today; the point is that no argument should be able to mean
 * "no arguments at all".
 *
 * So the flags are the whole vocabulary, matched exactly, and anything else is refused by name. They
 * are boolean and have no `=value` form: accepting `--check=false` as a request to check would be a
 * second silent misreading in the opposite direction.
 */
const ARGUMENTS = process.argv.slice(2);
const KNOWN_FLAGS = ['--check', '--if-available'];
const unrecognised = ARGUMENTS.filter((argument) => !KNOWN_FLAGS.includes(argument));
if (unrecognised.length > 0) {
  console.error(
    `Unrecognised argument${unrecognised.length === 1 ? '' : 's'}: ${unrecognised.join(', ')}\n` +
      `This script takes ${KNOWN_FLAGS.join(' and ')}, on their own and with no value.`,
  );
  process.exit(1);
}

/**
 * `--if-available` is what the build hook passes: regenerate when the gems are there (so a bump can
 * never ship a stale catalogue), and fall back to the committed output when they are not (so a fresh
 * clone still builds). An explicit `generate:theme-descriptors` passes no flag and fails loudly,
 * because someone who asked for regeneration should be told it did not happen.
 *
 * "There" means every file the generation reads — see {@link missingGemInputs}, and the incomplete
 * trees that used to fail the build hook outright.
 */
const optional = ARGUMENTS.includes('--if-available');
/**
 * `--check` compares the committed modules against what the vendored gems say they should be, and
 * writes nothing.
 *
 * It exists because `--if-available` cannot catch drift and was the only thing running here: the gem
 * tree is gitignored, so on every machine and every CI job without a wasm build the generator finds
 * no gems and no-ops — which reads exactly like "up to date". A `Gemfile.lock` bump that adds theme
 * keys, renames a deprecated spelling or changes a page size therefore left four committed modules
 * describing the PREVIOUS renderer, silently: the editor underlines keys the gem now has as
 * unrecognised, and the preview resolves a theme the export no longer reads the same way.
 *
 * Deliberately NOT `--if-available`-shaped. A check that skipped when the gems are absent would be a
 * check that never fails, which is the defect it was written to end. It is wired into the one job
 * that holds the gems (`pdf-wasm`), and it fails there when they are missing.
 *
 * Which is why it is tested BEFORE `--if-available` below, and not after. The two flags are not
 * mutually exclusive — `pnpm --filter … check:theme-descriptors --if-available` forwards the extra
 * flag verbatim onto the same command line — and with `--if-available` tested first, a runner with no
 * gems printed "keeping the committed catalogue" and exited 0 for a command that had asked to be told
 * about drift. Nothing in this repository passes both today; the ordering is what stops the first
 * caller that does from silently disabling the only check that can catch a stale catalogue.
 */
const check = ARGUMENTS.includes('--check');

if (check) {
  const { files, summary } = buildAll();
  const stale = [];
  for (const [path, text] of files) {
    if (!existsSync(path)) {
      stale.push(`${path} is not committed`);
    } else if (readFileSync(path, 'utf8') !== text) {
      stale.push(`${path} does not match the vendored gems`);
    }
  }
  if (stale.length > 0) {
    console.error(
      `The committed theme descriptors are out of date with the vendored gems:\n  ${stale.join('\n  ')}\n\n` +
        'Run: pnpm --filter @asciidocollab/shared generate:theme-descriptors',
    );
    process.exitCode = 1;
  } else {
    console.log(`The committed theme descriptors match the vendored gems:\n${summary}`);
  }
} else {
  const missing = optional ? missingGemInputs() : [];
  if (missing.length > 0) {
    console.log(
      'The vendored asciidoctor-pdf gems are not all there; keeping the committed theme descriptor ' +
        `catalogue. Build the wasm engine and re-run to regenerate it. Missing:\n  ${missing.join('\n  ')}`,
    );
  } else {
    const { files, summary } = buildAll();
    for (const [path, text] of files) writeFileSync(path, text, 'utf8');
    console.log(`Generated:\n${summary}`);
  }
}
