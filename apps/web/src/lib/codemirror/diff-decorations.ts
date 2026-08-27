/**
 * Line-decoration extension for a read-only CodeMirror 6 view rendering a unified-diff STRING
 * (`DiffDto.unified`) — colors each line by its diff role (added/removed/hunk header/file header/
 * context) so the diff reads at a glance, without reconstructing two documents to feed
 * `@codemirror/merge`'s `MergeView` (a unified diff only carries changed hunks plus surrounding
 * context, so that reconstruction would be lossy) and without a second, client-side diff engine.
 */
import { EditorState, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

/** The role one line of a unified diff plays, for coloring. */
export type DiffLineRole = 'file-header' | 'hunk' | 'added' | 'removed' | 'context';

/**
 * Line prefixes that mark the file-level header preceding a diff's hunks. The `---`/`+++` from/to
 * lines are matched by their exact git forms — a prefixed path (`a/…`, `b/…`) or `/dev/null` — not
 * the bare `--- `/`+++ ` prefix: a removed body line whose content itself begins with `-- ` reads as
 * `--- …` in the diff, and the loose prefix would mis-color it as a (muted) header instead of a
 * (destructive) removal. The from-file is always `a/`/`/dev/null` and the to-file `b/`/`/dev/null`.
 */
const FILE_HEADER_PREFIXES: readonly string[] = [
  'diff --git',
  'index ',
  '--- a/',
  '--- /dev/null',
  '+++ b/',
  '+++ /dev/null',
  'new file mode',
  'deleted file mode',
  'old mode',
  'new mode',
  'similarity index',
  'rename from',
  'rename to',
  'copy from',
  'copy to',
];

/**
 * Classifies one line of a unified diff by its role. `context` is the fallback for anything that
 * is not a recognized header/hunk/added/removed line (including a blank line).
 */
export function diffLineRole(line: string): DiffLineRole {
  if (line.startsWith('@@')) return 'hunk';
  if (line === '---' || line === '+++' || FILE_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) {
    return 'file-header';
  }
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}

/** A diff line role's rendered style — a tokenized className, never a literal color. */
export interface DiffRoleStyle {
  /** Tailwind classes for the line's text color/weight, built from design tokens only. */
  className: string;
}

/**
 * Maps a diff line's role to its style. Kept JSX-free and pure so it is directly unit-testable
 * (including for the no-hardcoded-color rule) independent of the CodeMirror extension that applies
 * it as a line decoration.
 */
export function diffRoleStyle(role: DiffLineRole): DiffRoleStyle {
  switch (role) {
    case 'added': {
      return { className: 'text-[hsl(var(--success))]' };
    }
    case 'removed': {
      return { className: 'text-destructive' };
    }
    case 'hunk': {
      return { className: 'text-[hsl(var(--info))] font-semibold' };
    }
    case 'file-header': {
      return { className: 'text-muted-foreground font-semibold' };
    }
    case 'context': {
      return { className: 'text-foreground' };
    }
  }
}

/** Builds the decoration set for `state`'s current document, one line decoration per line. */
function buildDiffDecorations(state: EditorState): DecorationSet {
  const ranges = [];
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber++) {
    const line = state.doc.line(lineNumber);
    const { className } = diffRoleStyle(diffLineRole(line.text));
    ranges.push(Decoration.line({ attributes: { class: className } }).range(line.from));
  }
  return Decoration.set(ranges);
}

const diffDecorationsField = StateField.define<DecorationSet>({
  create: buildDiffDecorations,
  update: (decorations, transaction) => (transaction.docChanged ? buildDiffDecorations(transaction.state) : decorations),
  provide: (field) => EditorView.decorations.from(field),
});

/** The diff line-decoration extension — add this to a read-only diff view's extensions array. */
export function diffLineDecorations(): Extension {
  return diffDecorationsField;
}
