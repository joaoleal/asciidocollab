'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContentChangedEventDto, FileTreeEventDto } from '@asciidocollab/shared';
import {
  buildProjectSymbolIndex,
  makeIncludeResolver,
  type ProjectSymbolIndex,
} from '@/lib/codemirror/asciidoc-symbol-index';
import { buildFilePathIndex } from '@/lib/codemirror/file-path-index';
import { fetchReachableContent } from '@/lib/codemirror/include-tree-fetcher';
import { getDocumentContent } from '@/lib/api/file-content';
import { fetchProjectFileTree } from '@/lib/api/file-tree';
import { useFileTreeEvents } from '@/hooks/use-file-tree-events';

/** Shared, stable empty scope returned before the index has built (avoids a new identity per call). */
const EMPTY_RESOLVED_SCOPE: ReadonlyMap<string, string> = new Map();

/** Options for {@link useProjectSymbolIndex}. */
interface UseProjectSymbolIndexOptions {
  /** The project whose files form the include tree. */
  projectId: string;
  /** Root of the include tree: the configured main file, or the open file when none. Null ⇒ no index. */
  rootFileId: string | null;
  /** The currently-open file id, whose live (unsaved) content overlays the persisted copy. */
  openFileId?: string | null;
  /** Live content of the open file; used instead of a fetch so in-progress edits are reflected. */
  liveContent?: string | null;
}

/** Result of {@link useProjectSymbolIndex}. */
interface UseProjectSymbolIndexResult {
  /** The current cross-file symbol index, or null when no root is configured. */
  index: ProjectSymbolIndex | null;
  /** Stable accessor returning the latest index (for CM extensions that capture a getter). */
  getIndex: () => ProjectSymbolIndex | null;
  /**
   * Snapshot of cached file contents keyed by project-relative path, with the open file's live
   * (unsaved) content overlaid — the input the preview's include assembler needs.
   *
   * @returns A path→content map covering the files fetched so far.
   */
  getFiles: () => Record<string, string>;
  /**
   * The resolved cross-document attribute scope for a file: the attributes it inherits from the
   * documents that include it (its ancestors along the include path from the root) merged with its
   * own definitions, with the file's own winning. This is the scope the editor uses to decide which
   * `{name}` references resolve cross-document and should highlight as known. Empty
   * before the index has built or when the file is unreachable from the root.
   *
   * @param fileId - Identifier of the file whose resolved scope is wanted.
   * @returns The resolved attribute map (lowercase name → value); empty when none.
   */
  resolvedScopeOf: (fileId: string) => ReadonlyMap<string, string>;
  /**
   * Force a full rebuild from the server, discarding the cached file contents and
   * tree. This is needed after an operation that rewrites persisted content
   * without a file-tree event, such as a project-wide symbol rename. Resolves when the
   * rebuild (and its content fetch) has settled, so a caller can await the refreshed content.
   */
  refresh: () => Promise<void>;
  /**
   * Looks up the file node id for a project-relative path (reverse of pathOf).
   *
   * @param path - Project-relative path.
   * @returns The file node id, or null when the path is not in the tree.
   */
  fileIdForPath: (path: string) => string | null;
  /**
   * Counter that increments whenever a reachable non-open file's content changes (a collaborator's
   * live edit or save, delivered as a `content-changed` SSE frame). Consumers include this in
   * useMemo/useEffect dependency arrays to recompute derived views (assembled outline, highlighting,
   * heading IDs) when a related file changes.
   */
  reachableDocVersion: number;
}

/**
 * Build and maintain the cross-file AsciiDoc symbol index for the editor.
 *
 * Fetches each file reachable from the root through the cycle-guarded include walk
 * exactly once (deduped against a per-file cache, capped concurrency) so a single
 * open/refresh of an N-file tree issues at most N content reads.
 * Invalidates on file-tree SSE events and whenever the root (main-file) changes, and
 * overlays the open file's live content so the index reflects in-progress edits.
 *
 * A collaborator's change to a reachable non-open file arrives as a `content-changed` SSE frame
 * (server-originated, no per-file client socket): the handler invalidates that file's cache, rebuilds,
 * and bumps `reachableDocVersion` so every downstream derived view recomputes — independent of any UI
 * panel's visibility.
 *
 * @param options - {@link UseProjectSymbolIndexOptions}.
 * @returns The {@link UseProjectSymbolIndexResult}.
 */
