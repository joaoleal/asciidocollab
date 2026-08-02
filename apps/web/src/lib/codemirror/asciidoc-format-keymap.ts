import { EditorView, type Command } from '@codemirror/view';
import { toggleComment } from '@codemirror/commands';

/**
 * Formatting shortcuts + auto-pair.
 *  - Mod-b / Mod-i / Mod-` wrap the selection in `*` / `_` / `` ` ``,
 *  - Mod-/ toggles a line comment,
 *  - typing an emphasis mark over a selection wraps it (auto-pair).
 * Bindings avoid clashing with save / find / undo.
 *
 * The wrap computation is a pure helper so it unit-tests without a live editor.
 */

/** Emphasis marks eligible for type-over-selection auto-wrapping. */
export const AUTO_WRAP_MARKS = new Set(['*', '_', '`', '#', '~', '^']);

/** Wrap `selected` (or a placeholder) in `mark`; returns the inserted text + selection span. */
export function wrapWith(selected: string, mark: string, placeholder = ''): { insert: string; innerFrom: number; innerTo: number } {
  const inner = selected === '' ? placeholder : selected;
  return { insert: `${mark}${inner}${mark}`, innerFrom: mark.length, innerTo: mark.length + inner.length };
}

function wrapCommand(mark: string, placeholder: string): Command {
  return (view: EditorView) => {
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    const { insert, innerFrom, innerTo } = wrapWith(selected, mark, placeholder);
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + innerFrom, head: from + innerTo },
    });
    return true;
  };
}

/**
 * The formatting commands, by the action id the key bindings registry knows each one by.
 *
 * Commands rather than a ready-made keymap: which key runs which command is the author's to change,
 * and the registry is where that is decided. Binding them here as well would give the same shortcut
 * two owners, and the hard-coded one would quietly win.
 */
export const formatCommands: Readonly<Record<string, Command>> = {
  'editor:bold': wrapCommand('*', 'bold'),
  'editor:italic': wrapCommand('_', 'italic'),
  'editor:code': wrapCommand('`', 'code'),
  'editor:toggle-comment': toggleComment,
};

/**
 * Input handler that wraps a non-empty selection when an emphasis mark is typed
 * over it, so selecting "word" and pressing `*` yields `*word*`.
 */
export const autoWrapInputHandler = EditorView.inputHandler.of((view, from, to, text) => {
  if (from === to || !AUTO_WRAP_MARKS.has(text)) return false;
  const selected = view.state.sliceDoc(from, to);
  const { insert, innerFrom, innerTo } = wrapWith(selected, text);
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + innerFrom, head: from + innerTo },
    userEvent: 'input.type',
  });
  return true;
});
