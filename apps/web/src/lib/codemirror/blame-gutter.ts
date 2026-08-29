/**
 * Per-line authorship ("blame") gutter extension for the live CodeMirror 6 editor. Each line's
 * marker shows a resolved author label and a compact authored-at date, with the full
 * author/date/hash/commit-message as a native hover tooltip.
 *
 * The blame data arrives out-of-band (fetched when the toolbar toggle turns blame on, refetched on
 * a file switch), so it lives in {@link blameLinesField} — a StateField replaced wholesale by
 * {@link setBlameLinesEffect} — and the gutter reads its per-line info from there. This mirrors the
 * review-decorations layer, which likewise refreshes from a custom effect rather than a document
 * edit.
 */
import { StateEffect, StateField, type Extension } from '@codemirror/state';
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
  /** The subject/summary line of the commit that last touched this line (may be empty). */
  message: string;
  /** Full author + date + short hash + commit message, shown as the marker's hover tooltip. */
  tooltip: string;
}

/** The per-line blame info the gutter renders, keyed by 1-based line number; null when blame is off. */
export type BlameLines = Map<number, BlameLineInfo> | null;

/**
 * Out-of-band effect replacing the full per-line blame map (a fresh fetch when blame is toggled on
 * or the open file changes). `null` clears it — the gutter then renders no markers.
 */
export const setBlameLinesEffect = StateEffect.define<BlameLines>();

/**
 * StateField holding the current per-line blame map (or `null` when blame is off), replaced wholesale
 * by {@link setBlameLinesEffect}. The gutter reads each line's info from here; nothing maps through
 * document edits, since a stale map is dropped and refetched rather than remapped.
 */
export const blameLinesField = StateField.define<BlameLines>({
  create() {
    return null;
  },
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setBlameLinesEffect)) next = effect.value;
    }
    return next;
  },
});

/** Builds the tooltip string for one blame line: author · date · short hash · message. */
export function blameTooltip(authorLabel: string, dateLabel: string, hash: string, message: string): string {
  const parts = [authorLabel, dateLabel, hash.slice(0, 7)];
  if (message.length > 0) parts.push(message);
  return parts.join(' · ');
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
 * Builds the blame gutter extension. It reads each line's info from {@link blameLinesField} (register
 * that field alongside this extension), so a line with no blame — or all lines while the field is
 * `null` — renders no marker. Rebuilds its markers whenever {@link setBlameLinesEffect} replaces the
 * map.
 */
export function blameGutter(): Extension {
  return gutter({
    class: 'cm-blame-gutter',
    lineMarker: (view, line) => {
      const lines = view.state.field(blameLinesField, false);
      if (!lines) return null;
      const lineNumber = view.state.doc.lineAt(line.from).number;
      const info = lines.get(lineNumber);
      return info ? new BlameGutterMarker(info) : null;
    },
    // The map arrives out-of-band via setBlameLinesEffect, so rebuild the markers when it lands (a
    // document edit already triggers a rebuild on its own).
    lineMarkerChange: (update) =>
      update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setBlameLinesEffect))),
  });
}

/** Convenience: the field + gutter as one extension, for hosts that always want both together. */
export function blameExtension(): Extension {
  return [blameLinesField, blameGutter()];
}
