'use client';
import { useEffect, useMemo, RefObject } from 'react';

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

function canonicalCombo(event: KeyboardEvent): string {
  if (MODIFIER_KEYS.has(event.key)) return '';
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  if (event.metaKey) parts.push('Meta');
  // Normalize key: uppercase single letters, keep others as-is
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  parts.push(key);
  return parts.join('+');
}

/**
 * Whether a keystroke landed somewhere the user is TYPING, rather than reaching for a shortcut.
 *
 * The listener below sits on the whole tree container, so it hears every key pressed inside it —
 * including in the find panel's input, which lives in that container. Without this the shortcuts and
 * the text field fight over the same keys, and the one that wins is the shortcut, because it calls
 * `preventDefault()`. Correcting a typo in the find box with `Delete` would then delete the SELECTED
 * FILE and not even remove the character; `Ctrl+N` in the same box would open a New File dialog.
 *
 * @param target - What the keydown was dispatched on.
 * @returns Whether the keystroke belongs to that element rather than to the tree.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // `isContentEditable` is the question worth asking — it is true inside an editable region as well
  // as on it — but it is one of the properties jsdom does not implement, where it reads false always.
  // The attribute is checked alongside it so the guard is exercised under test rather than merely
  // asserted to exist; the two agree in a browser. `contenteditable="false"` is not editable.
  if (target.isContentEditable) return true;
  const editable = target.getAttribute('contenteditable');
  if (editable === '' || editable === 'true') return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/**
 * Maps action identifiers to their handler functions.
 * Pass `undefined` for actions that are currently inactive — the hook only fires a handler
 * when it is defined, so callers control availability without coupling the hook to domain state.
 */
export type FileTreeKeyCallbacks = Record<string, (() => void) | undefined>;

/**
 * Attaches the file tree's keyboard shortcuts, scoped to the tree.
 *
 * A shortcut fires only while the focus is inside the tree — clicking a row puts it there, and moving
 * on to the editor takes it away again. So these keys act on the tree when the reader is working IN
 * the tree, and mean whatever the editor says they mean once they are working there instead. That is
 * a deliberate boundary rather than a limitation to route around: every one of these combos already
 * means something where the author's focus usually is, and the tree has no claim on it there.
 */
export function useFileTreeKeyHandler(
  containerReference: RefObject<HTMLElement | null>,
  bindings: Map<string, string>,
  callbacks: FileTreeKeyCallbacks,
): void {
  const invertedBindings = useMemo(() => {
    const inverted = new Map<string, string>();
    for (const [action, keyCombo] of bindings) {
      inverted.set(keyCombo, action);
    }
    return inverted;
  }, [bindings]);

  useEffect(() => {
    const element = containerReference.current;
    if (!element) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTextEntry(event.target)) return;
      const combo = canonicalCombo(event);
      if (!combo) return;
      const action = invertedBindings.get(combo);
      if (!action) return;
      const callback = callbacks[action];
      if (!callback) return;
      event.preventDefault();
      event.stopPropagation();
      callback();
    };

    element.addEventListener('keydown', handleKeyDown);
    return () => element.removeEventListener('keydown', handleKeyDown);
  }, [containerReference, invertedBindings, callbacks]);
}
