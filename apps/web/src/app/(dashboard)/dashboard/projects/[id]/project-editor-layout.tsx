'use client';
import { useLayoutEffect, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import Link from 'next/link';
import { ChevronLeft, Settings, Users } from 'lucide-react';
import type { CreateAnchorInput, ReviewItemDto } from '@asciidocollab/shared';
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { BackButton } from '@/components/back-button';
import { LogoMark } from '@/components/logo';
import { FileTree } from '@/components/file-tree/file-tree';
import { AsciiDocEditor, type EditorGrammarState } from '@/components/editor/asciidoc-editor';
import { useProjectSymbolIndex } from '@/hooks/use-project-symbol-index';
import { useFileTreeEvents } from '@/hooks/use-file-tree-events';
import type { ProjectSymbolIndex } from '@/lib/codemirror/asciidoc-symbol-index';
import { AsciiDocPreview, isAsciiDocFile } from '@/components/asciidoc-preview';
import { ImagePreview } from '@/components/image-preview';
import { isImageFile } from '@/lib/codemirror/asciidoc-image-extensions';
import { isThemeFilePath } from '@asciidocollab/shared';
import { ThemeEditor } from '@/components/theme-editor/theme-editor';
import { useThemeSettings } from '@/hooks/use-theme-settings';
import { useFileSelection } from '@/hooks/use-file-selection';
import { useFileHistory } from '@/hooks/use-file-history';
import { useEditorPreferences } from '@/hooks/use-editor-preferences';
import { type ConnectionState } from '@/hooks/use-collab-document';

import { LeftPanel } from '@/components/editor/left-panel';
import { RightPanel } from '@/components/editor/right-panel';
import { RightPanelRail } from '@/components/editor/right-panel-rail';
import { OutlineView } from '@/components/editor/outline-view';
import { CommentsPanelView, type CommentsSubView } from '@/components/editor/comments-panel-view';
import { WritingPanelView, type WritingSubView } from '@/components/editor/writing-panel-view';
import { SearchView, type SearchResultTarget } from '@/components/editor/search-view';
import { NonLiveIndicator } from '@/components/editor/non-live-indicator';
import type { SectionOutlineEntry } from '@/lib/codemirror/asciidoc-outline';
import { assembleOutline, mapOutlinePresence } from '@/lib/outline';
import {
  buildAssembledLineToSource,
  buildAssembledScrollContext,
  buildOpenFileLineToSource,
  liftSourceMapToBlockStarts,
  openLineToAssembledLine,
} from '@/lib/pdf/scroll-sync-map';
import { isOpenFileOutsideMainTree, resolvePreviewRoot } from '@/lib/pdf/preview-root';
import { sameOutlineEntries } from '@/lib/outline/stable-entries';
import type { OutlinePeer } from '@/lib/outline';
import type { SelectedFile, FileContentState } from '@/hooks/use-file-selection';
import type { CollabBinding } from '@/components/editor/asciidoc-editor';
import { ReviewViewStateProvider } from '@/components/review';
import type { TaskMember } from '@/components/review';
import { useReviewItems } from '@/hooks/use-review-items';
import { sortThreadsByDocumentOrder } from '@/lib/review/order';
import { reanchorReviewItem } from '@/lib/api/review';
import { membersApi } from '@/lib/api/members';
import type { ReviewAnchorRange } from '@/lib/codemirror/review-decorations';
import type { XrefTarget } from '@/lib/codemirror/asciidoc-link-handler';
import type { CursorSymbol } from '@/lib/codemirror/asciidoc-symbol-at-cursor';
import { EditorGoToSymbol } from '@/components/editor/editor-go-to-symbol';
import { EditorSymbolRefactor } from '@/components/editor/editor-symbol-refactor';
import { findSymbolUsages, renameSymbol } from '@/lib/api/projects';
import { useProjectEditorState } from '@/app/(dashboard)/dashboard/projects/[id]/use-project-editor-state';
import { useManagedCollab } from '@/app/(dashboard)/dashboard/projects/[id]/use-managed-collab';
import { useEditorNavigation } from '@/app/(dashboard)/dashboard/projects/[id]/use-editor-navigation';
import { useEditorRestoration } from '@/app/(dashboard)/dashboard/projects/[id]/use-editor-restoration';
import { readLastSelection } from '@/hooks/use-last-selection';
import { PdfExportButton } from '@/components/pdf-export-button';
import { HtmlExportButton } from '@/components/html-export-button';
import { useHtmlExport } from '@/hooks/use-html-export';
import { PdfDiagnostics } from '@/components/pdf-diagnostics';
import { PdfPreviewPanel } from '@/components/pdf-preview-panel';
import { usePdfExport } from '@/hooks/use-pdf-export';
import { usePdfPreview } from '@/hooks/use-pdf-preview';
import { buildProjectSnapshot, type SnapshotFile } from '@/lib/pdf/build-project-snapshot';
import { withAppRenderDefaults } from '@/lib/asciidoc/render-app-defaults';
import { collectReferencedAssetPaths } from '@/lib/pdf/collect-referenced-assets';
import { useProjectAssetCache, type ProjectAssetCache } from '@/hooks/use-project-asset-cache';
import { useProjectAuxiliaryTextCache } from '@/hooks/use-auxiliary-text-cache';
import { useProjectRenderConfig } from '@/hooks/use-project-render-config';
import { usePdfExtensionBundle } from '@/hooks/use-pdf-extension-bundle';

/** No extensions enabled. Shared so the memo keeps a stable identity across renders. */
const NO_EXTENSION_IDS: readonly string[] = [];
import {
  resolveRenderAttributes,
  SOFT_DEFAULT_SUFFIX,
  DEFAULT_HTML_EXPORT_PACKAGING,
  DEFAULT_HTML_EXPORT_THEME,
} from '@asciidocollab/shared';
import type { ProjectSnapshot, RenderDiagnostic } from '@asciidocollab/asciidoc-pdf';

/** A diagnostic source location the editor can reveal. */
type DiagnosticLocation = NonNullable<RenderDiagnostic['location']>;

/** Stable empty attribute seed used when no render root is resolved yet (keeps identity stable). */
const NO_EXPORT_ATTRIBUTES: ReadonlyMap<string, string> = new Map();

/** How long the export waits for a transiently-absent render root to (re)load before giving up. */
const EXPORT_ROOT_WAIT_TIMEOUT_MS = 10_000;
/** Poll cadence while waiting for the render root's content to arrive. */
const EXPORT_ROOT_WAIT_INTERVAL_MS = 100;

/**
 * Poll `predicate` until it is true or the timeout elapses. Used to wait for the render root's content
 * to land in the symbol index before an export dispatches. Returns the final predicate result.
 */
async function waitUntil(
  predicate: () => boolean,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

interface ContentAreaProperties {
  selectedFile: SelectedFile | null;
  contentState: FileContentState;
  canEdit: boolean;
  /** Project-role permission for the shared dictionary (no admin bypass). See the layout's prop. */
  canManageDictionary: boolean;
  /**
   * The reader's UN-NARROWED edit permission, for the view-local rule config only. `canEdit` above is
   * `editorCanEdit`, which already folds in `offline`/`collabUnavailable`; those must not disable a
   * control that writes nothing. See the editor's prop.
   */
  canConfigureRules: boolean;
  projectId: string;
  /**
   * Surfaces the editor's live grammar-panel state so the layout can render the Grammar rail.
   *
   * @param state - The current grammar issues plus the navigate/apply actions, or null when no
   * AsciiDoc editor is mounted to check anything.
   */
  onGrammarStateChange?: (state: EditorGrammarState | null) => void;
  /**
   * The project's binary-asset cache, forwarded to the theme editor so a theme's fonts are fetched
   * and embedded in its preview. The SAME instance the document preview and the export use, so a
   * font is fetched once per project however many renders reference it.
   */
  assetCache: ProjectAssetCache;
  /** Project document language (ISO 639-1) driving the spellchecker, or null when unset. */
  projectLanguage: string | null;
  onScrollLine?: (line: number) => void;
  onSelectionLine?: (line: number) => void;
  onLineClick?: (line: number) => void;
  // Ctrl+click on an include/image path — reveals and selects the target file in the tree.
  onNavigateToFile?: (path: string) => void;
  // Ctrl+click on a cross-reference — reveals its definition (same file or another).
  onNavigateToXref?: (target: XrefTarget) => void;
  // Include-path level offset inherited by the open file from its ancestors.
  inheritedOffset?: number;
  // Attributes the open file inherits from the documents that include it.
  inheritedAttributes?: ReadonlyMap<string, string>;
  // The open file's resolved cross-document scope (inherited + own), for `{name}` known highlighting.
  resolvedScope?: ReadonlyMap<string, string>;
  // Bumped when a collaborator changes any project file, so a visible rename offer re-queries.
  renameRefreshNonce?: number;
  // Live request to reveal a line in the open editor (same-file go-to-definition).
  revealRequest?: { line: number; nonce: number } | null;
  // Ctrl+click on a link or URL — opens it in a new tab.
  onOpenUrl?: (url: string) => void;
  onChange?: (value: string) => void;
  /** 1-based line to restore the cursor to on mount (only for the restored file). */
  initialLine?: number;
  /**
   * Reports the 1-based cursor line up for debounced persistence.
   *
   * @param line - The 1-based line the cursor is on.
   */
  onCursorLineChange?: (line: number) => void;
  /**
   * Reports the live section outline up so the left-panel Outline view can render it (028).
   *
   * @param entries - The current section outline entries, including the level-0 title.
   */
  onOutlineChange?: (entries: SectionOutlineEntry[]) => void;
  /** Live collaboration binding for the selected file, or null on the legacy path. */
  collab?: CollabBinding | null;
  /** True when the file is collaborative but the provider/Y.Doc is not ready yet. */
  collabPending?: boolean;
  /** Collaboration connection state, for the editor's status banner. */
  connectionState?: ConnectionState;
  /** Content to render instead of contentState.content (offline read-only fallback). */
  contentOverride?: string | null;
  /** True when the file is editable text with no collaborative document — read-only, no autosave. */
  collabUnavailable?: boolean;
  /** Live accessor for the cross-file symbol index; powers cross-file diagnostics + completion. */
  getProjectIndex?: () => ProjectSymbolIndex | null;
  /** Opens the Go to Symbol palette from the editor toolbar. */
  onGoToSymbol?: () => void;
  // Opens the refactor dialog from the editor toolbar, seeded with the cursor symbol.
  onRefactor?: (initial: CursorSymbol | null) => void;
  /** Review anchor ranges (feature 038) painted as editor highlights + gutter markers. */
  reviewRanges?: ReviewAnchorRange[];
  /** The emphasised review item id (hover ∪ selection); its highlight is strengthened, no scroll. */
  activeReviewId?: string | null;
  /** The review item just navigated to; scrolls it into view and flashes it once. */
  scrollToReviewId?: string | null;
  /**
   * Called when a review highlight/gutter marker is clicked (feature 038).
   *
   * @param id - The clicked review item id.
   */
  onReviewMarkerClick?: (id: string) => void;
  /**
   * Called as the pointer moves over (or off) a review marker (feature 038); highlights the rail card.
   *
   * @param id - The hovered review item id, or null.
   */
  onReviewMarkerHover?: (id: string | null) => void;
  /**
   * Called when a comment is started from the editor selection (feature 038).
   *
   * @param anchor - The captured anchor for the selected passage.
   */
  onCreateCommentFromSelection?: (anchor: CreateAnchorInput) => void;
}

function ContentArea({
  selectedFile,
  contentState,
  canEdit,
  canManageDictionary,
  canConfigureRules,
  projectId,
  assetCache,
  projectLanguage,
  onScrollLine,
  onSelectionLine,
  onLineClick,
  onNavigateToFile,
  onNavigateToXref,
  inheritedOffset,
  inheritedAttributes,
  resolvedScope,
  renameRefreshNonce,
  revealRequest,
  onOpenUrl,
  onChange,
  initialLine,
  onCursorLineChange,
  onOutlineChange,
  collab,
  collabPending,
  connectionState,
  contentOverride,
  collabUnavailable,
  getProjectIndex,
  onGoToSymbol,
  onRefactor,
  reviewRanges,
  activeReviewId,
  scrollToReviewId,
  onReviewMarkerClick,
  onReviewMarkerHover,
  onCreateCommentFromSelection,
  onGrammarStateChange,
}: ContentAreaProperties) {
  // Called before the early returns below, because a hook cannot be conditional. The result is only
  // consumed on the theme-file branch, but computing it here keeps the branch a plain render.
  const { settings: themeSettings, enabledExtensions } = useThemeSettings(projectId);

  if (selectedFile === null) {
    return <p className="text-muted-foreground text-sm p-4">Select a file from the tree to view its content.</p>;
  }
  if (contentState.isLoading || collabPending) {
    return (
      <div className="p-4 space-y-2">
        <div className="h-4 w-3/4 bg-muted animate-pulse rounded" />
        <div className="h-4 w-1/2 bg-muted animate-pulse rounded" />
      </div>
    );
  }
  if (contentState.isBinary) {
    if (isImageFile(selectedFile.nodeName)) {
      return (
        <ImagePreview
          key={selectedFile.nodeId}
          projectId={projectId}
          fileNodeId={selectedFile.nodeId}
          fileName={selectedFile.nodeName}
        />
      );
    }
    return <p className="text-muted-foreground text-sm p-4">Preview not available for binary files.</p>;
  }
  if (contentState.error) {
    return <p className="text-destructive text-sm p-4">{contentState.error}</p>;
  }
  // A theme is YAML, and opened on the AsciiDoc path it got AsciiDoc highlighting, AsciiDoc
  // completions and AsciiDoc diagnostics — the last of which reported a valid theme as broken
  // prose. Routing it to its own editor is as much a bug fix as a feature (FR-009, FR-009a). The
  // recognition rule is the SHARED one, so the editor and the renderer cannot disagree about which
  // files are themes.
  if (isThemeFilePath(selectedFile.nodeName)) {
    return (
      <ThemeEditor
        key={selectedFile.nodeId}
        themeSettings={themeSettings}
        enabledExtensions={enabledExtensions}
        assetCache={assetCache}
        content={contentOverride ?? contentState.content ?? ''}
        canEdit={canEdit}
        path={selectedFile.path}
        projectId={projectId}
        fileNodeId={selectedFile.nodeId}
        initialEtag={contentState.etag}
        collab={collab ? { doc: collab.doc, awareness: collab.awareness } : null}
        connectionState={connectionState}
        collabUnavailable={collabUnavailable}
        onChange={onChange}
      />
    );
  }
  return (
    <AsciiDocEditor
      key={selectedFile.nodeId}
      content={contentOverride ?? contentState.content ?? ''}
      canEdit={canEdit}
      canManageDictionary={canManageDictionary}
      canConfigureRules={canConfigureRules}
      projectId={projectId}
      fileNodeId={selectedFile.nodeId}
      onGrammarStateChange={onGrammarStateChange}
      initialEtag={contentState.etag}
      isAsciiDoc={isAsciiDocFile(selectedFile.nodeName)}
      spellcheckLanguage={projectLanguage}
      onScrollLine={onScrollLine}
      onSelectionLine={onSelectionLine}
      onLineClick={onLineClick}
      onNavigateToFile={onNavigateToFile}
      onNavigateToXref={onNavigateToXref}
      inheritedOffset={inheritedOffset}
      inheritedAttributes={inheritedAttributes}
      resolvedScope={resolvedScope}
      renameRefreshNonce={renameRefreshNonce}
      revealRequest={revealRequest}
      onOpenUrl={onOpenUrl}
      onChange={onChange}
      initialLine={initialLine}
      onCursorLineChange={onCursorLineChange}
      onOutlineChange={onOutlineChange}
      collab={collab}
      connectionState={connectionState}
      collabUnavailable={collabUnavailable}
      getProjectIndex={getProjectIndex}
      onGoToSymbol={onGoToSymbol}
      onRefactor={onRefactor}
      reviewRanges={reviewRanges}
      activeReviewId={activeReviewId}
      onReviewMarkerHover={onReviewMarkerHover}
      scrollToReviewId={scrollToReviewId}
      onReviewMarkerClick={onReviewMarkerClick}
      onCreateCommentFromSelection={onCreateCommentFromSelection}
    />
  );
}

interface ProjectEditorLayoutProperties {
  projectId: string;
  projectName: string;
  projectDescription: string | null;
  /** Project document language (ISO 639-1) driving the spellchecker, or null when unset. */
  projectLanguage: string | null;
  /** Configured main-file node id, or null when unset. */
  mainFileNodeId: string | null;
  canManage: boolean;
  canEdit: boolean;
  /**
   * Whether the user may mutate the file structure (create/rename/move/delete/upload). Distinct from
   * `canEdit`: it excludes the admin bypass, matching the file-tree API which authorizes on project
   * role only — so a global admin who is merely a viewer here sees no file-mutation buttons that would
   * 403. See page.tsx.
   */
  canModifyFiles: boolean;
  /**
   * Whether the user may write the project's shared grammar dictionary. Excludes the admin bypass for
   * the same reason as {@link canModifyFiles} — `requireDictionaryEditor` authorizes on project role
   * alone — and unlike the document editor nothing else covers it, since a dictionary write is a REST
   * call with no collaboration session to force read-only. See page.tsx.
   */
  canManageDictionary: boolean;
  /** Authenticated user id — scopes the persisted last-selection so accounts stay isolated. */
  userId: string;
}

/** Three-panel editor layout: collapsible file tree, CM6 editor, AsciiDoc preview. */
export function ProjectEditorLayout({
  projectId,
  projectName,
  projectDescription,
  projectLanguage,
  mainFileNodeId,
  canManage,
  canEdit,
  canModifyFiles,
  canManageDictionary,
  userId,
}: ProjectEditorLayoutProperties) {
  const { selectedFile, contentState, selectFile, clearSelection } = useFileSelection(projectId);

  // Whether this is the user's FIRST time opening this project on this browser — i.e. nothing was
  // ever remembered. Read once at mount (before the restoration effect writes anything), so it
  // reflects the pristine state. Drives the file tree's first-open auto-selection of the main file:
  // when there IS a remembered selection, restoration handles it and this stays false so nothing is
  // auto-selected over it. `readLastSelection` is guarded against an absent localStorage (SSR), where
  // it reads as "first open" — harmless, because the auto-select is an effect that only runs client-side.
  const [isFirstOpen] = useState(() => readLastSelection(userId, projectId) === null);

  // Layout-shell + live-content state: main-file selection, sidebar + preview visibility, and the
  // live editor buffer that feeds the preview.
  const {
    mainFile, setMainFile,
    sidebarOpen, setSidebarOpen, sidebarResize,
    previewOpen, togglePreview,
    liveContent, liveOverlayContent, handleChange,
  } = useProjectEditorState({
    mainFileNodeId,
    selectedFileNodeId: selectedFile?.nodeId ?? null,
    content: contentState.content,
  });

  // Editor preferences (preview style, outline scope/visibility, included-file display).
  const { scrollSyncEnabled, setScrollSyncEnabled, previewStyle, setPreviewStyle, leftPanelTab, setLeftPanelTab, rightPanelTab, setRightPanelTab, showIncludedFiles, setShowIncludedFiles, outlineScope, setOutlineScope, commentsPanelOpen, setCommentsPanelOpen } = useEditorPreferences();

  // Cross-file symbol index: rooted at the configured main file, or the open file when
  // none is set. Powers cross-file diagnostics + completion; refreshes when the main
  // file changes and overlays the open file's live content.
  const { index: projectIndex, getIndex: getProjectIndex, getFiles: getProjectFiles, resolvedScopeOf, refresh: refreshProjectIndex, fileIdForPath, reachableDocVersion } = useProjectSymbolIndex({
    projectId,
    rootFileId: mainFile ?? selectedFile?.nodeId ?? null,
    openFileId: selectedFile?.nodeId ?? null,
    // Overlay the open file's content only once its editor has produced it; before then `null` keeps
    // the index on the cached/persisted copy so a file switch doesn't transiently blank the open file
    // (which would drop its headings from the assembled outline and re-add them a frame later).
    liveContent: liveOverlayContent,
  });

  // Rename freshness: a rename suggestion's project-wide counts/collision must track a collaborator's
  // edits to ANY project file — including files outside the open document's dependency graph — so this
  // subscription is intentionally unfiltered (the symbol index's content-changed handler filters by
  // reachability, which is too narrow for a project-wide rename). The bumped nonce nudges the editor's
  // rename plugin to re-query while an offer is visible.
  const [renameRefreshNonce, setRenameRefreshNonce] = useState(0);
  // While the SSE stream is down, a collaborator's live edits are not being delivered, so related
  // content may be resolved from last-saved rather than a live session — surface that subtly. Driven
  // by the true connection edges (dropped ⇒ non-live, (re)established ⇒ live), not by a rebuild, so it
  // stays steadily on through an outage and clears exactly when the stream actually recovers.
  const [nonLive, setNonLive] = useState(false);
  // The file node named by the most recent content-changed frame, so the auxiliary cache refetches
  // exactly that file. Shares this subscription's unfiltered reach for the same reason: a theme is
  // never include-reachable, so a reachability-filtered handler would never see a theme edit at all.
  const [changedFileNodeId, setChangedFileNodeId] = useState<string | null>(null);
  useFileTreeEvents(projectId, {
    onContentChanged: (event) => {
      setRenameRefreshNonce((nonce) => nonce + 1);
      setChangedFileNodeId(event.fileNodeId);
    },
    // A collaborator changed the project's main file: update the single source of truth so BOTH the
    // symbol index's root and the preview root re-resolve against the new anchor (no split-brain).
    onMainFileChanged: (event) => setMainFile(event.mainFileNodeId),
    onReconnect: () => setNonLive(true),
    onConnected: () => setNonLive(false),
  });

  // Left-panel Outline view state (028): the live outline lifted from the editor and the cursor line
  // used to mark the current section. Held here so the panel is fed without remounting the editor.
  // Declared before useManagedCollab so cursorLine can be forwarded to presence publishing.
  const [cmOutlineEntries, setOutlineEntries] = useState<SectionOutlineEntry[]>([]);
  const [currentLine, setCurrentLine] = useState<number | null>(null);

  // Collaboration orchestration for the open file: the Yjs binding, mid-session role enforcement,
  // offline read-only fallback, presence (feature 024), and the derived editor
  // props (research D6 / EditorMode).
  const {
    presenceByFile,
    editorCollab,
    collabUnavailable,
    editorCanEdit,
    editorContentOverride,
    editorConnectionState,
    editorPending,
  } = useManagedCollab({ projectId, selectedFile, contentState, canEdit, cursorLine: currentLine });

  // ── Review comments & tasks (feature 038) ──────────────────────────────────────────────────
  // Comments are available only for a collaborative .adoc (a live Y.Doc + document id). The review
  // hook is consumed HERE so the editor decorations and the rail read one shared, live source.
  const commentsAvailable = editorCollab != null;
  const reviewItems = useReviewItems({
    projectId,
    documentId: editorCollab?.documentId ?? '',
    ydoc: editorCollab?.doc ?? null,
    enabled: commentsAvailable,
    // Include resolved items so the editor has anchor ranges for them: the rail can navigate to a
    // resolved thread (via its "All"/"Tasks" filter or the Reopen affordance), and the scroll effect
    // needs a range to reveal. Open-count/prev-next re-filter resolved out separately.
    includeResolved: true,
  });

  // Two-way editor↔rail linkage state, owned here so both the rail (explicit props) and the editor
  // decorations (activeReviewId prop) read the same active/hovered ids.
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  // A captured selection anchor pinned as the rail's new-comment composer.
  const [pendingAnchor, setPendingAnchor] = useState<CreateAnchorInput | null>(null);
  // While set, the next captured selection reattaches this detached item instead of creating one.
  const [reattachItemId, setReattachItemId] = useState<string | null>(null);
  // A cross-document jump requested from the project-wide list: the target file + thread to focus once
  // that document is bound and its threads have loaded (opening a file otherwise clears the focus).
  const [pendingReviewFocus, setPendingReviewFocus] = useState<{ fileNodeId: string; documentId: string; itemId: string } | null>(null);

  // Which surface the comments panel shows: this document's threads or the project-wide task list.
  const [commentsView, setCommentsView] = useState<CommentsSubView>('threads');
  // Live grammar-panel state surfaced from the editor (issues + navigate/apply/dictionary actions).
  const [grammarState, setGrammarState] = useState<EditorGrammarState | null>(null);
  // Writing panel sub-view: the list of issues, the project dictionary, or the rule configuration.
  const [grammarView, setGrammarView] = useState<WritingSubView>('issues');
  // The right panel holds two independent views, and only the comments one needs collaboration.
  // Gating the whole panel on a live Y.Doc hid the Writing view — and the issue count — for every
  // non-collaborative document, even though grammar checking runs locally and was still underlining
  // the text. So the panel is offered when EITHER view has something to show.
  const rightPanelAvailable = commentsAvailable || grammarState !== null;
  // Project members for the assignee picker + whether the current user owns the project.
  const [members, setMembers] = useState<TaskMember[]>([]);
  const [isProjectOwner, setIsProjectOwner] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void membersApi.list(projectId)
      .then((response) => {
        if (cancelled) return;
        setMembers(response.data.members.map((member) => ({ id: member.userId, displayName: member.displayName })));
        setIsProjectOwner(response.data.members.some((member) => member.userId === userId && member.role === 'owner'));
      })
      .catch(() => { /* the picker still renders "Unassigned" with an empty list */ });
    return () => { cancelled = true; };
  }, [projectId, userId]);

  // Every root in document order — the sequence the prev/next arrows walk. Resolved threads are
  // included: the arrows step through ALL comments, so a resolved one is never skipped over.
  // It shares the rail's ordering rule so the arrows visit the cards in exactly the order they appear
  // in the rail (including where a detached thread lands).
  const threadIdsInOrder = useMemo(
    () =>
      sortThreadsByDocumentOrder(reviewItems.threads, reviewItems.ranges).map((thread) => thread.root.id),
    [reviewItems.threads, reviewItems.ranges],
  );
  // The badge counts only what still needs attention, so it stays a count of OPEN comments.
  const openCount = useMemo(
    () => reviewItems.threads.filter((thread) => !thread.root.resolvedAt).length,
    [reviewItems.threads],
  );

  // Step the focused thread through every comment in document order, wrapping at both ends.
  const stepActiveThread = useCallback((delta: number) => {
    if (threadIdsInOrder.length === 0) return;
    const current = activeThreadId ? threadIdsInOrder.indexOf(activeThreadId) : -1;
    const nextIndex = current === -1
      ? (delta > 0 ? 0 : threadIdsInOrder.length - 1)
      : (current + delta + threadIdsInOrder.length) % threadIdsInOrder.length;
    setActiveThreadId(threadIdsInOrder[nextIndex]);
  }, [threadIdsInOrder, activeThreadId]);

  // A review marker was clicked in the editor: open the panel, switch to the per-file threads view
  // (the marker belongs to this file), and focus that thread.
  const handleReviewMarkerClick = useCallback((id: string) => {
    setCommentsPanelOpen(true);
    setCommentsView('threads');
    setActiveThreadId(id);
  }, [setCommentsPanelOpen]);

  // A selection was turned into a comment (or a reattach target when one is pending).
  const handleCreateCommentFromSelection = useCallback((anchor: CreateAnchorInput) => {
    if (reattachItemId) {
      void reanchorReviewItem(projectId, reattachItemId, { anchor }).then(() => reviewItems.refetch());
      setReattachItemId(null);
      return;
    }
    // The new-comment composer lives in the per-file rail, so surface it even if the cross-file
    // list was showing.
    setCommentsPanelOpen(true);
    setCommentsView('threads');
    setPendingAnchor(anchor);
  }, [reattachItemId, projectId, reviewItems, setCommentsPanelOpen]);

  // File + cross-reference navigation, the go-to-symbol palette, and the refactor dialog.
  const {
    scrollRequest, resetScroll, revealRequest, openPathRequest, pendingXrefLine,
    handleScrollLine, handleLineClick, revealLine, handleNavigateToFile, handleNavigateToXref, handleOpenUrl,
    goToSymbolOpen, setGoToSymbolOpen, symbolPathOf, handleSelectSymbol,
    refactorOpen, setRefactorOpen, refactorInitial, openRefactor,
    handleNavigateToUsage, handleSymbolRenamed,
  } = useEditorNavigation({ projectIndex, getProjectIndex, refreshProjectIndex });

  // Last-selection restoration, cursor-line persistence, and the stale-memory
  // cleanup for a missing restored file.
  const { handleSelectFile, handleCursorLineChange, initialLine } = useEditorRestoration({
    userId, projectId, selectedFile, contentState, selectFile, clearSelection, pendingXrefLine,
  });

  // Make file selection a real browser navigation: each opened file becomes a history entry, so the
  // Back/Forward buttons walk the files visited this session and re-open the previous one through the
  // same selection funnel (remember + cursor restore). Reload restoration stays the localStorage
  // concern of useEditorRestoration above.
  useFileHistory({ selectedFile, selectFile: handleSelectFile });

  // Jump from the project-wide list to an item's passage. When it lives in the open document, focus it
  // in the per-document rail immediately; otherwise open its file and defer focusing until that
  // document is bound and loaded (see the pending-focus effect below).
  const handleNavigateToReviewItem = useCallback((item: ReviewItemDto) => {
    setCommentsPanelOpen(true);
    if (editorCollab && item.documentId === editorCollab.documentId) {
      setCommentsView('threads');
      setActiveThreadId(item.id);
      return;
    }
    const path = item.fileNodeId ? projectIndex?.pathOf(item.fileNodeId) : null;
    if (!item.fileNodeId || !path) return;
    setPendingReviewFocus({ fileNodeId: item.fileNodeId, documentId: item.documentId, itemId: item.id });
    handleNavigateToFile(path);
  }, [editorCollab, projectIndex, handleNavigateToFile, setCommentsPanelOpen]);

  // Apply a deferred cross-document jump once the target document is bound AND its anchor has resolved
  // — not merely once the thread list loaded. Focusing on thread-load alone sets scrollToReviewId
  // before the freshly-bound doc has produced anchor ranges, so the editor's scroll effect (which keys
  // only on scrollToReviewId) finds no range and never scrolls. Wait for a resolved range (located or
  // section); a detached item has no passage to scroll to, so focus it as soon as it is known detached.
  useEffect(() => {
    if (!pendingReviewFocus || !editorCollab || editorCollab.documentId !== pendingReviewFocus.documentId) return;
    const { itemId } = pendingReviewFocus;
    if (!reviewItems.threads.some((thread) => thread.root.id === itemId)) return;
    const hasRange = reviewItems.ranges.some((range) => range.id === itemId);
    const detached = reviewItems.anchorStates.get(itemId) === 'detached';
    if (!hasRange && !detached) return;
    setCommentsView('threads');
    setActiveThreadId(itemId);
    setPendingReviewFocus(null);
  }, [pendingReviewFocus, editorCollab, reviewItems.threads, reviewItems.ranges, reviewItems.anchorStates]);

  // Reset the scroll position AND the current-section marker whenever a different file is opened, so the
  // Outline never highlights a row using the previous file's cursor line before the new editor reports
  // its cursor. useLayoutEffect prevents a one-frame flash of the old scroll position / stale highlight.
  useLayoutEffect(() => {
    resetScroll();
    setCurrentLine(null);
    // Clear review interaction state tied to the previous document so a pending composer or an armed
    // reattach never applies to the newly-opened document (which would post an anchor captured against
    // the old document's Y.Text). The active/hover focus is likewise per-document.
    setPendingAnchor(null);
    setReattachItemId(null);
    setActiveThreadId(null);
    setHoveredItemId(null);
    setCommentsView('threads');
    // Drop a cross-document jump unless this is the file it was targeting (which the effect above then
    // completes); otherwise a later unrelated open would spuriously focus the stale thread.
    setPendingReviewFocus((previous) => (previous && previous.fileNodeId === selectedFile?.nodeId ? previous : null));
  }, [selectedFile?.nodeId, resetScroll]);

  // Level offset the open file inherits from its include ancestors; 0 until the index
  // resolves it or when the file is the tree root. Re-evaluates heading levels on main-file change.
  const editorInheritedOffset = projectIndex && selectedFile ? projectIndex.inheritedOffset(selectedFile.nodeId) : 0;
  // Attributes the open file inherits from the documents that include it; empty until the
  // index resolves them or when the file is the tree root. Seeds the `{attr}` collapse-to-value
  // display so cross-document references render their value.
  const editorInheritedAttributes =
    projectIndex && selectedFile ? projectIndex.inheritedAttributes(selectedFile.nodeId) : undefined;
  // The open file's RESOLVED cross-document scope (inherited + own definitions): drives the editor's
  // known-vs-unknown `{name}` highlighting so a reference resolving in a parent/included file marks
  // as known. Recomputed when the index rebuilds (live).
  const editorResolvedScope =
    projectIndex && selectedFile ? resolvedScopeOf(selectedFile.nodeId) : undefined;
  // Render the assembled main document (includes inlined) only while the open file IS the
  // configured main file. Editing an included child still previews that child standalone with exact
  // source-line scroll-sync. (When the main file itself has content after an include, scroll-sync to
  // those later lines is approximate — an inherent limit of an assembled multi-file preview; lines
  // before the first include still map exactly.)
  const previewMainPath = mainFile && selectedFile?.nodeId === mainFile && projectIndex
    ? (projectIndex.pathOf(mainFile) ?? undefined)
    : undefined;

  // Cross-document attribute resolution: when a main file is configured and the open
  // file is NOT it, the preview resolves the open file's `{name}` references against the scope it
  // inherits under the main-file root. Paths key the worker's resolution model (matching getFiles).
  const previewRootPath = mainFile && projectIndex ? (projectIndex.pathOf(mainFile) ?? undefined) : undefined;
  const previewOpenPath =
    selectedFile && projectIndex ? (projectIndex.pathOf(selectedFile.nodeId) ?? undefined) : undefined;

  // Whether the open file is OUTSIDE the configured main document's include tree (not the main file and
  // not reachable through its includes). Only meaningful when a main file is configured; false otherwise
  // (with no main, the open file IS its own document). Assembled from the main root the same way the
  // outline/scroll-sync bridges are, so the three agree on reachability. When true, the on-screen preview
  // renders the open file on its own (as its own main document) rather than the unrelated main document,
  // and both previews surface a short "not part of the main document" notice. The export/download stays
  // rooted at the main document regardless (see handleExportPdf).
  const openFileOutsideMainTree = useMemo(() => {
    // Only the open preview consumes this (its root + the not-part-of-main notice), and assembling the
    // include tree is O(document size); skip the whole walk while the preview is closed so a closed panel
    // never taxes typing. Read the file map lazily (cached to one call): the helper also short-circuits
    // before any file read when no main file is configured or the open file IS the main file, so
    // getProjectFiles() is only invoked when reachability actually has to be assembled.
    if (!previewOpen) return false;
    let files: Record<string, string> | null = null;
    return isOpenFileOutsideMainTree(previewRootPath, previewOpenPath, (path: string) => {
      files ??= getProjectFiles();
      return files[path] ?? null;
    });
    // liveOverlayContent + reachableDocVersion are the same edit/content signals that refresh the render,
    // so a newly-added (or removed) include that changes reachability re-evaluates this.
  }, [previewOpen, previewRootPath, previewOpenPath, getProjectFiles, liveOverlayContent, reachableDocVersion]);

  // ── Export to PDF ──────────────────────────────────────────────────────────────────────────
  // Fully client-side one-click export. The render root mirrors the symbol-index root: the
  // configured main file, else the open file. Both are resolved to project-relative paths; the
  // control is disabled until a root path is known.
  const { config: renderConfig, loading: renderConfigLoading } = useProjectRenderConfig(projectId);
  // The extensions this project renders with, and the Ruby that implements them. Both the preview and
  // the export read the SAME two values, so a document exported from here matches what was previewed.
  const projectExtensionIds = useMemo(
    () => renderConfig.extensions?.enabled ?? NO_EXTENSION_IDS,
    [renderConfig.extensions?.enabled],
  );
  const { bundle: projectExtensionBundle, ready: projectExtensionsReady } = usePdfExtensionBundle(
    projectId,
    projectExtensionIds,
  );
  /**
   * Whether an export would render the project's ACTUAL configuration.
   *
   * Both halves start empty and fill in asynchronously, and neither failure is visible in the
   * result: an export taken before the render config arrives silently drops the project's theme,
   * page size and extension selection, and one taken before the extension sources arrive drops the
   * extensions alone. The document renders perfectly either way, which is what makes gating the
   * control the only honest fix — there is nothing to detect afterwards.
   *
   * The live preview needs no such gate: it re-renders when these settle.
   */
  const exportConfigurationReady = !renderConfigLoading && projectExtensionsReady;

  const { exportPdf, isExporting: isExportingPdf, phase: exportPhase, error: exportError, diagnostics: exportDiagnostics } =
    usePdfExport({ extensions: projectExtensionBundle, projectName });
  const exportRootFileId = mainFile ?? selectedFile?.nodeId ?? null;
  const exportMainPath = mainFile && projectIndex ? projectIndex.pathOf(mainFile) : null;
  const exportOpenPath =
    (selectedFile && projectIndex ? projectIndex.pathOf(selectedFile.nodeId) : null) ?? exportMainPath;
  // Project-level render configuration: the options a project applies to every render. Resolved to an
  // attribute map (soft-defaults, so a document header still wins) plus the extra project-relative font
  // directories to append to the PDF font search path.
  const projectRenderAttributes = useMemo(() => {
    const resolved = resolveRenderAttributes(renderConfig);
    // The project's own "Language" setting (which drives the editor spell checker) is ALSO the render
    // `lang` here, so the PDF/HTML output localizes to it — one language control, not two. Soft-
    // defaulted (`@`) and seeded first so a document `:lang:` header still overrides it.
    const configured =
      projectLanguage === null || projectLanguage === ''
        ? resolved.attributes
        : { lang: `${projectLanguage}${SOFT_DEFAULT_SUFFIX}`, ...resolved.attributes };
    // Then the app's own render defaults UNDERNEATH all of it (`icons=font`, so admonitions get icons
    // in every project and not just in one whose header declares `:icons:`). This is the single seam
    // every real render passes through — the HTML preview and export take this map as
    // `projectAttributes`, the PDF preview and export take it as the snapshot's attribute seed — so
    // the four of them cannot disagree about it. See render-app-defaults.ts for why it lives here.
    return { ...resolved, attributes: withAppRenderDefaults(configured) };
  }, [renderConfig, projectLanguage]);

  // The render root's own resolved attributes (it inherits none), layered OVER the project render-config
  // defaults so the exported PDF and the on-screen preview share one seed and a document header still
  // overrides a project default. The empty-map shortcut below preserves the base map identity when
  // there is nothing to layer; it no longer fires in practice, since the app render defaults
  // (`withAppRenderDefaults`) always contribute at least one entry.
  const baseExportAttributes =
    exportRootFileId && projectIndex ? resolvedScopeOf(exportRootFileId) : NO_EXPORT_ATTRIBUTES;
  const exportAttributes = useMemo<ReadonlyMap<string, string>>(() => {
    const projectAttributes = projectRenderAttributes.attributes;
    if (Object.keys(projectAttributes).length === 0) return baseExportAttributes;
    const merged = new Map<string, string>(Object.entries(projectAttributes));
    for (const [name, value] of baseExportAttributes) merged.set(name, value);
    return merged;
  }, [projectRenderAttributes, baseExportAttributes]);

  // The live PREVIEW's render root diverges from the export root ONLY when the open file is outside the
  // main document's tree: then it is previewed as its own main document (root + attribute scope = the open
  // file), so the panel shows what is being edited instead of an unrelated document. Otherwise it mirrors
  // the export root (the configured main document). The export always uses the main root — never this.
  const { mainPath: previewSnapshotMainPath, rootFileId: previewRootFileId } = resolvePreviewRoot({
    outsideMainTree: openFileOutsideMainTree,
    mainPath: exportMainPath,
    mainRootFileId: exportRootFileId,
    openFileId: selectedFile?.nodeId ?? null,
  });
  const basePreviewAttributes =
    previewRootFileId && projectIndex ? resolvedScopeOf(previewRootFileId) : NO_EXPORT_ATTRIBUTES;
  const previewAttributes = useMemo<ReadonlyMap<string, string>>(() => {
    const projectAttributes = projectRenderAttributes.attributes;
    if (Object.keys(projectAttributes).length === 0) return basePreviewAttributes;
    const merged = new Map<string, string>(Object.entries(projectAttributes));
    for (const [name, value] of basePreviewAttributes) merged.set(name, value);
    return merged;
  }, [projectRenderAttributes, basePreviewAttributes]);

  // Per-project cache of fetched binary asset (image / custom-font) bytes. Images and fonts live
  // server-side and are reached over the authenticated image endpoint; their bytes are not in the
  // editor's text cache. The cache fetches them once each and feeds them into the render snapshot as
  // `kind: 'binary'` files so the engine embeds the picture instead of its not-found placeholder.
  const assetCache = useProjectAssetCache(projectId);
  const { getAssets, ensureAssets, loadAssets, assetsSettled, assetVersion } = assetCache;

  // The theme and `.bib` contents, which the include-graph cache above can never reach. Without this
  // the snapshot has no theme content, and theme DISCOVERY — which filters the snapshot's own text
  // paths — cannot even see the theme's path, so the export renders unthemed.
  const { getAuxiliaryFiles, auxiliaryVersion } = useProjectAuxiliaryTextCache(
    projectId,
    renameRefreshNonce,
    changedFileNodeId,
  );

  // Shared snapshot builder: the single seam that captures the editor's project state into an
  // immutable render snapshot. Both the one-click export and the live preview build from it so the
  // exported PDF and the on-screen preview render exactly the same document, given the same binary
  // records. Returns null until a render root path is known. This is light main-thread work (a map
  // over the text cache plus the sandbox guard); all heavy rendering happens off-thread in the worker.
  const buildSnapshot = useCallback(
    (
      binaryFiles: readonly SnapshotFile[],
      snapshotMainPath: string | null,
      snapshotAttributes: ReadonlyMap<string, string>,
    ): ProjectSnapshot | null => {
      if (exportOpenPath === null) return null;
      // Text project files (AsciiDoc, YAML theme, .bib) from the symbol index's content cache, plus the
      // fetched binary assets keyed by the SAME project-relative path the engine resolves them to (so
      // `image::` targets — including paths with spaces, e.g. `New Folder/x.png` — find their bytes).
      // Auxiliary files first so a path the editor is also holding live (an open theme) wins — the
      // preview must show what is on screen, not the last-fetched copy.
      const textFiles: SnapshotFile[] = Object.entries({
        ...getAuxiliaryFiles(),
        ...getProjectFiles(),
      }).map(([path, content]): SnapshotFile => ({ path, kind: 'text', content }));
      const { snapshot } = buildProjectSnapshot({
        files: [...textFiles, ...binaryFiles],
        mainPath: snapshotMainPath,
        openPath: exportOpenPath,
        attributes: snapshotAttributes,
        extraFontDirs: projectRenderAttributes.extraFontDirs,
        enabledExtensions: projectExtensionIds,
      });
      return snapshot;
    },
    [
      exportOpenPath,
      projectRenderAttributes,
      projectExtensionIds,
      getProjectFiles,
      getAuxiliaryFiles,
      auxiliaryVersion,
    ],
  );

  /**
   * Guarantee the render root's content is present before an export dispatches.
   *
   * Every export names the main document as its root, and every engine fails outright if that path
   * carries no content: the PDF engine reports "root document is missing from the project snapshot",
   * and the HTML render has nothing to assemble includes from. The symbol index fetches file content
   * asynchronously, so the root can be transiently absent even while `exportMainPath` is already known
   * and the button is enabled: at first load, or for a frame after a file-tree / content-changed SSE
   * event invalidates and refetches it (exactly the shape the E2E export test hit — a fresh project
   * whose main file was just created/configured). A memo-based button gate cannot close the SSE window
   * (the invalidation does not change `projectIndex`'s identity), so the click handler is
   * authoritative: if the root content is missing, force a rebuild and wait for it.
   *
   * If it still has not arrived the caller falls through deliberately: the engine then surfaces its
   * own specific, user-visible error rather than the click silently doing nothing.
   */
  const ensureRootLoaded = useCallback(async () => {
    const rootLoaded = (): boolean =>
      exportMainPath === null ||
      Object.prototype.hasOwnProperty.call(getProjectFiles(), exportMainPath);
    if (rootLoaded()) return;
    await refreshProjectIndex();
    await waitUntil(rootLoaded, {
      timeoutMs: EXPORT_ROOT_WAIT_TIMEOUT_MS,
      intervalMs: EXPORT_ROOT_WAIT_INTERVAL_MS,
    });
  }, [exportMainPath, getProjectFiles, refreshProjectIndex]);

  // One-click export: enumerate the referenced assets, AWAIT their bytes (so nothing renders as a
  // placeholder in the downloaded file), then build the snapshot with them and render.
  const handleExportPdf = useCallback(async () => {
    if (exportOpenPath === null) return;
    await ensureRootLoaded();

    const assetPaths = collectReferencedAssetPaths({ files: getProjectFiles(), attributes: exportAttributes });
    const binaryFiles = await loadAssets(assetPaths);
    // The export/download ALWAYS renders from the configured main document (root = exportMainPath, or the
    // open file when no main is configured) — never the preview's per-open-file root.
    const snapshot = buildSnapshot(binaryFiles, exportMainPath, exportAttributes);
    if (snapshot === null) return;
    exportPdf(snapshot);
  }, [exportOpenPath, getProjectFiles, exportAttributes, exportMainPath, loadAssets, buildSnapshot, exportPdf, ensureRootLoaded]);

  // ── Export to HTML ──────────────────────────────────────────────────────────────────────────
  // The same whole-document scope as the PDF export, rendered by the engine that already draws the
  // preview and saved as a real standalone page. Packaging, stylesheet and palette are project
  // settings so a team's exports are consistent; the stylesheet falls back to whichever one the
  // reader currently has the preview in, so an export with nothing configured matches what they see.
  const {
    exportHtml,
    isExporting: isExportingHtml,
    phase: htmlExportPhase,
    error: htmlExportError,
    failures: htmlExportFailures,
  } = useHtmlExport({ projectId });

  const handleExportHtml = useCallback(async () => {
    if (exportOpenPath === null) return;
    await ensureRootLoaded();
    const htmlExport = renderConfig.htmlExport;
    exportHtml({
      // The export always renders the configured main document — never the preview's per-open-file
      // root — so what is downloaded is the whole document, exactly as the PDF export does it.
      rootPath: exportMainPath ?? exportOpenPath,
      // The download is named after the project, not the root — see `exportFileName`.
      projectName,
      files: getProjectFiles(),
      projectAttributes: projectRenderAttributes.attributes,
      packaging: htmlExport?.packaging ?? DEFAULT_HTML_EXPORT_PACKAGING,
      style: htmlExport?.style ?? previewStyle,
      theme: htmlExport?.theme ?? DEFAULT_HTML_EXPORT_THEME,
    });
  }, [
    exportOpenPath,
    exportMainPath,
    ensureRootLoaded,
    getProjectFiles,
    projectName,
    projectRenderAttributes,
    renderConfig.htmlExport,
    previewStyle,
    exportHtml,
  ]);

  // ── Live PDF preview ─────────────────────────────────────────────────────────────────────────
  // The single preview panel switches between its HTML and PDF renderings via the header's segmented
  // control; the PDF is fed by the SAME snapshot builder as the export. Building the snapshot is gated
  // on the panel being open AND in PDF mode so no work is done otherwise, and recomputes on the same
  // signals that drive the outline: the open file's live edits (`liveOverlayContent`) and reachable-doc
  // changes (`reachableDocVersion`). A fresh snapshot identity is the hook's sole render trigger, and
  // the hook debounces + renders entirely in a worker, so the editor thread is never blocked.
  // `changedPaths` is intentionally omitted — the layout tracks no per-render path delta — so each
  // render repopulates the whole VFS.
  const [previewMode, setPreviewMode] = useState<'html' | 'pdf'>('html');
  // Whether the OPEN FILE is something the document preview can render.
  //
  // A theme is not: it is YAML, it has its own preview inside the theme editor, and rendering it as a
  // document produces a PDF of raw YAML text. Leaving the document preview active for it did exactly
  // that — and because the last successful render is retained, that page of YAML was then shown for a
  // few seconds the moment the author opened a real document, until the first real render landed.
  const openFilePreviewable = selectedFile !== null && isAsciiDocFile(selectedFile.nodeName);

  const pdfPreviewActive = previewOpen && previewMode === 'pdf' && openFilePreviewable;
  // Capture the project for a page-formatted render — deliberately as a FUNCTION the preview hook
  // calls when a render is actually due, not as a value computed here.
  //
  // The identity of this callback still changes on every edit signal, which is what schedules the
  // render; what it no longer does is DO the work on every edit signal. Capturing the snapshot copies
  // every project file and re-runs the sandbox guard over every path, and enumerating the referenced
  // assets scans all of them for image macros — both proportional to the size of the project, both
  // synchronous, and both previously recomputed on each keystroke to feed a render that happens at
  // most once a second. Behind the debounce they run once per render instead.
  //
  // The asset enumeration lives here rather than in its own effect for the same reason and for one
  // more: warming the cache from the state that is being captured keeps the two describing the same
  // document. Each arriving image bumps `assetVersion`, which re-schedules a render that then includes
  // the picture. The preview roots at previewSnapshotMainPath (the main document, or the open file
  // when it is outside the main tree) with the matching attribute scope — distinct from the export's
  // always-main root.
  const capturePreviewSnapshot = useCallback((): ProjectSnapshot | null => {
    const referencedAssets = collectReferencedAssetPaths({
      files: getProjectFiles(),
      attributes: previewAttributes,
    });
    ensureAssets(referencedAssets);
    // Nothing is rendered until the pictures this document asks for have been answered. Rendered
    // without them, the engine reports each one as "image to embed not found or not readable" — an
    // alarming warning about a file that is present and already on its way — and the whole
    // page-formatted render, seconds of it, is then done again the moment the bytes land. The fetch is
    // the cheaper of the two waits by a wide margin.
    //
    // This holds only the renders that reference an asset nobody has fetched yet, which in practice
    // means the first one after the panel opens. A cached asset settles instantly, so typing is
    // untouched. Every settlement — bytes or an empty answer — bumps `assetVersion`, which is what
    // brings the held render back.
    if (!assetsSettled(referencedAssets)) return null;
    return buildSnapshot(getAssets(), previewSnapshotMainPath, previewAttributes);
    // liveOverlayContent + reachableDocVersion are edit/content signals, and assetVersion is the
    // binary-arrival signal, that must refresh this callback's identity even though the functions it
    // calls are referentially stable across them (see the outline memo for the same repopulate
    // pattern) — the identity change is what schedules the next render.
  }, [buildSnapshot, getAssets, ensureAssets, assetsSettled, getProjectFiles, previewSnapshotMainPath, previewAttributes, liveOverlayContent, reachableDocVersion, assetVersion]);
  const {
    pdf: previewPdf,
    isRendering: isPreviewRendering,
    phase: previewPhase,
    diagnostics: previewDiagnostics,
    // The whole-render failure, as opposed to the per-resource diagnostics beside it. The panel is the
    // only place an author can learn that the live preview stopped and why — a refusal the engine
    // explains (a document past the supported size, say) is worth nothing if it is dropped here.
    error: previewError,
    sourceMap: previewSourceMap,
    stats: previewStats,
    // The snapshot the PDF on screen was rendered from. Everything derived from that render is keyed
    // to it rather than to the live buffer, which has moved on — see the scroll-sync memo below.
    renderedSnapshot: previewRenderedSnapshot,
  } = usePdfPreview({
    snapshot: pdfPreviewActive ? capturePreviewSnapshot : null,
    isEnabled: pdfPreviewActive,
    extensions: projectExtensionBundle,
  });

  // Source-line count of the live buffer, driving the PDF preview's proportional scroll-sync fallback
  // (used whenever the engine emitted no source map — the editor's line maps onto the same fraction of
  // the page stack).
  const liveContentLineCount = useMemo(() => liveContent.split('\n').length, [liveContent]);

  /**
   * Whether the open file's content is still on its way, so the preview can tell an empty buffer that
   * means "not here yet" from one that means "this file is empty".
   *
   * "Pending" is only ever a statement that something is STILL COMING, so each clause names the thing
   * that will deliver it. An earlier version asked the opposite question — "do we have content yet?" —
   * and answered yes-still-pending whenever we did not. That is indistinguishable from a load that
   * FAILED: on a content fetch that rejects, `useFileSelection` leaves `content: null` with an error
   * and no collab, so the answer stayed pending forever and the preview went on showing the previous
   * file's document, marked as catching up, beside an editor pane displaying the error. Permanently
   * wrong beats briefly blank, so a settled-with-no-content file must render as the empty document it
   * has turned out to be.
   *
   * Clause 1 — the REST path, pending exactly while its fetch is in flight.
   * Clause 2 — collaboration, whose document never comes through `content` at all: a collab file
   * arrives by the editor's own seeding, so it is pending until the session says it is synced (and
   * `editorPending` covers both the discovery hop before a binding exists and the offline fallback's
   * own fetch). Both end in a bounded time, which is what makes them safe to wait on.
   * Clause 3 — the same-commit guard. `liveOverlayContent` is computed DURING RENDER from the fetched
   * content, while the buffer handed to the preview (`liveContent`) is applied by an effect on that
   * same content — one commit later. Without it there is an in-between commit reporting "settled"
   * about a buffer that is still the reset-to-empty one, and the preview believes the file it just
   * opened is genuinely empty: it publishes a blank render and drops the flag that would have flushed
   * the real content on arrival. That commit and nothing else — once the user types the overlay IS
   * the buffer, and while the overlay is null the earlier clauses already answer.
   */
  const previewContentPending =
    (liveOverlayContent === null &&
      (contentState.isLoading ||
        editorPending ||
        (editorCollab !== null && editorConnectionState !== 'synced'))) ||
    (liveOverlayContent !== null && liveOverlayContent !== liveContent);

  // Accurate scroll-sync bridge: the engine's source map is keyed to the ASSEMBLED (include-expanded)
  // document the worker converts, but the editor's cursor line is in the OPEN file. Build the same
  // provenance map the include-resolve stage would (via the shared helper), gated on the PDF preview
  // being active with scroll-sync on and a source map present so no assembly cost is paid otherwise.
  //
  // Built from the snapshot the preview was RENDERED from, which is the only document the source map
  // beside it describes — and which changes once per completed render rather than once per keystroke.
  // Assembling the live buffer instead lined a fresh assembly up against an older render's
  // coordinates, and did the whole include expansion, plus a split of the assembled text into one
  // string per line, on every character typed.
  const assembledScrollContext = useMemo(() => {
    if (!pdfPreviewActive || !scrollSyncEnabled || previewRenderedSnapshot === undefined) return null;
    if (previewSourceMap === undefined || previewSourceMap.length === 0) return null;
    return buildAssembledScrollContext(previewRenderedSnapshot);
  }, [pdfPreviewActive, scrollSyncEnabled, previewRenderedSnapshot, previewSourceMap]);
  const assembledLineToSource = assembledScrollContext?.lineToSource ?? null;

  // Lift the engine source map to block visual-start lines (title/attribute lines above each delimiter),
  // the PDF-side twin of the HTML preview's data-source-line adjustment, so a click on a block's title
  // scrolls to that block instead of the previous one. Falls back to the raw map when no assembly context
  // is available (e.g. scroll-sync off) — the panel then uses the untouched engine coordinates.
  const adjustedSourceMap = useMemo(() => {
    if (previewSourceMap === undefined) return undefined;
    if (assembledScrollContext === null) return previewSourceMap;
    return liftSourceMapToBlockStarts(previewSourceMap, assembledScrollContext.assembledLines);
  }, [previewSourceMap, assembledScrollContext]);

  // Translate the editor's current scroll request (an open-file line) into the assembled-document line
  // the source map is keyed in. A fresh scrollRequest object recomputes this so the panel scrolls to the
  // exact rendered block; undefined when no mapping is available (the panel falls back to proportional).
  const assembledScrollLine = useMemo<number | undefined>(() => {
    if (assembledLineToSource === null || scrollRequest === null || previewOpenPath === undefined) {
      return undefined;
    }
    return openLineToAssembledLine(assembledLineToSource, previewOpenPath, scrollRequest.line);
  }, [assembledLineToSource, scrollRequest, previewOpenPath]);

  // Reveal a diagnostic's source location, reusing the file/line navigation seam: in-place when it
  // is the open file, otherwise switch to its file and reveal the line once the new editor mounts.
  const handleDiagnosticLocation = useCallback(
    (location: DiagnosticLocation) => {
      if (previewOpenPath === location.path) {
        revealLine(location.line ?? 1);
        return;
      }
      pendingXrefLine.current = location.line ?? null;
      handleNavigateToFile(location.path);
    },
    [previewOpenPath, revealLine, handleNavigateToFile, pendingXrefLine],
  );

  // Reveal the editor source of a block clicked in the HTML preview. The click carries the block's line in
  // the preview's OPEN-FILE-rooted assembled coordinates. With include bodies hidden every line is the open
  // file's own, so the line is used directly; with bodies shown, reverse-map through the open-file-rooted
  // provenance map so a click inside an included body jumps to that file. Reuses the diagnostic seam.
  const handlePreviewSourceNavigate = useCallback(
    (assembledLine: number) => {
      if (previewOpenPath === undefined) return;
      let target: DiagnosticLocation = { path: previewOpenPath, line: assembledLine };
      if (showIncludedFiles) {
        const files = getProjectFiles();
        const map = buildOpenFileLineToSource(previewOpenPath, (path: string) => files[path] ?? null, true);
        const entry = map?.[assembledLine - 1];
        if (entry) target = { path: entry.path, line: entry.sourceLine };
      }
      handleDiagnosticLocation(target);
    },
    [previewOpenPath, showIncludedFiles, getProjectFiles, handleDiagnosticLocation],
  );

  // Reveal the editor source of a block clicked in the PDF preview. The click resolves (best-effort) to a
  // line in the MAIN-rooted assembled document; reverse-map it through the same provenance map the PDF
  // scroll-sync uses to a source {file, line}. Built lazily here since clicks are rare, and from the
  // snapshot the page on screen was rendered from — the coordinate space the click is expressed in.
  const handlePdfSourceNavigate = useCallback(
    (assembledLine: number) => {
      if (previewRenderedSnapshot === undefined) return;
      const map = buildAssembledLineToSource(previewRenderedSnapshot);
      const entry = map?.[assembledLine - 1];
      if (entry) handleDiagnosticLocation({ path: entry.path, line: entry.sourceLine });
    },
    [previewRenderedSnapshot, handleDiagnosticLocation],
  );

  // Exact PDF click-to-source: the block carried its render-time origin, so jump straight to it — no
  // reverse mapping through the (possibly newer) buffer, so it can't drift to the wrong file/section.
  const handlePdfExactSourceNavigate = useCallback(
    (path: string, line: number) => {
      handleDiagnosticLocation({ path, line });
    },
    [handleDiagnosticLocation],
  );

  // Full-document outline (feature 032): assemble across include directives when a main file is
  // configured and the open file is reachable. `getProjectFiles()` overlays the open file's live
  // content (once its editor has produced it — see `liveOverlayContent`) so in-progress edits are
  // reflected. Depends on liveOverlayContent (open-file edit), previewOpenPath (open-file change),
  // and previewRootPath (main-file change).
  const assembledOutlineResult = useMemo(() => {
    if (!previewRootPath || !previewOpenPath || !selectedFile) return null;
    if (outlineScope === 'current') return null; // skip assembly when user wants current-file only
    // Skip assembly until the file tree is loaded enough to resolve file IDs. Without this guard,
    // fileIdForPath falls back to the path string, making isOpenFile comparisons always false and
    // routing every outline heading click through handleNavigateToFile instead of revealLine.
    if (!fileIdForPath(previewOpenPath)) return null;
    const files = getProjectFiles();
    return assembleOutline({
      rootPath: previewRootPath,
      openFilePath: previewOpenPath,
      openFileId: selectedFile.nodeId,
      readFile: (path: string) => files[path] ?? null,
      fileIdForPath: (path: string) => fileIdForPath(path) ?? path,
      scopePreference: 'full',
    });
    // `projectIndex` is included so a rebuild that asynchronously fetches a reachable file's content
    // (e.g. The included file's text arrives after a reload, or a collaborator's live edit lands)
    // re-runs this memo against the now-populated `getProjectFiles()` snapshot. Without it the memo
    // would keep the stale assembly because `getProjectFiles` is referentially stable.
  }, [previewRootPath, previewOpenPath, selectedFile, liveOverlayContent, getProjectFiles, fileIdForPath, projectIndex, reachableDocVersion, outlineScope]);

  // Resolve outline entries and effective scope: prefer the assembled full outline when available
  // (scope='full'), otherwise use the CM6 single-file entries (current scope).
  const outlineEntriesRaw: SectionOutlineEntry[] =
    assembledOutlineResult?.scope === 'full' ? assembledOutlineResult.entries : cmOutlineEntries;
  const outlineEffectiveScope: 'full' | 'current' =
    assembledOutlineResult?.scope === 'full' ? 'full' : 'current';

  // Keep the outline array identity STABLE when a rebuild produces a value-equal result. The assembled
  // outline is recomputed on every symbol-index rebuild (keystrokes, reachable-doc changes, a file
  // switch that doesn't alter the full document), each time yielding a fresh array; reusing the prior
  // reference when nothing changed stops the outline panel from re-rendering needlessly.
  const stableOutlineReference = useRef<SectionOutlineEntry[]>(outlineEntriesRaw);
  if (!sameOutlineEntries(stableOutlineReference.current, outlineEntriesRaw)) {
    stableOutlineReference.current = outlineEntriesRaw;
  }
  const outlineEntries = stableOutlineReference.current;

  // Peer cursor positions mapped to outline headings (feature 032).
  // Only peers with a numeric cursorLine contribute; others are ignored.
  const outlinePresence = useMemo(() => {
    const peersWithCursor = new Map<string, OutlinePeer[]>();
    for (const [fileId, peers] of presenceByFile) {
      const filtered = peers.filter((p): p is OutlinePeer => typeof p.cursorLine === 'number');
      if (filtered.length > 0) peersWithCursor.set(fileId, filtered);
    }
    return mapOutlinePresence(outlineEntries, peersWithCursor);
  }, [outlineEntries, presenceByFile]);

  // Outline navigation (feature 032): route by provenance.
  // - Open-file entries (no provenance OR isOpenFile=true) → reveal in the open editor.
  // - Foreign-file entries (isOpenFile=false with a sourcePath) → switch to that file and reveal
  //   the source line once the new editor mounts (reuses the xref pending-line seam).
  const handleOutlineHeadingClick = useCallback(
    (entry: SectionOutlineEntry) => {
      if (entry.isOpenFile === false && entry.sourcePath) {
        pendingXrefLine.current = entry.sourceLine ?? null;
        handleNavigateToFile(entry.sourcePath);
        return;
      }
      const targetLine = entry.sourceLine ?? entry.line;
      revealLine(targetLine);
      if (previewOpen && !scrollSyncEnabled) handleLineClick(targetLine);
    },
    [revealLine, handleLineClick, handleNavigateToFile, pendingXrefLine, previewOpen, scrollSyncEnabled],
  );

  // Project-wide search result activation: reveal in place when the match is in the open file,
  // otherwise switch to its file and reveal the match line once the new editor mounts (reuses the
  // same pending-line seam as xref/outline navigation).
  const handleSearchResultNavigate = useCallback(
    (target: SearchResultTarget) => {
      if (selectedFile?.nodeId === target.fileNodeId) {
        revealLine(target.line);
        if (previewOpen && !scrollSyncEnabled) handleLineClick(target.line);
        return;
      }
      pendingXrefLine.current = target.line;
      handleNavigateToFile(target.path);
    },
    [selectedFile, revealLine, handleLineClick, handleNavigateToFile, pendingXrefLine, previewOpen, scrollSyncEnabled],
  );

  const showPreview = openFilePreviewable;

  return (
    // The editor is full-bleed: it cancels the dashboard <main>'s `p-6` with a negative margin and adds
    // that padding back to its height so the rail, editor, and preview reach every edge of the viewport.
    // COUPLED to `<main className="…p-6">` in `(dashboard)/layout.tsx`: `-m-6` cancels its padding and
    // `3rem` re-adds the top+bottom (2 × the 1.5rem `p-6`). If that padding changes, update BOTH here.
    <div className="flex flex-col h-[calc(100%+3rem)] -m-6">
      {/* Header */}
      <div className="flex items-center gap-3 h-14 px-3 border-b shrink-0">
        <BackButton href="/dashboard" label="Back to projects" />
        <LogoMark className="h-5 w-5 text-primary shrink-0" />
        <div className="min-w-0 flex flex-col">
          <span className="font-semibold text-sm truncate">{projectName}</span>
          {projectDescription && (
            <span className="text-xs text-muted-foreground truncate">{projectDescription}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <NonLiveIndicator active={nonLive} />
          <PdfExportButton
            onExport={handleExportPdf}
            isExporting={isExportingPdf}
            phase={exportPhase}
            disabled={exportOpenPath === null || !exportConfigurationReady}
          />
          {/* The HTML export needs the render config (its packaging/style/theme live there) but not the
              PDF extension bundle, which only the PDF engine runs — so it unlocks a beat earlier. */}
          <HtmlExportButton
            onExport={handleExportHtml}
            isExporting={isExportingHtml}
            phase={htmlExportPhase}
            disabled={exportOpenPath === null || renderConfigLoading}
          />
          {canManage && (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href={`/dashboard/projects/${projectId}/settings`}>
                  <Settings className="mr-2 h-4 w-4" />
                  Settings
                </Link>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link href={`/dashboard/projects/${projectId}/members`}>
                  <Users className="mr-2 h-4 w-4" />
                  Members
                </Link>
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Reattach hint: while a detached item awaits a new passage, prompt for a selection. */}
      {reattachItemId && (
        <div className="flex items-center gap-3 border-b bg-primary/10 px-3 py-1.5 text-xs text-foreground shrink-0" role="status">
          <span>Select the new passage in the editor, then choose <strong>Comment</strong> to reattach.</span>
          <button
            type="button"
            className="ml-auto rounded px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setReattachItemId(null)}
          >
            Cancel
          </button>
        </div>
      )}

      {/* PDF export outcome: a fatal failure alert and/or the non-fatal per-resource diagnostics
          (the export still succeeded). Both surface below the header and clear on the next export. */}
      {exportError && (
        <div role="alert" className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {`Export to PDF failed: ${exportError.message}`}
        </div>
      )}
      {exportDiagnostics.length > 0 && (
        <div className="shrink-0 border-b px-3 py-2">
          <PdfDiagnostics diagnostics={exportDiagnostics} onSelectLocation={handleDiagnosticLocation} />
        </div>
      )}

      {/* HTML export outcome, on the same terms: a fatal failure, and — separately — the images that
          could not be retrieved. The second is not a failure: the file downloaded, but those pictures
          are missing from it, which the author can only know if we say so. */}
      {htmlExportError && (
        <div role="alert" className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {`Export to HTML failed: ${htmlExportError}`}
        </div>
      )}
      {htmlExportFailures.length > 0 && (
        <div role="status" className="shrink-0 border-b px-3 py-2 text-sm text-muted-foreground">
          {`${htmlExportFailures.length} image${htmlExportFailures.length === 1 ? '' : 's'} could not be included in the exported HTML: ${htmlExportFailures
            .map((failure) => failure.source)
            .join(', ')}`}
        </div>
      )}

      {/* Body: sidebar + content + preview */}
      <div className="flex flex-1 overflow-hidden">
        {/* File tree panel — resizable via the divider on its right edge. Always rendered: collapsing
            hides the body and leaves the rail, so the panel shrinks to the rail's width rather than
            disappearing behind an anonymous chevron strip. */}
        <div
          data-testid="file-tree-panel"
          style={sidebarOpen ? { width: sidebarResize.width } : undefined}
          className="shrink-0 overflow-hidden"
        >
          <LeftPanel
            activeTab={leftPanelTab}
            onTabChange={setLeftPanelTab}
            collapsed={!sidebarOpen}
            onCollapse={() => setSidebarOpen(false)}
            onExpand={() => setSidebarOpen(true)}
            filesSlot={
              <FileTree
                projectId={projectId}
                canEdit={canModifyFiles}
                onSelectFile={handleSelectFile}
                selectedNodeId={selectedFile?.nodeId ?? null}
                presenceByFile={presenceByFile}
                openPathRequest={openPathRequest}
                // Only on a genuine first open (nothing remembered) — never override a restored selection.
                autoSelectNodeId={isFirstOpen ? mainFileNodeId : null}
              />
            }
            outlineSlot={
              <OutlineView
                entries={outlineEntries}
                currentLine={currentLine}
                hasDocument={selectedFile !== null && isAsciiDocFile(selectedFile.nodeName)}
                onHeadingClick={handleOutlineHeadingClick}
                effectiveScope={outlineEffectiveScope}
                outlineScope={previewRootPath ? outlineScope : undefined}
                onScopeChange={previewRootPath ? setOutlineScope : undefined}
                outlinePresence={outlinePresence}
              />
            }
            searchSlot={<SearchView projectId={projectId} onNavigate={handleSearchResultNavigate} />}
          />
        </div>
        {sidebarOpen && (
          <ResizeHandle
            ariaLabel="Resize file tree"
            onPointerDown={sidebarResize.onPointerDown}
            onKeyDown={sidebarResize.onKeyDown}
            isResizing={sidebarResize.isResizing}
          />
        )}

        {/* Editor + Preview + Comments panels. The editor's ContentArea stays mounted in ONE
            stable Panel regardless of previewOpen/commentsPanelOpen — only the preview and comments
            Panels + their resize handles mount/unmount — so toggling either never remounts
            CodeMirror and never loses editor content/cursor/scroll. The whole region is wrapped in
            the review view-state provider so the rail and editor share hover/active linkage. */}
        <ReviewViewStateProvider>
        <PanelGroup direction="horizontal" className="flex-1 overflow-hidden">
          <Panel
            id="editor-content"
            order={1}
            defaultSize={showPreview && previewOpen ? 50 : 100}
            minSize={20}
            className="overflow-hidden flex flex-col"
            data-testid="content-panel"
          >
            <ContentArea
              selectedFile={selectedFile}
              contentState={contentState}
              canEdit={editorCanEdit}
              canManageDictionary={canManageDictionary}
              canConfigureRules={canEdit}
              projectId={projectId}
              onGrammarStateChange={setGrammarState}
              assetCache={assetCache}
              projectLanguage={projectLanguage}
              onScrollLine={previewOpen && scrollSyncEnabled ? handleScrollLine : undefined}
              onSelectionLine={previewOpen && scrollSyncEnabled ? handleScrollLine : undefined}
              onLineClick={previewOpen ? handleLineClick : undefined}
              onNavigateToFile={handleNavigateToFile}
              onNavigateToXref={handleNavigateToXref}
              inheritedOffset={editorInheritedOffset}
              inheritedAttributes={editorInheritedAttributes}
              resolvedScope={editorResolvedScope}
              renameRefreshNonce={renameRefreshNonce}
              revealRequest={revealRequest}
              onOpenUrl={handleOpenUrl}
              onChange={handleChange}
              initialLine={initialLine}
              onCursorLineChange={(line) => { setCurrentLine(line); handleCursorLineChange(line); }}
              onOutlineChange={setOutlineEntries}
              collab={editorCollab}
              collabPending={editorPending}
              connectionState={editorConnectionState}
              contentOverride={editorContentOverride}
              collabUnavailable={collabUnavailable}
              getProjectIndex={getProjectIndex}
              onGoToSymbol={() => setGoToSymbolOpen(true)}
              onRefactor={openRefactor}
              reviewRanges={commentsAvailable ? reviewItems.ranges : undefined}
              // Hovering a rail card transiently emphasizes its passage; a click-selected thread keeps
              // the emphasis when nothing is hovered. Emphasis never scrolls.
              activeReviewId={commentsAvailable ? (hoveredItemId ?? activeThreadId) : null}
              // Only an explicit navigation (click / prev-next / marker) scrolls to + flashes the passage.
              scrollToReviewId={commentsAvailable ? activeThreadId : null}
              onReviewMarkerClick={commentsAvailable ? handleReviewMarkerClick : undefined}
              onReviewMarkerHover={commentsAvailable ? setHoveredItemId : undefined}
              onCreateCommentFromSelection={commentsAvailable ? handleCreateCommentFromSelection : undefined}
            />
          </Panel>
          {showPreview && previewOpen && (
            <>
              <PanelResizeHandle className="group relative z-10 -mx-[3px] flex w-[7px] shrink-0 cursor-col-resize items-stretch justify-center outline-none">
                <span className="w-px bg-border transition-colors group-hover:bg-primary/60 group-data-[resize-handle-state=drag]:bg-primary" />
              </PanelResizeHandle>
              <Panel id="editor-preview" order={2} defaultSize={50} minSize={20} className="overflow-hidden" data-testid="preview-panel">
                {previewMode === 'html' ? (
                  // Deliberately NOT keyed on the open file. A key here remounted the whole panel on
                  // every file switch, which threw away its render engine and reset it to a state that
                  // reads as "nothing to preview" — so each switch cost an engine start-up and flashed
                  // "preview not available" at a file that previews perfectly well. The panel tracks
                  // the open file through its props instead, and keeps its engine across the switch.
                  <AsciiDocPreview
                    content={liveContent}
                    // The live buffer is reset to '' the instant the selection changes, and stays that
                    // way until the newly opened file's content arrives. Only this side knows which of
                    // those an empty buffer is, so it says so rather than leaving the panel to guess.
                    contentPending={previewContentPending}
                    isEnabled={previewOpen}
                    projectId={projectId}
                    mainPath={previewMainPath}
                    getFiles={getProjectFiles}
                    filesVersion={reachableDocVersion}
                    projectAttributes={projectRenderAttributes.attributes}
                    // Outside the main tree, resolve the open file standalone (its own attribute scope),
                    // not against the unrelated main document's include-point.
                    rootFilePath={openFileOutsideMainTree ? null : previewRootPath}
                    openFilePath={previewOpenPath}
                    outsideMainTree={openFileOutsideMainTree}
                    scrollToLine={scrollRequest}
                    onCollapse={togglePreview}
                    scrollSyncEnabled={scrollSyncEnabled}
                    onToggleScrollSync={() => setScrollSyncEnabled(!scrollSyncEnabled)}
                    previewStyle={previewStyle}
                    onPreviewStyleChange={setPreviewStyle}
                    showIncludedFiles={showIncludedFiles}
                    onOpenInclude={handleNavigateToFile}
                    onNavigateToSource={handlePreviewSourceNavigate}
                    onShowIncludedFilesChange={setShowIncludedFiles}
                    previewMode={previewMode}
                    onPreviewModeChange={setPreviewMode}
                  />
                ) : (
                  <PdfPreviewPanel
                    pdf={previewPdf ?? null}
                    isRendering={isPreviewRendering}
                    phase={previewPhase}
                    diagnostics={previewDiagnostics}
                    error={previewError}
                    stats={previewStats}
                    onSelectLocation={handleDiagnosticLocation}
                    onNavigateToSource={handlePdfSourceNavigate}
                    onNavigateToExactSource={handlePdfExactSourceNavigate}
                    previewMode={previewMode}
                    onPreviewModeChange={setPreviewMode}
                    // The open file always contributes to the rendered document — it is either the render
                    // root (out-of-tree files preview standalone; see openFileOutsideMainTree) or an
                    // included child of the main document — so its lines always have a rendered position
                    // (exact via the source map, else the proportional fallback) to scroll to.
                    scrollToLine={scrollRequest}
                    sourceMap={adjustedSourceMap}
                    assembledLine={assembledScrollLine}
                    totalLines={liveContentLineCount}
                    outsideMainTree={openFileOutsideMainTree}
                    scrollSyncEnabled={scrollSyncEnabled}
                    onToggleScrollSync={() => setScrollSyncEnabled(!scrollSyncEnabled)}
                    onCollapse={togglePreview}
                    className="h-full rounded-none border-0"
                  />
                )}
              </Panel>
            </>
          )}
          {/* Collapsed preview: a plain strip standing in for the preview panel, so it keeps the
              preview's PLACE in the row — between the editor and the right panel. Rendered inside
              the group for that reason: the right panel is a member of this group, so anything
              placed after the group would sit beyond its rail instead of before it. */}
          {showPreview && !previewOpen && (
            <Button
              data-testid="preview-panel"
              variant="ghost"
              size="icon"
              aria-label="expand preview"
              className="w-6 h-full shrink-0 border-l rounded-none"
              onClick={togglePreview}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
          {rightPanelAvailable && commentsPanelOpen && (
            <>
              <PanelResizeHandle className="group relative z-10 -mx-[3px] flex w-[7px] shrink-0 cursor-col-resize items-stretch justify-center outline-none">
                <span className="w-px bg-border transition-colors group-hover:bg-primary/60 group-data-[resize-handle-state=drag]:bg-primary" />
              </PanelResizeHandle>
              <Panel
                id="editor-comments"
                order={3}
                // Wider than the pre-rail panel was: the view rail now takes a fixed ~46px out of
                // the panel, and at the old default the control row's tab labels wrapped onto two
                // lines. The min is raised for the same reason.
                defaultSize={30}
                minSize={22}
                maxSize={40}
                collapsible
                className="flex flex-col overflow-hidden"
                data-testid="comments-panel"
              >
                <RightPanel
                  activeTab={rightPanelTab}
                  onTabChange={setRightPanelTab}
                  onCollapse={() => setCommentsPanelOpen(false)}
                  commentCount={openCount}
                  writingCount={grammarState?.diagnostics.length}
                  writingSlot={
                    <WritingPanelView view={grammarView} onViewChange={setGrammarView} grammar={grammarState} />
                  }
                  commentsSlot={
                    editorCollab === null ? (
                      <p className="p-3 text-xs text-muted-foreground">
                        Comments need a live connection to this document. Reload once the collaboration
                        service is reachable.
                      </p>
                    ) : (
                    <CommentsPanelView
                      view={commentsView}
                      onViewChange={setCommentsView}
                      canStepThreads={threadIdsInOrder.length > 0}
                      onStepThread={stepActiveThread}
                      projectId={projectId}
                      documentId={editorCollab.documentId}
                      ydoc={editorCollab.doc}
                      role={editorCollab.role}
                      currentUserId={userId}
                      isProjectOwner={isProjectOwner}
                      enabled={commentsAvailable}
                      members={members}
                      pendingAnchor={pendingAnchor}
                      onPendingResolved={() => setPendingAnchor(null)}
                      hoveredItemId={hoveredItemId}
                      setHoveredItemId={setHoveredItemId}
                      activeThreadId={activeThreadId}
                      setActiveThreadId={setActiveThreadId}
                      onReattach={(itemId) => { setCommentsPanelOpen(true); setReattachItemId(itemId); }}
                      onMutated={reviewItems.refetch}
                      onNavigateToItem={handleNavigateToReviewItem}
                    />
                    )
                  }
                />
              </Panel>
            </>
          )}
        </PanelGroup>
        </ReviewViewStateProvider>
        {/* Collapsed right panel: the rail stays on screen, exactly as the file tree's does, so the
            open-comment and writing-issue counts remain visible and either view is one click away.
            It is the right-most element because the panel it restores is the right-most panel. */}
        {rightPanelAvailable && !commentsPanelOpen && (
          <RightPanelRail
            activeTab={rightPanelTab}
            onTabChange={setRightPanelTab}
            collapsed
            onExpand={() => setCommentsPanelOpen(true)}
            commentCount={openCount}
            writingCount={grammarState?.diagnostics.length}
          />
        )}
      </div>
      <EditorGoToSymbol
        open={goToSymbolOpen}
        symbols={projectIndex?.symbols ?? []}
        pathOf={symbolPathOf}
        onSelect={handleSelectSymbol}
        onClose={() => setGoToSymbolOpen(false)}
      />
      <EditorSymbolRefactor
        open={refactorOpen}
        projectId={projectId}
        canEdit={canEdit}
        initial={refactorInitial}
        findUsages={findSymbolUsages}
        renameSymbol={renameSymbol}
        onNavigate={handleNavigateToUsage}
        onRenamed={handleSymbolRenamed}
        onClose={() => setRefactorOpen(false)}
      />
    </div>
  );
}
