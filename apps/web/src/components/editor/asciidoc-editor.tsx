'use client';
import './editor-themes.css';
import React from 'react';
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { CollabAuthRole, CreateAnchorInput } from '@asciidocollab/shared';
import { EditorView } from '@codemirror/view';
import type { ConnectionState } from '@/hooks/use-collab-document';
import { collabExtensions, COLLAB_YTEXT_KEY } from './editor-collab-extensions';
import {
  setReviewRangesEffect,
  setActiveReviewEffect,
  flashReviewEffect,
  type ReviewAnchorRange,
} from '@/lib/codemirror/review-decorations';
import { setBlameLinesEffect } from '@/lib/codemirror/blame-gutter';
import { useBlame } from '@/hooks/use-blame';
import { captureAnchor } from '@/lib/review/anchor';
import { renameSuggestion } from '@/lib/codemirror/rename-suggestion/rename-suggestion-state';
import { findSymbolUsages, renameSymbol } from '@/lib/api/projects';
import { useAutoSave } from '@/hooks/use-auto-save';
import { useEditorPreferences } from '@/hooks/use-editor-preferences';
import { useIncludeCompletions, useImagePaths } from '@/hooks/use-include-completions';
import { useEditorMount } from '@/hooks/use-editor-mount';
import { useGrammarSettings } from '@/hooks/use-grammar-settings';
import { useProjectDictionary } from '@/hooks/use-project-dictionary';
import { useIgnoredLints } from '@/hooks/use-ignored-lints';
import type { DictionaryTermDto } from '@asciidocollab/shared';
import { GrammarStatus } from '@/components/grammar/grammar-status';
import type { LintScope } from '@/lib/codemirror/harper/harper-linter-source';
import { categoryCounts, type PositionedGrammarDiagnostic } from '@/lib/codemirror/harper/grammar-diagnostics';
import { applyGrammarSuggestion } from '@/lib/codemirror/harper/apply-suggestion';
import type { EngineSuggestion } from '@/lib/codemirror/harper/harper-engine';
import type { GrammarEngineStatus } from '@/lib/codemirror/harper/harper-worker-client';
import { useTableContext } from '@/hooks/use-table-context';
import { OFFLINE_QUEUE_KEY_PREFIX } from '@/lib/editor-config';
import type { SectionOutlineEntry } from '@/lib/codemirror/asciidoc-outline';
import type { ProjectSymbolIndex } from '@/lib/codemirror/asciidoc-symbol-index';
import type { XrefTarget } from '@/lib/codemirror/asciidoc-link-handler';
import type { CursorSymbol } from '@/lib/codemirror/asciidoc-symbol-at-cursor';
import { EditorBanners } from './editor-banners';
import { EditorStatusBar } from './editor-status-bar';
import { computeMetrics } from '@/lib/codemirror/asciidoc-metrics';
import { EditorChrome } from './editor-chrome';

/** The grammar-panel state the editor surfaces to the layout so it can render the Grammar rail. */
export interface EditorGrammarState {
  /** The current grammar issues with live document positions. */
  diagnostics: PositionedGrammarDiagnostic[];
  /** The on-device engine's panel status: loading, ready, failed, or disabled for this project. */
  status: GrammarEngineStatus;
  /** How much the checker reports on: this file, or the whole `include::` document. */
  lintScope: LintScope;
  /**
   * Change which prose the checker examines. A per-view preference — it never changes what other
   * collaborators check.
   *
   * @param next - The scope to check from now on.
   */
  setLintScope: (next: LintScope) => void;
  /**
   * Navigate the editor to an issue.
   *
   * @param from - Document offset of the issue start.
   * @param to - Document offset just past the issue.
   */
  navigate: (from: number, to: number) => void;
  /**
   * Apply a suggested fix.
   *
   * @param entry - The issue being resolved.
   * @param suggestion - The chosen suggestion.
   */
  apply: (entry: PositionedGrammarDiagnostic, suggestion: EngineSuggestion) => void;
  /** The project dictionary term records. */
  dictionary: DictionaryTermDto[];
  /**
   * Whether the caller may change the open document — the editor's EFFECTIVE edit permission, which
   * folds the observer role and a missing collaborative backing into the project role. Gates accepting
   * a fix, the one grammar action that writes shared content; the panel renders the fix chips disabled
   * when it is false rather than hiding the correction they name.
   */
  canEditDocument: boolean;
  /** Whether the caller may add/remove dictionary terms (editor/owner, and not an observer). */
  canManageDictionary: boolean;
  /**
   * Add a term to the project dictionary.
   *
   * @param term - The term to add.
   */
  addDictionaryTerm: (term: string) => void;
  /**
   * Remove a term from the project dictionary.
   *
   * @param termId - The id of the term to remove.
   */
  removeDictionaryTerm: (termId: string) => void;
  /**
   * Add the word an issue flagged to the project dictionary (reads the document text at the issue).
   *
   * @param entry - The issue whose flagged word to accept.
   */
  addIssueWordToDictionary: (entry: PositionedGrammarDiagnostic) => void;
  /**
   * Dismiss an issue for this reader alone, and remember the dismissal across reloads. Null when there
   * is nowhere to store it, so the panel can leave the action out instead of offering a dismissal that
   * does not last.
   *
   * @param entry - The issue to stop reporting.
   */
  ignore: ((entry: PositionedGrammarDiagnostic) => void) | null;
  /**
   * Whether the caller may change which checks run. Narrower than {@link canEditDocument}: the rule
   * config is view-local (nothing is persisted or sent to anyone), so a per-FILE transport condition
   * has no business revoking it — only the reader's project role does, exactly as for the dictionary.
   */
  canConfigureRules: boolean;
  /** The engine's current rule on/off configuration (empty until the engine loads). */
  ruleConfig: Record<string, boolean | null>;
  /**
   * The engine's one-line explanation of each rule, keyed by rule name (empty until the engine loads).
   * The panel uses it as the hover text of the rule chip naming an issue's rule.
   */
  ruleDescriptions: Record<string, string>;
  /**
   * Toggle a rule on or off.
   *
   * @param rule - The rule name.
   * @param enabled - The new state.
   */
  setRule: (rule: string, enabled: boolean) => void;
  /** Reset every rule to the engine default. */
  resetRules: () => void;
}

