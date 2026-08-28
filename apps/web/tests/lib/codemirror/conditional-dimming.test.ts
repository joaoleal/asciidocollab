/*
 * @jest-environment jsdom
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  computeDimmedRanges,
  asciidocConditionalDimming,
  DIMMED_CONDITIONAL_CLASS,
} from '@/lib/codemirror/conditional-dimming';

// jsdom environment — the ViewPlugin builds mark decorations and EditorView needs a DOM host.

/**
 * the conditional-dimming DECISION. Given a document containing
 * `ifdef`/`ifndef`/`ifeval` regions and a resolved attribute scope, `computeDimmedRanges`
 * returns the half-open character ranges of the lines that sit inside a branch which resolves
 * INACTIVE for that scope. The ranges are recomputed whenever the scope changes, and nesting /
 * unbalanced `endif` are handled without throwing. Reuses the single conditional authority
 * (`parseConditional`/`evaluateConditional`) — no `eval`.
 */

/** Builds the line-start offset of a 0-based line index in `text` (for asserting ranges). */
function lineStart(text: string, line0: number): number {
  const lines = text.split('\n');
  let offset = 0;
  for (let index = 0; index < line0; index += 1) offset += lines[index].length + 1;
  return offset;
}

describe('computeDimmedRanges', () => {
  test('dims the body of an inactive ifdef branch', () => {
    const text = 'before\nifdef::draft[]\nhidden line\nendif::[]\nafter\n';
    const ranges = computeDimmedRanges(text, new Map());
    // `draft` is not defined ⇒ the `hidden line` (line index 2) is dimmed.
    const hiddenStart = lineStart(text, 2);
    const hiddenEnd = hiddenStart + 'hidden line'.length;
    expect(ranges).toEqual([{ from: hiddenStart, to: hiddenEnd }]);
  });

  test('does NOT dim an active ifdef branch', () => {
    const text = 'before\nifdef::draft[]\nshown line\nendif::[]\nafter\n';
    const ranges = computeDimmedRanges(text, new Map([['draft', '']]));
    expect(ranges).toEqual([]);
  });

  test('a single-line ifdef::flag[text] (inline content form, no endif) dims nothing after it', () => {
    // The inline content form has non-empty brackets and no matching `endif` — it is NOT a region
    // opener. Treating it as one (the bug) would dim the entire rest of the file. Nothing must dim.
    const text = 'ifdef::draft[Draft watermark]\nbody one\nbody two\n';
    expect(computeDimmedRanges(text, new Map())).toEqual([]);
  });

  test('ifndef is the inverse of ifdef', () => {
    const text = 'ifndef::draft[]\nshown when undefined\nendif::[]\n';
    // draft undefined ⇒ ifndef is active ⇒ nothing dimmed.
    expect(computeDimmedRanges(text, new Map())).toEqual([]);
    // draft defined ⇒ ifndef is inactive ⇒ the body is dimmed.
    expect(computeDimmedRanges(text, new Map([['draft', '']]))).toHaveLength(1);
  });

  test('recomputes when the scope changes', () => {
    const text = 'ifdef::flag[]\nbody\nendif::[]\n';
    expect(computeDimmedRanges(text, new Map())).toHaveLength(1); // flag off ⇒ dimmed
    expect(computeDimmedRanges(text, new Map([['flag', '']]))).toHaveLength(0); // flag on ⇒ not dimmed
  });

  test('an inner region inside an inactive outer region stays dimmed regardless of its own test', () => {
    const text = [
      'ifdef::outer[]', // inactive (outer undefined)
      'a',
      'ifdef::inner[]', // its test would pass, but the enclosing region is inactive
      'b',
      'endif::[]',
      'c',
      'endif::[]',
      '',
    ].join('\n');
    const ranges = computeDimmedRanges(text, new Map([['inner', '']]));
    // Lines a (1), b (3), c (5) are all inside the inactive outer region ⇒ all dimmed.
    // (The directive lines themselves are not dimmed.)
    expect(ranges).toHaveLength(3);
  });

  test('the conditional directive lines themselves are not dimmed', () => {
    const text = 'ifdef::draft[]\nx\nendif::[]\n';
    const ranges = computeDimmedRanges(text, new Map());
    // Only the body line `x` (index 1) is dimmed, not the ifdef/endif lines.
    expect(ranges).toHaveLength(1);
    expect(ranges[0].from).toBe(lineStart(text, 1));
  });

  test('an unbalanced endif does not throw and dims nothing extra', () => {
    const text = 'before\nendif::[]\nafter\n';
    expect(() => computeDimmedRanges(text, new Map())).not.toThrow();
    expect(computeDimmedRanges(text, new Map())).toEqual([]);
  });

  test('ifeval against the resolved scope decides dimming', () => {
    const text = 'ifeval::[{level} > 2]\nbody\nendif::[]\n';
    expect(computeDimmedRanges(text, new Map([['level', '1']]))).toHaveLength(1); // 1 > 2 false ⇒ dimmed
    expect(computeDimmedRanges(text, new Map([['level', '5']]))).toHaveLength(0); // 5 > 2 true ⇒ shown
  });

  test('empty body lines inside an inactive branch produce no zero-length range noise', () => {
    const text = 'ifdef::draft[]\n\nendif::[]\n';
    // The blank line (index 1) is empty; a zero-length dim range is pointless, so it is skipped.
    expect(computeDimmedRanges(text, new Map())).toEqual([]);
  });

  test('treats an unsupplied scope as the empty one, so every guarded branch reads inactive', () => {
    // The editor mounts before the project index resolves anything, so the no-scope form is a real
    // state rather than a test convenience: nothing is defined, so an ifdef body is dimmed.
    expect(computeDimmedRanges('ifdef::draft[]\nhidden\nendif::[]\n')).toHaveLength(1);
  });
});

describe('asciidocConditionalDimming ViewPlugin', () => {
  test('dims the body of an inactive branch in a mounted editor', () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'ifdef::draft[]\nhidden\nendif::[]\n',
        extensions: [asciidocConditionalDimming(() => new Map())],
      }),
      parent: document.body,
    });
    expect(view.dom.querySelector(`.${DIMMED_CONDITIONAL_CLASS}`)).not.toBeNull();
    view.destroy();
  });

  test('dims against the empty scope when mounted without a scope accessor', () => {
    // How the editor mounts before the symbol index has resolved the file's attributes.
    const view = new EditorView({
      state: EditorState.create({
        doc: 'ifdef::draft[]\nhidden\nendif::[]\n',
        extensions: [asciidocConditionalDimming()],
      }),
      parent: document.body,
    });
    expect(view.dom.querySelector(`.${DIMMED_CONDITIONAL_CLASS}`)).not.toBeNull();
    view.destroy();
  });
});
