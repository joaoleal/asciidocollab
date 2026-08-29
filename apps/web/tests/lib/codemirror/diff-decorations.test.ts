import { EditorState } from '@codemirror/state';
import { EditorView, type DecorationSet } from '@codemirror/view';
import {
  diffLineDecorations,
  diffLineRole,
  diffRoleStyle,
  type DiffLineRole,
} from '@/lib/codemirror/diff-decorations';

describe('diffLineRole', () => {
  test.each([
    ['diff --git a/foo.adoc b/foo.adoc', 'file-header'],
    ['index abc123..def456 100644', 'file-header'],
    ['--- a/foo.adoc', 'file-header'],
    ['+++ b/foo.adoc', 'file-header'],
    ['--- /dev/null', 'file-header'],
    ['+++ /dev/null', 'file-header'],
    ['---', 'file-header'],
    ['+++', 'file-header'],
    ['new file mode 100644', 'file-header'],
    ['deleted file mode 100644', 'file-header'],
    ['rename from old.adoc', 'file-header'],
    ['rename to new.adoc', 'file-header'],
    ['similarity index 100%', 'file-header'],
    ['@@ -1,3 +1,4 @@', 'hunk'],
    ['+added content', 'added'],
    ['-removed content', 'removed'],
    [' unchanged context', 'context'],
    ['', 'context'],
  ] as const)('classifies %j as %s', (line, expected) => {
    expect(diffLineRole(line)).toBe(expected);
  });

  test('a removed line beginning with extra dashes is still classified as removed, not a file header', () => {
    expect(diffLineRole('-- a heading in the old content')).toBe('removed');
  });

  test('a removed body line whose own content begins with "-- " (so the diff line reads "--- …") is removed, not a file header', () => {
    // The removal prefix `-` plus content `-- a heading` renders as `--- a heading`, which the loose
    // `--- ` prefix used to mis-color as a muted file header instead of a destructive removal.
    expect(diffLineRole('--- a heading in the old content')).toBe('removed');
  });

  test('an added body line whose own content begins with "++ " (so the diff line reads "+++ …") is added, not a file header', () => {
    expect(diffLineRole('+++ a heading in the new content')).toBe('added');
  });
});

describe('diffRoleStyle', () => {
  const roles: DiffLineRole[] = ['file-header', 'hunk', 'added', 'removed', 'context'];

  test('every role maps to a non-empty className', () => {
    for (const role of roles) {
      expect(diffRoleStyle(role).className.length).toBeGreaterThan(0);
    }
  });

  test('distinguishes added from removed', () => {
    expect(diffRoleStyle('added').className).not.toBe(diffRoleStyle('removed').className);
  });

  test('never returns a hardcoded hex or rgb color', () => {
    for (const role of roles) {
      const { className } = diffRoleStyle(role);
      expect(className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(className).not.toMatch(/rgb\(/);
    }
  });
});

/** The decoration set the extension currently provides for `state`. */
function decorationsOf(state: EditorState): DecorationSet {
  // The decorations facet is typed as a union of a static set or a per-view provider; this extension
  // only ever contributes a static set, so narrow to it here.
  return state.facet(EditorView.decorations)[0] as DecorationSet;
}

/** Every line decoration's class attribute, in document order. */
function lineClasses(state: EditorState): string[] {
  const classes: string[] = [];
  decorationsOf(state).between(0, state.doc.length, (_from, _to, value) => {
    const className = value.spec.attributes?.class;
    classes.push(typeof className === 'string' ? className : '');
  });
  return classes;
}

function stateFor(document_: string): EditorState {
  return EditorState.create({ doc: document_, extensions: [diffLineDecorations()] });
}

describe('diffLineDecorations', () => {
  const DOC = ['@@ -1,2 +1,2 @@', '-old line', '+new line'].join('\n');

  test('decorates every line by its diff role', () => {
    expect(lineClasses(stateFor(DOC))).toEqual([
      diffRoleStyle('hunk').className,
      diffRoleStyle('removed').className,
      diffRoleStyle('added').className,
    ]);
  });

  test('re-derives the decorations after the document changes', () => {
    const state = stateFor(DOC);
    const next = state.update({
      changes: { from: 0, to: state.doc.line(1).to, insert: ' context line' },
    }).state;

    expect(lineClasses(next)[0]).toBe(diffRoleStyle('context').className);
  });

  test('keeps the existing decorations for a transaction that leaves the document alone', () => {
    const state = stateFor(DOC);
    const next = state.update({ selection: { anchor: 1 } }).state;

    expect(decorationsOf(next)).toBe(decorationsOf(state));
  });
});
