import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { drawnRuns, sameColour, type DrawnRun } from '../harness/pdftools';
import { colourOf, hexOf, normaliseFamily, preparePrintPage, readFixture, renderWithWorker } from './harness';

/**
 * Does the Print preview colour source code the way the page does?
 *
 * The other Print anchors measure typography and geometry, and none of them can see INSIDE a code
 * block: syntax highlighting is the render worker's own post-processing, so a page built from
 * Asciidoctor's output alone carries no token markup at all. That is why every defect reported in
 * this area survived a green suite.
 *
 * So this compares the two highlighters' output character by character, against a PDF the external
 * Asciidoctor-PDF toolchain really rendered. Both sides produce a list of (character, colour, weight,
 * slant); the lists are aligned on their text and compared entry for entry. Nothing is sampled, and
 * nothing is asserted about the stylesheet's contents — only about what the two of them draw.
 *
 * ## The two highlighters do not agree, and that is the point
 *
 * The export highlights with rouge and the preview with highlight.js. Where rouge draws a distinction
 * highlight.js cannot see, the mapping resolves it to something both sides can reach — their nearest
 * common ancestor when that ancestor carries a style, otherwise the token rouge's own lexers assign
 * most often counted over real source, and where that count finds NONE of the candidates (the bare
 * `title`, which only a C `struct` tag and a shell function name still reach) the code style itself.
 * Either way SOME of what the class covers agrees here, and the remainder appears below.
 *
 * What CANNOT be resolved is the two highlighters reading the same program differently: rouge's Ruby
 * lexer calls `require` a built-in method while highlight.js's Ruby grammar lists it among the
 * keywords, and highlight.js scopes no Ruby method call at all, so there is nothing in the markup for
 * a rule to reach. No mapping between vocabularies reconciles either.
 *
 * The deepest form of that is not a disagreement about one word but about what a highlighter IS FOR:
 * highlight.js classifies by IDENTITY — this word is in the built-ins list, this word is followed by a
 * colon — while rouge classifies by POSITION in its own grammar. `string` is a built-in to one and a
 * reserved word to the other; `doc:` is an attribute to one and an ordinary name to the other. The
 * TypeScript block exists to hold those two cases still.
 *
 * All of it is {@link DIVERGENCES}, an inventory rather than a tolerance — the comparison asserts the
 * observed set is EXACTLY this list. A new divergence fails, and a listed one that stops happening
 * fails too, so the list cannot quietly grow into a licence to be wrong.
 *
 * ## Two fixtures
 *
 * The unthemed one is the palette. The themed one recolours and slants the code font, which is the
 * only way to tell the palette's colours apart from the theme's: under it the renderer keeps a
 * palette token's own colour and upright bold, and draws everything the palette says nothing about in
 * the theme's code colour and slant. A preview that hard-coded either half passes one and fails the
 * other.
 */

/** The palette the renderer highlights with, as committed by the package that owns the gem. */
const PALETTE = JSON.parse(
  readFileSync(
    path.join(__dirname, '../../../../../packages/asciidoc-pdf/assets/rouge/palette.json'),
    'utf8',
  ),
) as {
  fallbackTheme: string;
  themes: Record<string, { styles: Record<string, { fg?: string; bg?: string; bold?: boolean }> }>;
};

/** The fixtures compared, and what each one is the only witness to. */
const FIXTURES = [
  { name: 'highlighting', why: "the renderer's palette, under the appearance a theme-less project gets" },
  {
    name: 'highlighting-themed',
    why: 'the cascade — the theme moves the code colour and slant, and the palette does not move with it',
  },
] as const;

/**
 * How many distinct colours the fixtures must still put on the page.
 *
 * A guard on the FIXTURE rather than on the code: an edit that reduced the source to two token kinds
 * would leave every assertion below passing while checking almost nothing. It is meant to be raised
 * when the corpus grows, never lowered to accommodate a smaller one.
 */
const MINIMUM_DISTINCT_COLOURS = 10;

