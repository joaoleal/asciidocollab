'use client';
import { useEffect, useRef, useCallback, useState } from 'react';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { refreshHeadingLevelsEffect } from '@/lib/codemirror/asciidoc-heading-levels';
import { refreshAttributeFoldEffect } from '@/lib/codemirror/asciidoc-attribute-fold';
import { setInheritedAttributesEffect } from '@/lib/codemirror/inherited-attributes-field';
import { contentChangedRefreshEffect } from '@/lib/codemirror/rename-suggestion/rename-suggestion-effects';
import { refreshCrossDocumentAttributesEffect } from '@/lib/codemirror/cross-document-attributes';
import type { ProjectSymbolIndex } from '@/lib/codemirror/asciidoc-symbol-index';
import { RENDER_INTRINSIC_ATTRIBUTES } from '@/lib/asciidoc/render-intrinsics';
import { createLinkHandler, type XrefTarget } from '@/lib/codemirror/asciidoc-link-handler';
import { outlineField } from '@/lib/codemirror/asciidoc-outline';
import type { SectionOutlineEntry } from '@/lib/codemirror/asciidoc-outline';
import { buildEditorExtensions, minimapExtension } from '@/lib/codemirror/editor-extensions';
import { createSpellcheckLinter } from '@/lib/codemirror/editor-spellcheck-linter';
import { createGrammarLinter, refreshGrammarLints } from '@/lib/codemirror/editor-grammar-linter';
import { createHarperEngine } from '@/lib/create-harper-worker';
import {
  createHarperWorkerClient,
  toGrammarEngineStatus,
  type HarperWorkerClient,
  type GrammarEngineStatus,
} from '@/lib/codemirror/harper/harper-worker-client';
import type { HarperLintSourceDeps } from '@/lib/codemirror/harper/harper-linter-source';
import type { GrammarDiagnostic } from '@/lib/codemirror/harper/lint-to-diagnostic';
import {
  createIncludedFileLinter,
  type IncludedFile,
  type IncludedFileIssue,
  type IncludedFileLinter,
} from '@/lib/codemirror/harper/included-file-lint';
import { resetDocumentScope, setDocumentScope } from '@/lib/codemirror/harper/document-scope-store';
import { asciidocLanguage } from '@/lib/codemirror/asciidoc-language';
import { DEFAULT_GRAMMAR_DIALECT, type GrammarDialect } from '@/lib/codemirror/harper/dialect';
import { grammarDiagnosticsListener, type PositionedGrammarDiagnostic } from '@/lib/codemirror/harper/grammar-diagnostics';
import type { LintScope } from '@/lib/codemirror/harper/harper-linter-source';
import { reviewDecorations } from '@/lib/codemirror/review-decorations';
import { reviewMarkerClickHandler, reviewMarkerHoverHandler } from '@/lib/codemirror/review-interaction';
import { editorShortcutCommands, editorShortcutsKeymap } from '@/lib/codemirror/editor-shortcuts';
import { useKeyBindings } from '@/hooks/use-key-bindings';
import {
  createLineClickHandler,
  createFileDropHandler,
  createCtrlClickTooltip,
  wireScrollSync,
} from '@/lib/codemirror/editor-dom-handlers';

/**
 * Clamps a remembered 1-based line number to the document's valid range — the "closest
 * valid line" rule, applied when restoring a cursor that may exceed the current document length.
 *
 * @param line - The remembered 1-based line number.
 * @param totalLines - The document's current line count.
 * @returns A line number within `[1, totalLines]`.
 */
function clampToValidLine(line: number, totalLines: number): number {
  return Math.min(Math.max(line, 1), totalLines);
}

/** Stable empty default for the inherited-attributes prop (avoids a new map identity per render). */
const EMPTY_INHERITED_ATTRIBUTES: ReadonlyMap<string, string> = new Map();

/**
 * Quiet period, in milliseconds, the selection-driven preview sync waits for after the caret settles.
 * A mouse drag or a held arrow key coalesces into one sync at the final line rather than one per step.
 */
const SELECTION_SYNC_DEBOUNCE_MS = 80;

/**
 * Window, in milliseconds, after a selection-only caret move during which the top-of-viewport scroll
 * sync is suppressed. A caret move auto-scrolls the editor to reveal the caret; that reveal scroll
 * fires just after the selection sync and would otherwise clobber the precise selected line in the
 * preview. Long enough to cover the reveal (and any follow-up measure scroll), short enough that a
 * deliberate user scroll a moment later still syncs.
 */
const SELECTION_REVEAL_SUPPRESS_MS = 350;

/**
 * How many times the cross-file ("Whole document") pass retries after the shared worker client
 * supersedes it. A few attempts cover a burst of typing landing on top of the pass; beyond that the
 * next trigger will re-run it anyway, so retrying forever would only burn the engine.
 */
const CROSS_FILE_LINT_ATTEMPTS = 3;

/** Quiet period, in milliseconds, before a superseded cross-file pass tries again. */
const CROSS_FILE_LINT_RETRY_MS = 1500;

/** Lowercase the keys of an attribute map into a name set (Asciidoctor matches names case-insensitively). */
function toLowercaseNames(scope: ReadonlyMap<string, string>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const name of scope.keys()) names.add(name.toLowerCase());
  return names;
}

