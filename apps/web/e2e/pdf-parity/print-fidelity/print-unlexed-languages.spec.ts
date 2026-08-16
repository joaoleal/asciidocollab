import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { drawnRuns, type Rgb } from '../harness/pdftools';
import { normaliseFamily, preparePrintPage, readFixture, renderWithWorker } from './harness';

/**
 * Does the Print style leave a listing uncoloured when the export leaves it uncoloured?
 *
 * The two highlighters do not cover the same languages, and they do not resolve a language name the
 * same way. Asciidoctor-PDF asks `Rouge::Lexer.find` for the language the AUTHOR wrote and falls
 * through to `Rouge::Lexers::PlainText` when there is none, so such a listing is printed in one
 * colour; the render worker fetches a highlight.js grammar for any language a document declares, and
 * highlight.js both has more grammars and downcases the name before looking one up. Left alone,
 * closing the "the PDF colours a Dockerfile and the preview does not" gap would have opened the same
 * gap pointing the other way.
 *
 * So the generated region of `print-preview.css` carries one more rule, and it names the languages the
 * export DOES lex — rouge's registry, spelled as rouge registers it — putting the token spans of
 * everything else back at the code colour. Two populations reach it: the 84 grammars (125 spellings)
 * rouge has no lexer for under any casing, and every language it does lex written with a capital,
 * because `find` is a plain hash lookup. `build-print-highlight-css.mjs --check` is what keeps the
 * list derived.
 *
 * What that check cannot see is whether the rule actually WINS in a browser: it competes with the
 * per-token rules above it, and any of specificity, order or attribute-value case could make it a
 * no-op that reads perfectly. All three of those have now been real:
 *
 *   - SPECIFICITY. A token rule carries one class per scope SEGMENT, so `title.class.inherited` is
 *     `.hljs-title.class_.inherited__` at (0,5,0) and out-weighed the descendant selector at (0,4,2)
 *     that this rule used to be. A superclass name in a Processing, Wren or Axapta listing came out
 *     in #003366 bold with every token beside it correctly greyed. The earlier version of this file
 *     could not have caught it: its Processing fixture was `Ball b = new Ball();`, which emits
 *     `class.title`, not `title.class.inherited`. The fixtures below declare a superclass for exactly
 *     that reason, and {@link deepestPaintedScope} makes the omission impossible to repeat.
 *   - CASE. `[source,Ruby]` previewed fully coloured and exported monochrome.
 *
 * The lower-case Ruby half is the control, and it is the assertion that matters most: a rule that
 * greyed out every listing would pass a one-sided test.
 *
 * ## What the reference PDF supplies, and what it cannot
 *
 * The colour a neutralised listing has to come out in is READ FROM the `highlighting` anchor's
 * reference PDF — the colour asciidoctor-pdf prints code in under the appearance a theme-less project
 * gets, which is the same appearance the page below is dressed in. It used to be `inkOf(code)`, the
 * preview's own `<code>` element, with every token span asserted equal to it: a rule that recoloured
 * `code[class*="language-"]` moved the tokens and the element they were compared against by the same
 * amount, and the file stayed green having compared the preview to itself. So did the control — "at
 * least one token differs from the code colour" is a statement about two preview values.
 *
 * What no reference can supply here is the EXPORT half. Rouge lexes every language the five anchor
 * listings declare, and none of the fourteen committed fixtures writes a language it has no lexer for
 * or spells one with a capital — so "asciidoctor-pdf prints THIS listing plain" is, for the three
 * listings below, a fact about the external toolchain that this suite has no render of. Closing that
 * would need a fixture of its own: the same document as `highlighting` plus a `[source,processing]`
 * block and a `[source,Ruby]` block, rendered through the reference Docker image, after which both
 * halves could be read off the page. Until then the export side stays a hand-verified constant, and
 * it is named as one rather than left looking measured.
 */

/** The stylesheet the rule under test is generated into. */
const STYLESHEET = path.resolve(__dirname, '../../../src/styles/print-preview.css');

/**
 * One listing per case the rule has to get right.
 *
 * Every one of them declares a superclass, so the deepest scope in the vocabulary
 * (`title.class.inherited`) is on the page in all three — the class the specificity defect leaked
 * through, and the one a fixture is most likely not to produce by accident.
 */
const SOURCE = `= Three listings

[source,ruby]
----
require 'json'

class Dog < Animal
  def greet(name)
    puts "hello"
  end
end
----

[source,Ruby]
----
require 'json'

class Dog < Animal
  def greet(name)
    puts "hello"
  end
end
----

[source,processing]
----
class Dog extends Animal {
  void setup() {
    size(400, 400);
    Ball b = new Ball();
  }
}
----
`;

/** What a run of text is drawn with, as the browser resolves it. */
interface Ink {
  readonly color: string;
  readonly fontWeight: string;
  readonly fontStyle: string;
}

