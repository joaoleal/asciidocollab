import { readFileSync } from 'node:fs';
import path from 'node:path';
import manifest from '@asciidocollab/asciidoc-pdf/assets/admonition-icons/manifest.json';

// The renderer's admonition icons are drawn in a colour and at a size that live in the converter's own
// `AdmonitionIcons` table, and the gem's default theme says nothing about either — so a project with
// no theme of its own gets those built-in values, the projection has nothing to write, and the
// STYLESHEET's fallback literals are what the page is actually painted with. They are among the few
// fallbacks in this file that are genuinely live.
//
// `packages/asciidoc-pdf/scripts/generate-admonition-icons.mjs` already reads that table out of the
// gem and records it in the committed manifest, and `check:admonition-icons` fails loudly when a gem
// bump changes it. What nothing checked is the other direction: that the literals in the stylesheet
// still say what the manifest says. A recoloured icon would fail the gem check while the preview went
// on painting the old colour, and a hand-edited literal would fail nothing at all.
//
// So the manifest is the single source and this is where the stylesheet is held to it. Nothing here
// restates a colour or a size: every expected value is read from the manifest, and the sizes are
// compared as lengths rather than as text so the assertion is about the measurement rather than
// about how it happens to be spelled.
const PRINT = path.resolve(__dirname, '../../src/styles/print-preview.css');

/** The stylesheet with its comments removed, so prose cannot satisfy or break an assertion. */
const RULES = readFileSync(PRINT, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '');

/** CSS resolves a point as 4/3 of a pixel; the projection writes these lengths in pixels. */
const PIXELS_PER_POINT = 96 / 72;

/**
 * Every fallback the stylesheet gives one custom property.
 *
 * @param property - The property's name.
 * @returns One entry per `var(--name, fallback)` the stylesheet writes.
 */
function fallbacksOf(property: string): string[] {
  const pattern = new RegExp(String.raw`var\(\s*${property}\s*,\s*([^),]+)\)`, 'g');
  return [...RULES.matchAll(pattern)].map((match) => match[1].trim());
}

describe("the admonition icons the preview paints are the converter's own", () => {
  test.each(manifest.icons.map((icon) => [icon.type, icon] as const))(
    'the %s icon is painted the colour the converter inks it',
    (type, icon) => {
      const fallbacks = fallbacksOf(`--print-admonition-icon-${type}-font-color`);
      expect(fallbacks.length).toBeGreaterThan(0);
      for (const fallback of fallbacks) {
        expect(fallback.toLowerCase()).toBe(`#${icon.strokeColor.toLowerCase()}`);
      }
    },
  );

  test.each(manifest.icons.map((icon) => [icon.type, icon] as const))(
    'the %s icon is drawn at the size the converter draws it',
    (type, icon) => {
      const fallbacks = fallbacksOf(`--print-admonition-icon-${type}-size`);
      expect(fallbacks.length).toBeGreaterThan(0);
      for (const fallback of fallbacks) {
        const pixels = /^([\d.]+)px$/.exec(fallback);
        expect(pixels).not.toBeNull();
        expect(Number(pixels?.[1]) / PIXELS_PER_POINT).toBeCloseTo(icon.sizePt, 4);
      }
    },
  );

  test('the glyphs it masks are exactly the ones the package publishes', () => {
    // The file names are the manifest's too, and `scripts/build-catalogue-fonts.mjs` copies those and
    // only those into `public/vendor/admonition-icons/`. A rule naming anything else is a mask the
    // browser fetches and does not get — an admonition drawn with no icon at all.
    const referenced = [...RULES.matchAll(/url\("\/vendor\/admonition-icons\/([^"]+)"\)/g)].map(
      (match) => match[1],
    );
    expect(new Set(referenced)).toEqual(new Set(manifest.icons.map((icon) => icon.file)));
  });
});