interface UseEditorMountOptions {
  content: string;
  canEdit: boolean;
  softWrap?: boolean;
  /** When true, shows the document text-preview (minimap). Defaults to false. */
  minimapEnabled?: boolean;
  /** Persistence key for per-file fold state; omitted ⇒ folds not persisted. */
  foldStorageKey?: string;
  /** Per-user spell-check ignore list. */
  spellIgnore?: string[];
  /** Document language for spell-check (ISO 639-1); defaults to 'en'. */
  spellcheckLanguage?: string;
  /** When false, spell-check produces no diagnostics regardless of language. Defaults to true. */
  spellcheckEnabled?: boolean;
  /** When true (and the language is English), on-device grammar checking is active. Defaults to false. */
  grammarEnabled?: boolean;
  /** Whether the project language is English — the hard gate for grammar checking. Defaults to false. */
  grammarLanguageIsEnglish?: boolean;
  /** The English dialect grammar checking enforces. Defaults to British. */
  grammarDialect?: GrammarDialect;
  /** The project dictionary terms to hydrate into the worker via `importWords` (so they stop being flagged). */
  dictionaryTerms?: string[];
  /** The caller's privacy-hashed ignored-lints blob to hydrate via `importIgnoredLints` (so ignores persist). */
  ignoredLintsBlob?: string;
  /**
   * Persist the caller's ignored-lints blob after they dismiss an issue. Omitted when there is nowhere
   * to store it, which also removes the Ignore action — better than offering a dismissal that is
   * forgotten on reload.
   *
   * @param blob - The engine's re-exported blob, to be stored as-is (opaque hashes, never prose).
   */
  onIgnoredLintsChange?: (blob: string) => void;
  /** The view-local lint scope: this file (default), or the whole `include::` document. */
  lintScope?: LintScope;
  /**
   * Called with the live grammar issues (for the panel + status bar) whenever they change.
   *
   * @param diagnostics - The current grammar diagnostics with live document positions.
   */
  onGrammarDiagnostics?: (diagnostics: PositionedGrammarDiagnostic[]) => void;
  /**
   * Called when grammar checking activates or deactivates (the engine loaded, or fell back to nspell).
   *
   * @param status - The on-device grammar engine's panel status (loading, ready, failed, or disabled).
   */
  onGrammarStatusChange?: (status: GrammarEngineStatus) => void;
  /**
   * Uploads a pasted/dropped image.
   *
   * @param file - The image file to upload.
   * @returns The inserted project-relative path, or null on failure.
   */
  uploadImage?: (file: File) => Promise<string | null>;
  includePaths: string[];
  imagePaths?: string[];
  /**
   * Live accessor for the cross-file project symbol index. Diagnostics and
   * xref/attribute completion consult it for cross-file targets; null ⇒ current-file
   * scope. The getter is captured once at mount and always returns the latest index.
   */
  getProjectIndex?: () => ProjectSymbolIndex | null;
  onDocChange: (content: string) => void;
  onCursorChange: (pos: { line: number; col: number; totalLines: number }) => void;
  onOutlineChange: (entries: SectionOutlineEntry[]) => void;
  onNavigateToFile?: (path: string) => void;
  onOpenUrl?: (url: string) => void;
  // Navigate to a cross-reference definition resolved via the project symbol index.
  onNavigateToXref?: (target: XrefTarget) => void;
  /**
   * Include-path level offset inherited by the open file from its ancestors. A change
   * to it after a main-file reconfiguration re-evaluates heading levels without a document edit.
   */
  inheritedOffset?: number;
  /**
   * Attributes the open file inherits from the documents that include it. They seed
   * the `{attr}` collapse-to-value display so cross-document references resolve; a change after the
   * symbol index rebuilds re-evaluates the display without a document edit.
   */
  inheritedAttributes?: ReadonlyMap<string, string>;
  /**
   * The open file's RESOLVED cross-document attribute scope (its inherited attributes merged with
   * its own definitions) — used to highlight `{name}` references that resolve anywhere in the
   * include tree as known. A change after the symbol index rebuilds re-evaluates the
   * highlighting without a document edit.
   */
  resolvedScope?: ReadonlyMap<string, string>;
  onLineClick?: (line: number) => void;
  /**
   * Called with the 1-based line at the top of the editor viewport as the user scrolls.
   *
   * @param line - The 1-based line number at the top of the visible viewport.
   */
  onScrollLine?: (line: number) => void;
  /**
   * Called with the 1-based caret line when the selection moves WITHOUT an edit — a click, keyboard
   * navigation, or a text selection, but never plain typing. Lets the preview follow the caret so
   * selecting a block scrolls it into view, as a companion to the scroll-position sync above.
   *
   * @param line - The 1-based line the caret moved to.
   */
  onSelectionLine?: (line: number) => void;
  /**
   * 1-based line to place the cursor on when the editor mounts (selection restore). Clamped
   * to the current document's line count ("closest valid line"); ignored when not provided.
   */
  initialLine?: number;
  /**
   * Live request to reveal a 1-based line in the already-mounted editor (same-file go-to-definition).
   * Each distinct `nonce` triggers one cursor move + scroll-into-view; clamped to the doc.
   */
  revealRequest?: { line: number; nonce: number } | null;
  /**
   * Collaboration binding extension (yCollab) for the collab path. When provided the editor is
   * populated from the bound `Y.Text` (empty on a first mount, see `getCollabDocText`); native
   * CodeMirror history is omitted to avoid double-undo (per-user undo is handled by the Yjs
   * UndoManager).
   */
  collabExtension?: Extension;
  /**
   * Current text of the bound `Y.Text`, read at view (re)creation time to seed the document.
   *
   * Note that yCollab's ySync plugin applies only INCREMENTAL `Y.Text` deltas — it never reads the
   * type's existing content. A view created empty against an ALREADY-populated document therefore stays
   * empty forever, because no further delta is coming, and the author's first keystroke then splices
   * into index 0 of the real text and gets persisted. That is reachable in practice: when the sync
   * handshake exceeds COLLAB_SYNC_TIMEOUT_MS the editor goes offline and drops the binding, and when
   * `synced` finally arrives the binding returns — so `remountKey` goes id → undefined → id and the
   * view is recreated against a `Y.Text` that is already full.
   *
   * Seeding from the live `Y.Text` makes creation idempotent: still empty on a first mount (unchanged
   * behaviour), restored on a recreation after sync. Never seed the REST copy here — yCollab would
   * append it to whatever Yjs subsequently delivers, duplicating the document.
   */
  getCollabDocText?: () => string;
  /**
   * The in-editor symbol rename-suggestion extension (feature 033). Built once by the editor with
   * stable getters, so it never forces a remount; omitted ⇒ no rename suggestions.
   */
  renameSuggestionExtension?: Extension;
  /**
   * Monotonic counter bumped when a collaborator changes any project file's content. Nudges the
   * rename-suggestion plugin to re-query its usage/collision counts while an offer is visible.
   * Undefined ⇒ no external refresh.
   */
  renameRefreshNonce?: number;
  /**
   * Forces the editor to recreate when it changes, such as the Yjs room id on a file switch, so
   * the collab binding rebinds to the new document. Stays undefined on the legacy path.
   */
  remountKey?: string;
  /**
   * Called when a review highlight/gutter marker (feature 038) is clicked, with the review item id
   * carried on its `data-review-id` attribute. Undefined ⇒ marker clicks are ignored.
   *
   * @param id - The clicked review item id.
   */
  onReviewMarkerClick?: (id: string) => void;
  /**
   * Called as the pointer moves over (or off) a review highlight/gutter marker (feature 038), with
   * the hovered review item id or null when none is under the pointer. Drives the editor→rail hover
   * emphasis. Undefined ⇒ hover is not reported.
   *
   * @param id - The hovered review item id, or null.
   */
  onReviewMarkerHover?: (id: string | null) => void;
  /**
   * Called from the floating "Comment" affordance over a non-empty selection (feature 038) with the
   * raw selection offsets; the host captures the Yjs anchor. Undefined ⇒ the affordance is hidden.
   *
   * @param from - The selection's start offset.
   * @param to - The selection's end offset.
   */
  onCommentFromSelection?: (from: number, to: number) => void;
}

