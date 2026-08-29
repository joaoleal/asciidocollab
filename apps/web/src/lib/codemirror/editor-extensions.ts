import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { autocompletion } from '@codemirror/autocomplete';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { lineNumbersWithFold } from '@/lib/codemirror/line-fold-gutter';
import { linter, lintGutter } from '@codemirror/lint';
import { showMinimap } from '@replit/codemirror-minimap';
import { blameExtension } from '@/lib/codemirror/blame-gutter';
import { asciidoc } from '@/lib/codemirror/asciidoc-language';
import { asciidocTheme } from '@/lib/codemirror/asciidoc-theme';
import { searchPanelTheme } from '@/lib/codemirror/search-panel-theme';
import { asciidocFold } from '@/lib/codemirror/asciidoc-fold';
import { asciidocHeadingLevels, inheritedHeadingOffsetFacet, outlineIncludeContextFacet, type IncludeResolutionContext } from '@/lib/codemirror/asciidoc-heading-levels';
import { asciidocAttributeFold } from '@/lib/codemirror/asciidoc-attribute-fold';
import { inheritedAttributesField } from '@/lib/codemirror/inherited-attributes-field';
import { asciidocCrossDocumentAttributes } from '@/lib/codemirror/cross-document-attributes';
import { asciidocConditionalDimming } from '@/lib/codemirror/conditional-dimming';
import { asciidocBlockDecorations } from '@/lib/codemirror/asciidoc-block-decorations';
import { asciidocSourceHighlight } from '@/lib/codemirror/asciidoc-source-highlight';
import { foldPersistence } from '@/lib/codemirror/asciidoc-fold-persist';
import { autoWrapInputHandler } from '@/lib/codemirror/asciidoc-format-keymap';
import { asciidocPasteHandlers } from '@/lib/codemirror/asciidoc-paste';
import { asciidocDiagnosticsSource } from '@/lib/codemirror/asciidoc-diagnostics';
import {
  createAttributeCompletionSource,
  createXrefCompletionSource,
  createIncludeCompletionSource,
  createImageCompletionSource,
  tableSnippetCompletionSource,
  tableCellCompletionSource,
  captionCompletionSource,
  sourceLanguageCompletionSource,
} from '@/lib/codemirror/asciidoc-completions';
import type { ProjectSymbolIndex } from '@/lib/codemirror/asciidoc-symbol-index';
import { outlineField, outlineResolvedScopeFacet } from '@/lib/codemirror/asciidoc-outline';
import { asciidocInlineStyleEmphasis } from '@/lib/codemirror/inline-style-registry';
import { tableContextField } from '@/lib/codemirror/asciidoc-table-context';
import { listContinuationKeymap } from '@/lib/codemirror/asciidoc-list-continuation';
import { createSpellcheckLinter } from '@/lib/codemirror/editor-spellcheck-linter';
import { createGrammarLinter } from '@/lib/codemirror/editor-grammar-linter';
import type { HarperLintSourceDeps } from '@/lib/codemirror/harper/harper-linter-source';

/** The compartments the hook reconfigures live; created once per (re)mount and passed in here. */
export interface EditorCompartments {
  /** Read-only / editability compartment, reconfigured when `canEdit` toggles. */
  readOnly: Compartment;
  /** Language compartment, reconfigured by the source-highlight loader to force a re-parse. */
  language: Compartment;
  /** Soft-wrap compartment, reconfigured when the soft-wrap preference toggles. */
  lineWrap: Compartment;
  /** Spell-check lint compartment, reconfigured when the language/enabled/ignore prefs change. */
  spellcheck: Compartment;
  /**
   * Harper grammar-check lint compartment. Empty at mount (the WASM engine loads asynchronously) and
   * reconfigured to the live source once the engine is ready; while it is active the spell-check
   * compartment is emptied so the two never double-flag the same misspelling.
   */
  grammar: Compartment;
  /** Minimap (document text-preview) compartment, reconfigured when the minimap preference toggles. */
  minimap: Compartment;
  /** Blame gutter compartment, reconfigured (empty ⇄ field+gutter) when the blame toggle flips. */
  blame: Compartment;
  /**
   * The author's configurable shortcuts. Empty at mount and reconfigured as soon as the mount hook
   * has the bindings — which is the same frame for the defaults, and again if the server's copy
   * differs. Held in a compartment because a keymap is fixed once built, and the author may change
   * one from the settings page while the editor is open.
   */
  shortcuts: Compartment;
}