export function useProjectSymbolIndex({
  projectId,
  rootFileId,
  openFileId,
  liveContent,
}: UseProjectSymbolIndexOptions): UseProjectSymbolIndexResult {
  const [index, setIndex] = useState<ProjectSymbolIndex | null>(null);
  const indexReference = useRef<ProjectSymbolIndex | null>(null);
  indexReference.current = index;

  const [reachableDocumentVersion, setReachableDocumentVersion] = useState(0);

  const contentCache = useRef<Map<string, string | null>>(new Map());
  const pathById = useRef<Map<string, string>>(new Map());
  const idByPath = useRef<Map<string, string>>(new Map());
  const treeLoaded = useRef(false);
  const buildToken = useRef(0);
  // Memoises resolved scopes per (index identity, fileId): `effectiveAttributes` builds a fresh Map on
  // every call, so without this cache `resolvedScopeOf(fileId)` would return a new identity each render
  // and the editor's `[resolvedScope]` effect would re-dispatch CodeMirror effects + re-publish the
  // outline on every parent re-render (keystroke/cursor move). Invalidated whenever the index rebuilds.
  const scopeCache = useRef<{ index: ProjectSymbolIndex | null; byFile: Map<string, ReadonlyMap<string, string>> }>({
    index: null,
    byFile: new Map(),
  });

  // Hold the live overlay in a ref so a rebuild reads the latest text without re-subscribing.
  const liveOverlay = useRef<{ id: string | null; text: string | null }>({
    id: openFileId ?? null,
    text: liveContent ?? null,
  });
  {
    const next = { id: openFileId ?? null, text: liveContent ?? null };
    const previous = liveOverlay.current;
    // When the open file changes, commit the file we're LEAVING into the cache from its last overlay
    // text before the overlay is reassigned to the new file. The open file is served from the overlay
    // (and excluded from fetching), so without this it would vanish from `getFiles()` the instant the
    // selection moves — collapsing the assembled full-document outline to the current-file fallback
    // for a frame until the next rebuild re-fetches it. Done during render so the assembled memo in
    // the same render already sees the committed content.
    if (previous.id !== null && previous.id !== next.id && previous.text !== null) {
      contentCache.current.set(previous.id, previous.text);
    }
    liveOverlay.current = next;
  }

  const readContent = useCallback((fileId: string): string | null => {
    const overlay = liveOverlay.current;
    if (overlay.id !== null && fileId === overlay.id && overlay.text !== null) return overlay.text;
    return contentCache.current.get(fileId) ?? null;
  }, []);

  // Which files a `getFiles()` snapshot could name right now: the paths the tree knows, and the ids
  // whose content has arrived. Deliberately not the content itself — an edit to a file already in the
  // set arrives as its own signal (the overlay for the open file, a `content-changed` frame for any
  // other), and hashing every reachable document on each build would cost the whole tree per keystroke
  // to detect something already announced.
  const reachableSignature = useCallback(
    (): string => `${pathById.current.size}:${[...contentCache.current.keys()].toSorted().join(',')}`,
    [],
  );

  const build = useCallback(async () => {
    const root = rootFileId;
    if (!root) {
      buildToken.current += 1;
      indexReference.current = null;
      setIndex(null);
      return;
    }
    buildToken.current += 1;
    const token = buildToken.current;
    const isCancelled = (): boolean => token !== buildToken.current;

    if (!treeLoaded.current) {
      try {
        const tree = await fetchProjectFileTree(projectId);
        if (isCancelled()) return;
        const paths = buildFilePathIndex(tree);
        pathById.current = paths.pathById;
        idByPath.current = paths.idByPath;
        treeLoaded.current = true;
      } catch {
        /* Tree load failed — fall through; resolution degrades to whatever is already cached/live. */
      }
    }

    const resolveInclude = makeIncludeResolver(
      (id) => pathById.current.get(id) ?? null,
      (path) => idByPath.current.get(path) ?? null,
    );

    // What the reachable snapshot could produce before this build fetched anything. `getFiles()` is
    // assembled from the path map and the content cache, so a build that adds to either changes what
    // every derived view — the preview's assembled render, the outline, the export snapshot — would
    // build from.
    const before = reachableSignature();

    const completed = await fetchReachableContent({
      rootFileId: root,
      readContent,
      resolveInclude,
      fetchContent: (id) => getDocumentContent(projectId, id),
      cache: contentCache.current,
      // The open file is served by its editor (overlay/Yjs sync), never fetched — fetching it would
      // add a redundant content round-trip per file open. When the overlay text is briefly null (just
      // before the editor produces content), a file the open file was switched FROM is already in the
      // cache (it was a reachable non-open file, or was committed on switch), so the assembled outline
      // still reads it; only a brand-new open file's headings wait for its editor to sync.
      overlayFileId: liveOverlay.current.id,
      isCancelled,
    });
    if (!completed) return;

    const built = buildProjectSymbolIndex(
      root,
      readContent,
      resolveInclude,
      liveOverlay.current.id ?? root,
      (id) => pathById.current.get(id) ?? null,
    );
    indexReference.current = built;
    setIndex(built);

    // The reachable snapshot gained (or lost) files, so anything derived from `getFiles()` is now
    // derived from something else. The FIRST build is the case this exists for: the preview posts its
    // render as soon as the panel opens, and until the include tree's contents land `getFiles()` holds
    // the open file alone — so the document renders with "Unresolved directive in index.adoc" under
    // every include line. Nothing announced their arrival: the version bumped only for a
    // collaborator's `content-changed` frame, so the notice stayed on screen until some unrelated
    // signal (toggling included files, a keystroke) happened to re-post a render. Guarded by the
    // signature rather than bumped on every build, because a build also runs shortly after every edit
    // settles, and bumping there would re-post a render for a snapshot that had not changed.
    if (reachableSignature() !== before) setReachableDocumentVersion((v) => v + 1);
  }, [projectId, rootFileId, readContent, reachableSignature]);

  // Rebuild when the project or root (main-file) changes.
  useEffect(() => {
    build();
  }, [build]);

  // Rebuild (sync extraction, no fetch) shortly after the open file's live content settles.
  useEffect(() => {
    const handle = setTimeout(() => {
      build();
    }, 250);
    return () => clearTimeout(handle);
  }, [liveContent, openFileId, build]);

  // (The file we switch away from is preserved in the cache from its last overlay text during render —
  // see the `liveOverlay` commit above — so the assembled outline never momentarily loses it. A
  // collaborator's later edits to that now-non-open file arrive as `content-changed` SSE frames, which
  // invalidate its cache and rebuild, exactly like any other included file.)

  // Invalidate on file-tree SSE: structural change ⇒ path maps + the affected file's cache are stale.
  const handleEvent = useCallback(
    (event: FileTreeEventDto) => {
      treeLoaded.current = false;
      contentCache.current.delete(event.fileNodeId);
      build();
    },
    [build],
  );
  // The SSE stream dropped (and may retry): the cache may be stale, so clear it and rebuild from the
  // server. The connection-status signal (not this rebuild) drives the non-live indicator, so there is
  // no version bump here.
  const handleReconnect = useCallback(() => {
    treeLoaded.current = false;
    contentCache.current.clear();
    build();
  }, [build]);

  // Coalesce a burst of content-changed frames into at most one fetch+rebuild per microtask batch;
  // the build's token check supersedes any still-in-flight build so recompute stays bounded. The
  // .catch keeps a rare synchronous build failure from leaving an unhandled rejection.
  const contentChangedScheduled = useRef(false);
  const flushContentChanged = useCallback(() => {
    contentChangedScheduled.current = false;
    void build()
      .then(() => setReachableDocumentVersion((v) => v + 1))
      .catch(() => {});
  }, [build]);

  // A collaborator's live edit (or a peer's save) to a reachable, non-open file: invalidate that
  // file's cached content and rebuild so every derived view re-resolves from one refreshed snapshot.
  // The open file is skipped — its own editor holds the authoritative live copy. A file already known
  // to be outside this document's dependency graph is ignored (client-side relevance filter); but
  // before the first build resolves the graph is unknown, so a frame arriving mid-initial-build still
  // invalidates the cache and schedules a rebuild rather than being dropped.
  const handleContentChanged = useCallback(
    (event: ContentChangedEventDto) => {
      const fileId = event.fileNodeId;
      if (fileId === liveOverlay.current.id) return;
      // Drop the cached copy BEFORE the reachability test. The filter exists to avoid a pointless
      // rebuild for a file outside this document's graph — not to keep a copy we have just been told is
      // stale. Keeping it strands that copy permanently: the fetcher skips any id already cached, so
      // when the file re-enters the graph (an `ifdef::` gate flips back, an include line is restored)
      // it is served from the pre-change text until a refresh, an SSE reconnect, or a file-tree event
      // for that id happens to clear it.
      contentCache.current.delete(fileId);
      const built = indexReference.current;
      if (built && !built.tree.nodes.includes(fileId)) return;
      if (!contentChangedScheduled.current) {
        contentChangedScheduled.current = true;
        queueMicrotask(flushContentChanged);
      }
    },
    [flushContentChanged],
  );

  useFileTreeEvents(projectId, {
    onFileTreeEvent: handleEvent,
    onContentChanged: handleContentChanged,
    onReconnect: handleReconnect,
  });

  // Discard all cached content + the tree and rebuild from the server (used after a symbol rename
  // rewrites persisted files without emitting a file-tree event). Mirrors the reconnect path.
  // Returns the rebuild's promise so a caller that needs the refreshed content (e.g. an export that
  // must not dispatch before the render root is loaded) can await it.
  const refresh = useCallback((): Promise<void> => {
    treeLoaded.current = false;
    contentCache.current.clear();
    return build();
  }, [build]);

  const getIndex = useCallback(() => indexReference.current, []);
  // The resolved cross-document scope (inherited from ancestors + the file's own definitions, the
  // file's own winning) drives the editor's known-vs-unknown `{name}` highlighting.
  // `effectiveAttributes` already composes inheritance with the file's own entries — the same
  // result `resolveAttributeScope` produces against the project main file as root. The result is
  // cached per (index, fileId) so the returned Map keeps a STABLE identity across renders until the
  // index rebuilds — otherwise the editor re-runs its `[resolvedScope]` effect on every render.
  const resolvedScopeOf = useCallback((fileId: string): ReadonlyMap<string, string> => {
    const current = indexReference.current;
    if (current === null) return EMPTY_RESOLVED_SCOPE;
    const cache = scopeCache.current;
    if (cache.index !== current) {
      cache.index = current;
      cache.byFile = new Map();
    }
    let scope = cache.byFile.get(fileId);
    if (scope === undefined) {
      scope = current.effectiveAttributes(fileId);
      cache.byFile.set(fileId, scope);
    }
    return scope;
  }, []);
  const getFiles = useCallback((): Record<string, string> => {
    const files: Record<string, string> = {};
    for (const [id, path] of pathById.current) {
      const content = readContent(id);
      if (content !== null) files[path] = content;
    }
    return files;
  }, [readContent]);
  const fileIdForPath = useCallback(
    (path: string): string | null => idByPath.current.get(path) ?? null,
    [],
  );
  return { index, getIndex, getFiles, resolvedScopeOf, refresh, fileIdForPath, reachableDocVersion: reachableDocumentVersion };
}
