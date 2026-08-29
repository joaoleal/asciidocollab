'use client';
import type { CreateAnchorInput } from '@asciidocollab/shared';
import { isThemeFilePath } from '@asciidocollab/shared';
import { AsciiDocEditor, type EditorGrammarState } from '@/components/editor/asciidoc-editor';
import type { CollabBinding } from '@/components/editor/asciidoc-editor';
import { ThemeEditor } from '@/components/theme-editor/theme-editor';
import { useThemeSettings } from '@/hooks/use-theme-settings';
import { ImagePreview } from '@/components/image-preview';
import { isImageFile } from '@/lib/codemirror/asciidoc-image-extensions';
import { isAsciiDocFile } from '@/components/asciidoc-preview';
import type { ProjectSymbolIndex } from '@/lib/codemirror/asciidoc-symbol-index';
import type { SectionOutlineEntry } from '@/lib/codemirror/asciidoc-outline';
import type { SelectedFile, FileContentState } from '@/hooks/use-file-selection';
import type { ConnectionState } from '@/hooks/use-collab-document';
import type { ProjectAssetCache } from '@/hooks/use-project-asset-cache';
import type { ReviewAnchorRange } from '@/lib/codemirror/review-decorations';
import type { XrefTarget } from '@/lib/codemirror/asciidoc-link-handler';
import type { CursorSymbol } from '@/lib/codemirror/asciidoc-symbol-at-cursor';

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
  /** The open file's project-relative path (for inline blame), or null when none/undeterminable. */
  openPath?: string | null;
  /** Whether the project has a connected Git repository — gates the editor's inline blame toggle. */
  gitConnected?: boolean;
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

/**
 * The editor pane's content: the loading/error/binary/empty states, the theme editor for a theme
 * file, and the AsciiDoc editor for everything else. Pure branch on the selected file's state.
 */
export function ContentArea({
  selectedFile,
  contentState,
  canEdit,
  canManageDictionary,
  canConfigureRules,
  projectId,
  openPath,
  gitConnected,
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
      openPath={openPath ?? selectedFile.path}
      gitConnected={gitConnected}
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