/**
 * Read the appearance of one element.
 *
 * @param locator - The element.
 * @returns Its resolved colour, weight and slant.
 */
async function inkOf(locator: Locator): Promise<Ink> {
  return locator.evaluate((element) => {
    const style = globalThis.getComputedStyle(element);
    return { color: style.color, fontWeight: style.fontWeight, fontStyle: style.fontStyle };
  });
}

/**
 * The deepest scope any generated token rule paints, counted in class names.
 *
 * Read out of the stylesheet rather than written down, because it is the thing the neutralising rule
 * has to out-weigh and it grows with the highlighter's vocabulary. Every assertion below that a
 * listing is uncoloured is only as strong as the deepest token the listing actually contains, so this
 * is compared against what the fixtures produced: a highlight.js release that adds a scope one level
 * deeper than anything here fails this file until a fixture emits it, instead of leaving a rule
 * nothing on the page can lose to.
 *
 * A generated token rule is `<scope> .hljs-a.b_.c__ {` on one line, and the `.hljs-` prefix is
 * emitted nowhere else in the stylesheet.
 *
 * @returns The number of classes in the most specific token selector.
 */
function deepestPaintedScope(): number {
  const rules = [...readFileSync(STYLESHEET, 'utf8').matchAll(/^[^\n{]* (\.hljs-[\w.-]+) \{$/gm)].map(
    (match) => match[1].split('.').length - 1,
  );
  // The vocabulary is 52 scopes today; this only asserts the reading found the region at all.
  expect(rules.length).toBeGreaterThan(20);
  return Math.max(...rules);
}

/**
 * How deeply nested the most deeply nested token in a listing is.
 *
 * highlight.js writes one class per scope segment (`scopeToCSSClass`), so a span's class count IS the
 * depth of the scope it carries.
 *
 * @param code - The listing's `code` element.
 * @returns The largest class count among its token spans.
 */
async function deepestTokenIn(code: Locator): Promise<number> {
  return code.evaluate((element) =>
    Math.max(
      0,
      ...[...element.querySelectorAll('span[class^="hljs-"]')].map((span) => span.classList.length),
    ),
  );
}

/** The single most common value in a list. */
function mode<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0]?.[0];
}

/** One decoded PDF colour, in the `rgb(r, g, b)` form a computed style reports. */
function asCss(colour: Rgb): string {
  return `rgb(${colour.map((channel) => Math.round(channel)).join(', ')})`;
}

/** What the reference PDF says code is drawn in. */
interface ReferenceInk {
  /** The colour it prints plain code in, as `rgb(r, g, b)`. */
  readonly plain: string;
  /** Every other colour it draws code in, which is the palette a lexed listing gets. */
  readonly palette: ReadonlySet<string>;
}

/**
 * Read the code colour and the code palette off a reference PDF.
 *
 * The anchor is almost entirely source blocks, so the face most of its runs are set in is the code
 * face and the colour most of THOSE are drawn in is the code colour — the one asciidoctor-pdf prints
 * a token it has no palette entry for, and the one it prints a whole listing in when rouge cannot lex
 * the language. Both are asserted to be what they claim before either is used.
 *
 * @param bytes - The reference PDF's bytes.
 * @returns The plain code colour and the palette around it.
 */
async function referenceInk(bytes: Uint8Array): Promise<ReferenceInk> {
  const drawn = await drawnRuns(bytes);
  const runs = drawn.filter((run) => run.text.trim() !== '');
  const stem = mode(runs.map((run) => normaliseFamily(run.fontFamily)));
  const code = runs.filter((run) => normaliseFamily(run.fontFamily) === stem);
  expect(code.length, 'the highlighting anchor is mostly code').toBeGreaterThan(runs.length / 2);

  const plain = mode(code.map((run) => asCss(run.colour)));
  expect(plain, 'the reference draws its code in some colour').toBeDefined();
  const palette = new Set(code.map((run) => asCss(run.colour)).filter((colour) => colour !== plain));
  // The reference's own statement that a palette reaches its code at all. Without it, "a lexed
  // listing has tokens the code colour does not cover" would be a claim about the preview alone —
  // and a reference that had stopped highlighting would make the control below vacuous rather than
  // failing.
  expect(palette.size, 'and draws its lexed listings in several colours besides it').toBeGreaterThan(3);
  return { plain: plain ?? 'rgb(0, 0, 0)', palette };
}

/**
 * Assert that one listing is drawn in the colour the REFERENCE prints code in, that every token span
 * in it agrees with the listing's own element, and that it was highlighted in the first place.
 *
 * The first of those is what anchors the file. Comparing the tokens only to `inkOf(code)` compares
 * the preview to itself: a rule that moved `code[class*="language-"]` moved both sides together.
 *
 * The last matters as much: without it the assertion would pass just as well against a preview that
 * had stopped highlighting the language altogether, which is a different (and worse) way to agree
 * with the page.
 *
 * @param code - The listing's `code` element.
 * @param deepest - The deepest scope the stylesheet paints, which the listing must reach.
 * @param reference - What the reference PDF draws code in.
 */
