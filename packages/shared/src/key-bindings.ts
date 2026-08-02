/** @file The editor shortcut defaults the browser needs before the server's answer arrives. */

/**
 * The editor's default key combos, by action id.
 *
 * Declared here rather than re-exported from `@asciidocollab/domain`, for exactly the reason the review
 * body limit is (see `./review/constants.ts`): these are runtime VALUES, so a re-export would pull the
 * whole domain package into the browser bundle behind every `@asciidocollab/shared` import, and the
 * architecture guard forbids the web app importing the domain at all.
 *
 * What they are for is the gap at the start of a session. The server merges each author's own combos
 * over the defaults and returns the complete set, so this table is never the authority — but that
 * answer arrives over the network, and an editor that bound nothing until it landed would ignore the
 * first `Mod+B` of every session. Binding these immediately and rebinding when the author's own
 * choices arrive means the shortcuts work from the first keystroke and still honour a remapping.
 *
 * `Mod` is the platform's command modifier: Cmd on macOS, Ctrl elsewhere. The two declarations are
 * held together by a parity test in `apps/api/tests/architecture`, the one layer that may read both.
 */
export const DEFAULT_EDITOR_KEY_COMBOS: Readonly<Record<string, string>> = {
  'editor:bold': 'Mod+B',
  'editor:italic': 'Mod+I',
  'editor:code': 'Mod+`',
  'editor:toggle-comment': 'Mod+/',
  'editor:fold-all': 'Mod+Alt+[',
  'editor:unfold-all': 'Mod+Alt+]',
  'editor:fold-level-1': 'Mod+Alt+1',
  'editor:fold-level-2': 'Mod+Alt+2',
  'editor:review-comment': 'Mod+Shift+M',
};
