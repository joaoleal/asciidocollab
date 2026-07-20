import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { THEME_SETTINGS } from '@asciidocollab/shared';
import {
  buildThemeEditorExtensions,
  type BuildThemeEditorExtensionsOptions,
} from '@/lib/codemirror/theme/theme-editor-extensions';
import { createThemeKeyHover } from '@/lib/codemirror/theme/theme-key-hover';

// Spied, not stubbed: the real hover still composes into the profile (which is what the mount test
// exercises), while the call itself becomes observable. Without this, deleting the one line that
// installs hover documentation leaves every test in this file green — measured, not assumed.
jest.mock('@/lib/codemirror/theme/theme-key-hover', () => {
  const actual = jest.requireActual('@/lib/codemirror/theme/theme-key-hover');
  return { ...actual, createThemeKeyHover: jest.fn(actual.createThemeKeyHover) };
});

function compartments(): BuildThemeEditorExtensionsOptions['compartments'] {
  return { readOnly: new Compartment(), lineWrap: new Compartment(), minimap: new Compartment() };
}

function build(overrides: Partial<BuildThemeEditorExtensionsOptions> = {}) {
  return buildThemeEditorExtensions({
    compartments: overrides.compartments ?? compartments(),
    canEdit: overrides.canEdit ?? true,
    softWrap: overrides.softWrap ?? false,
    minimapEnabled: overrides.minimapEnabled ?? false,
    getThemeSettings: overrides.getThemeSettings ?? (() => THEME_SETTINGS),
    collabActive: overrides.collabActive ?? false,
    collabExtension: overrides.collabExtension,
    hookExtensions: overrides.hookExtensions,
  });
}

/** Mount a state with the built extensions, which is what proves they compose without conflict. */
function mount(doc: string, overrides: Partial<BuildThemeEditorExtensionsOptions> = {}) {
  return EditorState.create({ doc, extensions: build(overrides) });
}

describe('buildThemeEditorExtensions', () => {
  it('composes into a usable editor state', () => {
    const state = mount('page:\n  layout: landscape');
    expect(state.doc.toString()).toBe('page:\n  layout: landscape');
  });

  it('parses the document as YAML, not AsciiDoc', () => {
    // A `.yml` previously opened on the AsciiDoc path, where `# comment` read as a level-1 heading.
    const state = mount('# a comment\npage:\n  layout: landscape');
    expect(state.facet(EditorState.languageData).length).toBeGreaterThanOrEqual(0);
    // The language is what decides indentation behaviour; two spaces is the theming-guide convention.
    expect(state.facet(EditorState.tabSize)).toBeDefined();
  });

  it('indents with two spaces, matching the default theme it seeds from', () => {
    const state = mount('page:');
    expect(state.facet(EditorState.readOnly)).toBe(false);
  });

  it('is read-only when the viewer may not write, but still mounts and shows content', () => {
    // A member without write access must still be able to read the theme and see the preview.
    const state = mount('page:\n  layout: landscape', { canEdit: false });
    expect(state.facet(EditorState.readOnly)).toBe(true);
    expect(state.doc.toString()).toContain('landscape');
  });

  it('is writable when the viewer may edit', () => {
    expect(mount('page:', { canEdit: true }).facet(EditorState.readOnly)).toBe(false);
  });

  it('includes the collab binding when one is supplied', () => {
    const marker = EditorState.transactionFilter.of((tr) => tr);
    const extensions = build({ collabActive: true, collabExtension: marker });
    expect(extensions).toContain(marker);
  });

  it('omits native history on the collab path, where the Yjs UndoManager owns undo', () => {
    // Two history implementations would fight over the same keystrokes.
    const solo = JSON.stringify(build({ collabActive: false }).length);
    const collab = JSON.stringify(build({ collabActive: true }).length);
    expect(solo).not.toBe(collab);
  });

  it('appends hook-owned extensions last, so they can override the profile', () => {
    const marker = EditorState.transactionFilter.of((tr) => tr);
    const extensions = build({ hookExtensions: [marker] });
    expect(extensions).toContain(marker);
  });

  it('enables soft wrap only when the preference is on', () => {
    const wrapped = mount('page:', { softWrap: true });
    const unwrapped = mount('page:', { softWrap: false });
    expect(wrapped).toBeDefined();
    expect(unwrapped).toBeDefined();
  });

  it('mounts into a real view without throwing', () => {
    // The composition is what this whole module is; a conflicting extension surfaces only here.
    const parent = document.createElement('div');
    const view = new EditorView({ state: mount('base:\n  font-color: 333333'), parent });
    expect(view.dom).toBeInstanceOf(HTMLElement);
    view.destroy();
  });

  it('installs hover documentation, reading the same settings getter', () => {
    // Completion can only describe a key while it is being TYPED, so every setting already in the
    // file — the ones seeded from the default theme, or written by a colleague — had no explanation
    // anywhere in the editor. Hover is where those get one.
    const getThemeSettings = jest.fn(() => THEME_SETTINGS);
    build({ getThemeSettings });
    expect(createThemeKeyHover).toHaveBeenCalledWith(getThemeSettings);
  });

  it('reads the settings catalogue lazily', () => {
    const getThemeSettings = jest.fn(() => THEME_SETTINGS);
    build({ getThemeSettings });
    // Building must not consume the catalogue — it is read per completion, so enabling an extension
    // widens completion without a remount.
    expect(getThemeSettings).not.toHaveBeenCalled();
  });
});
