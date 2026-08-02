/** Definition of a registerable key binding action. */
export interface KeyBindingDefinition {
  /** The namespace grouping for this action (e.g., 'file-tree'). */
  namespace: string;
  /** Human-readable label for this action. */
  label: string;
  /** Default key combination string for this action. */
  defaultCombo: string;
}

/**
 * The platform's own command modifier, as a combo may spell it: `Cmd` on macOS, `Ctrl` everywhere
 * else. Only DEFAULTS use it — a user who records a combo of their own records the modifier they
 * actually pressed, and that literal choice is then honoured on whatever machine they are using.
 *
 * It exists because the alternative is worse in both directions: a default of `Ctrl+B` is the wrong
 * key on a Mac, and a default of `Cmd+B` is a key most keyboards do not have.
 */
export const PLATFORM_MODIFIER = 'Mod';

/**
 * Registry of all known key binding actions with their defaults.
 *
 * Conflicts are resolved WITHIN a namespace (see the update use case), so two namespaces may use the
 * same combo for different things — which is what lets the editor keep `Ctrl+F` for find-in-document
 * while the file tree keeps it for find-file. Each is offered where its own surface has the focus.
 */
export const DEFAULT_KEY_BINDINGS: Record<string, KeyBindingDefinition> = {
  'file-tree:rename': { namespace: 'file-tree', label: 'Rename', defaultCombo: 'F2' },
  'file-tree:delete': { namespace: 'file-tree', label: 'Delete', defaultCombo: 'Delete' },
  'file-tree:new-file': { namespace: 'file-tree', label: 'New File', defaultCombo: 'Ctrl+N' },
  'file-tree:new-folder': { namespace: 'file-tree', label: 'New Folder', defaultCombo: 'Ctrl+Shift+N' },
  'file-tree:find': { namespace: 'file-tree', label: 'Find File', defaultCombo: 'Ctrl+F' },
  'editor:bold': { namespace: 'editor', label: 'Bold', defaultCombo: 'Mod+B' },
  'editor:italic': { namespace: 'editor', label: 'Italic', defaultCombo: 'Mod+I' },
  'editor:code': { namespace: 'editor', label: 'Inline Code', defaultCombo: 'Mod+`' },
  'editor:toggle-comment': { namespace: 'editor', label: 'Toggle Comment', defaultCombo: 'Mod+/' },
  'editor:fold-all': { namespace: 'editor', label: 'Fold All Sections', defaultCombo: 'Mod+Alt+[' },
  'editor:unfold-all': { namespace: 'editor', label: 'Unfold All Sections', defaultCombo: 'Mod+Alt+]' },
  'editor:fold-level-1': { namespace: 'editor', label: 'Fold to Level 1', defaultCombo: 'Mod+Alt+1' },
  'editor:fold-level-2': { namespace: 'editor', label: 'Fold to Level 2', defaultCombo: 'Mod+Alt+2' },
  'editor:review-comment': { namespace: 'editor', label: 'Add Review Comment', defaultCombo: 'Mod+Shift+M' },
};

/**
 * Browser-reserved combos that must not be remapped.
 * Note: Alt+F4 is listed defensively — browsers typically cannot intercept this
 * OS-level shortcut; entry serves as documentation intent rather than a runtime guard.
 */
export const RESERVED_KEY_COMBOS: string[] = [
  'Ctrl+W',
  'Ctrl+T',
  'Ctrl+R',
  'F5',
  'F11',
  'Alt+F4',
];