/** Manages the full CodeMirror 6 view lifecycle: mount, teardown, content/readOnly sync. */
export function useEditorMount({
  content,
  canEdit,
  softWrap = true,
  minimapEnabled = false,
  foldStorageKey,
  spellIgnore,
  spellcheckLanguage = 'en',
  spellcheckEnabled = true,
  grammarEnabled = false,
  grammarLanguageIsEnglish = false,
  grammarDialect = DEFAULT_GRAMMAR_DIALECT,
  dictionaryTerms,
  ignoredLintsBlob,
  onIgnoredLintsChange,
  lintScope = 'this-file',
  onGrammarDiagnostics,
  onGrammarStatusChange,
  uploadImage,
  includePaths,
  imagePaths = [],
  getProjectIndex,
  onDocChange,
  onCursorChange,
  onOutlineChange,
  onNavigateToFile,
  onOpenUrl,
  onNavigateToXref,
  inheritedOffset = 0,
  inheritedAttributes = EMPTY_INHERITED_ATTRIBUTES,
  resolvedScope = EMPTY_INHERITED_ATTRIBUTES,
  onLineClick,
  onScrollLine,
  onSelectionLine,
  initialLine,
  revealRequest,
  collabExtension,
  getCollabDocText,
  renameSuggestionExtension,
  renameRefreshNonce,
  remountKey,
  onReviewMarkerClick,
  onReviewMarkerHover,
  onCommentFromSelection,
}: UseEditorMountOptions) {
  const collabActive = collabExtension !== undefined;
  const containerReference = useRef<HTMLDivElement>(null);
  const viewReference = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());
  const lineWrapCompartment = useRef(new Compartment());
  const spellcheckCompartment = useRef(new Compartment());
  const grammarCompartment = useRef(new Compartment());
  const minimapCompartment = useRef(new Compartment());
  const shortcutsCompartment = useRef(new Compartment());
  // The author's own key combos for the editor's commands, empty until the server answers — at which
  // point the effect below rebinds. Until then the registry's defaults apply, so nothing is dead.
  const shortcutBindings = useKeyBindings('editor');
  // The Harper worker client is created lazily the first time grammar checking activates, then reused.
  const harperClientReference = useRef<HarperWorkerClient | null>(null);
  const onGrammarDiagnosticsReference = useRef(onGrammarDiagnostics);
  onGrammarDiagnosticsReference.current = onGrammarDiagnostics;
  const onGrammarStatusChangeReference = useRef(onGrammarStatusChange);
  onGrammarStatusChangeReference.current = onGrammarStatusChange;
  const onIgnoredLintsChangeReference = useRef(onIgnoredLintsChange);
  onIgnoredLintsChangeReference.current = onIgnoredLintsChange;
  // Checks the OTHER files of the include tree for "Whole document" scope. Held across passes so its
  // per-file parse cache survives, making a re-check of an unchanged tree nearly free.
  const includedFileLinterReference = useRef<IncludedFileLinter | null>(null);
  // True once the engine has loaded and the grammar lint source is live; drives disabling nspell so the
  // two never double-flag a misspelling, and reverts to nspell if the engine never loads (degradation).
  const [grammarActive, setGrammarActive] = useState(false);
  const includePathsReference = useRef<string[]>(includePaths);
  useEffect(() => { includePathsReference.current = includePaths; }, [includePaths]);
  const imagePathsReference = useRef<string[]>(imagePaths);
  useEffect(() => { imagePathsReference.current = imagePaths; }, [imagePaths]);
  const onLineClickReference = useRef(onLineClick);
  useEffect(() => { onLineClickReference.current = onLineClick; }, [onLineClick]);
  const onScrollLineReference = useRef(onScrollLine);
  useEffect(() => { onScrollLineReference.current = onScrollLine; }, [onScrollLine]);
  const onSelectionLineReference = useRef(onSelectionLine);
  useEffect(() => { onSelectionLineReference.current = onSelectionLine; }, [onSelectionLine]);
  // Timestamp (ms) until which the top-of-viewport scroll sync is suppressed because a selection move
  // just triggered a reveal scroll; read by wireScrollSync so that reveal does not clobber the sync.
  const selectionRevealUntilReference = useRef(0);
  // Review interactivity (feature 038): kept in refs so the marker-click handler and the
  // selection-affordance plugin stay live without rebinding (they are captured once at mount).
  const onReviewMarkerClickReference = useRef(onReviewMarkerClick);
  useEffect(() => { onReviewMarkerClickReference.current = onReviewMarkerClick; }, [onReviewMarkerClick]);
  const onReviewMarkerHoverReference = useRef(onReviewMarkerHover);
  useEffect(() => { onReviewMarkerHoverReference.current = onReviewMarkerHover; }, [onReviewMarkerHover]);
  const onCommentFromSelectionReference = useRef(onCommentFromSelection);
  useEffect(() => { onCommentFromSelectionReference.current = onCommentFromSelection; }, [onCommentFromSelection]);
  const getProjectIndexReference = useRef(getProjectIndex);
  useEffect(() => { getProjectIndexReference.current = getProjectIndex; }, [getProjectIndex]);
  // Cross-file navigation seam, reused by the Writing panel to open an issue found in another file.
  const onNavigateToXrefReference = useRef(onNavigateToXref);
  useEffect(() => { onNavigateToXrefReference.current = onNavigateToXref; }, [onNavigateToXref]);
  const projectIndexAccessor = (): ProjectSymbolIndex | null => getProjectIndexReference.current?.() ?? null;
  // The open file's project-relative path (from the symbol index), used to write include::/image::
  // targets relative to the authoring file — AsciiDoc resolves directives relative to it, not the root.
  const currentFilePath = (): string | null => {
    const index = projectIndexAccessor();
    return index ? index.pathOf(index.activeFileId) : null;
  };
  // Attribute map in scope for the open file (its own definitions plus those inherited from the
  // files that include it) — for `{attr}` / `imagesdir` substitution in this file's macro targets.
  const currentAttributes = (): ReadonlyMap<string, string> => {
    const index = projectIndexAccessor();
    return index ? index.effectiveAttributes(index.activeFileId) : new Map();
  };
  const inheritedOffsetReference = useRef(inheritedOffset);
  useEffect(() => { inheritedOffsetReference.current = inheritedOffset; }, [inheritedOffset]);
  // Attributes inherited from including documents, seeding the `{attr}` collapse-to-value display.
  const inheritedAttributesReference = useRef(inheritedAttributes);
  useEffect(() => { inheritedAttributesReference.current = inheritedAttributes; }, [inheritedAttributes]);
  // Lowercase names known anywhere in the include tree, for known-vs-unknown `{name}` highlighting.
  // A reference is "known" when the attribute is defined ANYWHERE in the tree — in a
  // parent/including file OR in an included file — so this uses the index's
  // project-wide `attributes` view, not the position-aware resolved scope (which omits a descendant's
  // definitions). Recomputed when the index rebuilds (the resolvedScope prop changes identity then).
  const knownAttributeNames = (): ReadonlySet<string> => {
    const index = projectIndexAccessor();
    return index?.attributes ? toLowercaseNames(index.attributes) : new Set<string>();
  };
  const crossDocumentNamesReference = useRef<ReadonlySet<string>>(knownAttributeNames());
  useEffect(() => { crossDocumentNamesReference.current = knownAttributeNames(); }, [resolvedScope]);
  // The full resolved cross-document scope (name → value), read by the section outline to resolve
  // `{attr}` titles and exclude inactive conditional-branch headings.
  const resolvedScopeReference = useRef<ReadonlyMap<string, string>>(resolvedScope);
  useEffect(() => { resolvedScopeReference.current = resolvedScope; }, [resolvedScope]);
  // Keep onOutlineChange in a ref so the refresh effects below can re-publish the outline without
  // listing the callback in their deps (it is captured once at mount for the update listener).
  const onOutlineChangeReference = useRef(onOutlineChange);
  useEffect(() => { onOutlineChangeReference.current = onOutlineChange; }, [onOutlineChange]);
  // Tracks whether the collab cursor-line restore has fired for the current (re)mount.
  const collabLineRestoredReference = useRef(false);

  // Stable heading-click callback — viewReference is a ref, so no deps needed.
  const handleHeadingClick = useCallback((entry: { from: number }) => {
    if (viewReference.current) {
      viewReference.current.dispatch({
        selection: { anchor: entry.from },
        scrollIntoView: true,
      });
      viewReference.current.focus();
    }
  }, []);

  // Mount / teardown the EditorView once.
  useEffect(() => {
    if (!containerReference.current) return;
    collabLineRestoredReference.current = false;

    // Debounces the selection-driven preview sync so dragging a selection or holding an arrow key
    // coalesces into one request; cleared on teardown below.
    let selectionSyncTimer: ReturnType<typeof setTimeout> | null = null;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onDocChange(update.state.doc.toString());
        try { onOutlineChange(update.state.field(outlineField)); } catch { /* field not installed */ }
        // Collab path: the editor mounts empty and is populated by Yjs sync, so the remembered
        // cursor line is restored when content FIRST arrives (not merely on `synced`,
        // which can precede the populating transaction), clamped to the populated document.
        // Scheduled to a microtask to avoid dispatching while an update is in progress.
        if (
          collabActive &&
          initialLine !== undefined &&
          !collabLineRestoredReference.current &&
          update.state.doc.length > 0
        ) {
          collabLineRestoredReference.current = true;
          queueMicrotask(() => {
            const view = viewReference.current;
            if (!view) return;
            const targetLine = clampToValidLine(initialLine, view.state.doc.lines);
            view.dispatch({ selection: { anchor: view.state.doc.line(targetLine).from }, scrollIntoView: true });
          });
        }
      }
      const head = update.state.selection.main.head;
      const line = update.state.doc.lineAt(head);
      onCursorChange({ line: line.number, col: head - line.from + 1, totalLines: update.state.doc.lines });

      // Selection-driven preview sync: follow the caret in the preview when it moves WITHOUT an edit
      // (a click, keyboard navigation, or selecting text). Skipped on `docChanged` so plain typing
      // never yanks the preview on every keystroke, and debounced so a mouse drag or a held arrow key
      // produces a single sync at the settled line. The same move opens a short window during which the
      // top-of-viewport scroll sync is suppressed (see wireScrollSync): the reveal scroll it triggers
      // would otherwise fire just after and clobber the precise selected line in the preview.
      if (update.selectionSet && !update.docChanged) {
        selectionRevealUntilReference.current = Date.now() + SELECTION_REVEAL_SUPPRESS_MS;
        if (onSelectionLineReference.current) {
          const selectionLine = line.number;
          if (selectionSyncTimer !== null) clearTimeout(selectionSyncTimer);
          selectionSyncTimer = setTimeout(() => {
            selectionSyncTimer = null;
            onSelectionLineReference.current?.(selectionLine);
          }, SELECTION_SYNC_DEBOUNCE_MS);
        }
      }
    });

    // DOM-level handlers + Ctrl+click hover tooltip. Each closes over a live ref accessor so it
    // always observes the latest prop without rebinding (see editor-dom-handlers.ts).
    const lineClickHandler = createLineClickHandler(() => onLineClickReference.current);
    const fileDropHandler = createFileDropHandler(currentFilePath, currentAttributes);
    const ctrlClickTooltip = createCtrlClickTooltip(projectIndexAccessor);

    const state = EditorState.create({
      // Collab path seeds from the LIVE Y.Text: empty on a first mount, already-populated when the
      // view is recreated after sync (the offline→synced round trip drops and restores the binding,
      // which changes remountKey). Never the REST copy — yCollab would append it to whatever Yjs
      // delivers. See getCollabDocText (B3).
      doc: collabActive ? (getCollabDocText?.() ?? '') : content,
      extensions: buildEditorExtensions({
        compartments: {
          readOnly: readOnlyCompartment.current,
          language: languageCompartment.current,
          lineWrap: lineWrapCompartment.current,
          spellcheck: spellcheckCompartment.current,
          grammar: grammarCompartment.current,
          minimap: minimapCompartment.current,
          shortcuts: shortcutsCompartment.current,
        },
        canEdit,
        softWrap,
        minimapEnabled,
        foldStorageKey: foldStorageKey ?? null,
        getSpellIgnore: () => spellIgnore ?? [],
        spellcheckLanguage,
        spellcheckEnabled,
        // Grammar starts empty at mount: the WASM engine loads asynchronously, and the lifecycle effect
        // below reconfigures this compartment once it is ready (until then the nspell fallback is active).
        grammarLinterDeps: null,
        uploadImage,
        getIncludePaths: () => includePathsReference.current,
        getImagePaths: () => imagePathsReference.current,
        getCurrentFilePath: currentFilePath,
        getCurrentAttributes: currentAttributes,
        getInheritedAttributes: () => inheritedAttributesReference.current,
        getCrossDocumentAttributeNames: () => crossDocumentNamesReference.current,
        getOutlineResolvedScope: () => resolvedScopeReference.current,
        projectIndexAccessor,
        getInheritedOffset: () => inheritedOffsetReference.current,
        getIncludeContext: () => {
          const index = projectIndexAccessor();
          if (!index) return null;
          return {
            fileId: index.activeFileId,
            getContent: (id) => index.getContent(id),
            resolveInclude: (fromId, target) => index.resolveInclude(fromId, target),
            // Gating seed for conditional includes: the render intrinsics (e.g. `backend-html5`) plus
            // the open file's inherited attributes, so an `ifdef`/`ifeval`-guarded include is gated in
            // the editor exactly as the preview renders it — keeping their effective heading levels in
            // lockstep (R2). Matches the seed the preview worker/assembler and effectiveLevelOffset use.
            seedAttributes: new Map<string, string>([
              ...RENDER_INTRINSIC_ATTRIBUTES,
              ...inheritedAttributesReference.current,
            ]),
          };
        },
        collabActive,
        collabExtension,
        hookExtensions: [
          updateListener,
          lineClickHandler,
          fileDropHandler,
          ctrlClickTooltip,
          ...(renameSuggestionExtension ? [renameSuggestionExtension] : []),
          // Review comments (feature 038): the highlight/gutter layer plus its click, hover, and
          // add-comment affordances. The gutter renders a per-line "add comment" "+" (hover/selection
          // reveal) when a comment handler is available, and the shortcut comments the current
          // selection or line. The layer is inert (zero gutter width, no decorations) until ranges or a
          // comment handler are present, so it is safe to register on every editor instance.
          reviewDecorations(
            () => onReviewMarkerHoverReference.current,
            () => onCommentFromSelectionReference.current,
            () => onReviewMarkerClickReference.current,
          ),
          reviewMarkerClickHandler(() => onReviewMarkerClickReference.current),
          reviewMarkerHoverHandler(() => onReviewMarkerHoverReference.current),
          // Surface grammar issues to the panel + status bar. Inert (fires with an empty set) until the
          // grammar lint source produces diagnostics, so it is safe to register on every editor instance.
          grammarDiagnosticsListener((diagnostics) => onGrammarDiagnosticsReference.current?.(diagnostics)),
        ],
      }),
    });

    const view = new EditorView({ state, parent: containerReference.current });
    viewReference.current = view;
    try { onOutlineChange(view.state.field(outlineField)); } catch { /* field not installed */ }
    // A seeded collab view starts with its content already in place, so the update listener's
    // `docChanged` branch never runs for it and the host would keep the stale/empty text it last saw.
    // Publish it explicitly; the parent bails when the value is unchanged, so a first mount (seed is
    // '') costs nothing.
    if (collabActive && view.state.doc.length > 0) onDocChange(view.state.doc.toString());
    // Seed the shared inherited-attributes field so heading-id derivation (rename detection, xref
    // completion) reflects a parent-set idprefix/idseparator/sectids, matching the server + preview.
    // Needed on (re)mount because the [inheritedAttributes] effect below does not re-run on a remount
    // whose inheritedAttributes identity is unchanged. Kept fresh afterward by that effect.
    view.dispatch({ effects: setInheritedAttributesEffect.of(inheritedAttributesReference.current) });

    // Restore the cursor to a remembered line on mount, clamped to the current document
    // ("closest valid line"), and scroll it into view. Only runs when initialLine is
    // provided — ordinary in-session mounts are unaffected. Skipped on the collab path: the
    // doc mounts empty and is populated by Yjs sync, so the restore is deferred until after
    // sync (handled by the editor component once `connectionState` reaches `synced`).
    // A seeded collab view already holds its content, so the update listener's "restore once content
    // FIRST arrives" branch will never fire for it — restore here instead, and latch it so the two
    // paths can never both run.
    if (initialLine !== undefined && (!collabActive || view.state.doc.length > 0)) {
      if (collabActive) collabLineRestoredReference.current = true;
      const targetLine = clampToValidLine(initialLine, view.state.doc.lines);
      view.dispatch({ selection: { anchor: view.state.doc.line(targetLine).from }, scrollIntoView: true });
    }

    // Scroll sync: fire onScrollLine with the 1-based line at the top of the viewport.
    const teardownScrollSync = wireScrollSync(
      view,
      () => onScrollLineReference.current,
      () => Date.now() < selectionRevealUntilReference.current,
    );

    const linkHandler = createLinkHandler(
      {
        onNavigateToFile,
        onOpenUrl,
        onNavigateToXref,
        onUnresolvedPath: (path) => {
          globalThis.dispatchEvent(new CustomEvent('editor:unresolved-path', { detail: path }));
        },
      },
      () => includePathsReference.current,
      projectIndexAccessor,
    );
    const mousedownFunction = (event: MouseEvent) => linkHandler.handleMousedown(event, view);
    view.dom.addEventListener('mousedown', mousedownFunction);

    return () => {
      teardownScrollSync();
      if (selectionSyncTimer !== null) clearTimeout(selectionSyncTimer);
      view.dom.removeEventListener('mousedown', mousedownFunction);
      view.destroy();
      viewReference.current = null;
      onOutlineChange([]);
    };
    // Mount once per editor instance; recreate only when remountKey changes (collab room
    // switch). content/canEdit changes are handled by their own effects below. Other closure
    // values are intentionally captured at (re)mount time.
  }, [remountKey]);

  // Live reveal: move the cursor to a requested line and scroll it into view (same-file
  // go-to-definition). Runs on the already-mounted view; each new nonce reveals once.
  const revealedNonceReference = useRef<number | null>(null);
  useEffect(() => {
    const view = viewReference.current;
    if (!view || !revealRequest || revealRequest.nonce === revealedNonceReference.current) return;
    revealedNonceReference.current = revealRequest.nonce;
    const targetLine = clampToValidLine(revealRequest.line, view.state.doc.lines);
    view.dispatch({ selection: { anchor: view.state.doc.line(targetLine).from }, scrollIntoView: true });
  }, [revealRequest]);

  // Re-evaluate heading levels when the inherited include-path offset changes (e.g. the project
  // main file was reconfigured) — no document edit occurs, so the plugin needs an explicit nudge.
  // The refresh effect recomputes the outline StateField (effective levels), so re-publish it: the
  // mount update listener only fires onOutlineChange on a doc edit, not on an out-of-band refresh.
  useEffect(() => {
    const view = viewReference.current;
    if (!view) return;
    view.dispatch({ effects: refreshHeadingLevelsEffect.of() });
    try { onOutlineChangeReference.current(view.state.field(outlineField)); } catch { /* field not installed */ }
  }, [inheritedOffset]);

  // Re-evaluate the `{attr}` collapse-to-value display when the inherited attributes change (e.g. a
  // parent file's content loaded into the index) — no document edit occurs, so nudge the plugin.
  useEffect(() => {
    viewReference.current?.dispatch({
      effects: [refreshAttributeFoldEffect.of(), setInheritedAttributesEffect.of(inheritedAttributes)],
    });
  }, [inheritedAttributes]);

  // Re-evaluate the cross-document `{name}` known-vs-unknown highlighting when the resolved scope
  // changes (e.g. a parent/included file's content loaded into the index, or the main file was
  // reconfigured) — no document edit occurs, so nudge the plugin explicitly. The
  // section outline also derives from the resolved scope (it resolves `{attr}` titles and excludes
  // inactive conditional-branch headings), so route the shared refreshHeadingLevelsEffect through it
  // and re-publish the recomputed outline — keeping computeHeadingLevels the single
  // recompute trigger for the outline field.
  useEffect(() => {
    const view = viewReference.current;
    if (!view) return;
    view.dispatch({
      effects: [refreshCrossDocumentAttributesEffect.of(), refreshHeadingLevelsEffect.of()],
    });
    try { onOutlineChangeReference.current(view.state.field(outlineField)); } catch { /* field not installed */ }
  }, [resolvedScope]);

  // A collaborator changed some project file: nudge the rename-suggestion plugin to re-query its
  // usage/collision counts for a visible offer. Skips the initial mount (nonce 0/undefined).
  useEffect(() => {
    if (!renameRefreshNonce) return;
    viewReference.current?.dispatch({ effects: contentChangedRefreshEffect.of(null) });
  }, [renameRefreshNonce]);

  // Sync external content changes into the live view. Skipped on the collab path —
  // yCollab owns the document content there (seeding from REST would desync, B3).
  useEffect(() => {
    if (collabActive) return;
    if (!viewReference.current) return;
    const current = viewReference.current.state.doc.toString();
    if (current !== content) {
      viewReference.current.dispatch({ changes: { from: 0, to: current.length, insert: content } });
    }
  }, [content, collabActive]);

  // Sync canEdit changes via the Compartment — no view recreation needed.
  useEffect(() => {
    if (!viewReference.current) return;
    viewReference.current.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(!canEdit),
        EditorView.editable.of(canEdit),
      ]),
    });
    // The grammar tooltip's one-click fixes are decided per lint pass from the view's read-only state,
    // and a permission change arrives without a document change (an observer promoted mid-session, a
    // collab session lost). Ask for a fresh pass, or the previous pass's fix buttons stay on screen.
    // They would refuse to apply — `applyGrammarSuggestion` re-checks — but offering a control that
    // does nothing is worse than not offering it, so this is the visible half of the same gate.
    if (grammarActive) refreshGrammarLints(viewReference.current);
  }, [canEdit, grammarActive]);

  // Sync the soft-wrap preference live via its Compartment.
  useEffect(() => {
    if (!viewReference.current) return;
    viewReference.current.dispatch({
      effects: lineWrapCompartment.current.reconfigure(softWrap ? [EditorView.lineWrapping] : []),
    });
  }, [softWrap]);

  // Sync the minimap (text-preview) preference live via its Compartment.
  useEffect(() => {
    const view = viewReference.current;
    if (!view) return;
    view.dispatch({
      effects: minimapCompartment.current.reconfigure(minimapEnabled ? minimapExtension() : []),
    });
    // @replit/codemirror-minimap builds its DOM when the facet turns on but paints the canvas only on
    // a *later* view update, so a freshly-enabled minimap stays blank until the next transaction (e.g.
    // a scroll). Dispatch one empty transaction to drive that first paint immediately.
    if (minimapEnabled) view.dispatch({});
  }, [minimapEnabled]);

  // Bind the author's configurable shortcuts, and rebind them when they change.
  //
  // Runs unconditionally rather than only once the server's bindings arrive: `editorShortcutsKeymap`
  // falls back to the registry's defaults for every action the author has not remapped, so this binds
  // a complete keymap on the first pass and simply rebinds it if their own choices differ. Waiting
  // for the fetch would leave the first `Mod+B` of every session doing nothing.
  useEffect(() => {
    const view = viewReference.current;
    if (!view) return;
    view.dispatch({
      effects: shortcutsCompartment.current.reconfigure(
        editorShortcutsKeymap(
          editorShortcutCommands(() => onCommentFromSelectionReference.current),
          shortcutBindings,
        ),
      ),
    });
  }, [shortcutBindings]);

  // Sync the spell-check language / enabled preference live via its Compartment — a fresh lint source
  // bound to the new language+enabled, so changes apply without a remount. While grammar checking is
  // active, nspell is suppressed (Harper owns prose checking) so the two never double-flag a word.
  useEffect(() => {
    if (!viewReference.current) return;
    viewReference.current.dispatch({
      effects: spellcheckCompartment.current.reconfigure(
        createSpellcheckLinter(() => spellIgnore ?? [], spellcheckLanguage, spellcheckEnabled && !grammarActive),
      ),
    });
  }, [spellcheckLanguage, spellcheckEnabled, spellIgnore, grammarActive]);

  /**
   * Dismiss one issue for this user: tell the engine to stop reporting that lint, persist the blob it
   * re-exports, and re-lint so the underline goes away without waiting for the next keystroke.
   *
   * The engine matches the lint by object identity against what it handed out, so a diagnostic that has
   * outlived its lint (the cache was cleared and the document re-linted) is rejected. That is caught and
   * dropped: the issue simply stays underlined, which is the honest outcome, and it can be dismissed
   * again from the fresh diagnostic.
   */
  const ignoreGrammarIssue = useCallback((diagnostic: GrammarDiagnostic) => {
    const client = harperClientReference.current;
    if (!client) return;
    void (async () => {
      try {
        await client.ignore(diagnostic.grammarSegmentText, diagnostic.grammarLint);
      } catch {
        return;
      }
      onIgnoredLintsChangeReference.current?.(await client.exportIgnoredLints());
      const view = viewReference.current;
      if (view) refreshGrammarLints(view);
    })();
  }, [viewReference]);

  // Grammar-checking lifecycle: when active (enabled AND English), lazily construct the Harper worker
  // client, warm it up off the typing path, and once the engine is ready reconfigure the grammar
  // compartment to the live lint source (which flips `grammarActive`, disabling nspell above). If the
  // WASM engine fails to load, `grammarActive` stays false so the editor remains fully usable with the
  // nspell fallback (graceful degradation — Principle X). When inactive, the compartment is emptied.
  useEffect(() => {
    const view = viewReference.current;
    if (!view) return;
    const shouldActivate = grammarEnabled && grammarLanguageIsEnglish;

    if (shouldActivate) {
      let client = harperClientReference.current;
      // A reused client carries the PREVIOUS dialect, and applying the new one is asynchronous. The
      // lint source must not be installed until it has landed: reconfiguring first means the pass it
      // triggers runs on the old dialect and flags British spellings in an American document (or the
      // reverse) until the next keystroke. A rejection here is not fatal — the client reports its own
      // failed status — so it is swallowed and warm-up proceeds to report it.
      const dialectApplied = client
        ? client.setDialect(grammarDialect).catch(() => undefined)
        : Promise.resolve(undefined);
      if (!client) {
        client = createHarperWorkerClient(createHarperEngine(grammarDialect));
        harperClientReference.current = client;
      }

      let cancelled = false;
      const activeClient = client;
      // Surface the engine's real lifecycle to the panel: `loading` while the WASM warms up, `ready`
      // once it can lint, `failed` if init rejects — so the panel never shows an eternal "loading" for
      // an engine that has actually failed. Report the current status immediately, then on every change.
      const reportStatus = () => onGrammarStatusChangeReference.current?.(toGrammarEngineStatus(activeClient.getStatus()));
      const unsubscribe = activeClient.onStatusChange(() => {
        if (!cancelled) reportStatus();
      });
      reportStatus();
      void dialectApplied
        .then(() => activeClient.warmUp())
        .then(() => {
          if (cancelled || !activeClient.isReady() || !viewReference.current) return;
          const deps: HarperLintSourceDeps = {
            client: activeClient,
            // Only offered when the host can store the dismissal; otherwise the tooltip shows fixes alone.
            ...(onIgnoredLintsChangeReference.current === undefined ? {} : { onIgnore: ignoreGrammarIssue }),
          };
          viewReference.current.dispatch({
            effects: grammarCompartment.current.reconfigure(createGrammarLinter(deps)),
          });
          setGrammarActive(true);
          reportStatus(); // now `ready`
        })
        // `warmUp` re-throws anything that is not a HarperEngineInitError, and by then the client has
        // already published `failed` — so the panel is correct and there is nothing left to do but keep
        // the rejection from surfacing as an unhandled one.
        .catch(() => undefined);
      return () => {
        cancelled = true;
        unsubscribe();
      };
    }

    // Inactive: grammar is gated off for this project — empty the compartment, fall back to nspell, and
    // tell the panel it is `disabled` (a real end state, not a transient loading one).
    view.dispatch({ effects: grammarCompartment.current.reconfigure([]) });
    setGrammarActive(false);
    onGrammarStatusChangeReference.current?.('disabled');
    return;
  }, [grammarEnabled, grammarLanguageIsEnglish, grammarDialect, ignoreGrammarIssue]);

  // Reconcile the whole project dictionary into the worker once grammar is active and whenever the
  // terms change, so accepted terms stop being flagged AND removed/cleared terms are flagged again —
  // without a reload. `resetWords` replaces the worker's user dictionary (clear + import), so a term
  // removed from the project (a shrunk set, including down to empty) actually takes effect.
  useEffect(() => {
    if (!grammarActive || !dictionaryTerms) return;
    const client = harperClientReference.current;
    if (!client) return;
    void client
      .resetWords(dictionaryTerms)
      .then(() => {
        // A changed dictionary changes results, but the document did not change — ask the lint plugin
        // explicitly, or an accepted term stays underlined until the next keystroke.
        const view = viewReference.current;
        if (view) refreshGrammarLints(view);
      })
      .catch((error: unknown) => {
        // `resetWords` clears the worker's dictionary BEFORE re-importing, so a rejection anywhere in
        // that pair leaves the engine with NO accepted terms while the Dictionary panel still lists
        // them all — it reads the server, not the engine. That divergence is invisible without this:
        // the reader sees an accepted word underlined and no indication why. Reported rather than
        // rethrown, because a failed hydration must not take down a working editor.
        // eslint-disable-next-line no-console -- an accepted term that is still flagged must surface.
        console.error('Failed to hydrate the project dictionary into the grammar engine.', error);
      });
  }, [grammarActive, dictionaryTerms]);

  // Hydrate the caller's ignored-lints blob into the worker once grammar is active, so issues they
  // dismissed in a previous session (or on another device) stay hidden. Re-lint after importing.
  useEffect(() => {
    if (!grammarActive || !ignoredLintsBlob) return;
    const client = harperClientReference.current;
    if (!client) return;
    void client
      .importIgnoredLints(ignoredLintsBlob)
      .then(() => {
        const view = viewReference.current;
        if (view) refreshGrammarLints(view);
      })
      .catch((error: unknown) => {
        // Same shape as the dictionary hydration above: a rejection here silently resurrects issues the
        // reader already dismissed, with nothing on screen to explain it.
        // eslint-disable-next-line no-console -- a resurrected dismissed issue must surface.
        console.error('Failed to hydrate dismissed grammar issues into the engine.', error);
      });
  }, [grammarActive, ignoredLintsBlob]);

  // The include tree's file list, as a value an effect can depend on. Read during render (the hook
  // re-renders on every edit, so a newly added or removed `include::` shows up promptly) and only while
  // the cross-file pass is actually wanted, so a panel scoped to this file never walks the tree at all.
  const documentScopeWanted = grammarActive && lintScope === 'whole-document';
  const includeTreeSignature = documentScopeWanted
    ? (projectIndexAccessor()?.tree.nodes.join('|') ?? '')
    : '';

  // "Whole document" scope: check the other files of the open file's `include::` tree and publish the
  // result to the Writing panel. It deliberately does NOT run on the local user's keystrokes — those
  // change only the open file, whose issues come from the live editor lint — so the trigger set is
  // entering the scope, the engine becoming ready, the tree's file list changing, and a collaborator
  // touching a project file. Combined with the linter's per-file parse cache and the worker's
  // per-segment result cache, a repeat pass over an unchanged tree costs a few map lookups.
  useEffect(() => {
    if (!documentScopeWanted) {
      resetDocumentScope();
      return;
    }
    const client = harperClientReference.current;
    const index = projectIndexAccessor();
    if (!client || !index) {
      resetDocumentScope();
      return;
    }

    // The tree is rooted at the configured main file (or at the open file when none is configured). If
    // the open file is not in it, the main document is not the document being edited, and "whole
    // document" has no larger document to mean — say so rather than silently checking this file twice.
    const openFileId = index.activeFileId;
    const nodes = index.tree.nodes;
    const reveal = (issue: IncludedFileIssue): void => {
      onNavigateToXrefReference.current?.({
        fileId: issue.fileId,
        path: issue.path,
        line: issue.line,
        sameFile: false,
      });
    };
    if (!nodes.includes(openFileId)) {
      setDocumentScope({ state: 'outside-main', fileCount: 0, issues: [], reveal: null });
      return;
    }

    const files: IncludedFile[] = [];
    for (const fileId of nodes) {
      if (fileId === openFileId) continue;
      const path = index.pathOf(fileId);
      const content = index.getContent(fileId);
      if (path === null || content === null) continue; // not fetched yet — a later pass picks it up
      files.push({ fileId, path, content });
    }
    if (files.length === 0) {
      setDocumentScope({ state: 'alone', fileCount: 0, issues: [], reveal: null });
      return;
    }

    let cancelled = false;
    const linter = (includedFileLinterReference.current ??= createIncludedFileLinter({
      parse: (text) => asciidocLanguage.parser.parse(text),
    }));
    setDocumentScope({ state: 'scanning', fileCount: files.length, issues: [], reveal });

    void (async () => {
      // The worker client is shared with the open file's lint source, and its staleness guard lets the
      // newest request win — so an edit landing mid-pass aborts this one. Retry a bounded number of
      // times rather than publishing a list that silently omits the files never reached.
      // Whatever the last attempt did reach. Published as `incomplete` if every attempt was cut short,
      // because publishing nothing left the panel saying "Checking N other files…" for the rest of the
      // mount — recoverable only by toggling the scope, and indistinguishable from a slow pass.
      let reached: readonly IncludedFileIssue[] = [];
      let completed = false;
      for (let attempt = 0; attempt < CROSS_FILE_LINT_ATTEMPTS && !cancelled; attempt++) {
        const result = await linter.lint(files, { client, isCancelled: () => cancelled });
        if (cancelled) return;
        reached = result.issues;
        if (result.completed) {
          completed = true;
          setDocumentScope({ state: 'checked', fileCount: files.length, issues: result.issues, reveal });
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, CROSS_FILE_LINT_RETRY_MS));
      }
      if (!completed && !cancelled) {
        setDocumentScope({ state: 'incomplete', fileCount: files.length, issues: reached, reveal });
      }
      // This pass's own requests may have superseded an in-flight lint of the open file, leaving it with
      // no diagnostics. Ask for one more pass over the open file so its underlines come back.
      const view = viewReference.current;
      if (!cancelled && view) refreshGrammarLints(view);
    })();

    return () => {
      cancelled = true;
    };
  }, [documentScopeWanted, includeTreeSignature, renameRefreshNonce]);

  // Leave nothing behind for the next editor: the panel's cross-file list belongs to this mount.
  useEffect(() => resetDocumentScope, []);

  // Dispose the Harper worker on unmount so its engine + worker are released.
  useEffect(
    () => () => {
      void harperClientReference.current?.dispose();
      harperClientReference.current = null;
    },
    [],
  );

  /** Accessor for the live Harper worker client (null until grammar activates), for the Rules tab. */
  const getHarperClient = useCallback(() => harperClientReference.current, []);

  return { containerReference, viewReference, handleHeadingClick, getHarperClient, ignoreGrammarIssue };
}
