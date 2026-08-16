/**
 * @file Every literal fallback in the Print stylesheet, held to the value the projection would write.
 *
 * The stylesheet reads each theme value as `var(--print-x, <literal>)`, and the literal is what a
 * reader sees when the projection writes nothing. The file's own header says a literal may only ever
 * be one of three things: a value the renderer's own default theme really sets, the last step of a
 * chain the renderer really walks, or `inherit` where the renderer leaves the value in force
 * standing. What it must never be is a number that looked about right.
 *
 * Nothing enforced that. About twenty-five of them had drifted — point values written as pixels
 * (a 4pt quote rule as `4px` rather than `5.3333px`), values borrowed from the wrong theme layer, a
 * heading ladder quantised differently from the gem's, and one property that ended in two DIFFERENT
 * literals in the same file, neither of them the gem's. None of it was visible, because every one of
 * those properties is written on the ordinary path — which is exactly what makes hand-checking them
 * hopeless and why this is a test rather than a review.
 *
 * ## How it decides what is right
 *
 * The renderer's own default appearance, projected through the same `appearanceToCssProperties` the
 * application uses, with the same catalogue face metrics. A property that projection WRITES has one
 * correct fallback and this asserts it. A property it deliberately leaves unwritten — a codespan's
 * size, a quotation's colour, every value the renderer inherits rather than sets — has no such
 * answer, and those are skipped: their fallbacks are the `inherit`/`1em` chains the header describes,
 * and asserting anything about them here would be asserting the model's absence twice.
 *
 * This replaces the class rather than the instances. A property added to the vocabulary with a
 * made-up default fails here on the first run.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveAppearance } from '@asciidocollab/shared';
import { appearanceToCssProperties } from '@/lib/print-preview/appearance-to-css';
import { planFontFaces } from '@/lib/print-preview/font-faces';
import { resolveFaceMetrics } from '@/lib/print-preview/font-metrics';

const PRINT = path.resolve(__dirname, '../../src/styles/print-preview.css');

/** The stylesheet with its comments removed, so a `var(…)` quoted in prose is not read as a rule. */
const RULES = readFileSync(PRINT, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '');

/** One `var(--print-x, <literal>)` the stylesheet reads. */
interface Fallback {
  /** The custom property being read. */
  readonly name: string;
  /** The literal it degrades to, exactly as written. */
  readonly literal: string;
}

/**
 * Every `var()` in the stylesheet whose fallback is a literal rather than another `var()`.
 *
 * Scanned by walking parentheses rather than by a regular expression: fallbacks nest
 * (`var(--a, var(--b, 1px))`) and one of them is an arithmetic expression, neither of which a regex
 * can bracket correctly. A nested read is found on its own pass, so the inner literal is attributed
 * to the inner property — which is the whole point of the nesting.
 *
 * @param css - The stylesheet, comments already removed.
 * @returns One entry per literal fallback, in source order.
 */
function literalFallbacks(css: string): Fallback[] {
  const found: Fallback[] = [];
  for (let index = css.indexOf('var('); index !== -1; index = css.indexOf('var(', index + 1)) {
    let depth = 0;
    let end = -1;
    for (let scan = index + 3; scan < css.length; scan += 1) {
      if (css[scan] === '(') depth += 1;
      else if (css[scan] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = scan;
          break;
        }
      }
    }
    if (end === -1) continue;
    const inside = css.slice(index + 4, end);
    const comma = inside.indexOf(',');
    if (comma === -1) continue;
    const name = inside.slice(0, comma).trim();
    const literal = inside.slice(comma + 1).trim();
    // A fallback that reads another property is a step in a chain, not a literal: the literal at the
    // end of that chain belongs to the property named there, and this scan reaches it on its own.
    //
    // Which means the OUTER property of a chain has no literal here, and that is deliberate rather
    // than an oversight. `var(--print-sidebar-border-color, var(--print-base-border-color, #EEEEEE))`
    // does not claim `#EEEEEE` is the sidebar's rule colour — the default theme's is `E1E1E1` — it
    // claims the renderer walks `resolve_theme_color %(#{category}_border_color),
    // @theme.base_border_color` when the category names none (`converter.rb:4551, 4593`), which is a
    // step no projected value can confirm or deny: it fires only for a theme that writes an explicit
    // null, and for such a theme the model carries nothing and the renderer really does inherit. The
    // same shape covers `--print-code-border-color`, the two cite groups (`theme_font :quote_cite`
    // assigns size and colour only `if` the category has them) and the table footer's fill
    // (`resolve_theme_color :table_foot_background_color, tbl_bg_color`, converter.rb:2070). What IS
    // decided about each of those is its terminal, on the pass that finds it.
    if (literal.includes('var(')) continue;
    found.push({ name, literal });
  }
  return found;
}