/**
 * The document text-preview (minimap) extension — a scaled-down overview of the whole document down
 * the right edge. Gated behind the {@link EditorCompartments.minimap} compartment so it can be
 * toggled live, and off by default (see the `minimapEnabled` preference).
 *
 * @returns A `showMinimap` facet configured with an empty container the library renders into.
 */
export function minimapExtension(): Extension {
  return showMinimap.of({ create: () => { const dom = document.createElement('div'); return { dom }; } });
}

/** Inputs for {@link buildEditorExtensions}: compartments, live accessors, and per-mount flags. */
export interface BuildEditorExtensionsOptions {
  /** The live-reconfigurable compartments, created once per (re)mount by the hook. */
  compartments: EditorCompartments;
  /** Whether the editor is editable at mount (drives the readOnly compartment's initial value). */
  canEdit: boolean;
  /** Whether soft-wrap is enabled at mount (drives the lineWrap compartment's initial value). */
  softWrap: boolean;
  /** Whether the minimap (text-preview) is enabled at mount (drives the minimap compartment). */
  minimapEnabled: boolean;
  /** Whether the blame gutter is shown at mount (drives the blame compartment's initial value). */
  blameEnabled: boolean;
  /** Persistence key for per-file fold state; null ⇒ folds not persisted. */
  foldStorageKey: string | null;
  /** Returns the current spell-check ignore list. */
  getSpellIgnore: () => string[];
  /** Document language for spell-check (ISO 639-1). */
  spellcheckLanguage: string;
  /** When false, spell-check produces no diagnostics regardless of language. */
  spellcheckEnabled: boolean;
  /**
   * The Harper grammar-linter dependencies at mount, or null when grammar checking is inactive (the
   * usual mount state — the engine has not loaded yet, so the compartment starts empty and the hook
   * reconfigures it once the engine is ready).
   */
  grammarLinterDeps: HarperLintSourceDeps | null;
  /**
   * Uploads a pasted/dropped image.
   *
   * @param file - The image file to upload.
   * @returns The inserted project-relative path, or null on failure.
   */
  uploadImage?: (file: File) => Promise<string | null>;
  /** Returns the latest include paths for include:: completion. */
  getIncludePaths: () => string[];
  /** Returns the latest image paths for image:: completion. */
  getImagePaths: () => string[];
  /** Returns the open file's project-relative path, used to relativize include::/image:: targets. */
  getCurrentFilePath: () => string | null;
  /** Returns the project attribute map (supplies `imagesdir` for image-target relativization). */
  getCurrentAttributes: () => ReadonlyMap<string, string>;
  /**
   * Returns the attributes the open file inherits from the documents that include it, seeding the
   * `{attr}` collapse-to-value display so cross-document references resolve.
   */
  getInheritedAttributes: () => ReadonlyMap<string, string>;
  /**
   * Returns the names (lowercase) KNOWN ANYWHERE in the include tree — the symbol index's project-wide
   * `attributes` view (every file's definitions unioned), used to highlight a `{name}` whose attribute
   * is defined in a parent OR an included file as known. Deliberately broader than
   * the position-resolved value scope ({@link BuildEditorExtensionsOptions.getOutlineResolvedScope} /
   * the `{attr}` fold), so a `{name}` can be highlighted-known yet not collapse to a value at a
   * reference above its definition.
   */
  getCrossDocumentAttributeNames: () => ReadonlySet<string>;
  /**
   * Returns the open file's RESOLVED cross-document attribute scope (lowercase name → value). The
   * section outline reads it to resolve `{attr}` references in heading titles and to evaluate
   * conditional (`ifdef`/`ifndef`/`ifeval`) regions so inactive-branch headings are excluded, keeping
   * the outline consistent with the rendered preview. Read lazily; the outline recomputes
   * via the shared {@link refreshHeadingLevelsEffect} when the resolved scope changes.
   */
  getOutlineResolvedScope: () => ReadonlyMap<string, string>;
  /** Returns the latest project symbol index (or null for current-file scope). */
  projectIndexAccessor: () => ProjectSymbolIndex | null;
  /** Returns the inherited include-path heading-level offset. */
  getInheritedOffset: () => number;
  /** Returns the include resolution context for heading-level include tracing, or null. */
  getIncludeContext?: () => IncludeResolutionContext | null;
  /** True on the collab path: native history is omitted (Yjs UndoManager owns undo). */
  collabActive: boolean;
  /** The collaboration binding extension, when present (collab path only). */
  collabExtension?: Extension;
  /** Extensions the hook builds that close over its refs (update listener, DOM handlers, tooltip). */
  hookExtensions: Extension[];
}

