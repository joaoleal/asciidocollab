'use client';
import { useState, useCallback, useMemo, useRef, type RefObject } from 'react';
import type { ProjectSymbolIndex } from '@/lib/codemirror/asciidoc-symbol-index';
import { resolveProjectTheme, type ProjectTheme } from '@/lib/print-preview/resolve-project-theme';
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
import type { ConnectionState } from '@/hooks/use-collab-document';
import type { ScrollRequest } from '@/hooks/use-asciidoc-preview';
import type { useProjectPresence } from '@/hooks/use-project-presence';
import type { SearchResultTarget } from '@/components/editor/search-view';
import type { PreviewStyleValue, OutlineScope } from '@/hooks/use-editor-preferences';
import { buildProjectSnapshot, type SnapshotFile } from '@/lib/pdf/build-project-snapshot';
import { withAppRenderDefaults } from '@/lib/asciidoc/render-app-defaults';
import { collectReferencedAssetPaths } from '@/lib/pdf/collect-referenced-assets';
import { useProjectAssetCache } from '@/hooks/use-project-asset-cache';
import { useProjectAuxiliaryTextCache } from '@/hooks/use-auxiliary-text-cache';
import { useProjectRenderConfig } from '@/hooks/use-project-render-config';
import { usePdfExtensionBundle } from '@/hooks/use-pdf-extension-bundle';
import { useHtmlExport } from '@/hooks/use-html-export';
import { usePdfExport } from '@/hooks/use-pdf-export';
import { usePdfPreview } from '@/hooks/use-pdf-preview';
import { isAsciiDocFile } from '@/components/asciidoc-preview';
import {
  resolveRenderAttributes,
  SOFT_DEFAULT_SUFFIX,
  stripSoftDefault,
  DEFAULT_HTML_EXPORT_PACKAGING,
  DEFAULT_HTML_EXPORT_THEME,
  htmlExportStyleFor,
} from '@asciidocollab/shared';
import type { ProjectSnapshot, RenderDiagnostic } from '@asciidocollab/asciidoc-pdf';

/** No extensions enabled. Shared so the memo keeps a stable identity across renders. */
const NO_EXTENSION_IDS: readonly string[] = [];

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

interface UseEditorRenderPipelineOptions {
  projectId: string;
  projectName: string;
  projectLanguage: string | null;
  mainFile: string | null;
  selectedFile: SelectedFile | null;
  contentState: FileContentState;
  projectIndex: ProjectSymbolIndex | null;
  getProjectFiles: () => Record<string, string>;
  resolvedScopeOf: (fileId: string) => ReadonlyMap<string, string>;
  refreshProjectIndex: () => Promise<void>;
  fileIdForPath: (path: string) => string | null;
  reachableDocVersion: number;
  liveContent: string;
  liveOverlayContent: string | null;
  previewOpen: boolean;
  previewStyle: PreviewStyleValue;
  showIncludedFiles: boolean;
  scrollSyncEnabled: boolean;
  outlineScope: OutlineScope;
  renameRefreshNonce: number;
  changedFileNodeId: string | null;
  cmOutlineEntries: SectionOutlineEntry[];
  presenceByFile: ReturnType<typeof useProjectPresence>;
  editorPending: boolean;
  editorCollab: CollabBinding | null;
  editorConnectionState: ConnectionState | undefined;
  scrollRequest: ScrollRequest | null;
  revealLine: (line: number) => void;
  handleNavigateToFile: (path: string) => void;
  handleLineClick: (line: number) => void;
  pendingXrefLine: RefObject<number | null>;
}

/**
 * The project editor's render pipeline: the resolved editor-inherited attribute scopes, the PDF and
 * HTML one-click exports, the live HTML/PDF preview and its snapshot builder, click-to-source and
 * diagnostic navigation, and the assembled full-document outline. Extracted wholesale from the layout
 * so its many interdependent memos and callbacks live in one cohesive unit the layout composes.
 */
export function useEditorRenderPipeline({
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
}: UseEditorRenderPipelineOptions) {
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
  const { getAssets, getAssetBytes, ensureAssets, loadAssets, assetsSettled, assetVersion } = assetCache;

  // The theme and `.bib` contents, which the include-graph cache above can never reach. Without this
  // the snapshot has no theme content, and theme DISCOVERY — which filters the snapshot's own text
  // paths — cannot even see the theme's path, so the export renders unthemed.
  const { getAuxiliaryFiles, auxiliaryVersion } = useProjectAuxiliaryTextCache(
    projectId,
    renameRefreshNonce,
    changedFileNodeId,
  );

  // The theme document the Print preview dresses its page in: the export's own choice, resolved by
  // the export's own function from the same merged file snapshot the export builds from. Computed
  // only while that style is selected — the other two ignore it, and reading the file maps for
  // nothing on every render of a document being typed is exactly the cost this feature must not add.
  //
  // The version counters are what make this live: the maps are mutable behind stable callbacks, so a
  // collaborator's theme edit (auxiliaryVersion, driven by the UNFILTERED content-changed stream — a
  // theme is never include-reachable) and the author's own edit to an open theme (liveOverlayContent)
  // each have to be named here or the page would keep the theme it first saw.
  const printTheme = useMemo<ProjectTheme>(
    () =>
      previewStyle === 'print'
        ? resolveProjectTheme({
            files: { ...getAuxiliaryFiles(), ...getProjectFiles() },
            // Stripped of its soft-default marker, exactly as the export's snapshot builder strips
            // it: every project attribute carries `@` so a document header can override it, and the
            // marker is not part of the path.
            declaredThemePath: stripSoftDefault(projectRenderAttributes.attributes['pdf-theme'] ?? ''),
          })
        : {},
    [
      previewStyle,
      getAuxiliaryFiles,
      getProjectFiles,
      auxiliaryVersion,
      reachableDocVersion,
      liveOverlayContent,
      projectRenderAttributes,
    ],
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
      style: htmlExport?.style ?? htmlExportStyleFor(previewStyle),
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

  return {
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
    exportError,
    exportDiagnostics,
    handleExportPdf,
    isExportingHtml,
    htmlExportPhase,
    htmlExportError,
    htmlExportFailures,
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
  };
}
