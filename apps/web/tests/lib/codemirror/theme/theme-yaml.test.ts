import {
  stripComment,
  themeAssignments,
  themeCursorContext,
} from '@/lib/codemirror/theme/theme-yaml';

const THEME = [
  '# A project theme',
  'page:',
  '  layout: landscape',
  '  margin: [0.5in, 0.67in, 0.67in, 0.67in]',
  'base:',
  '  font-family: Noto Serif',
  '  font-color: #333333  # body text',
  'heading:',
  '  h2:',
  '    font-color: 194F8A',
  'link:',
  '  font-color: 428BCA',
].join('\n');

/** Offset of the first occurrence of `needle`, plus `delta`. */
function at(text: string, needle: string, delta = 0): number {
  return text.indexOf(needle) + delta;
}

describe('stripComment', () => {
  it('removes a trailing comment', () => {
    expect(stripComment(' landscape  # the wide one')).toBe(' landscape  ');
  });

  it('keeps a hash-prefixed colour, which is a value and not a comment', () => {
    expect(stripComment(' #333333')).toBe(' #333333');
    expect(stripComment(' #333333 # body')).toBe(' #333333 ');
  });

  it('ignores a hash inside quotes', () => {
    expect(stripComment(" '#FFFFFF'")).toBe(" '#FFFFFF'");
    expect(stripComment(' "a # b"')).toBe(' "a # b"');
  });

  it('leaves a value with no comment alone', () => {
    expect(stripComment(' Noto Serif')).toBe(' Noto Serif');
  });
});

describe('themeAssignments', () => {
  const assignments = themeAssignments(THEME);

  it('builds the full dotted path from the nesting', () => {
    expect(assignments.map((a) => a.key)).toEqual([
      'page.layout',
      'page.margin',
      'base.font-family',
      'base.font-color',
      'heading.h2.font-color',
      'link.font-color',
    ]);
  });

  it('does not report a container as an assignment', () => {
    // `heading:` opens a path; it assigns nothing to preview or validate.
    expect(assignments.some((a) => a.key === 'heading')).toBe(false);
    expect(assignments.some((a) => a.key === 'heading.h2')).toBe(false);
  });

  it('closes a path when the indentation returns', () => {
    // `link.font-color` must not end up nested under `heading.h2`.
    expect(assignments.at(-1)?.key).toBe('link.font-color');
  });

  it('reports the value with its comment removed', () => {
    const fontColour = assignments.find((a) => a.key === 'base.font-color');
    expect(fontColour?.value).toBe('#333333');
  });

  it('locates the key text so a diagnostic can underline it', () => {
    const layout = assignments.find((a) => a.key === 'page.layout');
    expect(THEME.slice(layout!.keyFrom, layout!.keyTo)).toBe('layout');
  });

  it('locates the value text so a widget can replace exactly it', () => {
    const colour = assignments.find((a) => a.key === 'heading.h2.font-color');
    expect(THEME.slice(colour!.valueFrom, colour!.valueTo)).toBe('194F8A');
    const family = assignments.find((a) => a.key === 'base.font-family');
    expect(THEME.slice(family!.valueFrom, family!.valueTo)).toBe('Noto Serif');
  });

  it('reports 1-based line numbers', () => {
    expect(assignments.find((a) => a.key === 'page.layout')?.line).toBe(3);
  });

  it('skips comments and blank lines', () => {
    expect(themeAssignments('# just a comment\n\n   \n')).toEqual([]);
  });

  it('handles a flat theme with no nesting at all', () => {
    // base-theme.yml is written this way, and an author may paste from it.
    expect(themeAssignments('page_layout: portrait\nbase_font_size: 12').map((a) => a.key)).toEqual([
      'page_layout',
      'base_font_size',
    ]);
  });

  it('ignores a line it cannot make sense of rather than guessing at a key', () => {
    // A list item is not something a theme contains; inventing a key for it would be worse than
    // leaving the line un-decorated.
    expect(themeAssignments('- not a mapping\nfoo: bar').map((a) => a.key)).toEqual(['foo']);
  });

  it('reports an empty document as having no assignments', () => {
    expect(themeAssignments('')).toEqual([]);
  });
});

describe('themeCursorContext', () => {
  it('reports the enclosing path while a key is being typed', () => {
    const text = 'heading:\n  h2:\n    font-c';
    const context = themeCursorContext(text, text.length);
    expect(context).toMatchObject({ parentPath: 'heading.h2', typed: 'font-c', inValue: false });
    expect(text.slice(context!.from)).toBe('font-c');
  });

  it('reports an empty path at the top level', () => {
    const text = 'pag';
    expect(themeCursorContext(text, 3)).toMatchObject({ parentPath: '', typed: 'pag', inValue: false });
  });

  it('closes sibling paths so a dedented key completes at the right level', () => {
    const text = 'heading:\n  h2:\n    font-color: 194F8A\nlin';
    expect(themeCursorContext(text, text.length)).toMatchObject({ parentPath: '', typed: 'lin' });
  });

  it('switches to value completion past the colon', () => {
    const text = 'page:\n  layout: land';
    const context = themeCursorContext(text, text.length);
    expect(context).toMatchObject({ inValue: true, key: 'page.layout', typed: 'land' });
    expect(text.slice(context!.from)).toBe('land');
  });

  it('offers value completion on an empty value', () => {
    const text = 'page:\n  layout: ';
    expect(themeCursorContext(text, text.length)).toMatchObject({
      inValue: true,
      key: 'page.layout',
      typed: '',
    });
  });

  it('does not complete inside a comment', () => {
    const text = '# page.lay';
    expect(themeCursorContext(text, text.length)).toBeNull();
  });

  it('does not complete where a key could not go', () => {
    const text = 'page:\n  [not a key';
    expect(themeCursorContext(text, text.length)).toBeNull();
  });

  it('reads the line the cursor is on, not the last one', () => {
    const text = 'page:\n  lay\nbase:\n  font-size: 10';
    const context = themeCursorContext(text, at(text, '  lay', 5));
    expect(context).toMatchObject({ parentPath: 'page', typed: 'lay' });
  });
});