/** One character of code, with the appearance it is drawn in. */
interface InkedCharacter {
  readonly character: string;
  /** `#rrggbb`, lower case. */
  readonly colour: string;
  readonly bold: boolean;
  readonly italic: boolean;
}

/**
 * One place the preview and the page draw the same run of code differently.
 *
 * `where` is the exact run of characters, so a reader can find it in the fixture. `drawn` records how
 * each fixture's two sides draw it — `[preview, pdf]`, written the way {@link appearanceOf} writes
 * them — because the themed fixture moves the code colour and slant, so the same cause shows up as a
 * different pair of appearances there.
 */
interface Divergence {
  readonly where: string;
  readonly why: string;
  readonly drawn: Readonly<Record<string, readonly [preview: string, pdf: string]>>;
}

/**
 * Every divergence between the preview's colouring and the page's, over both fixtures.
 *
 * Two kinds live here, and the difference matters.
 *
 * The first is the mapping's DELIBERATE loss of specificity: rouge draws a distinction highlight.js
 * writes no differently, so the preview paints the nearest common ancestor and is less specific than
 * the page. Those are working as designed, and they are listed so the cost of the design is visible
 * rather than merely argued for.
 *
 * The second is the two highlighters reading the same program differently — a word one calls a
 * keyword and the other a method, a region one marks as a whole and the other divides. No mapping
 * between vocabularies reconciles those, and no colour choice would.
 *
 * Neither kind is a tolerance. The comparison asserts the observed set is EXACTLY this list, so a new
 * divergence fails and a listed one that stops happening fails too.
 */
