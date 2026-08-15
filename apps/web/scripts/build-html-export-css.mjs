// Generates the stylesheet payloads an HTML export inlines into the file it produces.
//
// An exported document is a standalone file with no application around it, so the CSS that dresses
// the preview on screen has to travel with it. Two things have to be carried:
//
//   1. The two preview stylesheets, VERBATIM. The export reuses the preview's own container class
//      (`.asciidoc-preview-content` + `data-preview-style`), so the selectors already match and no
//      re-scoping is needed — which also means the exported file renders exactly like the panel.
//   2. The design-token values. The app's own stylesheet is written against `hsl(var(--foreground))`
//      and friends, which resolve only because the app declares them on `:root` / `.dark`. Stripped
//      of the app they resolve to nothing and every colour collapses, so the token declarations are
//      extracted here and re-emitted scoped to the export container.
//
// Only custom properties are taken from globals.css — never its layout, resets or Tailwind layers,
// which belong to the application chrome and would fight the document's own styling.
//
// DO NOT edit the generated output by hand — edit the sources and re-run:
//   pnpm --filter @asciidocollab/web run build:html-export-css
//   pnpm --filter @asciidocollab/web run check:html-export-css   # verify it, change nothing
//
// `--check` exists for the same reason it exists on `build-print-highlight-css.mjs` and
// `build-hljs-language-map.mjs`, and it is not interchangeable with the `prebuild` hook that also
// runs this script. The hook OVERWRITES the committed module, so it can never disagree with it: a
// hand edit inside the generated file, or a committed output that no source produces, survives every
// build and every CI job looking exactly like a generated artefact. Nothing in the repository
// confirmed that this file's committed bytes came from these sources until `--check` was wired into
// scripts/ci/quality.sh — and it is wired in BEFORE `pnpm -r build` there, deliberately, because the
// build's own `prebuild` regenerates this file and a check that ran after it would compare the
// generator against itself.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import postcss from 'postcss';

const here = dirname(fileURLToPath(import.meta.url));
const GLOBALS = resolve(here, '../src/styles/globals.css');
const COLLAB_CSS = resolve(here, '../src/styles/asciidoc-preview.css');
const ASCIIDOCTOR_CSS = resolve(here, '../src/styles/asciidoctor-style.generated.css');
const OUTPUT = resolve(here, '../src/lib/html-export/export-css.generated.ts');

/**
 * Where the export declares its design tokens.
 *
 * BOTH the document root and the content container, and the root matters as much as the container. An
 * exported file has page-level rules of its own — the body's background and text colour, the details
 * line — and they are written against the same tokens. Declared on the container alone, those tokens do
 * not exist as far as the body is concerned, `background: hsl(var(--background))` is invalid at
 * computed-value time, and the declaration is DROPPED: the page keeps the browser's default white
 * while the text column paints itself from the palette. That is the "page background does not match the
 * content" bug, and it is a scoping mistake rather than a colour one.
 *
 * The container is kept in the list so the preview stylesheet's own selectors keep resolving even if a
 * future export were to place the content somewhere other than inside that root.
 */
const EXPORT_SCOPE = ':root, .asciidoc-preview-content';

/**
 * Collect the custom-property declarations from every rule whose selector matches `selectors`.
 * Later declarations win, mirroring the cascade within a single stylesheet.
 */
function collectTokens(root, selectors) {
  const tokens = new Map();
  root.walkRules((rule) => {
    const matches = rule.selectors.some((selector) => selectors.includes(selector.trim()));
    if (!matches) return;
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) tokens.set(decl.prop, decl.value.trim());
    });
  });
  return tokens;
}

/** Render a token map as the body of a rule, one declaration per line. */
function renderTokens(tokens, indent) {
  return [...tokens].map(([property, value]) => `${indent}${property}: ${value};`).join('\n');
}

const globalsSource = readFileSync(GLOBALS, 'utf8');
const globalsRoot = postcss.parse(globalsSource, { from: GLOBALS });

// `:root` carries the light palette; `.dark` overrides it. `html.dark`/`:root.dark` are accepted too
// so a selector-syntax change in globals.css does not silently yield an empty dark palette.
const light = collectTokens(globalsRoot, [':root', 'html', ':host']);
const dark = collectTokens(globalsRoot, ['.dark', 'html.dark', ':root.dark']);

if (light.size === 0) {
  throw new Error(
    `No custom properties found on :root in ${GLOBALS}. The export would render unstyled — refusing to ` +
      'generate a payload that silently drops every colour.',
  );
}
if (dark.size === 0) {
  throw new Error(
    `No custom properties found on .dark in ${GLOBALS}. A dark or auto export would fall back to the ` +
      'light palette without saying so — refusing to generate it.',
  );
}

// The dark palette is emitted as a FULL palette (light overlaid with the dark overrides), not as the
// override subset alone. A standalone file has no cascade from the app to fall back to, so a token
// the dark block does not mention has to come from somewhere — here, explicitly.
const darkComplete = new Map([...light, ...dark]);

const collabCss = readFileSync(COLLAB_CSS, 'utf8');
const asciidoctorCss = readFileSync(ASCIIDOCTOR_CSS, 'utf8');

const banner = `/**
 * GENERATED FILE — do not edit.
 *
 * Sources: src/styles/globals.css (design tokens), src/styles/asciidoc-preview.css,
 * src/styles/asciidoctor-style.generated.css.
 *
 * Re-run: pnpm --filter @asciidocollab/web run build:html-export-css
 */
/* eslint-disable */

`;

const body = `/** The light design-token palette, scoped to the export's content container. */
export const LIGHT_TOKENS_CSS = ${JSON.stringify(`${EXPORT_SCOPE} {\n${renderTokens(light, '  ')}\n}`)};

/** The dark design-token palette (light overlaid with the dark overrides), scoped the same way. */
export const DARK_TOKENS_CSS = ${JSON.stringify(`${EXPORT_SCOPE} {\n${renderTokens(darkComplete, '  ')}\n}`)};

/** The app's own preview stylesheet, verbatim — its selectors already target the export container. */
export const ASCIIDOCOLLAB_CSS = ${JSON.stringify(collabCss)};

/** The vendored Asciidoctor stylesheet, already scoped to \`[data-preview-style="asciidoctor"]\`. */
export const ASCIIDOCTOR_CSS = ${JSON.stringify(asciidoctorCss)};
`;

const rendered = banner + body;
const summary =
  `${light.size} light tokens, ${darkComplete.size} dark tokens, ` +
  `${collabCss.length} + ${asciidoctorCss.length} bytes of CSS`;

if (process.argv.includes('--check')) {
  let existing = null;
  try {
    existing = readFileSync(OUTPUT, 'utf8');
  } catch {
    existing = null;
  }
  if (existing !== rendered) {
    console.error(
      `${OUTPUT}\ndoes not match what its sources produce (globals.css, asciidoc-preview.css, ` +
        'asciidoctor-style.generated.css).\n\n' +
        'Run: pnpm --filter @asciidocollab/web run build:html-export-css',
    );
    process.exitCode = 1;
  } else {
    console.log(`The committed HTML-export stylesheet payloads match their sources (${summary}).`);
  }
} else {
  writeFileSync(OUTPUT, rendered);
  console.log(`Wrote ${OUTPUT} (${summary})`);
}
