'use client';
import { useLayoutEffect, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Settings, Users } from 'lucide-react';
import type { CreateAnchorInput, ReviewItemDto } from '@asciidocollab/shared';
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { BackButton } from '@/components/back-button';
import { LogoMark } from '@/components/logo';
import { FileTree } from '@/components/file-tree/file-tree';
import { AsciiDocEditor } from '@/components/editor/asciidoc-editor';
import { useProjectSymbolIndex } from '@/hooks/use-project-symbol-index';
import { useFileTreeEvents } from '@/hooks/use-file-tree-events';
import type { ProjectSymbolIndex } from '@/lib/codemirror/asciidoc-symbol-index';
import { AsciiDocPreview, isAsciiDocFile } from '@/components/asciidoc-preview';
import { ImagePreview } from '@/components/image-preview';
import { isImageFile } from '@/lib/codemirror/asciidoc-image-extensions';
import { useFileSelection } from '@/hooks/use-file-selection';
import { useFileHistory } from '@/hooks/use-file-history';
import { useEditorPreferences } from '@/hooks/use-editor-preferences';
import { type ConnectionState } from '@/hooks/use-collab-document';

import { LeftPanel } from '@/components/editor/left-panel';
import { OutlineView } from '@/components/editor/outline-view';
import { SearchView, type SearchResultTarget } from '@/components/editor/search-view';
import { NonLiveIndicator } from '@/components/editor/non-live-indicator';
import type { SectionOutlineEntry } from '@/lib/codemirror/asciidoc-outline';
import { assembleOutline, mapOutlinePresence } from '@/lib/outline';
import {
  buildAssembledScrollContext,
  liftSourceMapToBlockStarts,
  openLineToAssembledLine,
} from '@/lib/pdf/scroll-sync-map';
import { sameOutlineEntries } from '@/lib/outline/stable-entries';
import type { OutlinePeer } from '@/lib/outline';
import type { SelectedFile, FileContentState } from '@/hooks/use-file-selection';
import type { CollabBinding } from '@/components/editor/asciidoc-editor';
import { CommentRail, TaskPanel, ReviewToggle, ReviewViewStateProvider } from '@/components/review';
import { cn } from '@/lib/utilities';
import type { TaskMember } from '@/components/review';
import { useReviewItems } from '@/hooks/use-review-items';
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
import { PdfExportButton } from '@/components/pdf-export-button';
import { PdfDiagnostics } from '@/components/pdf-diagnostics';
import { PdfPreviewPanel } from '@/components/pdf-preview-panel';
import { usePdfExport } from '@/hooks/use-pdf-export';
import { usePdfPreview } from '@/hooks/use-pdf-preview';
import { buildProjectSnapshot, type SnapshotFile } from '@/lib/pdf/build-project-snapshot';
import { collectReferencedAssetPaths } from '@/lib/pdf/collect-referenced-assets';
import { useProjectAssetCache } from '@/hooks/use-project-asset-cache';
import { useProjectRenderConfig } from '@/hooks/use-project-render-config';
import { resolveRenderAttributes, SOFT_DEFAULT_SUFFIX } from '@asciidocollab/shared';
import type { ProjectSnapshot, RenderDiagnostic } from '@asciidocollab/asciidoc-pdf';

/** A diagnostic source location the editor can reveal. */
type DiagnosticLocation = NonNullable<RenderDiagnostic['location']>;

/** Stable empty attribute seed used when no render root is resolved yet (keeps identity stable). */
const NO_EXPORT_ATTRIBUTES: ReadonlyMap<string, string> = new Map();

/** Stable empty asset-path list used while the PDF preview is inactive (keeps memo identity stable). */
const NO_ASSET_PATHS: readonly string[] = [];