const DIVERGENCES: readonly Divergence[] = [
  // ── The mapping's deliberate loss of specificity ──────────────────────────────────────────────
  // Rouge separates a global from an instance variable and highlight.js writes both `hljs-variable`,
  // so the preview paints their parent `Name.Variable`. Neither of the page's two colours is a guess
  // the preview is entitled to make; the parent is a colour the theme really states.
  {
    where: '$audit',
    why: "a global variable. Rouge's `Name.Variable.Global` is #dd7700; the preview cannot tell it from an instance variable, so it paints the parent `Name.Variable`",
    drawn: {
      highlighting: ['#336699', '#dd7700'],
      'highlighting-themed': ['#336699 italic', '#dd7700 italic'],
    },
  },
  ...(['@number', '@currency', '@lines'] as const).map((where) => ({
    where,
    why: "an instance variable. Rouge's `Name.Variable.Instance` is #3333bb; same class as a global in highlight.js, so the preview paints the parent `Name.Variable`",
    drawn: {
      highlighting: ['#336699', '#3333bb'] as readonly [string, string],
      'highlighting-themed': ['#336699 italic', '#3333bb italic'] as readonly [string, string],
    },
  })),
  {
    where: '@dataclass',
    why: "a decorator. Highlight.js writes annotations and preprocessor directives with one class, and rouge holds them far apart (`Name.Decorator` #555555 against `Comment.Preproc` #cc0000 bold). The mapping paints the plurality — 79.3% of the characters carrying this class across six languages of real third-party source are `Comment.Preproc`, against 19.2% `Name.Decorator` — so the C directive below agrees and the Python decorator, the minority, does not",
    drawn: {
      highlighting: ['#cc0000 bold', '#555555'],
      'highlighting-themed': ['#cc0000 bold', '#555555 italic'],
    },
  },

  // ── One highlighter divides a region the other marks whole ────────────────────────────────────
  ...(['#{', '}', '}#{'] as const).map((where) => ({
    where,
    why: "an interpolation delimiter. Highlight.js's `subst` span covers the delimiters AND the code between them; rouge colours only the delimiters (`Literal.String.Interpol`) and lexes the code as ordinary code. Colouring the whole span would put the delimiters right and the code inside them wrong, which is the larger half",
    drawn: {
      highlighting: ['#333333', '#3333bb'] as readonly [string, string],
      'highlighting-themed': ['#1a4d2e italic', '#3333bb italic'] as readonly [string, string],
    },
  })),
  ...(['[', ']', String.raw`\d{2,}`] as const).map((where) => ({
    where,
    why: "an escape inside a regular expression. Highlight.js marks the literal as one span; rouge additionally paints what is escaped inside it (`Literal.String.Escape` #0044dd)",
    drawn: {
      highlighting: ['#008800', '#0044dd'] as readonly [string, string],
      'highlighting-themed': ['#008800 italic', '#0044dd italic'] as readonly [string, string],
    },
  })),
  {
    where: String.raw`\n`,
    why: "an escape inside a string. Same shape as the regex case: highlight.js's Ruby grammar marks the string as one span, rouge paints the escape within it",
    drawn: {
      highlighting: ['#dd2200', '#0044dd'],
      'highlighting-themed': ['#dd2200 italic', '#0044dd italic'],
    },
  },
  // A preprocessor directive is the same shape pointing the other way: rouge inks the WHOLE line as
  // preprocessor text, while highlight.js marks the line `meta` and then nests spans of its own
  // vocabulary inside it. The nested spans win the cascade, so the parts highlight.js names are drawn
  // as what it names them and only the rest of the line carries the directive's colour.
  ...(['include', 'define'] as const).map((where) => ({
    where,
    why: "the word of a C preprocessor directive. Rouge lexes `#include <stdio.h>` and `#define MAX_LINES 64` as one `Comment.Preproc` fragment each; highlight.js nests a `keyword` span inside its `meta` span, and a nested span is the more specific rule. The `#` and the macro's name and value, which no nested span covers, do agree",
    drawn: {
      highlighting: ['#008800 bold', '#cc0000 bold'] as readonly [string, string],
      'highlighting-themed': ['#008800 bold', '#cc0000 bold'] as readonly [string, string],
    },
  })),
  {
    where: '<stdio.h>',
    why: "the header named by an `#include`. Highlight.js nests a `string` span inside the `meta` span for it; rouge calls it `Comment.PreprocFile`, which inherits the directive's own #cc0000 bold",
    drawn: {
      highlighting: ['#dd2200', '#cc0000 bold'],
      'highlighting-themed': ['#dd2200 italic', '#cc0000 bold'],
    },
  },

  // ── Highlight.js marks nothing where rouge colours ────────────────────────────────────────────
  // Not a colour that could be chosen differently: highlight.js's Ruby grammar has a rule for `def
  // NAME` and none at all for a call, and `OBJECT_CREATION` scopes only the receiver of `.new`, never
  // the `.new`. There is no class in the markup for any rule to reach, so no colour table can close
  // this — it is a lexer-level gap, and the only fix would be a different highlighter.
  ...(['new', 'sum', 'zero?', 'total'] as const).map((where) => ({
    where,
    why: "a Ruby method CALL, which highlight.js leaves unscoped; rouge calls it `Name.Function`",
    drawn: {
      highlighting: ['#333333', '#0066bb bold'] as readonly [string, string],
      'highlighting-themed': ['#1a4d2e italic', '#0066bb bold'] as readonly [string, string],
    },
  })),
  {
    where: 'puts',
    why: "a Ruby built-in method, unscoped by highlight.js for the same reason as any other call; rouge calls it `Name.Builtin`",
    drawn: {
      highlighting: ['#333333', '#003388'],
      'highlighting-themed': ['#1a4d2e italic', '#003388 italic'],
    },
  },
  // `dataclasses`, the module named in Python's `from … import`, was in this group and is not any
  // more — not because the preview changed, but because the reference did. It was listed as
  // "highlight.js leaves it unscoped; rouge calls it `Name.Namespace`" (#bb0066 bold), and that was
  // true of the rouge the REFERENCE toolchain ran (5.0.0, whose Python overhaul introduced the
  // `Name::Namespace`) and never true of the rouge the shipped engine runs (4.7.0, which emits a bare
  // `Name` the palette leaves at the code colour). The two pins are now converged on 4.7.0, so both
  // sides leave the word alone and there is nothing left to declare. Should the pins move together to
  // a rouge that colours it again, this assertion fails as an UNdeclared divergence and the entry
  // comes back — which is the inventory working, not a regression.
  ...(['super', 'this'] as const).map((where) => ({
    where,
    why: "a language-defined name. Highlight.js has one class for `this`/`self`/`super`; rouge has no token for the idea at all — its Ruby and JavaScript lexers call them keywords, its Python lexer an ordinary name, its PHP lexer a variable — so there is nothing in the taxonomy to name and the code colour is what is left",
    drawn: {
      highlighting: ['#333333', '#008800 bold'] as readonly [string, string],
      'highlighting-themed': ['#1a4d2e italic', '#008800 bold'] as readonly [string, string],
    },
  })),

  // ── The two lexers disagree about what the word IS ────────────────────────────────────────────
  {
    where: 'require',
    why: "highlight.js's Ruby grammar lists `require` among the keywords; rouge's Ruby lexer calls it a `Name.Builtin`",
    drawn: {
      highlighting: ['#008800 bold', '#003388'],
      'highlighting-themed': ['#008800 bold', '#003388 italic'],
    },
  },
  {
    where: 'include',
    why: "a keyword to highlight.js, a `Keyword.Pseudo` to rouge — same colour, and this palette makes only the plain `Keyword` bold",
    drawn: {
      highlighting: ['#008800 bold', '#008800'],
      'highlighting-themed': ['#008800 bold', '#008800 italic'],
    },
  },
  {
    where: 'in',
    why: "a keyword to highlight.js, an `Operator.Word` to rouge — same colour, and this palette makes only the plain `Keyword` bold",
    drawn: {
      highlighting: ['#008800 bold', '#008800'],
      'highlighting-themed': ['#008800 bold', '#008800 italic'],
    },
  },
  ...(['string', 'number'] as const).map((where) => ({
    where,
    why: "a TypeScript primitive type. The two highlighters classify by different things: highlight.js by IDENTITY — the word is in its built-ins list — and rouge by POSITION, which is why its TypeScript lexer files these among the RESERVED WORDS (`Keyword.Reserved`, inheriting `Keyword`'s #008800 bold) rather than as names at all. The mapping paints the class `Name.Builtin`, rouge's own token for the concept and the majority answer in the languages whose lexers keep a built-ins list of their own",
    drawn: {
      highlighting: ['#003388', '#008800 bold'] as readonly [string, string],
      'highlighting-themed': ['#003388 italic', '#008800 bold'] as readonly [string, string],
    },
  })),
  ...(['doc', 'total'] as const).map((where) => ({
    where,
    why: "the name bound by a TypeScript annotation. Highlight.js marks anything followed by `:` as an `attr`, which is right for a JSON key and a YAML key and is what the mapping paints (`Name.Attribute` #336699); rouge's TypeScript lexer reads a parameter and a `const` as ordinary `Name.Other`, which this palette leaves at the code colour",
    drawn: {
      highlighting: ['#336699', '#333333'] as readonly [string, string],
      'highlighting-themed': ['#336699 italic', '#1a4d2e italic'] as readonly [string, string],
    },
  })),
  {
    where: 'None',
    why: "a built-in value to highlight.js. Rouge's lexers scatter those: JavaScript's `null` is a `Keyword.Constant`, which is what the mapping names, while Python's `None` is a `Name.Builtin.Pseudo`",
    drawn: {
      highlighting: ['#008800 bold', '#003388'],
      'highlighting-themed': ['#008800 bold', '#003388 italic'],
    },
  },
  // The mapping paints `hljs-title class_` as `Name.Constant`, because that is what rouge assigns to
  // 77.0% of the characters carrying that class across 316 real third-party Ruby files, against 17.0%
  // for the two declaration tokens. Constant REFERENCES — `Comparable`, `ArgumentError`, `Struct`,
  // `Billing::Invoice` — therefore agree now, and it is the far rarer DECLARATION that diverges. It is
  // the same indistinguishability either way; what changed is which side of it is the minority.
  ...(['Billing', 'Invoice', 'Ledger', 'Base'] as const).map((where) => ({
    where,
    why: "the name in a class or module DECLARATION. Highlight.js gives a declaration and a reference the same class list — its Ruby grammar's scope map emits `title.class` from four different rules — so the preview cannot tell them apart; rouge calls a declaration `Name.Class`/`Name.Namespace` (#bb0066 bold) and a reference `Name.Constant` (#003366 bold). Both are bold, both are dark, and the mapping follows the majority",
    drawn: {
      highlighting: ['#003366 bold', '#bb0066 bold'] as readonly [string, string],
      'highlighting-themed': ['#003366 bold', '#bb0066 bold'] as readonly [string, string],
    },
  })),
  {
    where: '::',
    why: "the separator inside a namespaced constant. Highlight.js's `CLASS_NAME_WITH_NAMESPACE_RE` swallows it into the one `title.class` span; rouge lexes it as an `Operator`, which this palette leaves at the code colour",
    drawn: {
      highlighting: ['#003366 bold', '#333333'],
      'highlighting-themed': ['#003366 bold', '#1a4d2e italic'],
    },
  },
  ...(['static', 'const'] as const).map((where) => ({
    where,
    why: "a C storage class and a C type qualifier. Highlight.js's C grammar lists both among its TYPES, and the mapping paints a type `Keyword.Type` (#888888 bold) because that is rouge's own token for one; rouge's C lexer keeps `static` and `const` in the plain `Keyword` list (#008800 bold) and reserves `Keyword.Type` for `int`, `size_t` and the rest — which do agree",
    drawn: {
      highlighting: ['#888888 bold', '#008800 bold'] as readonly [string, string],
      'highlighting-themed': ['#888888 bold', '#008800 bold'] as readonly [string, string],
    },
  })),
  ...(['PATTERN', 'RATE'] as const).map((where) => ({
    where,
    why: "a SCREAMING_CASE binding, which highlight.js's JavaScript grammar marks as a constant. Rouge's JavaScript lexer has no such notion and calls it an ordinary `Name.Other`, which this palette leaves at the code colour",
    drawn: {
      highlighting: ['#003366 bold', '#333333'] as readonly [string, string],
      'highlighting-themed': ['#003366 bold', '#1a4d2e italic'] as readonly [string, string],
    },
  })),
];

