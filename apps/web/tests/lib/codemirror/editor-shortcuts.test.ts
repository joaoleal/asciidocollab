import { DEFAULT_EDITOR_KEY_COMBOS } from '@asciidocollab/shared';
import { codemirrorKey, editorShortcutCommands, editorShortcutsKeymap } from '@/lib/codemirror/editor-shortcuts';

/** The keys a built keymap binds, in the order it bound them. */
function boundKeys(extension: ReturnType<typeof editorShortcutsKeymap>): string[] {
  // `keymap.of(...)` yields a facet provider whose input is the binding array; reading it back is how
  // a test can see what the editor will actually bind without mounting one.
  const bindings = (extension as { value?: readonly { key?: string }[] }).value ?? [];
  return bindings.map((binding) => binding.key ?? '');
}

describe('codemirrorKey', () => {
  it('turns a stored combo into CodeMirror’s spelling of the same keystroke', () => {
    expect(codemirrorKey('Mod+B')).toBe('Mod-b');
    expect(codemirrorKey('Ctrl+Alt+[')).toBe('Ctrl-Alt-[');
    expect(codemirrorKey('Mod+Alt+1')).toBe('Mod-Alt-1');
  });

  it('lowercases the letter even when Shift is one of the modifiers', () => {
    // CodeMirror reads an uppercase letter as the SHIFTED character, so `Mod-Shift-M` would ask for a
    // keystroke nobody can type. Shift stays a modifier of its own and the letter stays plain.
    expect(codemirrorKey('Mod+Shift+M')).toBe('Mod-Shift-m');
  });

  it('leaves a named key alone', () => {
    expect(codemirrorKey('F2')).toBe('F2');
    expect(codemirrorKey('Ctrl+Delete')).toBe('Ctrl-Delete');
  });
});

describe('editorShortcutsKeymap', () => {
  const commands = editorShortcutCommands(() => undefined);

  it('binds every command the editor offers', () => {
    const keymap = editorShortcutsKeymap(commands, new Map());

    expect(boundKeys(keymap)).toHaveLength(Object.keys(commands).length);
  });

  it('falls back to the default for an action the author has not remapped', () => {
    const keymap = editorShortcutsKeymap(commands, new Map());

    // The author's own combos arrive over the network. Binding nothing until they land would ignore
    // the first Mod+B of every session, so the defaults apply from the first frame.
    expect(boundKeys(keymap)).toContain(codemirrorKey(DEFAULT_EDITOR_KEY_COMBOS['editor:bold']!));
  });

  it('binds the author’s own combo in place of the default', () => {
    const keymap = editorShortcutsKeymap(commands, new Map([['editor:bold', 'Ctrl+Alt+B']]));

    const keys = boundKeys(keymap);
    expect(keys).toContain('Ctrl-Alt-b');
    expect(keys).not.toContain('Mod-b');
  });

  it('ignores a binding for an action this editor does not provide', () => {
    // The registry is shared with the file tree. Treating its actions as an error here would mean
    // adding a shortcut anywhere broke every other consumer of the same bindings.
    const keymap = editorShortcutsKeymap(commands, new Map([['file-tree:rename', 'F2']]));

    expect(boundKeys(keymap)).not.toContain('F2');
  });
});

describe('editorShortcutCommands', () => {
  it('provides a command for every editor shortcut the settings page offers', () => {
    // The whole point of the module. A shortcut the settings page lists and the editor cannot run is
    // configurable in appearance only: the author remaps it, the page reports success, and the key
    // goes on doing what it always did.
    const offered = Object.keys(DEFAULT_EDITOR_KEY_COMBOS).toSorted();
    expect(Object.keys(editorShortcutCommands(() => undefined)).toSorted()).toEqual(offered);
  });
});
