// Generates a scoped copy of the vendored Asciidoctor stylesheet so its global
// selectors cannot leak into the application chrome (Constitution VI — Style Isolation).
//
// Every selector is prefixed with
//   .asciidoc-preview-content[data-preview-style="asciidoctor"]
// Root selectors (html, body, :root, *) are mapped onto the scope itself rather than
// becoming an (always-empty) descendant selector. At-rules (@media, etc.) are preserved;
// their inner rules are prefixed like any other rule.
//
// DO NOT edit the generated output by hand — edit the vendored source and re-run:
//   pnpm --filter @asciidocollab/web run build:asciidoctor-style
//   pnpm --filter @asciidocollab/web run check:asciidoctor-style   # verify it, change nothing
//
// `--check` is what makes the "do not edit by hand" line above enforceable. This script also runs as
// a `prebuild`/`predev` hook, and that hook OVERWRITES the committed stylesheet rather than comparing
// against it — so a hand edit inside the generated file, or a re-vendored source that nobody
// regenerated from, was invisible to every build and every CI job. It is wired into
// scripts/ci/quality.sh BEFORE `pnpm -r build`, because the build's own `prebuild` regenerates this
// file and a check that ran afterwards would be comparing the generator against itself.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import postcss from 'postcss';
import prefixSelector from 'postcss-prefix-selector';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, '../src/styles/vendor/asciidoctor-default.css');
const OUTPUT = resolve(here, '../src/styles/asciidoctor-style.generated.css');
const SCOPE = '.asciidoc-preview-content[data-preview-style="asciidoctor"]';

// Selectors that target the document root; under our scope these must collapse onto the
// scoped container itself, otherwise `.scope html` / `.scope body` would never match.
const ROOT_SELECTORS = new Set(['html', 'body', ':root']);

const transform = (prefix, selector, prefixedSelector) => {
  const trimmed = selector.trim();
  if (ROOT_SELECTORS.has(trimmed)) return prefix;
  // e.g. `body.book`, `html.foo` → replace the leading root element with the scope.
  if (/^(html|body)(?=[.:#[\s]|$)/.test(trimmed)) {
    return trimmed.replace(/^(html|body)/, prefix);
  }
  // Universal and everything else keep the default `${prefix} ${selector}` form,
  // which is correct for `*`, `*::before`, and ordinary descendant selectors.
  return prefixedSelector;
};

// Cleans up rules that selector-prefixing alone cannot make safe:
//  1. Legacy IE star/underscore property hacks (e.g. `*zoom:1`) — invalid modern CSS that
//     Next.js's stricter parser rejects. Valid Unicode escapes in `content` values
//     (e.g. `\00a0`) are untouched — only the hack *property names* are dropped.
//  2. Page-level at-rules (`@page`) — these have no selector to prefix, so they would leak
//     into the whole application's print layout. They must be removed to keep the stylesheet
//     confined to the preview surface (Constitution VI — Style Isolation).
const stripUnscopableRules = () => ({
  postcssPlugin: 'strip-unscopable-rules',
  Declaration(decl) {
    // The star/underscore hack prefix is parsed into the declaration's `before` raw
    // (e.g. `*zoom:1` → prop `zoom`, before `*`), not into the property name.
    const before = (decl.raws.before ?? '').trim();
    if (decl.prop.startsWith('*') || decl.prop.startsWith('_') || before === '*' || before === '_') {
      decl.remove();
    }
  },
  AtRule(atRule) {
    if (atRule.name === 'page') {
      atRule.remove();
    }
  },
});
stripUnscopableRules.postcss = true;

const source = readFileSync(SOURCE, 'utf8');
const { css } = postcss([
  prefixSelector({ prefix: SCOPE, transform }),
  stripUnscopableRules,
]).process(source, { from: SOURCE, to: OUTPUT });

const banner =
  '/* GENERATED FILE — do not edit. Source: src/styles/vendor/asciidoctor-default.css\n' +
  ` * Scoped to ${SCOPE} by scripts/build-asciidoctor-style.mjs.\n` +
  ' * Re-run: pnpm --filter @asciidocollab/web run build:asciidoctor-style */\n';

// The vendored stylesheet relies on the browser's UA defaults for base list markers
// (it only sets list-style-type for the special variants like ul.disc / ol.loweralpha).
// Tailwind's Preflight resets `ul, ol { list-style: none }` app-wide, which strips those
// UA defaults, so plain lists in the preview lose their bullets/numbers. Re-establish the
// defaults inside the scope. Appended last so it beats the vendored `ul,ol,dl` base rule
// (equal specificity, later wins); the higher-specificity variant rules (ul.none,
// ol.loweralpha, …) still override it. Kept here — not hand-added to the generated file —
// so it survives re-vendoring + a rebuild.
const listMarkerCompensation =
  '\n/* Added by build-asciidoctor-style.mjs — restore UA list markers stripped by Tailwind Preflight. */\n' +
  `${SCOPE} ul{list-style-type:disc}\n` +
  `${SCOPE} ol{list-style-type:decimal}\n`;

const rendered = banner + css + listMarkerCompensation;

if (process.argv.includes('--check')) {
  let existing = null;
  try {
    existing = readFileSync(OUTPUT, 'utf8');
  } catch {
    existing = null;
  }
  if (existing !== rendered) {
    console.error(
      `${OUTPUT}\ndoes not match what ${SOURCE}\nproduces under the ${SCOPE} scope.\n\n` +
        'Run: pnpm --filter @asciidocollab/web run build:asciidoctor-style',
    );
    process.exitCode = 1;
  } else {
    console.log(`The committed scoped Asciidoctor stylesheet matches its vendored source (${rendered.length} bytes).`);
  }
} else {
  writeFileSync(OUTPUT, rendered);
  console.log(`Wrote ${OUTPUT}`);
}
