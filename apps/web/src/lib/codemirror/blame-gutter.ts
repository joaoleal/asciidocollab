/**
 * Per-line authorship gutter extension for a read-only CodeMirror 6 view rendering one blamed
 * file's content (`BlameDto.lines`, joined). Each line's marker shows a resolved author label and
 * a compact authored-at date, with the full author/date/hash as a native hover tooltip.
 */
import type { Extension } from '@codemirror/state';
import { GutterMarker, gutter } from '@codemirror/view';

/** Whether a blame line's author is known — a tokenized style, never a literal color. */
export interface BlameAuthorStyle {
  /** Tailwind classes for the line's text color/style, built from design tokens only. */
  className: string;
}

/**
 * Maps whether a blame line's author resolved to a known project member to its style. Kept
 * JSX-free and pure so it is directly unit-testable (including for the no-hardcoded-color rule)
 * independent of the gutter marker that applies it.
 */
export function blameAuthorStyle(hasAuthor: boolean): BlameAuthorStyle {
  return hasAuthor ? { className: 'text-foreground' } : { className: 'text-muted-foreground italic' };
}

/**
 * Reduces an ISO 8601 timestamp to its compact calendar-date portion (`YYYY-MM-DD`) for the
 * gutter's per-line date label — deterministic (no locale/timezone-dependent formatting) and still
 * recognizably ISO 8601. Returns an empty string for an unparseable input.
 */
export function formatBlameDate(authoredAt: string): string {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(authoredAt);
  return match ? match[0] : '';
}

/** One line's resolved blame info, as shown by its gutter marker. */
export interface BlameLineInfo {
  /** The resolved author's display name, or a neutral fallback label. */
  authorLabel: string;
  /** Whether `authorLabel` names an actual resolved project member. */
  hasAuthor: boolean;
  /** The line's compact authored-at date label (see {@link formatBlameDate}). */
  dateLabel: string;
  /** Full author + date + commit hash, shown as the marker's hover tooltip. */
  tooltip: string;
}

/** Renders one blame gutter cell: a truncated author label and a compact date, both tokenized. */
class BlameGutterMarker extends GutterMarker {
  constructor(private readonly info: BlameLineInfo) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return (
      other instanceof BlameGutterMarker &&
      other.info.authorLabel === this.info.authorLabel &&
      other.info.dateLabel === this.info.dateLabel &&
      other.info.tooltip === this.info.tooltip
    );
  }

  override toDOM(): Node {
    const wrapper = document.createElement('span');
    wrapper.className = `flex items-center gap-1.5 px-1.5 text-xs ${blameAuthorStyle(this.info.hasAuthor).className}`;
    wrapper.title = this.info.tooltip;

    const author = document.createElement('span');
    author.className = 'max-w-[8rem] truncate';
    author.textContent = this.info.authorLabel;

    const date = document.createElement('span');
    date.className = 'shrink-0 text-muted-foreground';
    date.textContent = this.info.dateLabel;

    wrapper.append(author, date);
    return wrapper;
  }
}

/**
 * Builds the blame gutter extension. `getLineInfo` resolves a 1-based line number to its blame
 * info (or `null` for a line with none, which renders no marker) — kept as a callback so this
 * extension stays independent of `BlameDto`/member-lookup shapes.
 */
export function blameGutter(getLineInfo: (lineNumber: number) => BlameLineInfo | null): Extension {
  return gutter({
    class: 'cm-blame-gutter',
    lineMarker: (view, line) => {
      const lineNumber = view.state.doc.lineAt(line.from).number;
      const info = getLineInfo(lineNumber);
      return info ? new BlameGutterMarker(info) : null;
    },
  });
}
