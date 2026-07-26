/**
 * @file Which of MathJax's fonts an exported document actually needs — usually none.
 *
 * MathJax's CHTML output injects a stylesheet at typeset time (see `prerender-content.ts`) and that
 * stylesheet declares an `@font-face` for EVERY family in its font data — 22 files, 392 KB, pointing
 * at the app's own `/vendor/mathjax/…` bundle. Copying it into an export is how a saved file ends up
 * asking a stranger's browser for `http://localhost:3000/…/MathJax_Zero.woff`.
 *
 * Very little of it is ever used. The preview typesets to native MathML wherever the browser supports
 * it (Chromium ≥109, Firefox, Safari — see `render-math.ts`), in which case the browser lays the maths
 * out with its own fonts and NONE of MathJax's are needed; and when it does fall back to CHTML, one
 * document uses a handful of variants, not all nineteen. So rather than embedding the directory, this
 * works out which families the rendered markup actually asks for and lets the rest be dropped.
 *
 * The link between a family and the markup is the variant class MathJax puts on each character:
 * `.TEX-I { font-family: MJXZERO, MJXTEX-I; }` in the stylesheet, `class="mjx-c … TEX-I"` in the
 * output. A family is needed exactly when one of the classes that names it is present.
 */

import { parseFontFaces, unquote } from './font-faces';

/** A class token inside a selector. */
const SELECTOR_CLASS = /\.(-?[_a-z][\w-]*)/gi;
/** The `font-family` declaration inside a rule body. */
const FONT_FAMILY_DECLARATION = /font-family\s*:\s*([^;}]+)/i;
/** A `class` attribute in serialized markup, in either quoting style. */
const CLASS_ATTRIBUTE = /class\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Every class name present in a fragment of serialized markup.
 *
 * Exact tokens, not a substring search: `TEX-B` and `MJX-TEX` share a substring, and a needless
 * 40 KB font in every export is the price of getting that wrong.
 *
 * @param html - The serialized document body.
 * @returns The set of class names it uses.
 */
export function classNames(html: string): Set<string> {
  const names = new Set<string>();
  for (const match of html.matchAll(CLASS_ATTRIBUTE)) {
    for (const token of (match[1] ?? match[2] ?? '').split(/\s+/)) {
      if (token.length > 0) names.add(token);
    }
  }
  return names;
}

/**
 * The font families a rendered document actually renders in, according to a stylesheet that maps
 * classes to families.
 *
 * A family counts as used when some rule naming it has a class selector whose class appears in the
 * markup. A family that no rule names at all is NOT reported: MathJax reaches its fonts exclusively
 * through those variant classes, so an unreferenced face is either unused or a shape this does not
 * model — and in the second case the maths degrades to the reader's own fonts, which is a far better
 * outcome than a stylesheet full of URLs that only work on the machine that made it.
 *
 * @param css - The stylesheet MathJax injected.
 * @param html - The rendered document body.
 * @returns The families whose faces are worth carrying.
 */
export function usedFontFamilies(css: string, html: string): Set<string> {
  const present = classNames(html);
  const used = new Set<string>();

  // The @font-face rules themselves declare families without using them; drop them first so a face
  // cannot justify its own existence.
  let withoutFaces = css;
  for (const block of parseFontFaces(css)) {
    withoutFaces = withoutFaces.replace(block.text, () => '');
  }

  // Split on the closing brace and take everything after the LAST opening brace as the body: linear,
  // and it needs no pattern with two unbounded quantifiers in it. An `@media` wrapper simply becomes
  // part of the first inner rule's selector, which costs nothing — only class tokens are read out.
  for (const chunk of withoutFaces.split('}')) {
    const open = chunk.lastIndexOf('{');
    if (open === -1) continue;
    const families = FONT_FAMILY_DECLARATION.exec(chunk.slice(open + 1))?.[1];
    if (families === undefined) continue;
    const classes = [...chunk.slice(0, open).matchAll(SELECTOR_CLASS)].map((match) => match[1]);
    if (!classes.some((name) => present.has(name))) continue;
    for (const family of families.split(',')) {
      const name = unquote(family);
      if (name.length > 0) used.add(name);
    }
  }
  return used;
}