/**
 * Assembles the full CodeMirror extension array for the AsciiDoc editor. Pure with respect to React
 * — it receives the compartments, live accessors, and hook-owned extensions as inputs and returns
 * the array passed to {@link EditorState.create}. The ordering and precedence here are load-bearing
 * (see inline notes) and must match the live editor's behaviour exactly.
 *
 * @param options - Compartments, accessors, mount-time flags, and hook-owned extensions.
 * @returns The ordered extension array.
 */
export function buildEditorExtensions(options: BuildEditorExtensionsOptions): Extension[] {
  const {
    compartments,
    canEdit,
    softWrap,
    minimapEnabled,
    blameEnabled,
    foldStorageKey,
    getSpellIgnore,
    spellcheckLanguage,
    spellcheckEnabled,
    grammarLinterDeps,
    uploadImage,
    getIncludePaths,
    getImagePaths,
    getCurrentFilePath,
    getCurrentAttributes,
    getInheritedAttributes,
    getCrossDocumentAttributeNames,
    getOutlineResolvedScope,
    projectIndexAccessor,
    getInheritedOffset,
    getIncludeContext,
    collabActive,
    collabExtension,
    hookExtensions,
  } = options;

  const nativeHistory = collabActive ? [] : [history()];
  const nativeHistoryKeymap = collabActive ? [] : historyKeymap;
  const collab = collabExtension ? [collabExtension] : [];

  return [
    // The open file's inherited-attribute seed, read by the rename detector and xref completion to
    // derive heading ids under a parent-set idprefix/idseparator. Installed in the base set so those
    // consumers never depend on an optional feature extension being present; seeded from use-editor-mount.
    inheritedAttributesField,
    // The language lives in a compartment so the source-highlight loader can
    // reconfigure it (forcing a re-parse) once an embedded language loads.
    compartments.language.of(asciidoc()),
    // `{ fresh: true }`: reconfiguring with a NEW Language is what forces CodeMirror to restart
    // parsing so the just-loaded embedded parser is injected (see asciidoc-language.ts).
    asciidocSourceHighlight((view) =>
      view.dispatch({ effects: compartments.language.reconfigure(asciidoc({ fresh: true })) }),
    ),
    // asciidocTheme (Prec.highest, below) already includes syntaxHighlighting for the 030 style;
    // the legacy asciidocHighlightStyle registration was removed to prevent its span-level fontSize
    // specs from overriding the 030 line-level heading ramp (cm-ad-h* decorations).
    syntaxHighlighting(defaultHighlightStyle),
    // Native history is omitted on the collab path (Yjs UndoManager owns undo there).
    ...nativeHistory,
    // List auto-continuation Enter command — registered before defaultKeymap (and at
    // Prec.high) so it handles list lines first and all other lines fall through.
    listContinuationKeymap,
    // The author's configurable shortcuts (formatting, folding, review comment), bound before
    // defaultKeymap so they win without overriding save/find/undo.
    compartments.shortcuts.of([]),
    autoWrapInputHandler,
    keymap.of([...defaultKeymap, ...nativeHistoryKeymap, ...searchKeymap]),
    search({ top: true }),
    // Style the stock find/replace panel from design tokens (behaviour/keymap unchanged).
    searchPanelTheme,
    // readOnly blocks user input but not programmatic Yjs-applied updates, so observers
    // still see live remote edits (research D8); editable.of(false) also drops the caret/
    // contenteditable so there is no misleading editable affordance.
    compartments.readOnly.of([
      EditorState.readOnly.of(!canEdit),
      EditorView.editable.of(canEdit),
    ]),
    // One gutter for line numbers + section folding: a fold chevron sits beside the number on every
    // foldable line, so folding needs no separate column (it also carries codeFolding(), the fold state).
    lineNumbersWithFold(),
    highlightActiveLine(),
    asciidocFold,
    // Whole-document fold controls (fold-all/unfold-all/to-level) + per-file
    // fold persistence.
    foldPersistence(foldStorageKey),
    // Paste/drop conveniences: URL→link, HTML→AsciiDoc, image→upload+image::.
    asciidocPasteHandlers({ uploadImage }),
    // Prose spell-check + cross-file/structural diagnostics:
    // each is its own lint source so they merge in the gutter/underlines.
    lintGutter(),
    compartments.spellcheck.of(
      createSpellcheckLinter(getSpellIgnore, spellcheckLanguage, spellcheckEnabled),
    ),
    // Grammar check (Harper): empty until the engine loads, then reconfigured live by the mount hook,
    // which also empties the spell-check compartment while grammar is active (research R8).
    compartments.grammar.of(createGrammarLinter(grammarLinterDeps)),
    linter(asciidocDiagnosticsSource(projectIndexAccessor)),
    // Effective heading-level styling: raw level + in-file :leveloffset:.
    // Inherited (cross-file) offset is wired from the symbol index.
    asciidocHeadingLevels(getInheritedOffset, getIncludeContext),
    // Expose the same inherited offset to the outline StateField so it derives effective levels
    // (and the beyond-max / leveloffset rules) identically to the heading highlight.
    inheritedHeadingOffsetFacet.of(getInheritedOffset),
    // {attr} collapse-to-value display fold — source text unchanged. Seeded with the
    // attributes inherited from including documents so cross-file references collapse too.
    asciidocAttributeFold(getInheritedAttributes),
    // Mark `{name}` references that resolve in the file's RESOLVED cross-document scope,
    // so the theme can distinguish known cross-document references from unknown ones. The accessor is
    // read lazily; a refresh effect re-evaluates the marks live as the symbol index resolves values.
    asciidocCrossDocumentAttributes(getCrossDocumentAttributeNames),
    // Dim the content of inactive conditional branches (`ifdef`/`ifndef`/`ifeval`) so the editor
    // matches what the preview renders. The branch active/inactive decision evaluates
    // each region against the SAME resolved cross-document scope the outline uses to exclude
    // inactive-branch headings (`getOutlineResolvedScope` = inherited attributes + the file's own
    // definitions), so the dimming and the outline never disagree — e.g. a branch gated on a
    // locally-defined `:flag:` is both shown in the outline and left undimmed. It recomputes live on a
    // document edit and on the shared cross-document refresh effect (dispatched when the scope changes).
    asciidocConditionalDimming(getOutlineResolvedScope),
    // Give role spans `[.role]#…#` with a KNOWN inline style (built-in or registered) a distinct
    // emphasis on top of the grammar's generic role-span highlight. Registering a new
    // role needs no change here — the decoration recomputes from the registry on each update.
    asciidocInlineStyleEmphasis(),
    // Recede block-title `.` markers and table `|` separators, and bold table header cells, layered
    // over the grammar's token colours.
    asciidocBlockDecorations(),
    // Feed the section outline the file's resolved cross-document scope so it resolves `{attr}` titles
    // and excludes inactive conditional-branch headings; read lazily so the shared
    // refreshHeadingLevelsEffect re-evaluates it when the scope changes without a document edit.
    outlineResolvedScopeFacet.of(getOutlineResolvedScope),
    // Give the outline the SAME include-resolution context the heading decorations use, so it traces
    // `include::` directives and folds an included file's persisting `:leveloffset:` into the levels of
    // the headings below the include — keeping the outline and the styled headings in lockstep on an
    // include-induced offset. Falls back to no include tracing when the project index is unavailable.
    outlineIncludeContextFacet.of(getIncludeContext ?? (() => null)),
    outlineField,
    tableContextField,
    // Text-preview (minimap), gated behind its compartment and off unless the user opts in.
    compartments.minimap.of(minimapEnabled ? minimapExtension() : []),
    // Per-line authorship (blame) gutter + its backing field, gated behind its compartment and off
    // unless the toolbar toggle turns blame on. Empty when off, so the blame column takes no width.
    compartments.blame.of(blameEnabled ? blameExtension() : []),
    autocompletion({
      override: [
        createAttributeCompletionSource(projectIndexAccessor),
        sourceLanguageCompletionSource,
        createXrefCompletionSource(projectIndexAccessor),
        createIncludeCompletionSource(getIncludePaths, getCurrentFilePath),
        createImageCompletionSource(getImagePaths, getCurrentAttributes),
        tableSnippetCompletionSource,
        tableCellCompletionSource,
        captionCompletionSource,
      ],
    }),
    ...collab,
    ...hookExtensions,
    // Brand editor theme (chrome + syntax via --syntax-* vars), following light/dark
    // automatically. Prec.highest so its highlight wins over the highlighters above:
    // CodeMirror mounts higher-precedence style modules last, so they win the cascade.
    Prec.highest(asciidocTheme),
    // Soft-wrap lives in a compartment so toggling the preference reconfigures
    // the live editor without a remount.
    compartments.lineWrap.of(softWrap ? [EditorView.lineWrapping] : []),
  ];
}