interface ContentAreaProperties {
  selectedFile: SelectedFile | null;
  contentState: FileContentState;
  canEdit: boolean;
  projectId: string;
  /** Project document language (ISO 639-1) driving the spellchecker, or null when unset. */
  projectLanguage: string | null;
  onScrollLine?: (line: number) => void;
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
  projectId,
  projectLanguage,
  onScrollLine,
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
}: ContentAreaProperties) {
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
  return (
    <AsciiDocEditor
      key={selectedFile.nodeId}
      content={contentOverride ?? contentState.content ?? ''}
      canEdit={canEdit}
      projectId={projectId}
      fileNodeId={selectedFile.nodeId}
      initialEtag={contentState.etag}
      isAsciiDoc={isAsciiDocFile(selectedFile.nodeName)}
      spellcheckLanguage={projectLanguage}
      onScrollLine={onScrollLine}
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
  userId,
}: ProjectEditorLayoutProperties) {
  const { selectedFile, contentState, selectFile, clearSelection } = useFileSelection(projectId);

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
  const { scrollSyncEnabled, setScrollSyncEnabled, previewStyle, setPreviewStyle, leftPanelTab, setLeftPanelTab, showIncludedFiles, setShowIncludedFiles, outlineScope, setOutlineScope, commentsPanelOpen, setCommentsPanelOpen } = useEditorPreferences();

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
  useFileTreeEvents(projectId, {
    onContentChanged: () => setRenameRefreshNonce((nonce) => nonce + 1),
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
  const [commentsView, setCommentsView] = useState<'threads' | 'tasks'>('threads');
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

  // Open (unresolved) roots in document order, for the count badge + sequential navigation.
  const openThreadIdsInOrder = useMemo(() => {
    const fromById = new Map(reviewItems.ranges.map((range) => [range.id, range.from]));
    return reviewItems.threads
      .filter((thread) => !thread.root.resolvedAt)
      .map((thread) => thread.root.id)
      .toSorted((a, b) => (fromById.get(a) ?? Number.POSITIVE_INFINITY) - (fromById.get(b) ?? Number.POSITIVE_INFINITY));
  }, [reviewItems.threads, reviewItems.ranges]);
  const openCount = openThreadIdsInOrder.length;

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

  // Step the focused thread through the open threads in document order (sequential navigation).
  const stepActiveThread = useCallback((delta: number) => {
    if (openThreadIdsInOrder.length === 0) return;
    const current = activeThreadId ? openThreadIdsInOrder.indexOf(activeThreadId) : -1;
    const nextIndex = current === -1
      ? (delta > 0 ? 0 : openThreadIdsInOrder.length - 1)
      : (current + delta + openThreadIdsInOrder.length) % openThreadIdsInOrder.length;
    setActiveThreadId(openThreadIdsInOrder[nextIndex]);
  }, [openThreadIdsInOrder, activeThreadId]);

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

  // ── Export to PDF ──────────────────────────────────────────────────────────────────────────
  // Fully client-side one-click export. The render root mirrors the symbol-index root: the
  // configured main file, else the open file. Both are resolved to project-relative paths; the
  // control is disabled until a root path is known.
  const { exportPdf, isExporting: isExportingPdf, phase: exportPhase, error: exportError, diagnostics: exportDiagnostics } = usePdfExport();
  const exportRootFileId = mainFile ?? selectedFile?.nodeId ?? null;
  const exportMainPath = mainFile && projectIndex ? projectIndex.pathOf(mainFile) : null;
  const exportOpenPath =
    (selectedFile && projectIndex ? projectIndex.pathOf(selectedFile.nodeId) : null) ?? exportMainPath;
  // Project-level render configuration: the options a project applies to every render. Resolved to an
  // attribute map (soft-defaults, so a document header still wins) plus the extra project-relative font
  // directories to append to the PDF font search path.
  const { config: renderConfig } = useProjectRenderConfig(projectId);
  const projectRenderAttributes = useMemo(() => {
    const resolved = resolveRenderAttributes(renderConfig);
    // The project's own "Language" setting (which drives the editor spell checker) is ALSO the render
    // `lang` here, so the PDF/HTML output localizes to it — one language control, not two. Soft-
    // defaulted (`@`) and seeded first so a document `:lang:` header still overrides it.
    if (projectLanguage === null || projectLanguage === '') return resolved;
    return {
      ...resolved,
      attributes: { lang: `${projectLanguage}${SOFT_DEFAULT_SUFFIX}`, ...resolved.attributes },
    };
  }, [renderConfig, projectLanguage]);

  // The render root's own resolved attributes (it inherits none), layered OVER the project render-config
  // defaults so the exported PDF and the on-screen preview share one seed and a document header still
  // overrides a project default. An empty project config preserves the base map identity (no churn).
  const baseExportAttributes =
    exportRootFileId && projectIndex ? resolvedScopeOf(exportRootFileId) : NO_EXPORT_ATTRIBUTES;
  const exportAttributes = useMemo<ReadonlyMap<string, string>>(() => {
    const projectAttributes = projectRenderAttributes.attributes;
    if (Object.keys(projectAttributes).length === 0) return baseExportAttributes;
    const merged = new Map<string, string>(Object.entries(projectAttributes));
    for (const [name, value] of baseExportAttributes) merged.set(name, value);
    return merged;
  }, [projectRenderAttributes, baseExportAttributes]);

  // Per-project cache of fetched binary asset (image / custom-font) bytes. Images and fonts live
  // server-side and are reached over the authenticated image endpoint; their bytes are not in the
  // editor's text cache. The cache fetches them once each and feeds them into the render snapshot as
  // `kind: 'binary'` files so the engine embeds the picture instead of its not-found placeholder.
  const { getAssets, ensureAssets, loadAssets, assetVersion } = useProjectAssetCache(projectId);

  // Shared snapshot builder: the single seam that captures the editor's project state into an
  // immutable render snapshot. Both the one-click export and the live preview build from it so the
  // exported PDF and the on-screen preview render exactly the same document, given the same binary
  // records. Returns null until a render root path is known. This is light main-thread work (a map
  // over the text cache plus the sandbox guard); all heavy rendering happens off-thread in the worker.
  const buildSnapshot = useCallback(
    (binaryFiles: readonly SnapshotFile[]): ProjectSnapshot | null => {
      if (exportOpenPath === null) return null;
      // Text project files (AsciiDoc, YAML theme, .bib) from the symbol index's content cache, plus the
      // fetched binary assets keyed by the SAME project-relative path the engine resolves them to (so
      // `image::` targets — including paths with spaces, e.g. `New Folder/x.png` — find their bytes).
      const textFiles: SnapshotFile[] = Object.entries(getProjectFiles()).map(
        ([path, content]): SnapshotFile => ({ path, kind: 'text', content }),
      );
      const { snapshot } = buildProjectSnapshot({
        files: [...textFiles, ...binaryFiles],
        mainPath: exportMainPath,
        openPath: exportOpenPath,
        attributes: exportAttributes,
        extraFontDirs: projectRenderAttributes.extraFontDirs,
      });
      return snapshot;
    },
    [exportOpenPath, exportMainPath, exportAttributes, projectRenderAttributes, getProjectFiles],
  );

  // One-click export: enumerate the referenced assets, AWAIT their bytes (so nothing renders as a
  // placeholder in the downloaded file), then build the snapshot with them and render.
  const handleExportPdf = useCallback(async () => {
    if (exportOpenPath === null) return;
    const assetPaths = collectReferencedAssetPaths({ files: getProjectFiles(), attributes: exportAttributes });
    const binaryFiles = await loadAssets(assetPaths);
    const snapshot = buildSnapshot(binaryFiles);
    if (snapshot === null) return;
    exportPdf(snapshot);
  }, [exportOpenPath, getProjectFiles, exportAttributes, loadAssets, buildSnapshot, exportPdf]);

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
  const pdfPreviewActive = previewOpen && previewMode === 'pdf';
  // The binary assets the live PDF preview references. Enumerated only while the preview is active
  // (a cheap macro scan), and recomputed on the same content signals as the snapshot so a
  // newly-referenced image is discovered as soon as it is typed.
  const previewAssetPaths = useMemo<readonly string[]>(
    () => (pdfPreviewActive ? collectReferencedAssetPaths({ files: getProjectFiles(), attributes: exportAttributes }) : NO_ASSET_PATHS),
    [pdfPreviewActive, getProjectFiles, exportAttributes, liveOverlayContent, reachableDocVersion],
  );
  // Warm the cache for the referenced assets off the render path; each arriving image bumps
  // assetVersion, which rebuilds the snapshot below so the picture appears on the next render.
  useEffect(() => {
    if (pdfPreviewActive) ensureAssets(previewAssetPaths);
  }, [pdfPreviewActive, previewAssetPaths, ensureAssets]);
  const previewSnapshot = useMemo<ProjectSnapshot | null>(
    () => (pdfPreviewActive ? buildSnapshot(getAssets()) : null),
    // liveOverlayContent + reachableDocVersion are edit/content signals, and assetVersion is the
    // binary-arrival signal, that must refresh the snapshot identity even though buildSnapshot/getAssets
    // are referentially stable across them (see the outline memo for the same repopulate pattern).
    [pdfPreviewActive, buildSnapshot, getAssets, liveOverlayContent, reachableDocVersion, assetVersion],
  );
  const {
    pdf: previewPdf,
    isRendering: isPreviewRendering,
    phase: previewPhase,
    diagnostics: previewDiagnostics,
    sourceMap: previewSourceMap,
  } = usePdfPreview({ snapshot: previewSnapshot, isEnabled: pdfPreviewActive });

  // Source-line count of the live buffer, driving the PDF preview's proportional scroll-sync fallback
  // (used whenever the engine emitted no source map — the editor's line maps onto the same fraction of
  // the page stack).
  const liveContentLineCount = useMemo(() => liveContent.split('\n').length, [liveContent]);

  // Accurate scroll-sync bridge: the engine's source map is keyed to the ASSEMBLED (include-expanded)
  // document the worker converts, but the editor's cursor line is in the OPEN file. Build the same
  // provenance map the include-resolve stage would (via the shared helper), gated on the PDF preview
  // being active with scroll-sync on and a source map present so no assembly cost is paid otherwise.
  // Recomputes on the snapshot identity that drives the render, so it tracks the current source map.
  const assembledScrollContext = useMemo(() => {
    if (!pdfPreviewActive || !scrollSyncEnabled || previewSnapshot === null) return null;
    if (previewSourceMap === undefined || previewSourceMap.length === 0) return null;
    return buildAssembledScrollContext(previewSnapshot);
  }, [pdfPreviewActive, scrollSyncEnabled, previewSnapshot, previewSourceMap]);
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

  const showPreview = selectedFile !== null && isAsciiDocFile(selectedFile.nodeName);

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
            disabled={exportOpenPath === null}
          />
          {commentsAvailable && (
            <div className="flex items-center gap-1">
              {commentsPanelOpen && openCount > 0 && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label="Previous comment"
                    onClick={() => stepActiveThread(-1)}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label="Next comment"
                    onClick={() => stepActiveThread(1)}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </>
              )}
              <ReviewToggle
                openCount={openCount}
                isOpen={commentsPanelOpen}
                onToggle={() => setCommentsPanelOpen(!commentsPanelOpen)}
              />
            </div>
          )}
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

      {/* Body: sidebar + content + preview */}
      <div className="flex flex-1 overflow-hidden">
        {/* File tree panel — resizable via the divider on its right edge. */}
        <div
          data-testid="file-tree-panel"
          style={sidebarOpen ? { width: sidebarResize.width } : undefined}
          className={sidebarOpen ? 'shrink-0 overflow-hidden' : 'hidden'}
        >
          <LeftPanel
            activeTab={leftPanelTab}
            onTabChange={setLeftPanelTab}
            onCollapse={() => setSidebarOpen(false)}
            filesSlot={
              <FileTree
                projectId={projectId}
                canEdit={canEdit}
                onSelectFile={handleSelectFile}
                selectedNodeId={selectedFile?.nodeId ?? null}
                presenceByFile={presenceByFile}
                openPathRequest={openPathRequest}
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

        {!sidebarOpen && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="expand sidebar"
            className="w-6 h-full shrink-0 border-r rounded-none"
            onClick={() => setSidebarOpen(true)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
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
              projectId={projectId}
              projectLanguage={projectLanguage}
              onScrollLine={previewOpen && scrollSyncEnabled ? handleScrollLine : undefined}
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
                  <AsciiDocPreview
                    key={selectedFile?.nodeId}
                    content={liveContent}
                    isEnabled={previewOpen}
                    projectId={projectId}
                    mainPath={previewMainPath}
                    getFiles={getProjectFiles}
                    filesVersion={reachableDocVersion}
                    projectAttributes={projectRenderAttributes.attributes}
                    rootFilePath={previewRootPath}
                    openFilePath={previewOpenPath}
                    scrollToLine={scrollRequest}
                    onCollapse={togglePreview}
                    scrollSyncEnabled={scrollSyncEnabled}
                    onToggleScrollSync={() => setScrollSyncEnabled(!scrollSyncEnabled)}
                    previewStyle={previewStyle}
                    onPreviewStyleChange={setPreviewStyle}
                    showIncludedFiles={showIncludedFiles}
                    onOpenInclude={handleNavigateToFile}
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
                    onSelectLocation={handleDiagnosticLocation}
                    previewMode={previewMode}
                    onPreviewModeChange={setPreviewMode}
                    scrollToLine={scrollRequest}
                    sourceMap={adjustedSourceMap}
                    assembledLine={assembledScrollLine}
                    totalLines={liveContentLineCount}
                    scrollSyncEnabled={scrollSyncEnabled}
                    onToggleScrollSync={() => setScrollSyncEnabled(!scrollSyncEnabled)}
                    onCollapse={togglePreview}
                    className="h-full rounded-none border-0"
                  />
                )}
              </Panel>
            </>
          )}
          {commentsAvailable && commentsPanelOpen && editorCollab && (
            <>
              <PanelResizeHandle className="group relative z-10 -mx-[3px] flex w-[7px] shrink-0 cursor-col-resize items-stretch justify-center outline-none">
                <span className="w-px bg-border transition-colors group-hover:bg-primary/60 group-data-[resize-handle-state=drag]:bg-primary" />
              </PanelResizeHandle>
              <Panel
                id="editor-comments"
                order={3}
                defaultSize={22}
                minSize={16}
                maxSize={32}
                collapsible
                className="flex flex-col overflow-hidden"
                data-testid="comments-panel"
              >
                <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1" role="tablist" aria-label="Comments view">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={commentsView === 'threads'}
                    data-testid="comments-view-threads"
                    onClick={() => setCommentsView('threads')}
                    className={cn(
                      'rounded px-2 py-0.5 text-xs font-medium transition-colors',
                      commentsView === 'threads' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    This file
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={commentsView === 'tasks'}
                    data-testid="comments-view-tasks"
                    onClick={() => setCommentsView('tasks')}
                    className={cn(
                      'rounded px-2 py-0.5 text-xs font-medium transition-colors',
                      commentsView === 'tasks' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    All comments &amp; tasks
                  </button>
                  {/* Collapse lives on the shared tab bar (like the left panel's rail) so it stays
                      available from both the per-file and cross-file views. */}
                  <button
                    type="button"
                    aria-label="collapse comments"
                    title="Collapse panel"
                    onClick={() => setCommentsPanelOpen(false)}
                    className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  {commentsView === 'threads' ? (
                    <CommentRail
                      projectId={projectId}
                      documentId={editorCollab.documentId}
                      ydoc={editorCollab.doc}
                      role={editorCollab.role}
                      currentUserId={userId}
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
                    />
                  ) : (
                    <TaskPanel
                      projectId={projectId}
                      currentUserId={userId}
                      isOwner={isProjectOwner}
                      readOnly={editorCollab.role === 'observer'}
                      enabled={commentsAvailable}
                      onNavigate={handleNavigateToReviewItem}
                    />
                  )}
                </div>
              </Panel>
            </>
          )}
        </PanelGroup>
        </ReviewViewStateProvider>
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
