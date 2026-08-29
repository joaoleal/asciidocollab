'use client';
import { useLayoutEffect, useState, useCallback, useMemo, useEffect } from 'react';
import Link from 'next/link';
import { ChevronLeft, Settings, Users } from 'lucide-react';
import type { CreateAnchorInput, ReviewItemDto } from '@asciidocollab/shared';
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { BackButton } from '@/components/back-button';
import { LogoMark } from '@/components/logo';
import { FileTree } from '@/components/file-tree/file-tree';
import { type EditorGrammarState } from '@/components/editor/asciidoc-editor';
import { useProjectSymbolIndex } from '@/hooks/use-project-symbol-index';
import { useFileTreeEvents } from '@/hooks/use-file-tree-events';
import { AsciiDocPreview, isAsciiDocFile } from '@/components/asciidoc-preview';
import { useFileSelection } from '@/hooks/use-file-selection';
import { useFileHistory } from '@/hooks/use-file-history';
import { useEditorPreferences } from '@/hooks/use-editor-preferences';
import { LeftPanel } from '@/components/editor/left-panel';
import { RightPanel } from '@/components/editor/right-panel';
import { RightPanelRail } from '@/components/editor/right-panel-rail';
import { OutlineView } from '@/components/editor/outline-view';
import { CommentsPanelView, type CommentsSubView } from '@/components/editor/comments-panel-view';
import { WritingPanelView, type WritingSubView } from '@/components/editor/writing-panel-view';
import { SearchView } from '@/components/editor/search-view';
import { NonLiveIndicator } from '@/components/editor/non-live-indicator';
import type { SectionOutlineEntry } from '@/lib/codemirror/asciidoc-outline';
import { ReviewViewStateProvider } from '@/components/review';
import type { TaskMember } from '@/components/review';
import { useReviewItems } from '@/hooks/use-review-items';
import { sortThreadsByDocumentOrder } from '@/lib/review/order';
import { reanchorReviewItem } from '@/lib/api/review';
import { membersApi } from '@/lib/api/members';
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
import { PdfPreviewPanel } from '@/components/pdf-preview-panel';
import { ContentArea } from './content-area';
import { useProjectGit } from './use-project-git';
import { useEditorRenderPipeline } from './use-editor-render-pipeline';
import { GitToolbar } from './git-toolbar';
import { GitDialogs } from './git-dialogs';
import { EditorStatusBanners } from './editor-status-banners';


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

  // All git-sync wiring: read-model subscriptions, mutation hooks and dialog state.
  const git = useProjectGit({ projectId, canEdit });
  const { statusByFileNodeId } = git;

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

  // The whole render pipeline for the open document: resolved editor scopes, PDF/HTML export, the
  // live HTML/PDF preview, click-to-source navigation and the assembled outline.
  const pipeline = useEditorRenderPipeline({
    projectId,
    projectName,
    projectLanguage,
    mainFile,
    selectedFile,
    contentState,
    projectIndex,
    getProjectFiles,
    resolvedScopeOf,
    refreshProjectIndex,
    fileIdForPath,
    reachableDocVersion,
    liveContent,
    liveOverlayContent,
    previewOpen,
    previewStyle,
    showIncludedFiles,
    scrollSyncEnabled,
    outlineScope,
    renameRefreshNonce,
    changedFileNodeId,
    cmOutlineEntries,
    presenceByFile,
    editorPending,
    editorCollab,
    editorConnectionState,
    scrollRequest,
    revealLine,
    handleNavigateToFile,
    handleLineClick,
    pendingXrefLine,
  });
  const {
    editorInheritedOffset,
    editorInheritedAttributes,
    editorResolvedScope,
    previewMainPath,
    previewRootPath,
    previewOpenPath,
    openFileOutsideMainTree,
    assetCache,
    ensureAssets,
    getAssetBytes,
    assetsSettled,
    assetVersion,
    projectRenderAttributes,
    printTheme,
    renderConfigLoading,
    exportConfigurationReady,
    exportOpenPath,
    isExportingPdf,
    exportPhase,
    handleExportPdf,
    isExportingHtml,
    htmlExportPhase,
    handleExportHtml,
    previewMode,
    setPreviewMode,
    showPreview,
    previewPdf,
    isPreviewRendering,
    previewPhase,
    previewDiagnostics,
    previewError,
    previewStats,
    liveContentLineCount,
    previewContentPending,
    adjustedSourceMap,
    assembledScrollLine,
    handleDiagnosticLocation,
    handlePreviewSourceNavigate,
    handlePdfSourceNavigate,
    handlePdfExactSourceNavigate,
    outlineEntries,
    outlineEffectiveScope,
    outlinePresence,
    handleOutlineHeadingClick,
    handleSearchResultNavigate,
  } = pipeline;

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
        <div className="ml-auto flex items-center gap-2 overflow-x-auto">
          <div className="flex items-center gap-2 shrink-0">
            <NonLiveIndicator active={nonLive} />
            <GitToolbar git={git} canEdit={canEdit} />
          </div>
          <div className="flex items-center gap-2 shrink-0 border-l pl-2">
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
          </div>
          {canManage && (
            <div className="flex items-center gap-2 shrink-0 border-l pl-2">
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
            </div>
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

      <EditorStatusBanners git={git} pipeline={pipeline} />

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
                statusByFileNodeId={statusByFileNodeId}
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
              // Blame keys on the OPEN file's own path, never the export root: `exportOpenPath`
              // falls back to the configured main file's path while the open file's own path is
              // still resolving, which would render the main file's authorship against the wrong
              // document. `selectedFile.path` is always the open file's own path.
              openPath={selectedFile?.path ?? null}
              gitConnected={git.gitConnected}
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
                    themeText={printTheme.themeText}
                    themePath={printTheme.themePath}
                    // The Print style's fonts come from the project through the SAME asset mechanism
                    // every image and theme font already travels — passed in, never rebuilt.
                    ensureAssets={ensureAssets}
                    getAssetBytes={getAssetBytes}
                    assetVersion={assetVersion}
                    assetsSettled={assetsSettled}
                    onSelectDiagnosticLocation={handleDiagnosticLocation}
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
      <GitDialogs git={git} projectId={projectId} />
    </div>
  );
}