/**
 * Whether two `#rrggbb` colours are the same ink, within the tolerance the suite holds every colour to.
 *
 * Both sides are parsed by the harness's reader, which THROWS on anything that is not a colour. The
 * copy this replaced sliced hex out of fixed offsets, so a value in any other syntax produced `NaN`
 * channels — and `Math.abs(NaN - x) > tolerance` is `false`, which this function returned as "they
 * agree". Every character on the page then agreed with every character in the PDF, and the inventory
 * below passed green having compared nothing at all.
 *
 * @param a - One colour, as `#rrggbb`.
 * @param b - The other.
 * @returns Whether they are the same ink.
 */
function sameInk(a: string, b: string): boolean {
  return sameColour(colourOf(a, 'a colour in the preview'), colourOf(b, 'a colour in the reference'));
}

/**
 * The PDF's ink, one entry per visible character.
 *
 * Weight and slant are read from the name the EMBEDDED font gives itself. A PDF has no notion of
 * "bold" — it has a different font resource — and the catalogue names its files by style, so
 * `mplus1mn-bold` is the page stating which face it set the run in. That is the same fact a computed
 * `font-weight` states on the other side, which is what makes the two comparable at all.
 *
 * Whitespace is dropped from both sides. The renderer replaces a leading space with a no-break space
 * and emits runs of indentation with no styling whatsoever, so a space is not a place where the two
 * can meaningfully disagree.
 *
 * Only ink set in the code family is kept, and that is not tidiness: a code block that crosses a page
 * break has the running footer's page NUMBER drawn between its two halves, in the middle of the
 * operator stream, and a stream that carried it would never align with the block's own text again.
 *
 * @param runs - Every run of text the PDF draws, in drawing order.
 * @param family - The family the resolved appearance sets code in.
 * @returns One entry per non-whitespace character of code, in reading order.
 */