interface AsciiDocEditorProperties {
  content: string;
  canEdit: boolean;
  /**
   * Whether the user may write the PROJECT's shared dictionary — a narrower permission than
   * {@link canEdit}, which carries the global-admin bypass. `requireDictionaryEditor` authorizes on
   * project membership alone, so an admin who is only a viewer here must not be offered a control the
   * API answers 403 to; and unlike a document edit, nothing downstream forces that admin read-only.
   *
   * Defaults to {@link canEdit} for hosts that do not distinguish the two (the editor is also rendered
   * standalone in tests and previews). The project editor MUST pass the role-only value.
   */
  canManageDictionary?: boolean;
  /**
   * Whether the user's project ROLE lets them change which checks run. Separate from {@link canEdit}
   * because that prop arrives already narrowed by the host: the project editor passes `editorCanEdit`,
   * which folds in `offline` and `collabUnavailable` (see `use-managed-collab.ts`). Those are per-FILE
   * transport conditions, and the rule config is view-local — nothing is persisted and nothing is sent
   * to anyone — so letting them revoke it would leave a project OWNER who opens one unbacked text file,
   * or who briefly goes offline, with every rule toggle disabled for a control that writes nothing.
   *
   * Defaults to {@link canEdit} for hosts that do not distinguish the two (the editor is also rendered
   * standalone in tests and previews). The project editor MUST pass the role-only value.
   */
  canConfigureRules?: boolean;
  projectId?: string;
  fileNodeId?: string;
  /**
   * Called with the live grammar-panel state so the layout can render the Grammar rail.
   *
   * @param state - The current grammar issues plus the navigate/apply actions, or null once this
   * editor goes away and there is no document being checked any more.
   */
  onGrammarStateChange?: (state: EditorGrammarState | null) => void;
  /**
   * ETag from the initial GET /content response — seeds external-change polling
   *  so it works from first load without requiring a save first.
   */
  initialEtag?: string | null;
  /** When false, hides the AsciiDoc toolbar and outline panel (e.g. For plain-text files). */
  isAsciiDoc?: boolean;
  /** When true (default), enables line wrapping in the editor. */
  softWrap?: boolean;
  /** When true, shows the document text-preview (minimap). Defaults to the user preference (off). */
  minimapEnabled?: boolean;
  /**
   * The open file's project-relative path, used to fetch its per-line blame. Null/omitted when
   * nothing blameable is open, which (together with {@link gitConnected}) hides the blame toggle.
   */
  openPath?: string | null;
  /**
   * Whether the project has a connected Git repository. Gates the inline blame toggle — with no
   * connected repository (or no open file) there is nothing to blame, so the toggle is hidden.
   */
  gitConnected?: boolean;
  /**
   * Project document language (ISO 639-1) driving the spellchecker, or null when the project has
   * none configured (the editor then falls back to its default). Spellcheck language is a
   * project-level setting; whether spellcheck runs at all stays a per-user preference.
   */
  spellcheckLanguage?: string | null;
  // Live accessor for the cross-file symbol index; powers cross-file diagnostics + completion.
  getProjectIndex?: () => ProjectSymbolIndex | null;
  onChange?: (value: string) => void;
  onNavigateToFile?: (path: string) => void;
  // Navigate to a cross-reference definition resolved via the project symbol index.
  onNavigateToXref?: (target: XrefTarget) => void;
  /** Include-path level offset inherited by the open file from its ancestors. */
  inheritedOffset?: number;
  /** Attributes the open file inherits from the documents that include it. */
  inheritedAttributes?: ReadonlyMap<string, string>;
  /** The open file's resolved cross-document attribute scope (inherited + own), for `{name}` known highlighting. */
  resolvedScope?: ReadonlyMap<string, string>;
  /** Bumped when a collaborator changes any project file, so a visible rename offer re-queries its counts. */
  renameRefreshNonce?: number;
  /** Live request to reveal a line in the open editor (same-file go-to-definition). */
  revealRequest?: { line: number; nonce: number } | null;
  onOpenUrl?: (url: string) => void;
  onLineClick?: (line: number) => void;
  /**
   * Called with the top visible 1-based line number as the editor is scrolled.
   *
   * @param line - The 1-based line number at the top of the visible viewport.
   */
  onScrollLine?: (line: number) => void;
  /**
   * Called with the caret's 1-based line when the selection moves without an edit (click, keyboard
   * navigation, or text selection), so the preview can follow the caret. See {@link onScrollLine}.
   *
   * @param line - The 1-based line the caret moved to.
   */
  onSelectionLine?: (line: number) => void;
  /** 1-based line to place the cursor on when this editor instance mounts (selection restore). */
  initialLine?: number;
  /**
   * Collaboration binding. When present the editor enters collab mode: it binds to the shared
   * Y.Doc (empty initial doc, populated by sync), and the REST autosave/poll/draft/keepalive
   * machinery is disabled — the collaboration server owns persistence. Absent for the
   * legacy REST path (binary assets, non-collaborative files, offline fallback).
   */
  collab?: CollabBinding | null;
  /**
   * Collaboration connection state for the status banner. Passed independently of
   * `collab` so the offline read-only fallback (no binding) can still show the offline banner.
   */
  connectionState?: ConnectionState;
  /**
   * Called (the caller debounces) with the 1-based cursor line as it changes, so the position
   * can be persisted for restore.
   *
   * @param line - The 1-based line the cursor is on.
   */
  onCursorLineChange?: (line: number) => void;
  /**
   * Reports the live section outline up to the layout so it can drive the left-panel Outline view
   * (028). Fires on every doc edit / out-of-band heading refresh with the full entry list.
   *
   * @param entries - The current section outline entries, including the level-0 title.
   */
  onOutlineChange?: (entries: SectionOutlineEntry[]) => void;
  /**
   * True when this is editable text with no collaborative document (GET /collab 404). The editor
   * opens read-only with a banner and the REST autosave stays disabled — silently writing through
   * the legacy path would let two clients overwrite each other (no Yjs merge, no session lock).
   */
  collabUnavailable?: boolean;
  /** Opens the Go to Symbol palette from the toolbar. */
  onGoToSymbol?: () => void;
  // Opens the refactor dialog from the toolbar, seeded with the symbol under the cursor.
  onRefactor?: (initial: CursorSymbol | null) => void;
  /**
   * Review anchor ranges (feature 038) painted as highlights + gutter markers. The layout resolves
   * them from the shared review hook so the editor and the rail stay in sync. Empty when the file
   * has no collaborative review document.
   */
  reviewRanges?: ReviewAnchorRange[];
  /**
   * The emphasised review item id (feature 038): hover ∪ selection. Its highlight is strengthened
   * but the editor does NOT scroll for it — hover is a transient cue only.
   */
  activeReviewId?: string | null;
  /**
   * The review item the user just navigated to (clicking a card, prev/next, a marker). Unlike
   * {@link activeReviewId}, this scrolls the passage into view and flashes it once.
   */
  scrollToReviewId?: string | null;
  /**
   * Called when a review highlight/gutter marker is clicked (feature 038, FR-005).
   *
   * @param id - The clicked review item id.
   */
  onReviewMarkerClick?: (id: string) => void;
  /**
   * Called as the pointer moves over (or off) a review highlight/gutter marker (feature 038), with the
   * hovered review item id or null — highlights the matching card in the rail.
   *
   * @param id - The hovered review item id, or null when none is under the pointer.
   */
  onReviewMarkerHover?: (id: string | null) => void;
  /**
   * Called when the user starts a comment from the current selection (feature 038), with the
   * captured Yjs anchor for the passage.
   *
   * @param anchor - The captured anchor describing the selected passage.
   */
  onCreateCommentFromSelection?: (anchor: CreateAnchorInput) => void;
}