/**
 * Reduce a CSS value to what it MEANS, so two spellings of one value compare equal.
 *
 * Two differences are spelling and nothing else: a hexadecimal colour is case-insensitive, and a
 * string may write a character as itself or as any of several numeric escapes — the projection emits
 * `"\202f "` where a hand-written fallback says `"\202F"`, and those are the same character. Anything
 * this does not normalise is a real difference.
 *
 * @param value - A CSS value.
 * @returns Its normalised form.
 */
function meaningOf(value: string): string {
  const trimmed = value.trim().replaceAll(/\s+/g, ' ');
  if (!/^["']/.test(trimmed)) return trimmed.toLowerCase();
  const quoted = trimmed.slice(1, -1);
  const decoded = quoted.replaceAll(/\\([\da-f]{1,6})[ ]?/gi, (_, code: string) =>
    String.fromCodePoint(Number.parseInt(code, 16)),
  );
  return `"${decoded}"`;
}

/** The renderer's own default appearance, projected exactly as the application projects it. */
function defaultProperties(): Record<string, string> {
  const resolved = resolveAppearance({});
  const metrics = resolveFaceMetrics(planFontFaces(resolved.appearance.fonts, ''), () => undefined);
  return appearanceToCssProperties(resolved.appearance, metrics.boxOf);
}

describe('every literal fallback is the value the projection would write', () => {
  const projected = defaultProperties();
  const fallbacks = literalFallbacks(RULES);

  /**
   * The pairs this can decide, which is narrower than "every literal" in two stated ways.
   *
   * The property has to be one the default appearance really WRITES, for the reason the file header
   * gives — there is nothing to compare an unwritten property's fallback against.
   *
   * And the literal has to be a value rather than `inherit`. `inherit` is the third of the three
   * things the stylesheet's own header permits a fallback to be, and it answers a different question
   * from the other two: not "what would the projection have written" but "the renderer assigned
   * nothing on this axis, so whatever is in force stands". Every such read in this file sits in a
   * rule that exists to put an axis BACK after the construct's own rule cut it — `strong b.button`,
   * `em code`, `:is(h1…h6) kbd` — where the ancestor supplying it is the markup the renderer read the
   * style out of, so `inherit` IS the renderer's answer even where the projection also writes a
   * value. Measured on this anchor: 35 fallbacks in the file are `inherit`, and exactly four of them
   * name a property the default appearance writes (`--print-button-font-weight` and
   * `--print-menu-font-weight`, twice each), all four in re-inherit rules of that shape.
   */
  const decidable = fallbacks.filter(
    (fallback) => projected[fallback.name] !== undefined && fallback.literal !== 'inherit',
  );

  it('reads the stylesheet at all, and reaches most of the vocabulary', () => {
    // A scan that found nothing — or that skipped everything as "unwritten" — would make the
    // assertion below vacuously true, which is the one way a test like this fails silently. The
    // bounds are set just under what this anchor measures (527 fallbacks over 251 names, 241
    // properties projected, 191 names decidable) rather than at a round number a third of that: the
    // looser guards this carried would have survived two thirds of the sheet's reads disappearing.
    expect(fallbacks.length).toBeGreaterThan(500);
    expect(new Set(fallbacks.map((fallback) => fallback.name)).size).toBeGreaterThan(240);
    expect(Object.keys(projected).length).toBeGreaterThan(230);
    expect(new Set(decidable.map((fallback) => fallback.name)).size).toBeGreaterThan(180);
  });

  it('degrades every written property to the value it would have been written with', () => {
    // Only the properties the default appearance WRITES are decidable. The rest — a codespan's size,
    // a quotation's colour, every `inherit` chain — are values the renderer leaves standing rather
    // than assigning, so there is no projected value to compare their fallback against; their
    // literals come from the converter's own tables and the stylesheet's comments cite them. That a
    // fallback names a property the projection can write at all is the vocabulary test's job, not
    // this one's.
    const wrong = decidable
      .filter((fallback) => meaningOf(fallback.literal) !== meaningOf(projected[fallback.name]))
      .map((fallback) => `${fallback.name}: ${fallback.literal} — projected ${projected[fallback.name]}`);
    expect([...new Set(wrong)].toSorted()).toEqual([]);
  });
});