async function expectNeutralised(
  code: Locator,
  deepest: number,
  reference: ReferenceInk,
): Promise<void> {
  const tokens = code.locator('span[class^="hljs-"]');
  expect(await tokens.count()).toBeGreaterThan(2);
  expect(await deepestTokenIn(code)).toBeGreaterThanOrEqual(deepest);

  const plain = await inkOf(code);
  // The anchor: the listing is set in the colour the export prints code in, read off the reference.
  expect(plain.color, 'the listing is set in the colour the reference prints code in').toBe(
    reference.plain,
  );
  const spans = await tokens.all();
  const inks = await Promise.all(spans.map((token) => inkOf(token)));
  for (const ink of inks) expect(ink).toEqual(plain);
}

/**
 * Put the three listings on the page in the Print style.
 *
 * @param page - The browser page.
 * @returns What the reference PDF of the anchor the page is dressed from draws code in.
 */
async function prepare(page: Page): Promise<ReferenceInk> {
  // The theme-less anchor: the palette under the appearance a project with no theme of its own gets.
  // Its own source is replaced because what is measured here is the STYLE's answer to three listings,
  // and no anchor fixture has one in a language rouge cannot lex. The fixture's REFERENCE is still
  // read — it is the same appearance, so the colour it prints code in is the colour these listings
  // have to come out in.
  const anchor = readFixture('highlighting');
  const fixture = { ...anchor, source: SOURCE };
  await preparePrintPage(page, fixture, await renderWithWorker(fixture));
  return referenceInk(anchor.referencePdf);
}

test.describe('a listing the export prints plain', () => {
  test('is drawn in the code colour when the export has no lexer for its language', async ({ page }) => {
    const reference = await prepare(page);
    const deepest = deepestPaintedScope();

    const lexed = page.locator('code.language-ruby');
    const unlexed = page.locator('code.language-processing');
    await expect(lexed).toHaveCount(1);
    await expect(unlexed).toHaveCount(1);

    await expectNeutralised(unlexed, deepest, reference);

    // And the control: the palette still reaches a language rouge lexes, in the colours the
    // reference's OWN code palette holds. Comparing the lexed tokens only to the unlexed listing's
    // colour would say nothing about which colours they are — a preview that painted every token
    // one arbitrary shade would satisfy it.
    const lexedTokens = lexed.locator('span[class^="hljs-"]');
    expect(await lexedTokens.count()).toBeGreaterThan(2);
    expect(await deepestTokenIn(lexed)).toBeGreaterThanOrEqual(deepest);
    const lexedSpans = await lexedTokens.all();
    const lexedInks = await Promise.all(lexedSpans.map((token) => inkOf(token)));
    const coloured = lexedInks.filter((ink) => ink.color !== reference.plain);
    expect(coloured.length, 'the lexed listing keeps tokens the code colour does not cover').toBeGreaterThan(0);
    for (const ink of coloured) {
      expect(
        reference.palette.has(ink.color),
        `${ink.color} is a colour the reference draws code in: ${[...reference.palette].join(' ')}`,
      ).toBe(true);
    }
  });

  test('is drawn in the code colour when the author capitalised a language the export does lex', async ({
    page,
  }) => {
    const reference = await prepare(page);
    const deepest = deepestPaintedScope();

    // `Rouge::Lexer.find` is `registry[name.to_s]` and Asciidoctor stores the author's own spelling,
    // so the page prints this listing plain while `hljs.getLanguage` downcases and colours it.
    // HAND-VERIFIED against the reference toolchain rather than measured here — no committed fixture
    // writes a capitalised language, so there is no render of one to read: the same file as
    // `[source,ruby]` renders with six palette colours in its content stream and as `[source,Ruby]`
    // with none. See the file header for the fixture that would make this measurable.
    const capitalised = page.locator('code.language-Ruby');
    const lowercase = page.locator('code.language-ruby');
    await expect(capitalised).toHaveCount(1);
    await expect(lowercase).toHaveCount(1);

    await expectNeutralised(capitalised, deepest, reference);

    // The control, and the reason the generated list carries no `i` flag: the SAME source under the
    // spelling rouge registers keeps its palette — and keeps it in the reference's own colours.
    const lowercaseSpans = await lowercase.locator('span[class^="hljs-"]').all();
    const lowercaseInks = await Promise.all(lowercaseSpans.map((token) => inkOf(token)));
    const coloured = lowercaseInks.filter((ink) => ink.color !== reference.plain);
    expect(coloured.length, 'the lower-case spelling keeps its palette').toBeGreaterThan(0);
    for (const ink of coloured) {
      expect(
        reference.palette.has(ink.color),
        `${ink.color} is a colour the reference draws code in: ${[...reference.palette].join(' ')}`,
      ).toBe(true);
    }
  });
});