/** Live collaboration binding passed to the editor when a file is a collaborative document. */
export interface CollabBinding {
  /** Shared Y.Doc owned by useCollabDocument. */
  doc: Y.Doc;
  /** Provider awareness for remote cursors/presence. */
  awareness: Awareness;
  /** Current connection lifecycle state (drives read-only/banners). */
  connectionState: ConnectionState;
  /** The user's collaboration role for this document. */
  role: CollabAuthRole;
  /** Yjs state id — used as the editor remount key on room switch. */
  yjsStateId: string;
  /** The backing Document's id, used as the key for document-scoped review APIs. */
  documentId: string;
}

type EditorCssVariables = { '--editor-font-size': string } & React.CSSProperties;

function editorStyle(fontSize: number): EditorCssVariables {
  return { '--editor-font-size': `${fontSize}px` };
}

/** CodeMirror 6 AsciiDoc editor — composes the mount hook, auto-save, preferences, and chrome. */
export function AsciiDocEditor({
  content,
  canEdit,
  canManageDictionary: canManageDictionaryProperty,
  canConfigureRules: canConfigureRulesProperty,
  projectId,
  fileNodeId,
  onGrammarStateChange,
  initialEtag,
  isAsciiDoc = true,
  softWrap: softWrapProperty,
  minimapEnabled: minimapEnabledProperty,
  openPath,
  gitConnected = false,
  spellcheckLanguage,
  getProjectIndex,
  onChange,
  onNavigateToFile,
  onNavigateToXref,
  inheritedOffset,
  inheritedAttributes,
  resolvedScope,
  renameRefreshNonce,
  revealRequest,
  onOpenUrl,
  onLineClick,
  onScrollLine,
  onSelectionLine,
  initialLine,
  onCursorLineChange,
  onOutlineChange,
  collab,
  connectionState,
  collabUnavailable = false,
  onGoToSymbol,
  onRefactor,
  reviewRanges,
  activeReviewId,
  scrollToReviewId,
  onReviewMarkerClick,
  onReviewMarkerHover,
  onCreateCommentFromSelection,
}: AsciiDocEditorProperties) {
  // The file is on the collab path whenever a binding is present OR a connection state is set —
  // the latter covers the offline read-only fallback, where the binding is dropped but the file
  // is still collaborative and must NOT re-enable the REST autosave machinery.
  // `collabUnavailable` (text doc with no collab document) also disables autosave: that file is
  // opened read-only, and the legacy clobbering PUT path must never run for it.
  const onCollabPath = collab != null || connectionState != null || collabUnavailable;
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1, totalLines: 1 });
  // Live grammar issues + engine state, surfaced from the editor for the panel and status bar.
  const [grammarDiagnostics, setGrammarDiagnostics] = useState<PositionedGrammarDiagnostic[]>([]);
  const [grammarStatus, setGrammarStatus] = useState<GrammarEngineStatus>('disabled');
  const grammarEngineReady = grammarStatus === 'ready';
  const [lintScope, setLintScope] = useState<LintScope>('this-file');
  const [ruleConfig, setRuleConfig] = useState<Record<string, boolean | null>>({});
  const [ruleDescriptions, setRuleDescriptions] = useState<Record<string, string>>({});
  // Live word count / reading time for the status bar. Seeded from the
  // initial content and refreshed from each editor change.
  const [docText, setDocText] = useState(content);
  const metrics = useMemo(() => computeMetrics(docText), [docText]);
  const [externalChangeBanner, setExternalChangeBanner] = useState(false);
  const [draftContent, setDraftContent] = useState<string | null>(null);

  const { fontSize, theme, softWrap: prefsSoftWrap, minimapEnabled: prefsMinimapEnabled, spellIgnore, spellcheckEnabled, setFontSize, setTheme, setSoftWrap, setMinimapEnabled } = useEditorPreferences();
  const softWrap = softWrapProperty === undefined ? prefsSoftWrap : softWrapProperty;
  const minimapEnabled = minimapEnabledProperty === undefined ? prefsMinimapEnabled : minimapEnabledProperty;

  // Inline per-line blame: a per-file view toggle (not a persisted preference), driven from the
  // editor toolbar. Available only with a connected Git repository AND an open file — there is
  // otherwise nothing to blame — and forced off whenever that availability drops (e.g. switching to
  // a non-git file), so a stale gutter never lingers.
  const blameAvailable = Boolean(gitConnected && openPath);
  const [blameEnabled, setBlameEnabled] = useState(false);
  useEffect(() => {
    if (!blameAvailable && blameEnabled) setBlameEnabled(false);
  }, [blameAvailable, blameEnabled]);
  const { blameLines, error: blameError } = useBlame({
    projectId,
    path: openPath,
    enabled: blameEnabled && blameAvailable,
  });
  // Spellcheck language comes from the project; fall back to English when the project leaves it unset.
  const effectiveSpellcheckLanguage = spellcheckLanguage ?? 'en';
  // On-device grammar checking: gated on a real project (its render-config supplies the enable flag)
  // whose language is English. Harper then owns prose checking and suppresses the nspell spellchecker.
  // Use the SAME defaulted language as the spellchecker — a project that leaves its language unset
  // falls back to English, so grammar checking is active by default there just as spellcheck is.
  const grammarSettings = useGrammarSettings(projectId ?? '', effectiveSpellcheckLanguage);
  // Gate on `loaded` too: until the render-config has actually been read, `enabled` reflects the
  // "unset ⇒ default-on" assumption, which would warm up the WASM engine for a grammar-DISABLED
  // project only to tear it down when the real config arrives. Wait for the real value first.
  const grammarEnabled = Boolean(projectId) && grammarSettings.loaded && grammarSettings.enabled;
  const dictionary = useProjectDictionary(projectId ?? '');
  // Observers get a read-only editor that still renders live remote edits. A text doc with
  // no collaborative backing is also forced read-only so it can never be edited via legacy autosave.
  // Declared here, above its first use: every grammar action that writes anything shared is gated on
  // THIS value, not on the raw `canEdit` prop. Gating on the prop was the bug — it says only what the
  // reader's project role allows and knows nothing about the observer role or a document with no
  // collaborative backing, so a read-only viewer was offered (and could invoke) every mutating action.
  const effectiveCanEdit = collab?.role === 'observer' || collabUnavailable ? false : canEdit;
  // The project dictionary is shared content: adding a term stops that word being flagged for every
  // collaborator, in every file. The server independently requires editor/owner (`requireDictionaryEditor`).
  //
  // Deliberately NOT `effectiveCanEdit`: the dictionary is scoped to the PROJECT, not to the open file,
  // and the server authorizes it on the project role alone. `collabUnavailable` is a per-FILE transport
  // condition (a text document whose collab record is missing), so folding it in would let one unbacked
  // file revoke a project-level capability the server would grant — Add/Remove would vanish from the
  // Dictionary tab, and `addIssueWordToDictionary` would silently no-op, for an owner. The observer role
  // IS the project role restated (`toCollabRole` maps `viewer` → `observer`), so it stays in the check.
  //
  // The base permission is the host-supplied, admin-free one where given: `canEdit` includes the
  // global-admin bypass and the dictionary API does not, so an admin who is only a viewer of this
  // project would otherwise be shown controls the server answers 403 to.
  const canManageDictionary =
    collab?.role === 'observer' ? false : (canManageDictionaryProperty ?? canEdit);
  // Which checks run is view-local: nothing is persisted, nothing is sent to anyone, and the config
  // lives on the session-wide Harper client rather than on this file. So it takes the same shape as
  // the dictionary gate and for the same reason — the per-FILE transport conditions have no business
  // revoking it, or a project OWNER who opens one unbacked text file (or who briefly goes offline)
  // would find every rule toggle and Reset disabled for a control that writes nothing.
  //
  // It reads the host-supplied ROLE permission, NOT the `canEdit` prop, because the project editor has
  // already folded `offline`/`collabUnavailable` into that prop (`use-managed-collab.ts` →
  // `editorCanEdit`). Deriving from it here would silently reinstate exactly the coupling this exists
  // to avoid — as it did — while the local `effectiveCanEdit` below narrows it further still. The
  // observer role stays in the check: it IS the reader's project role restated, and a reader offered
  // no other writing control should not be steering the checker either.
  const canConfigureRules =
    collab?.role === 'observer' ? false : (canConfigureRulesProperty ?? canEdit);
  const ignoredLints = useIgnoredLints(grammarEnabled ? (fileNodeId ?? null) : null);
  const includePaths = useIncludeCompletions(projectId ?? '');
  const imagePaths = useImagePaths(includePaths);

  const handleExternalChange = useCallback(() => setExternalChangeBanner(true), []);
  const handleDraftRecovered = useCallback((draft: string) => setDraftContent(draft), []);

  const { saveState, save } = useAutoSave({
    projectId: projectId ?? '',
    fileNodeId: fileNodeId ?? '',
    initialEtag: initialEtag ?? undefined,
    // Collab path: the collaboration server owns persistence — disable autosave/poll/draft.
    enabled: !onCollabPath,
    onExternalChange: handleExternalChange,
    onDraftRecovered: handleDraftRecovered,
  });

  // yCollab binding for the collab path; memoized on the doc/awareness identity so it is rebuilt
  // only when the room changes (the editor remounts via remountKey at the same time).
  const collabExtension = useMemo(
    () => (collab ? collabExtensions(collab.doc, collab.awareness) : undefined),
    [collab?.doc, collab?.awareness],
  );

  // In-editor symbol rename-suggestion (feature 033). Built once with ref-based getters so it never
  // forces a remount; the getters always read the current project/file. Detection only fires while
  // editing a definition, so read-only viewers never see it.
  const projectIdReference = useRef(projectId);
  projectIdReference.current = projectId;
  const fileNodeIdReference = useRef(fileNodeId);
  fileNodeIdReference.current = fileNodeId;
  const canEditReference = useRef(effectiveCanEdit);
  canEditReference.current = effectiveCanEdit;
  const renameSuggestionExtension = useMemo(
    () =>
      renameSuggestion({
        getProjectId: () => projectIdReference.current,
        getFileNodeId: () => fileNodeIdReference.current,
        getCanEdit: () => canEditReference.current,
        findSymbolUsages,
        renameSymbol,
      }),
    [],
  );

  const handleChange = useCallback((value: string) => {
    setDocText(value);
    if (projectId && fileNodeId) save(value);
    onChange?.(value);
  }, [projectId, fileNodeId, save, onChange]);

  // Re-assert the synced document to the parent's live buffer (which feeds the preview) the first
  // time it is non-empty. On the collab path the parent resets that buffer to the null REST content
  // DURING the file-switch render, and under concurrent rendering that reset can commit AFTER the
  // Yjs-sync `onChange` already delivered the document — wedging the preview at empty (`state: idle`,
  // "Preview not available") with no further edit to recover it. This effect runs POST-COMMIT, so a
  // set-state-during-render reset cannot tear it; `docText` is the editor's own state, populated from
  // the sync transaction independently of the parent buffer. The editor remounts per file (keyed on
  // the node id), so this one-shot latch resets naturally for each opened document. Idempotent: if the
  // buffer already holds this text, the parent's `setState` bails out.
  const initialContentDeliveredReference = useRef(false);
  useEffect(() => {
    if (!onCollabPath || initialContentDeliveredReference.current || docText.length === 0) return;
    initialContentDeliveredReference.current = true;
    onChange?.(docText);
  }, [onCollabPath, docText, onChange]);

  // Track cursor position for the status bar and report the line up for persistence.
  const handleCursorChange = useCallback((pos: { line: number; col: number; totalLines: number }) => {
    setCursorPos(pos);
    onCursorLineChange?.(pos.line);
  }, [onCursorLineChange]);

  // Lift the live outline to the layout (028); the outline now lives in the left panel, not here.
  const handleOutlineChange = useCallback((entries: SectionOutlineEntry[]) => {
    onOutlineChange?.(entries);
  }, [onOutlineChange]);

  // Capture a Yjs anchor for the selected passage and hand it up (feature 038). Held in a ref so the
  // mount hook can invoke it through a stable getter while it closes over the live `viewReference`
  // (declared by useEditorMount below) and the current `collab`. Only meaningful on the collab path —
  // the shared Y.Text is where relative positions are pinned.
  const commentFromSelectionReference = useRef<(from: number, to: number) => void>(() => {});

  // Store a dismissal against the open document. Passed as `undefined` when there is no document id:
  // that removes the Ignore action rather than offering one that is forgotten on the next reload.
  const { save: saveIgnoredLints } = ignoredLints;
  const persistIgnoredLints = useCallback(
    (next: string) => {
      void saveIgnoredLints(next);
    },
    [saveIgnoredLints],
  );

  const { containerReference, viewReference, getHarperClient, ignoreGrammarIssue } = useEditorMount({
    content,
    canEdit: effectiveCanEdit,
    softWrap,
    minimapEnabled,
    blameEnabled: blameEnabled && blameAvailable,
    foldStorageKey: projectId && fileNodeId ? `asciidocollab:folds:${projectId}:${fileNodeId}` : undefined,
    spellIgnore,
    spellcheckLanguage: effectiveSpellcheckLanguage,
    spellcheckEnabled,
    grammarEnabled,
    grammarLanguageIsEnglish: grammarSettings.languageIsEnglish,
    grammarDialect: grammarSettings.dialect,
    dictionaryTerms: dictionary.terms,
    ignoredLintsBlob: ignoredLints.blob,
    onIgnoredLintsChange: grammarEnabled && fileNodeId ? persistIgnoredLints : undefined,
    lintScope,
    onGrammarDiagnostics: setGrammarDiagnostics,
    onGrammarStatusChange: setGrammarStatus,
    includePaths,
    imagePaths,
    onDocChange: handleChange,
    onCursorChange: handleCursorChange,
    onOutlineChange: handleOutlineChange,
    onNavigateToFile,
    onNavigateToXref,
    inheritedOffset,
    inheritedAttributes,
    resolvedScope,
    revealRequest,
    onOpenUrl,
    onLineClick,
    onScrollLine,
    onSelectionLine,
    initialLine,
    getProjectIndex,
    collabExtension,
    // Read at (re)creation time, so a view recreated against an already-synced room is seeded with the
    // room's text instead of opening blank. See getCollabDocText in useEditorMount.
    getCollabDocText: collab ? () => collab.doc.getText(COLLAB_YTEXT_KEY).toString() : undefined,
    renameSuggestionExtension,
    renameRefreshNonce,
    remountKey: collab?.yjsStateId,
    onReviewMarkerClick,
    onReviewMarkerHover,
    // Only wire the comment affordances when review commenting is available for this document
    // (the parent passes onCreateCommentFromSelection only then). This keeps the gutter "add
    // comment" affordance and its shortcut inert — and the review gutter zero-width — elsewhere.
    onCommentFromSelection: onCreateCommentFromSelection
      ? (from, to) => commentFromSelectionReference.current(from, to)
      : undefined,
  });

  // Populate the selection→anchor capture now that `viewReference` exists. Rebuilds only when the
  // collab binding or the up-handler change; the mount hook reads it live via its stable getter.
  useEffect(() => {
    commentFromSelectionReference.current = (from: number, to: number) => {
      const view = viewReference.current;
      if (!collab || !view || !onCreateCommentFromSelection) return;
      const ytext = collab.doc.getText(COLLAB_YTEXT_KEY);
      const documentText = view.state.doc.toString();
      const lineHint = view.state.doc.lineAt(from).number;
      onCreateCommentFromSelection(captureAnchor(ytext, from, to, documentText, lineHint));
    };
  }, [collab, onCreateCommentFromSelection, viewReference]);

  // Push the resolved review ranges into the editor's decoration layer whenever they change
  // (feature 038). The ranges arrive out-of-band (SSE + Yjs re-resolution), so a dedicated effect
  // dispatches the replace-all effect rather than relying on a document edit.
  useEffect(() => {
    viewReference.current?.dispatch({ effects: setReviewRangesEffect.of(reviewRanges ?? []) });
  }, [reviewRanges, viewReference]);

  // Push the resolved per-line blame map into the gutter's backing field whenever it changes — a
  // fresh fetch when blame is toggled on, a refetch on a file switch, or null when toggled off (which
  // clears the gutter). The gutter itself is mounted/unmounted by the blame compartment (mount hook).
  useEffect(() => {
    viewReference.current?.dispatch({ effects: setBlameLinesEffect.of(blameLines) });
  }, [blameLines, viewReference]);

  // Emphasise the active review passage (hover ∪ selection). This is a transient view cue only —
  // it never scrolls, so hovering a rail card can't yank the editor around.
  useEffect(() => {
    viewReference.current?.dispatch({ effects: setActiveReviewEffect.of(activeReviewId ?? null) });
  }, [activeReviewId, viewReference]);

  // Scroll to a passage and flash it once when the user *navigates* to it (clicking a card, prev/next,
  // a marker) — distinct from the hover emphasis above. Keyed ONLY on the navigation target: the live
  // ranges are read through a ref so a range refresh (SSE / collaborator edit) can't re-run this effect
  // and cancel the pending flash-clear (which would strand the flash class and re-pulse every keystroke).
  const reviewRangesReference = useRef(reviewRanges);
  reviewRangesReference.current = reviewRanges;
  const flashTimerReference = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const view = viewReference.current;
    if (!view) return;
    const target = scrollToReviewId ?? null;
    if (target === null) return; // Any timer armed by a prior navigation still fires and clears the flash.
    const range = (reviewRangesReference.current ?? []).find((entry) => entry.id === target);
    if (!range) return;
    view.dispatch({
      effects: [EditorView.scrollIntoView(range.from, { y: 'center' }), flashReviewEffect.of(target)],
    });
    // Replace (not cancel-on-rerender) the clear timer, so it survives unrelated re-renders and always
    // fires ~700ms after the navigation — the flash is a genuine one-shot.
    if (flashTimerReference.current) clearTimeout(flashTimerReference.current);
    flashTimerReference.current = setTimeout(() => {
      viewReference.current?.dispatch({ effects: flashReviewEffect.of(null) });
      flashTimerReference.current = null;
    }, 700);
  }, [scrollToReviewId, viewReference]);

  // Clear any pending flash timer when the editor unmounts (document switch, unmount).
  useEffect(
    () => () => {
      if (flashTimerReference.current) clearTimeout(flashTimerReference.current);
    },
    [],
  );

  const tableContext = useTableContext(viewReference.current);

  function handleRetry() {
    const currentContent = viewReference.current?.state.doc.toString() ?? '';
    if (projectId && fileNodeId) save(currentContent);
  }

  function restoreDraft() {
    if (!draftContent || !viewReference.current) return;
    viewReference.current.dispatch({
      changes: { from: 0, to: viewReference.current.state.doc.length, insert: draftContent },
    });
    if (projectId && fileNodeId) save(draftContent);
    setDraftContent(null);
  }

  function discardDraft() {
    if (fileNodeId) localStorage.removeItem(OFFLINE_QUEUE_KEY_PREFIX + fileNodeId);
    setDraftContent(null);
  }

  // Grammar panel actions: navigate the editor to an issue, or apply a fix as an ordinary edit.
  const navigateToGrammarIssue = useCallback((from: number, to: number) => {
    const view = viewReference.current;
    if (!view) return;
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    view.focus();
  }, [viewReference]);
  // Accepting a fix edits the shared document, so it refuses outright for a reader who may not — the
  // panel already disables the chips, and `applyGrammarSuggestion` re-checks the view's own read-only
  // state, but neither is a reason for the editor to hand out an action it knows is not allowed.
  const applyGrammarIssue = useCallback((entry: PositionedGrammarDiagnostic, suggestion: EngineSuggestion) => {
    if (!effectiveCanEdit) return;
    const view = viewReference.current;
    if (view) applyGrammarSuggestion(view, entry.from, entry.to, suggestion);
  }, [viewReference, effectiveCanEdit]);
  // Offered only when the dismissal has somewhere to live, matching the tooltip's Ignore action.
  const ignoreIssue = useMemo(
    () =>
      grammarEnabled && fileNodeId
        ? (entry: PositionedGrammarDiagnostic) => ignoreGrammarIssue(entry.diagnostic)
        : null,
    [grammarEnabled, fileNodeId, ignoreGrammarIssue],
  );
  // Load the engine's rule config once it is ready (data-driven — never a hardcoded rule list), along
  // with its rule descriptions, which name what each rule checks in the panel's rule chips. Both are
  // read once per ready engine: the descriptions are static for a Harper version, so re-reading them on
  // every rule toggle would just be hundreds of strings crossing the worker again.
  useEffect(() => {
    if (!grammarEngineReady) return;
    let active = true;
    const client = getHarperClient();
    void client?.getLintConfig().then((config) => {
      if (active) setRuleConfig(config);
    });
    void client?.getLintDescriptions().then((descriptions) => {
      if (active) setRuleDescriptions(descriptions);
    });
    return () => {
      active = false;
    };
  }, [grammarEngineReady, getHarperClient]);
  // `setLintConfig` REPLACES the linter's whole configuration — harper.js documents it as "set the
  // linter's current configuration", not a merge. Passing just the toggled rule therefore threw every
  // other rule away: the next `getLintConfig()` returned a single-key object, so the Rules list
  // collapsed to the one rule the user clicked, and Reset (which derived its key set from that same
  // collapsed config) could not bring the others back either. Always send the full config with the one
  // rule changed, read fresh from the engine rather than from React state so a stale closure cannot
  // resurrect the same bug.
  //
  // Both refuse for a reader who may not edit. The rule config is view-local (it changes only what
  // this collaborator's checker reports, and is never persisted or sent to anyone), so this is not a
  // write-authorization boundary — it is consistency: a read-only viewer is offered no other writing
  // control, and leaving these live makes the panel claim an authority over the checker that the rest
  // of the surface denies. The panel disables the controls too; refusing here as well keeps a stale
  // render or a programmatic call from slipping through. The gate is `canConfigureRules`, NOT
  // `effectiveCanEdit`: consistency with the reader's ROLE is the point, and a file that merely lacks
  // collaborative backing makes nobody a reader.
  const setRule = useCallback((rule: string, enabled: boolean) => {
    if (!canConfigureRules) return;
    const client = getHarperClient();
    if (!client) return;
    void (async () => {
      const current = await client.getLintConfig();
      await client.setLintConfig({ ...current, [rule]: enabled });
      setRuleConfig(await client.getLintConfig());
      viewReference.current?.dispatch({});
    })();
  }, [canConfigureRules, getHarperClient, viewReference]);
  const resetRules = useCallback(() => {
    if (!canConfigureRules) return;
    const client = getHarperClient();
    if (!client) return;
    void (async () => {
      // Derive the key set from the engine, not from `ruleConfig`: state can lag, and reading it here
      // is what made Reset unable to recover from the collapse described above.
      const current = await client.getLintConfig();
      const cleared = Object.fromEntries(Object.keys(current).map((name) => [name, null]));
      await client.setLintConfig(cleared);
      setRuleConfig(await client.getLintConfig());
      viewReference.current?.dispatch({});
    })();
  }, [canConfigureRules, getHarperClient, viewReference]);

  // Every dictionary write goes through one of these three, and each refuses for a reader who may not
  // manage the dictionary. The panel hides the controls as well, but hiding is a rendering decision:
  // these are the handlers a stale render, a shortcut, or a programmatic caller would reach, and the
  // server would answer them with a 403 the user never asked for.
  const { addTerm: addDictionaryTerm, removeTerm: removeDictionaryTerm } = dictionary;
  const addTermToDictionary = useCallback((term: string) => {
    if (!canManageDictionary) return;
    void addDictionaryTerm(term);
  }, [canManageDictionary, addDictionaryTerm]);
  const removeTermFromDictionary = useCallback((termId: string) => {
    if (!canManageDictionary) return;
    void removeDictionaryTerm(termId);
  }, [canManageDictionary, removeDictionaryTerm]);
  const addIssueWordToDictionary = useCallback((entry: PositionedGrammarDiagnostic) => {
    if (!canManageDictionary) return;
    const view = viewReference.current;
    if (!view) return;
    const word = view.state.sliceDoc(entry.from, entry.to).trim();
    if (word) void addDictionaryTerm(word);
  }, [viewReference, canManageDictionary, addDictionaryTerm]);

  // Bubble the grammar panel state (issues + actions) to the layout so it can render the Grammar rail.
  useEffect(() => {
    onGrammarStateChange?.({
      diagnostics: grammarDiagnostics,
      status: grammarStatus,
      lintScope,
      setLintScope,
      navigate: navigateToGrammarIssue,
      apply: applyGrammarIssue,
      dictionary: dictionary.entries,
      canEditDocument: effectiveCanEdit,
      canManageDictionary,
      addDictionaryTerm: addTermToDictionary,
      removeDictionaryTerm: removeTermFromDictionary,
      addIssueWordToDictionary,
      ignore: ignoreIssue,
      canConfigureRules,
      ruleConfig,
      ruleDescriptions,
      setRule,
      resetRules,
    });
  }, [
    onGrammarStateChange,
    grammarDiagnostics,
    grammarStatus,
    lintScope,
    setLintScope,
    navigateToGrammarIssue,
    applyGrammarIssue,
    dictionary.entries,
    effectiveCanEdit,
    canManageDictionary,
    addTermToDictionary,
    removeTermFromDictionary,
    addIssueWordToDictionary,
    ignoreIssue,
    canConfigureRules,
    ruleConfig,
    ruleDescriptions,
    setRule,
    resetRules,
  ]);

  // Take the panel down with the editor. This component is the only publisher of grammar state, so
  // when it goes away nothing else can tell the layout the issues went with it: opening an image, a
  // theme file, or a file that fails to load would otherwise leave the Writing panel listing the
  // previous document's issues, with navigate/apply bound to a destroyed EditorView. React unmounts
  // the outgoing editor before mounting the next one, so switching between two AsciiDoc files still
  // ends with the new document's state, not this null.
  useEffect(() => () => onGrammarStateChange?.(null), [onGrammarStateChange]);

  const grammarCounts = useMemo(() => categoryCounts(grammarDiagnostics), [grammarDiagnostics]);

  // The effective collaboration connection state, surfaced on the root below. `synced` renders no
  // banner (ConnectionBanner returns null), so without this attribute the settled state has NO DOM
  // representation at all and the only way to observe it is the ABSENCE of the connecting banner —
  // which reads as "synced" before that banner has even mounted. Absent entirely off the collab path.
  const effectiveConnectionState = connectionState ?? collab?.connectionState;

  return (
    <div
      className="asciidoc-editor flex flex-col h-full"
      style={editorStyle(fontSize)}
      data-theme={theme}
      data-collab-state={effectiveConnectionState}
    >
      <EditorChrome
        view={viewReference.current}
        isAsciiDoc={isAsciiDoc}
        canEdit={effectiveCanEdit}
        fontSize={fontSize}
        theme={theme}
        softWrap={softWrap}
        minimapEnabled={minimapEnabled}
        blameEnabled={blameEnabled && blameAvailable}
        setFontSize={setFontSize}
        setTheme={setTheme}
        setSoftWrap={setSoftWrap}
        setMinimapEnabled={setMinimapEnabled}
        // Only offered when there is something to blame (connected repo + open file); otherwise the
        // toggle is hidden rather than shown disabled.
        setBlameEnabled={blameAvailable ? setBlameEnabled : undefined}
        tableContext={tableContext}
        awareness={collab?.awareness}
        onGoToSymbol={onGoToSymbol}
        onRefactor={onRefactor}
      />
      <EditorBanners
        externalChange={externalChangeBanner}
        draftContent={draftContent}
        onDismissExternalChange={() => setExternalChangeBanner(false)}
        onRestoreDraft={restoreDraft}
        onDiscardDraft={discardDraft}
        connectionState={effectiveConnectionState}
        readOnly={collab?.role === 'observer'}
        collabUnavailable={collabUnavailable}
        blameError={blameEnabled ? blameError : null}
      />
      <div className="flex flex-1 overflow-hidden">
        <div ref={containerReference} className="flex-1 overflow-auto" />
      </div>
      {(projectId && fileNodeId) && (
        <div className="border-t">
          <EditorStatusBar
            line={cursorPos.line}
            col={cursorPos.col}
            totalLines={cursorPos.totalLines}
            saveState={saveState}
            onRetry={handleRetry}
            wordCount={metrics.words}
            readingTimeMin={metrics.readingTimeMin}
            // The check-scope toggle lives in the Writing panel's own controls, not here: it
            // configures that panel, so it belongs beside it rather than in the shared status bar.
            grammarStatus={<GrammarStatus counts={grammarCounts} engineReady={grammarEngineReady} />}
          />
        </div>
      )}
    </div>
  );
}
