/**
 * @file That the Print stylesheet is still a stylesheet.
 *
 * This sheet is nine-tenths prose: nearly every rule carries a comment explaining which line of the
 * renderer it copies. That is deliberate and worth keeping, but it makes one mistake very easy and
 * completely silent — closing a comment, writing another paragraph, and closing it again:
 *
 *     …the same page a fraction looser rather than a broken one. * /
 *     It has to be applied to exactly the elements the strut is applied to. * /
 *     …@supports (text-box-trim: trim-end) { … }
 *
 * The first terminator ends the comment. Everything after it is CSS, and a parser recovering from
 * that garbage swallows the `@supports` block whole. Nothing errors: the file loads, every other rule
 * works, and the one that was eaten simply does not apply. It cost two full runs of the fidelity
 * oracle to find, twice, because the symptom is a geometry assertion failing by ~1pt — which is
 * indistinguishable from the arithmetic in that rule being wrong.
 *
 * These are the two checks that would have caught it in under a second, and they are cheap enough to
 * run over the whole file: after removing every well-formed comment, no comment delimiter may be left
 * anywhere, and the braces must balance. A stray terminator leaves a `* /` behind; an unterminated
 * comment eats the rest of the file and leaves the braces unbalanced.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PRINT = path.resolve(__dirname, '../../src/styles/print-preview.css');

/**
 * The sheet with every well-formed comment replaced by a blank line-preserving gap.
 *
 * Newlines are kept so a reported line number is the line in the file.
 *
 * @param css - The stylesheet's text.
 * @returns The same text with comment bodies blanked out.
 */
function withoutComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, (comment) => comment.replaceAll(/[^\n]/g, ' '));
}

/**
 * The 1-based line numbers on which a pattern occurs.
 *
 * @param text - The text to search.
 * @param pattern - What to look for.
 * @returns One entry per occurrence.
 */
function linesContaining(text: string, pattern: string): number[] {
  return text
    .split('\n')
    .map((line, index) => (line.includes(pattern) ? index + 1 : 0))
    .filter((line) => line !== 0);
}

describe('the Print stylesheet parses as one', () => {
  const css = readFileSync(PRINT, 'utf8');
  const stripped = withoutComments(css);

  it('leaves no comment delimiter outside a comment', () => {
    // A `*/` here is a comment that was closed twice — the prose after the first terminator is being
    // parsed as CSS, and it takes the next rule down with it.
    expect(linesContaining(stripped, '*/')).toEqual([]);
    // A `/*` here is a comment that was never closed, which eats every rule after it.
    expect(linesContaining(stripped, '/*')).toEqual([]);
  });

  it('balances its braces', () => {
    const opens = (stripped.match(/\{/g) ?? []).length;
    const closes = (stripped.match(/\}/g) ?? []).length;
    expect({ opens, closes }).toEqual({ opens: closes, closes });
  });

  it('still declares the rules the vertical model depends on', () => {
    // Named individually because each is a rule whose absence is silent: the page keeps rendering,
    // a block's geometry just goes back to the browser's. See the strut and the trimmed end edge in
    // the stylesheet for what each one is for.
    expect(stripped).toContain('text-box-trim: trim-end');
    expect(stripped).toContain('text-box-edge: cap alphabetic');
    expect(stripped).toMatch(/@supports \(text-box-trim: trim-end\) and \(text-box-edge: cap alphabetic\)/);
    expect(stripped).toContain('--line-top-gap');
    expect(stripped).toContain('--line-bottom-gap');
  });
});
