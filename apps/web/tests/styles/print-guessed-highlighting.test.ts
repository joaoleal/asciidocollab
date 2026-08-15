/* @jest-environment jsdom */
/**
 * Where the guess is declined, and where it is kept.
 *
 * The render worker colours a listing whose declared language no shipped grammar answers to by
 * asking highlight.js to DETECT the language, and marks that block so the styles can differ about it
 * (`asciidoc-render.worker.ts`, and the tests there that assert the marker is emitted on a guessed
 * block and withheld from a grammar-backed one). One rendered document serves all three preview
 * styles at once, so the difference cannot be made in the worker: this is the other half of it.
 *
 * Print declines the guess, because rouge does not guess — a listing it has no lexer for is printed
 * in one colour, and a preview showing five is showing something the page will not. The two styles
 * that present the document rather than the page keep it, which is how they behaved before the
 * on-demand grammars arrived and is not a claim about the PDF.
 *
 * The interesting case is `terraform`: rouge lexes it and highlight.js has no grammar for it (one of
 * 222 such names in rouge's registry). The older rule cannot reach that block — it neutralises by
 * excluding the languages the export lexes, and terraform is excluded — which is the whole reason the
 * marker is an attribute with a rule of its own.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WEB_ROOT = path.resolve(__dirname, '../..');
/**
 * Every stylesheet a preview container is served with, because the question below is about all three
 * styles rather than about one file.
 *
 * Reading only `print-preview.css` made the two "keeps it" cases vacuous: every selector in that file
 * is pinned to `[data-preview-style="print"]`, so nothing in it can ever reach a container asked for
 * `asciidocollab` or `asciidoctor` and the derived list was `[]` by construction. The sheets that
 * actually govern those two styles — where a rule declining the guess would have to be written, and
 * where the token colours for both of them live — were never opened at all.
 */
const STYLESHEETS = [
  path.join(WEB_ROOT, 'src/styles/print-preview.css'),
  path.join(WEB_ROOT, 'src/styles/asciidoc-preview.css'),
  path.join(WEB_ROOT, 'src/styles/asciidoctor-style.generated.css'),
];
const WORKER = path.join(WEB_ROOT, 'src/workers/asciidoc-render.worker.ts');

/**
 * The attribute the worker marks a guess with, read from the worker rather than restated.
 *
 * The generator reads it from the same declaration for the same reason: an assertion that quoted the
 * name would keep passing after the worker stopped emitting it.
 *
 * @returns The attribute name.
 */
function guessedMarker(): string {
  const declaration = /const GUESSED_MARKUP_MARKER = '([a-z][\w-]*)';/.exec(readFileSync(WORKER, 'utf8'));
  if (declaration === null) throw new Error('the render worker declares no GUESSED_MARKUP_MARKER literal');
  return declaration[1];
}

/** One rule: a single selector, and the declarations it carries. */
interface Rule {
  /** The selector, with a selector list already split into one rule per selector. */
  readonly selector: string;
  /** The rule's declarations, as written. */
  readonly declarations: string;
}

/** Every rule of every preview stylesheet, comments removed, with selector lists split. */
function previewRules(): Rule[] {
  const rules: Rule[] = [];
  for (const file of STYLESHEETS) {
    const css = readFileSync(file, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '');
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations = rule[2].trim();
      // Split on top-level commas so a `:is(a, b)` argument list is not torn into invalid selectors.
      let depth = 0;
      let start = 0;
      const selectors: string[] = [];
      for (let index = 0; index < rule[1].length; index += 1) {
        const character = rule[1][index];
        if (character === '(' || character === '[') depth += 1;
        else if (character === ')' || character === ']') depth -= 1;
        else if (character === ',' && depth === 0) {
          selectors.push(rule[1].slice(start, index));
          start = index + 1;
        }
      }
      selectors.push(rule[1].slice(start));
      for (const selector of selectors) {
        const trimmed = selector.trim();
        // A rule with a pseudo-element styles a generated box rather than the element, so it can
        // never be the rule that paints a token span or the code around it — and `matches()` cannot
        // be asked about one anyway. Dropped here rather than caught later, so a selector this
        // genuinely cannot evaluate still raises.
        if (trimmed.length > 0 && !trimmed.includes('::')) rules.push({ selector: trimmed, declarations });
      }
    }
  }
  return rules;
}

const RULES = previewRules();

/** The `color` a rule declares, or undefined when it declares none. */
function colourOf(rule: Rule): string | undefined {
  const declared = /(?:^|;)\s*color\s*:([^;]*)/.exec(rule.declarations);
  return declared?.[1].trim().replaceAll(/\s+/g, ' ');
}

/** The custom-property names one CSS value reads. */
function propertiesRead(value: string): Set<string> {
  return new Set([...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]));
}

