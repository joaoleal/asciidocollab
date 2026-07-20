/**
 * @file The CodeMirror extension profile for editing an Asciidoctor-PDF theme.
 *
 * A theme is YAML, not AsciiDoc. Before this file a `*-theme.yml` opened on the AsciiDoc path, where
 * it got AsciiDoc highlighting, AsciiDoc completions and AsciiDoc diagnostics — all of them wrong for
 * the content, and the last actively misleading.
 *
 * This is a deliberately SMALLER profile than {@link buildEditorExtensions}, not a variant of it.
 * Most of what the AsciiDoc editor carries — include tracing, heading levels, the outline, symbol
 * indexing, conditional dimming — answers questions a theme document does not raise. What is shared
 * is the surrounding editor behaviour a collaborator expects to be identical whatever they have open:
 * the same read-only compartment, the same collab binding, the same minimap and soft-wrap
 * preferences. Those are threaded through rather than reimplemented, so a theme file co-edits on
 * exactly the terms every other project file does (FR-026a).
 */
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { autocompletion } from '@codemirror/autocomplete';
import { linter, lintGutter } from '@codemirror/lint';
import { syntaxHighlighting, indentUnit } from '@codemirror/language';
import { yaml } from '@codemirror/lang-yaml';
import type { ThemeSettingDescriptor } from '@asciidocollab/shared';
import { lineNumbersWithFold } from '@/lib/codemirror/line-fold-gutter';
import { asciidocTheme } from '@/lib/codemirror/asciidoc-theme';
import { searchPanelTheme } from '@/lib/codemirror/search-panel-theme';
import { minimapExtension } from '@/lib/codemirror/editor-extensions';
import { createThemeKeyCompletionSource } from '@/lib/codemirror/completions/theme-key';
import { createThemeDiagnosticsSource } from '@/lib/codemirror/theme/theme-diagnostics';
import { createThemeKeyHover } from '@/lib/codemirror/theme/theme-key-hover';
import { createThemeValueWidgets } from '@/lib/codemirror/theme/theme-value-widgets';
import { themeYamlHighlightStyle } from '@/lib/codemirror/theme/theme-yaml-highlight';

/**
 * YAML nests with two spaces, and the default theme this editor seeds from is written that way. A
 * theme indented any other way still parses, but would diverge from every example an author finds in
 * the theming guide.
 */
const THEME_INDENT = '  ';

/** The compartments the theme editor reconfigures live. */
export interface ThemeEditorCompartments {
  /** Read-only / editability, reconfigured when write access changes. */
  readOnly: Compartment;
  /** Soft-wrap, reconfigured when the preference toggles. */
  lineWrap: Compartment;
  /** Minimap, reconfigured when the preference toggles. */
  minimap: Compartment;
}

/** Inputs for {@link buildThemeEditorExtensions}. */
export interface BuildThemeEditorExtensionsOptions {
  /** The live-reconfigurable compartments, created once per mount. */
  compartments: ThemeEditorCompartments;
  /** Whether the theme is editable at mount. A reader still gets the editor and the preview (FR-026). */
  canEdit: boolean;
  /** Whether soft-wrap is enabled at mount. */
  softWrap: boolean;
  /** Whether the minimap is enabled at mount. */
  minimapEnabled: boolean;
  /**
   * The theme settings completion may offer, widened by whatever extensions the project has enabled.
   * Read lazily so enabling one widens completion without a remount (invariant D5).
   */
  getThemeSettings: () => readonly ThemeSettingDescriptor[];
  /** True on the collab path: native history is omitted, as the Yjs UndoManager owns undo. */
  collabActive: boolean;
  /** The collaboration binding extension, when present. */
  collabExtension?: Extension;
  /** Extensions the hook builds that close over its refs. */
  hookExtensions?: Extension[];
}

/**
 * Assemble the CodeMirror extensions for a theme document.
 *
 * @param options - Compartments, mount-time flags, and the lazily-read settings catalogue.
 * @returns The ordered extension array.
 */
export function buildThemeEditorExtensions(
  options: BuildThemeEditorExtensionsOptions,
): Extension[] {
  const {
    compartments,
    canEdit,
    softWrap,
    minimapEnabled,
    getThemeSettings,
    collabActive,
    collabExtension,
    hookExtensions = [],
  } = options;

  // Yjs owns undo on the collab path; a second history would fight it.
  const nativeHistory = collabActive ? [] : [history()];
  const nativeHistoryKeymap = collabActive ? [] : historyKeymap;

  return [
    yaml(),
    indentUnit.of(THEME_INDENT),
    // The app's own light/dark palette, NOT `defaultHighlightStyle` — that one's colours are fixed
    // hex values chosen against a white background, which on the dark surface rendered YAML keys as
    // dark blue on near-black.
    syntaxHighlighting(themeYamlHighlightStyle),
    ...nativeHistory,
    keymap.of([...defaultKeymap, ...nativeHistoryKeymap, ...searchKeymap]),
    search({ top: true }),
    searchPanelTheme,
    // Same rule as the AsciiDoc editor: readOnly blocks user input but not Yjs-applied updates, so a
    // reader still sees collaborators' live edits; editable.of(false) drops the misleading caret.
    compartments.readOnly.of([
      EditorState.readOnly.of(!canEdit),
      EditorView.editable.of(canEdit),
    ]),
    lineNumbersWithFold(),
    highlightActiveLine(),
    lintGutter(),
    // The lint source reads the SAME getter completion does, so a key an enabled extension
    // contributes is offered and accepted by one decision rather than two that can disagree.
    linter(createThemeDiagnosticsSource(getThemeSettings)),
    // Inline colour swatches and font samples, revealed as raw text wherever the cursor sits. Same
    // getter again, so an extension's contributed colour key gets a swatch like any built-in one.
    createThemeValueWidgets(getThemeSettings),
    compartments.minimap.of(minimapEnabled ? minimapExtension() : []),
    autocompletion({ override: [createThemeKeyCompletionSource(getThemeSettings)] }),
    // The same getter again, so a key an enabled extension contributes is offered, accepted AND
    // explained by one decision rather than three that can disagree.
    createThemeKeyHover(getThemeSettings),
    ...(collabExtension ? [collabExtension] : []),
    ...hookExtensions,
    // Prec.highest for the same reason as the AsciiDoc editor: CodeMirror mounts higher-precedence
    // style modules last, so the brand theme must outrank the highlighters above it.
    Prec.highest(asciidocTheme),
    compartments.lineWrap.of(softWrap ? [EditorView.lineWrapping] : []),
  ];
}
