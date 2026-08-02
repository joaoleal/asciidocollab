/**
 * The editor's configurable keyboard shortcuts.
 *
 * Every command the author can reach by keystroke is registered here against the action id the key
 * bindings registry knows it by, so one list is both what the settings page offers to remap and what
 * the editor actually binds. Held apart deliberately: a shortcut listed in settings but bound from a
 * hard-coded keymap somewhere else looks configurable and is not, which is worse than not offering it
 * — the author remaps it, the page says it worked, and the key goes on doing what it always did.
 */

import { keymap, type Command, type KeyBinding } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { DEFAULT_EDITOR_KEY_COMBOS } from '@asciidocollab/shared';
import { formatCommands } from '@/lib/codemirror/asciidoc-format-keymap';
import { foldCommands } from '@/lib/codemirror/asciidoc-fold-persist';
import { reviewCommentCommand, type CommentFromSelectionAccessor } from '@/lib/codemirror/review-interaction';

/**
 * Translate a stored key combo into the spelling CodeMirror's keymap expects.
 *
 * The two vocabularies differ in exactly three ways, and each is handled here rather than by asking
 * every caller to remember it:
 *  - the separator is `+` in a stored combo and `-` in CodeMirror's;
 *  - `Mod` survives untouched, because CodeMirror reads it the same way the registry means it —
 *    Cmd on macOS, Ctrl elsewhere;
 *  - a single-character key is lowercased. CodeMirror reads an uppercase letter as the SHIFTED
 *    character, so `Mod-B` would silently mean Mod+Shift+B and the plain shortcut would never fire.
 *    Shift, when the author wants it, is a modifier of its own and is preserved as one.
 *
 * @param combo - A combo as the registry and the settings page spell it, e.g. `Mod+Shift+M`.
 * @returns The same combo as CodeMirror spells it, e.g. `Mod-Shift-m`.
 */
export function codemirrorKey(combo: string): string {
  const parts = combo.split('+');
  const key = parts.at(-1) ?? '';
  const modifiers = parts.slice(0, -1);
  return [...modifiers, key.length === 1 ? key.toLowerCase() : key].join('-');
}

/** The editor commands the settings page can rebind, by the action id the registry knows them by. */
export type EditorShortcutCommands = Readonly<Record<string, Command>>;

/**
 * Every command the editor offers as a configurable shortcut.
 *
 * One list, assembled where the commands live, so that adding a shortcut is a single edit and cannot
 * be half-done — an action in the registry with no command here binds nothing, and a command here
 * with no registry entry is unreachable. The tests hold both directions to the registry.
 *
 * @param getOnComment - Live accessor for the review-comment handler, which is per-mount state.
 * @returns The action-id-to-command map for {@link editorShortcutsKeymap}.
 */
export function editorShortcutCommands(getOnComment: CommentFromSelectionAccessor): EditorShortcutCommands {
  return {
    ...formatCommands,
    ...foldCommands,
    'editor:review-comment': reviewCommentCommand(getOnComment),
  };
}

/**
 * Build the editor's shortcut keymap from the author's bindings.
 *
 * An action the author has not remapped falls back to the registry's default, so the keymap is
 * complete from the first frame — the bindings arrive from the server asynchronously, and an editor
 * that bound nothing until they landed would ignore the first `Mod+B` of every session.
 *
 * A binding naming an action this editor does not provide is skipped rather than treated as an error:
 * the registry is shared with the file tree, and asking every consumer to implement every action
 * would mean adding one anywhere broke the others.
 *
 * @param commands - The commands this editor offers, by action id.
 * @param bindings - The author's combos by action id; missing entries fall back to the default.
 * @returns The keymap extension for those commands.
 */
export function editorShortcutsKeymap(
  commands: EditorShortcutCommands,
  bindings: ReadonlyMap<string, string>,
): Extension {
  const shortcuts: KeyBinding[] = [];
  for (const [action, run] of Object.entries(commands)) {
    const combo = bindings.get(action) ?? DEFAULT_EDITOR_KEY_COMBOS[action];
    if (combo === undefined) continue;
    shortcuts.push({ key: codemirrorKey(combo), run, preventDefault: true });
  }
  return keymap.of(shortcuts);
}