/** Build one listing and return the parts of it the questions below are about. */
function listing(options: { language: string; guessed: boolean; previewStyle: string }): {
  token: Element;
  code: Element;
  block: Element;
} {
  // The converter's own shape, down to the wrappers, because the rule that paints the code around a
  // token is written against them: `.listingblock > .content > pre` in the Print sheet.
  document.body.innerHTML =
    `<div class="asciidoc-preview-content" data-preview-style="${options.previewStyle}">` +
    '<div class="listingblock"><div class="content">' +
    '<pre class="highlight hljs">' +
    `<code class="language-${options.language}"${options.guessed ? ` ${guessedMarker()}` : ''}>` +
    '<span class="hljs-keyword">from</span>' +
    '</code></pre></div></div></div>';
  const token = document.querySelector('span.hljs-keyword');
  const code = document.querySelector('code');
  const block = document.querySelector('pre');
  if (token === null || code === null || block === null) throw new Error('the fixture is incomplete');
  return { token, code, block };
}

/**
 * Every colour any of the three sheets paints the CODE around a token with.
 *
 * Derived rather than named, because "the code colour" is a different value in each style — the Print
 * sheet reads `--print-code-font-color`, the brand sheet's `pre code` is `inherit` — and hard-coding
 * one of them is what made the two "keeps it" cases below unable to fail. The union is taken across
 * all three sheets on purpose: a rule declining the guess is one that paints a token the colour of
 * the code it sits in, whichever style's vocabulary it spells that in.
 */
const CODE_COLOURS: string[] = (() => {
  const found = new Set<string>();
  for (const previewStyle of ['print', 'asciidocollab', 'asciidoctor']) {
    const { code, block } = listing({ language: 'ruby', guessed: false, previewStyle });
    for (const rule of RULES) {
      const colour = colourOf(rule);
      if (colour === undefined) continue;
      if (code.matches(rule.selector) || block.matches(rule.selector)) found.add(colour);
    }
  }
  return [...found];
})();

/**
 * Whether a token span in one listing is put back at the code colour by any rule in any sheet.
 *
 * Asked of the rules as the browser would ask — `matches()` against the real selector — rather than
 * by searching the stylesheet text, so a rule that is written to look right and matches nothing
 * cannot answer yes.
 *
 * @param options - The listing to build: the declared language, whether it carries the guess marker,
 *   and the style the container has been asked for.
 * @returns The selectors that neutralise the token, if any.
 */
function neutralisingRulesFor(options: {
  language: string;
  guessed: boolean;
  previewStyle: string;
}): string[] {
  const { token } = listing(options);
  // A rule that paints the token the code colour is the neutralisation; a rule that gives it any
  // other colour is a token rule and is not one. "The code colour" is a shared custom property where
  // the value reads one, and the value itself where it does not — so a token rule reading the same
  // property another style's code is painted from is caught as well as one repeating a literal.
  return RULES.filter((rule) => {
    const colour = colourOf(rule);
    if (colour === undefined) return false;
    const names = propertiesRead(colour);
    return CODE_COLOURS.some(
      (code) => code === colour || [...propertiesRead(code)].some((name) => names.has(name)),
    );
  })
    .filter((rule) => token.matches(rule.selector))
    .map((rule) => rule.selector);
}

describe('a guessed listing under each preview style', () => {
  test('the sheets and the colours these questions are asked over are really there', () => {
    // Both halves of the derivation, because either one coming back empty would make every "keeps
    // it" assertion below true by construction — which is exactly how the two of them survived
    // reading one file that cannot reach the styles they are about.
    expect(RULES.length).toBeGreaterThan(300);
    expect(CODE_COLOURS.length).toBeGreaterThan(1);
    for (const file of STYLESHEETS) expect(readFileSync(file, 'utf8').length).toBeGreaterThan(0);
  });

  test.each([
    ['a language nothing lexes at all', 'mylang'],
    ['a language rouge lexes and highlight.js has no grammar for', 'terraform'],
  ])('Print declines the guess for %s', (_what, language) => {
    const neutralising = neutralisingRulesFor({ language, guessed: true, previewStyle: 'print' });
    expect(neutralising.length).toBeGreaterThan(0);
    expect(neutralising.some((selector) => selector.includes(guessedMarker()))).toBe(true);
  });

  test.each(['asciidocollab', 'asciidoctor'])('the %s style keeps it', (previewStyle) => {
    // Nothing in the Print sheet may reach a container that was not asked for Print — that is the
    // Style Isolation rule the sheet is held to elsewhere — so the guessed colour survives in both.
    for (const language of ['mylang', 'terraform']) {
      expect(neutralisingRulesFor({ language, guessed: true, previewStyle })).toEqual([]);
    }
  });

  test('Print keeps the colour of a listing highlighted from its own grammar', () => {
    // Unmarked and lexed by both: the page colours it, so the preview must too. This is what the
    // marker buys — without it the choice would have to be made from the language name alone, and
    // there is no name that distinguishes "guessed" from "read off the grammar".
    expect(neutralisingRulesFor({ language: 'ruby', guessed: false, previewStyle: 'print' })).toEqual([]);
  });

  test('the older rule alone would not have covered the guess', () => {
    // The evidence for the marker being an attribute with a rule of its own. `terraform` is inside
    // the `:not()` — the export really does lex it — so the rule that neutralises an unlexed listing
    // passes over it, and only the marker rule is left to catch the guess.
    const [neutralising] = [neutralisingRulesFor({ language: 'terraform', guessed: true, previewStyle: 'print' })];
    expect(neutralising).toHaveLength(1);
    expect(neutralising[0]).toContain(guessedMarker());
  });
});