function inkedCharacters(runs: readonly DrawnRun[], family: string): InkedCharacter[] {
  const wanted = normaliseFamily(family);
  const characters: InkedCharacter[] = [];
  for (const run of runs) {
    if (normaliseFamily(run.fontFamily) !== wanted) continue;
    const face = run.fontFamily.toLowerCase();
    const bold = face.includes('bold');
    const italic = face.includes('italic') || face.includes('oblique');
    const colour = `#${run.colour.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
    for (const character of run.text) {
      if (/\s/.test(character)) continue;
      characters.push({ character, colour, bold, italic });
    }
  }
  return characters;
}

/** How one side draws a run. */
function appearanceOf(entry: InkedCharacter): string {
  return `${entry.colour}${entry.bold ? ' bold' : ''}${entry.italic ? ' italic' : ''}`;
}

/** One divergence as a single line, so observed and declared can be compared as text. */
function keyOf(where: string, preview: string, pdf: string): string {
  return `${where} | preview ${preview} | pdf ${pdf}`;
}

/**
 * The divergences declared for one fixture.
 *
 * A divergence that names no appearance for a fixture is a mistake rather than a licence, so it is
 * reported as such instead of quietly matching nothing.
 *
 * @param fixture - The fixture's name.
 * @returns One line per declared divergence.
 */
function declaredFor(fixture: string): string[] {
  return DIVERGENCES.map((entry) => {
    const drawn = entry.drawn[fixture];
    if (drawn === undefined) return `${entry.where} | DECLARES NOTHING for ${fixture}`;
    return keyOf(entry.where, drawn[0], drawn[1]);
  });
}

test.describe('the Print style colours source code the way the page does', () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.name}: ${fixture.why}`, async ({ page }) => {
      test.setTimeout(120_000);
      const anchor = readFixture(fixture.name);

      // The preview side has to come from the worker: Asciidoctor emits an unhighlighted `<pre>`, and
      // the token spans this whole comparison is about are the worker's own output.
      const prepared = await preparePrintPage(page, anchor, await renderWithWorker(anchor));

      const blocks = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="page"] pre.highlight code')].map((element) => {
          const out: { character: string; colour: string; weight: string; slant: string }[] = [];
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const parent = node.parentElement;
            if (parent === null) continue;
            const style = getComputedStyle(parent);
            for (const character of (node as Text).data) {
              out.push({ character, colour: style.color, weight: style.fontWeight, slant: style.fontStyle });
            }
          }
          return out;
        }),
      );
      expect(blocks.length, 'the worker produced no highlighted source blocks').toBeGreaterThan(0);

      const previewCharacters: InkedCharacter[] = [];
      const blockTexts: string[] = [];
      for (const block of blocks) {
        const start = previewCharacters.length;
        for (const entry of block) {
          if (/\s/.test(entry.character)) continue;
          previewCharacters.push({
            character: entry.character,
            colour: hexOf(entry.colour, 'the colour the preview draws a token in'),
            // A computed weight is a number, and 600 is where CSS puts the boundary between the two
            // faces a family with a single bold face has.
            bold: Number(entry.weight) >= 600,
            italic: entry.slant !== 'normal',
          });
        }
        blockTexts.push(
          previewCharacters
            .slice(start)
            .map((entry) => entry.character)
            .join(''),
        );
      }

      // The family the appearance resolves for code, with the quoting a CSS value carries stripped:
      // it is what tells the code block's ink apart from the page's own.
      //
      // REQUIRED, not defaulted. This used to read `?? 'M+ 1mn'`, and that literal is exactly what the
      // renderer's own default resolves to — so a projection that stopped emitting the property at all
      // handed this comparison the right answer anyway, and every assertion below went on passing on a
      // page that had never been dressed. A fallback whose value is the expected one is not a
      // degradation, it is the check deleting itself.
      const codeFamilyProperty = prepared.cssProperties['--print-code-font-family'];
      expect(
        codeFamilyProperty,
        'the projection resolves the family the code block is set in',
      ).toBeDefined();
      const codeFamily = (codeFamilyProperty ?? '').replaceAll(/^["']|["']$/g, '');
      const pdfCharacters = inkedCharacters(await drawnRuns(anchor.referencePdf), codeFamily);
      const pdfText = pdfCharacters.map((entry) => entry.character).join('');

      // Each block is located in the PDF's own character stream rather than filtered out of it by
      // typeface: the blocks are separated by headings on the page, and searching forward from the
      // previous match keeps the alignment in reading order. A block that cannot be found means the
      // two documents are not the same document, which no colour comparison could survive.
      const aligned: { preview: InkedCharacter; pdf: InkedCharacter; adjacent: boolean }[] = [];
      let searchFrom = 0;
      let previewCursor = 0;
      for (const [index, text] of blockTexts.entries()) {
        const at = pdfText.indexOf(text, searchFrom);
        expect(
          at,
          `block ${index + 1} of the preview is not in the reference PDF: ${text.slice(0, 60)}…`,
        ).toBeGreaterThanOrEqual(0);
        for (let offset = 0; offset < text.length; offset += 1) {
          aligned.push({
            preview: previewCharacters[previewCursor + offset],
            pdf: pdfCharacters[at + offset],
            adjacent: offset > 0,
          });
        }
        previewCursor += text.length;
        searchFrom = at + text.length;
      }

      // The fixture still has teeth: a source reduced to two token kinds would pass everything below
      // while proving nothing.
      const inked = new Set(aligned.map((pair) => pair.pdf.colour));
      expect(inked.size, `the fixture puts only ${inked.size} distinct colours on the page`).toBeGreaterThanOrEqual(
        MINIMUM_DISTINCT_COLOURS,
      );

      // Every colour the page inks inside a code block is either one the palette states outright or
      // the code colour this project's theme resolves to. A colour from neither would mean the
      // reference was rendered with a palette this comparison is not reading, and every agreement
      // below would be an agreement about the wrong thing.
      // Same rule as the family above, and the same trap avoided: `?? '#333333'` was the renderer's
      // own default code colour, so a projection that emitted nothing supplied the right answer and
      // the "every colour is the palette's or the theme's" assertion below could not fail. The step
      // from `code` to `base` stays — that one is the renderer's own inheritance, not a default —
      // but one of the two has to be there.
      const codeColourProperty =
        prepared.cssProperties['--print-code-font-color'] ??
        prepared.cssProperties['--print-base-font-color'];
      expect(
        codeColourProperty,
        'the projection resolves the colour the code block is set in',
      ).toBeDefined();
      const codeColour = hexOf(codeColourProperty, 'the colour the code block is set in');
      const paletteColours = new Set(
        Object.values(PALETTE.themes[PALETTE.fallbackTheme].styles)
          .map((style) => style.fg)
          .filter((colour): colour is string => colour !== undefined),
      );
      expect(
        [...inked].filter((colour) => colour !== codeColour && !paletteColours.has(colour)).toSorted(),
        'the page inks a colour that is in neither the palette nor the resolved theme',
      ).toEqual([]);

      // Disagreements are grouped into runs sharing one explanation, which is how a reader meets them
      // and how the inventory records them. Only characters that are ADJACENT in the source join a
      // run: two identical-looking disagreements in different places are two entries, not one.
      const observed: { where: string; preview: string; pdf: string }[] = [];
      let previousIndex = Number.NEGATIVE_INFINITY;
      for (const [index, pair] of aligned.entries()) {
        const agrees =
          sameInk(pair.preview.colour, pair.pdf.colour) &&
          pair.preview.bold === pair.pdf.bold &&
          pair.preview.italic === pair.pdf.italic;
        if (agrees) continue;
        const preview = appearanceOf(pair.preview);
        const pdf = appearanceOf(pair.pdf);
        const last = observed.at(-1);
        if (last !== undefined && index === previousIndex + 1 && pair.adjacent && last.preview === preview && last.pdf === pdf) {
          observed[observed.length - 1] = { ...last, where: last.where + pair.preview.character };
        } else {
          observed.push({ where: pair.preview.character, preview, pdf });
        }
        previousIndex = index;
      }

      expect(
        [...new Set(observed.map((entry) => keyOf(entry.where, entry.preview, entry.pdf)))].toSorted(),
      ).toEqual([...new Set(declaredFor(fixture.name))].toSorted());
    });
  }
});
