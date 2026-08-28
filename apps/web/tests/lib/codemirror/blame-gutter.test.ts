/* @jest-environment jsdom */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { blameAuthorStyle, blameGutter, formatBlameDate, type BlameLineInfo } from '@/lib/codemirror/blame-gutter';

describe('formatBlameDate', () => {
  test('reduces an ISO 8601 timestamp to its calendar-date portion', () => {
    expect(formatBlameDate('2026-08-24T10:15:00.000Z')).toBe('2026-08-24');
  });

  test('handles a bare date with no time component', () => {
    expect(formatBlameDate('2026-01-02')).toBe('2026-01-02');
  });

  test('returns an empty string for an unparseable value', () => {
    expect(formatBlameDate('not-a-date')).toBe('');
  });
});

describe('blameAuthorStyle', () => {
  test('returns a distinct style for a known vs. unknown author', () => {
    expect(blameAuthorStyle(true).className).not.toBe(blameAuthorStyle(false).className);
  });

  test('never returns a hardcoded hex or rgb color', () => {
    for (const hasAuthor of [true, false]) {
      const { className } = blameAuthorStyle(hasAuthor);
      expect(className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(className).not.toMatch(/rgb\(/);
    }
  });
});

/** One line's blame info, with every field defaulted so a test states only what it cares about. */
function lineInfo(overrides: Partial<BlameLineInfo> = {}): BlameLineInfo {
  return {
    authorLabel: 'Ada Lovelace',
    hasAuthor: true,
    dateLabel: '2026-08-24',
    tooltip: 'Ada Lovelace · 2026-08-24 · abc1234',
    ...overrides,
  };
}

function mount(document_: string, getLineInfo: (lineNumber: number) => BlameLineInfo | null) {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: document_, extensions: [blameGutter(getLineInfo)] }),
    parent,
  });
  return { view, parent };
}

function markers(view: EditorView): HTMLElement[] {
  return [...view.dom.querySelectorAll<HTMLElement>('.cm-blame-gutter .cm-gutterElement')];
}

describe('blameGutter', () => {
  test('renders the author label, date, and tooltip for each line it has blame for', () => {
    const { view, parent } = mount('first line\nsecond line', (lineNumber) =>
      lineInfo({ authorLabel: `Author ${lineNumber}`, dateLabel: `2026-08-0${lineNumber}` }),
    );

    const cells = markers(view);
    expect(cells[0]).toHaveTextContent('Author 1');
    expect(cells[0]).toHaveTextContent('2026-08-01');
    expect(cells[0].querySelector('span')?.title).toBe('Ada Lovelace · 2026-08-24 · abc1234');
    expect(cells[1]).toHaveTextContent('Author 2');

    view.destroy();
    parent.remove();
  });

  test('renders no marker content for a line it has no blame for', () => {
    const { view, parent } = mount('first line\nsecond line', (lineNumber) =>
      lineNumber === 1 ? lineInfo() : null,
    );

    const cells = markers(view);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveTextContent('Ada Lovelace');

    view.destroy();
    parent.remove();
  });

  test('styles a resolved author differently from an unresolved one', () => {
    const { view, parent } = mount('first line\nsecond line', (lineNumber) =>
      lineNumber === 1
        ? lineInfo()
        : lineInfo({ authorLabel: 'Unknown author', hasAuthor: false }),
    );

    const cells = markers(view);
    expect(cells[0].querySelector('span')?.className).toContain('text-foreground');
    expect(cells[1].querySelector('span')?.className).toContain('italic');

    view.destroy();
    parent.remove();
  });

  test('leaves a line marker in place when an edit leaves its blame info unchanged', () => {
    const { view, parent } = mount('first line\nsecond line', () => lineInfo());
    const before = markers(view)[0].firstElementChild;

    view.dispatch({ changes: { from: 0, insert: 'x' } });

    expect(markers(view)[0].firstElementChild).toBe(before);
    expect(markers(view)[0]).toHaveTextContent('Ada Lovelace');

    view.destroy();
    parent.remove();
  });

  test('replaces a line marker when an edit changes its blame info', () => {
    let author = 'Ada Lovelace';
    const { view, parent } = mount('first line\nsecond line', () =>
      lineInfo({ authorLabel: author, tooltip: `${author} · 2026-08-24 · abc1234` }),
    );
    expect(markers(view)[0]).toHaveTextContent('Ada Lovelace');

    author = 'Grace Hopper';
    view.dispatch({ changes: { from: 0, insert: 'x' } });

    expect(markers(view)[0]).toHaveTextContent('Grace Hopper');

    view.destroy();
    parent.remove();
  });
});
