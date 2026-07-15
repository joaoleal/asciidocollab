import { blockStartLine } from '@/lib/asciidoc/block-start-line';

describe('blockStartLine', () => {
  it('lifts a delimited block to its title line', () => {
    // 1 `= T`, 2 ``, 3 `Before.`, 4 ``, 5 `.Example block`, 6 `====`.
    const lines = ['= T', '', 'Before.', '', '.Example block', '===='];
    expect(blockStartLine(lines, 6)).toBe(5);
  });

  it('lifts over stacked attribute and title lines to the topmost', () => {
    // 6 `[source,ruby]`, 7 `.Code caption`, 8 `----`.
    const lines = ['', '', '', '', '', '[source,ruby]', '.Code caption', '----'];
    expect(blockStartLine(lines, 8)).toBe(6);
  });

  it('lifts a block anchor (`[[id]]`) above a section heading', () => {
    // 3 `[[intro]]`, 4 `== Intro`.
    const lines = ['= T', '', '[[intro]]', '== Intro'];
    expect(blockStartLine(lines, 4)).toBe(3);
  });

  it('returns the line unchanged when a blank line sits directly above', () => {
    const lines = ['= T', '', 'A paragraph.'];
    expect(blockStartLine(lines, 3)).toBe(3);
  });

  it('does not mistake a literal-block delimiter (`....`) for a title', () => {
    // 2 `....` is a delimiter, not a `.Title`, so the block at line 3 is not lifted onto it.
    const lines = ['A paragraph.', '....', 'literal', '....'];
    expect(blockStartLine(lines, 3)).toBe(3);
  });

  it('stops at a content line above, not absorbing prose', () => {
    const lines = ['Prose above.', '.Titled block', 'body'];
    // The title on line 2 lifts, but prose on line 1 stops the walk.
    expect(blockStartLine(lines, 3)).toBe(2);
  });
});
