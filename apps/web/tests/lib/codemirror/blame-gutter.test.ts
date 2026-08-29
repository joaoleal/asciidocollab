/* @jest-environment jsdom */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  blameAuthorStyle,
  blameExtension,
  blameTooltip,
  formatBlameDate,
  setBlameLinesEffect,
  type BlameLineInfo,
} from '@/lib/codemirror/blame-gutter';

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

describe('blameTooltip', () => {
  test('joins author, date, short hash, and message with a middot separator', () => {
    expect(blameTooltip('Ada Lovelace', '2026-08-24', 'abc1234def', 'Fix the intro')).toBe(
      'Ada Lovelace · 2026-08-24 · abc1234 · Fix the intro',
    );
  });

  test('omits the message segment when the commit summary is empty', () => {
    expect(blameTooltip('Ada Lovelace', '2026-08-24', 'abc1234def', '')).toBe('Ada Lovelace · 2026-08-24 · abc1234');
  });
});

/** One line's blame info, with every field defaulted so a test states only what it cares about. */
function lineInfo(overrides: Partial<BlameLineInfo> = {}): BlameLineInfo {
  return {
    authorLabel: 'Ada Lovelace',
    hasAuthor: true,
    dateLabel: '2026-08-24',
    message: 'Fix the intro',
    tooltip: 'Ada Lovelace · 2026-08-24 · abc1234 · Fix the intro',
    ...overrides,
  };
}

/**
 * Mounts the field-backed blame extension and pushes an initial per-line map (or null) via the
 * out-of-band effect, mirroring how the live editor feeds the gutter.
 */
function mount(document_: string, lines: Map<number, BlameLineInfo> | null) {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: document_, extensions: [blameExtension()] }),
    parent,
  });
  view.dispatch({ effects: setBlameLinesEffect.of(lines) });
  return { view, parent };
}

function markers(view: EditorView): HTMLElement[] {
  return [...view.dom.querySelectorAll<HTMLElement>('.cm-blame-gutter .cm-gutterElement')];
}

/** Builds a per-line map from a callback, for the common one-marker-per-line cases. */
function linesFrom(count: number, build: (lineNumber: number) => BlameLineInfo | null): Map<number, BlameLineInfo> {
  const map = new Map<number, BlameLineInfo>();
  for (let lineNumber = 1; lineNumber <= count; lineNumber++) {
    const info = build(lineNumber);
    if (info) map.set(lineNumber, info);
  }
  return map;
}

describe('blameGutter', () => {
  test('renders no marker content while the backing field holds no blame map', () => {
    const { view, parent } = mount('first line\nsecond line', null);
    expect(markers(view)).toHaveLength(0);
    view.destroy();
    parent.remove();
  });

  test('renders the author label, date, and tooltip (incl. commit message) for each blamed line', () => {
    const { view, parent } = mount(
      'first line\nsecond line',
      linesFrom(2, (lineNumber) =>
        lineInfo({
          authorLabel: `Author ${lineNumber}`,
          dateLabel: `2026-08-0${lineNumber}`,
          message: `Commit ${lineNumber}`,
          tooltip: `Author ${lineNumber} · 2026-08-0${lineNumber} · abc1234 · Commit ${lineNumber}`,
        }),
      ),
    );

    const cells = markers(view);
    expect(cells[0]).toHaveTextContent('Author 1');
    expect(cells[0]).toHaveTextContent('2026-08-01');
    expect(cells[0].querySelector('span')?.title).toBe('Author 1 · 2026-08-01 · abc1234 · Commit 1');
    expect(cells[1]).toHaveTextContent('Author 2');

    view.destroy();
    parent.remove();
  });

  test('renders no marker content for a line it has no blame for', () => {
    const { view, parent } = mount('first line\nsecond line', linesFrom(2, (lineNumber) => (lineNumber === 1 ? lineInfo() : null)));

    const cells = markers(view);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveTextContent('Ada Lovelace');

    view.destroy();
    parent.remove();
  });

  test('styles a resolved author differently from an unresolved one', () => {
    const { view, parent } = mount(
      'first line\nsecond line',
      linesFrom(2, (lineNumber) =>
        lineNumber === 1 ? lineInfo() : lineInfo({ authorLabel: 'Unknown author', hasAuthor: false }),
      ),
    );

    const cells = markers(view);
    expect(cells[0].querySelector('span')?.className).toContain('text-foreground');
    expect(cells[1].querySelector('span')?.className).toContain('italic');

    view.destroy();
    parent.remove();
  });

  test('toggling blame off (a null map) clears every marker live', () => {
    const { view, parent } = mount('first line\nsecond line', linesFrom(2, () => lineInfo()));
    expect(markers(view)).toHaveLength(2);

    view.dispatch({ effects: setBlameLinesEffect.of(null) });

    expect(markers(view)).toHaveLength(0);

    view.destroy();
    parent.remove();
  });

  test('replacing the map (a file switch / refetch) rerenders the markers from the new data', () => {
    const { view, parent } = mount('first line\nsecond line', linesFrom(2, () => lineInfo({ authorLabel: 'Ada Lovelace' })));
    expect(markers(view)[0]).toHaveTextContent('Ada Lovelace');

    view.dispatch({ effects: setBlameLinesEffect.of(linesFrom(2, () => lineInfo({ authorLabel: 'Grace Hopper' }))) });

    expect(markers(view)[0]).toHaveTextContent('Grace Hopper');

    view.destroy();
    parent.remove();
  });

  test('leaves a line marker in place when an edit leaves its blame info unchanged', () => {
    const { view, parent } = mount('first line\nsecond line', linesFrom(2, () => lineInfo()));
    const before = markers(view)[0].firstElementChild;

    view.dispatch({ changes: { from: 0, insert: 'x' } });

    expect(markers(view)[0].firstElementChild).toBe(before);
    expect(markers(view)[0]).toHaveTextContent('Ada Lovelace');

    view.destroy();
    parent.remove();
  });
});
