'use client';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ChevronLeft } from 'lucide-react';
import { FileTreeNode } from './file-tree-node';
import { FileTreeActions } from './file-tree-actions';
import { DragDropZone } from './drag-drop-zone';
import { FindPanel } from './find-panel';
import { MoveConfirmationDialog } from './move-confirmation-dialog';
import { moveFileNode, renameFileNode } from '@/lib/api/file-tree';
import { Button } from '@/components/ui/button';
import { useFileTreeEvents } from '@/hooks/use-file-tree-events';
import { useKeyBindings } from '@/hooks/use-key-bindings';
import { useFileTreeKeyHandler } from '@/hooks/use-file-tree-key-handler';
import { useFileTreeUIState } from '@/hooks/use-file-tree-ui-state';
import type { FileTreeNode as FileTreeNodeType } from './types';
import type { ParticipantPresence } from '@/hooks/use-collab-presence';
import type { FileTreeEventDto } from '@asciidocollab/shared';
import { API_BASE_URL } from '@/lib/api/base-url';

// Folders are grouped before files; within each group, entries are ordered alphabetically
// (case-insensitive). This single comparator governs both the initial load and every real-time
// SSE mutation, so the folders-first invariant holds after creates, renames and moves too.
const sortComparator = (a: FileTreeNodeType, b: FileTreeNodeType) => {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
};

function sortChildren(node: FileTreeNodeType): FileTreeNodeType {
  return {
    ...node,
    children: node.children.toSorted(sortComparator).map(sortChildren),
  };
}

interface Properties {
  projectId: string;
  canEdit: boolean;
  onSelectFile: (nodeId: string, nodeName: string, nodePath: string, nodeType: 'file' | 'folder') => void;
  selectedNodeId: string | null;
  /** Feature 024: other users currently editing each file, keyed by file node id (for the marker). */
  presenceByFile?: ReadonlyMap<string, ParticipantPresence[]>;
  /** When provided, renders a collapse button in the header and calls this on click. */
  onCollapse?: () => void;
  // A request to reveal and select a file by its project-relative path, such as from a Ctrl+click
  // on an include or image macro in the editor. The nonce makes repeat requests for the same path
  // distinct so they re-fire.
  openPathRequest?: { path: string; nonce: number } | null;
  // The project's main file node id, to select automatically the FIRST time this user opens the
  // project — when no previous selection was remembered, the editor would otherwise open on an empty
  // "no file selected" state. The parent passes this ONLY on a genuine first open (nothing stored),
  // so it never overrides a restored selection. Once the tree has loaded the node is selected once;
  // thereafter the user's own navigation is remembered and restored instead.
  autoSelectNodeId?: string | null;
}

function applyEvent(tree: FileTreeNodeType | null, event: FileTreeEventDto): FileTreeNodeType | null {
  if (!tree) return tree;

  if (event.type === 'created') {
    // Idempotency: skip if the node already exists (e.g., fetchTree beat SSE delivery)
    const hasNode = (node: FileTreeNodeType): boolean =>
      node.id === event.fileNodeId || node.children.some(hasNode);
    if (hasNode(tree)) return tree;

    const addNode = (node: FileTreeNodeType): FileTreeNodeType => {
      if (node.id === event.parentId) {
        const newNode: FileTreeNodeType = {
          id: event.fileNodeId,
          name: event.name,
          type: event.nodeType,
          path: event.path,
          parentId: event.parentId,
          children: [],
        };
        const updated = { ...node, children: [...node.children, newNode] };
        return { ...updated, children: updated.children.toSorted(sortComparator) };
      }
      return { ...node, children: node.children.map(addNode) };
    };
    return addNode(tree);
  }

  if (event.type === 'deleted') {
    const removeNode = (node: FileTreeNodeType): FileTreeNodeType => ({
      ...node,
      children: node.children
        .filter((c) => c.id !== event.fileNodeId)
        .map(removeNode),
    });
    return removeNode(tree);
  }

  if (event.type === 'renamed') {
    const renameNode = (node: FileTreeNodeType): FileTreeNodeType => {
      if (node.id === event.fileNodeId) {
        return { ...node, name: event.name, path: event.path };
      }
      const mapped = node.children.map(renameNode);
      const hasChange = mapped.some((c, index) => c !== node.children[index]);
      if (!hasChange) return node;
      return { ...node, children: mapped.toSorted(sortComparator) };
    };
    return renameNode(tree);
  }

  if (event.type === 'moved') {
    let movedNode: FileTreeNodeType | null = null;
    const removeNode = (node: FileTreeNodeType): FileTreeNodeType => ({
      ...node,
      children: node.children
        .filter((c) => {
          if (c.id === event.fileNodeId) { movedNode = { ...c, parentId: event.parentId, path: event.path }; return false; }
          return true;
        })
        .map(removeNode),
    });
    let result = removeNode(tree);
    if (movedNode) {
      const addNode = (node: FileTreeNodeType): FileTreeNodeType => {
        if (node.id === event.parentId) {
          const children = [...node.children, movedNode!].toSorted(sortComparator);
          return { ...node, children };
        }
        return { ...node, children: node.children.map(addNode) };
      };
      result = addNode(result);
    }
    return result;
  }

  return tree;
}

interface MoveDialogState {
  sourceId: string;
  targetId: string;
  sourcePath: string;
  targetPath: string;
  hasConflict: boolean;
}

function findNodeInTree(node: FileTreeNodeType, id: string): FileTreeNodeType | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNodeInTree(child, id);
    if (found) return found;
  }
  return null;
}

function findNodeByPath(node: FileTreeNodeType, path: string): FileTreeNodeType | null {
  if (node.path === path) return node;
  for (const child of node.children) {
    const found = findNodeByPath(child, path);
    if (found) return found;
  }
  return null;
}

/** Renders the full file tree for a project, with real-time SSE updates and keyboard shortcut support. */
export function FileTree({ projectId, canEdit, onSelectFile, selectedNodeId, presenceByFile, onCollapse, openPathRequest, autoSelectNodeId }: Properties) {
  const [tree, setTree] = useState<FileTreeNodeType | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [moveDialog, setMoveDialog] = useState<MoveDialogState | null>(null);
  const containerReference = useRef<HTMLDivElement>(null);
  const autoExpandedReference = useRef(false);
  const lastRevealedReference = useRef<string | null>(null);
  const pendingScrollReference = useRef<string | null>(null);
  // The id of the node currently being dragged, tracked the instant `dragstart` fires. This is the
  // reliable source of truth for an in-tree move — see handleFolderDrop for why we don't depend on
  // the dataTransfer payload.
  const draggedNodeIdReference = useRef<string | null>(null);
  // Last handled openPathRequest nonce, so the resolve effect fires once per request (and not
  // again merely because the tree re-rendered).
  const openPathNonceReference = useRef<number>(-1);
  // Whether the first-open auto-selection has already been resolved (one way or the other), so it
  // never fires twice or fights a later user navigation.
  const autoSelectedReference = useRef(false);

  const userBindings = useKeyBindings('file-tree');
  const bindings = useMemo(() => new Map(userBindings), [userBindings]);

  const {
    expandedState,
    toggleExpand,
    collapseAll,
    expandAll,
    revealSelected,
    operationError,
    setOperationError,
    findOpen,
    openFind,
    find,
    handleKeyDown,
    handleDismissFind,
    handleNext,
    handlePrevious,
    handleQueryChange,
  } = useFileTreeUIState(tree, onSelectFile, bindings);

  const handleRevealFile = useCallback(() => {
    if (!selectedNodeId) return;
    revealSelected(selectedNodeId);
    setTimeout(() => {
      const element = containerReference.current?.querySelector(`[data-node-id="${selectedNodeId}"]`);
      element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 0);
  }, [selectedNodeId, revealSelected]);

  const fetchTree = useCallback(async () => {
    try {
      setFetchError(false);
      const response = await fetch(`${API_BASE_URL}/projects/${projectId}/files`, { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        setTree(sortChildren(data));
      } else {
        setFetchError(true);
      }
    } catch {
      setFetchError(true);
    }
  }, [projectId]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  useEffect(() => {
    if (tree && !autoExpandedReference.current) {
      autoExpandedReference.current = true;
      for (const child of tree.children) {
        if (child.type === 'folder') toggleExpand(child.id);
      }
    }
  }, [tree, toggleExpand]);

  // Auto-reveal: when `selectedNodeId` changes to a node that may be hidden behind collapsed
  // folders (e.g. a restored selection), expand its ancestors. Keyed on
  // `selectedNodeId` + `tree` (NOT `expandedState`) so manually collapsing a folder holding
  // the selected node does not re-trigger a reveal; the last-revealed ref makes it a
  // one-shot per selection. The scroll itself happens in the effect below, after the
  // ancestor expansion has committed and the node is in the DOM.
  useEffect(() => {
    if (!selectedNodeId || !tree) return;
    if (lastRevealedReference.current === selectedNodeId) return;
    lastRevealedReference.current = selectedNodeId;
    revealSelected(selectedNodeId);
    pendingScrollReference.current = selectedNodeId;
  }, [selectedNodeId, tree, revealSelected]);

  // Scroll a freshly-revealed node into view once it is actually rendered. Runs after the
  // expansion above commits (expandedState changes) and on the initial selection change; the
  // pending ref ensures it fires exactly once per reveal and never on a manual collapse.
  useEffect(() => {
    const target = pendingScrollReference.current;
    if (!target) return;
    const element = containerReference.current?.querySelector(`[data-node-id="${target}"]`);
    if (element) {
      element.scrollIntoView({ block: 'nearest' });
      pendingScrollReference.current = null;
    }
  }, [selectedNodeId, expandedState, tree]);

  // First-open auto-selection: the FIRST time this user opens the project (the parent passes
  // `autoSelectNodeId` only when nothing was previously remembered), open the project's main file
  // rather than the empty "no file selected" state. Waits for the tree so the node's name/path are
  // known, resolves exactly once, and yields to any selection that has already been made (a restore,
  // a Ctrl+click) so it can only ever ADD a selection, never replace one. A missing or non-file main
  // file simply leaves the editor on the empty state, as before.
  useEffect(() => {
    if (autoSelectedReference.current) return;
    if (!tree || !autoSelectNodeId) return;
    if (selectedNodeId) {
      autoSelectedReference.current = true;
      return;
    }
    const node = findNodeInTree(tree, autoSelectNodeId);
    if (!node) return;
    autoSelectedReference.current = true;
    if (node.type === 'file') {
      onSelectFile(node.id, node.name, node.path, node.type);
    }
  }, [tree, autoSelectNodeId, selectedNodeId, onSelectFile]);

  const onEvent = useCallback((event: FileTreeEventDto) => {
    setTree((previous) => applyEvent(previous, event));
  }, []);

  const onReconnect = useCallback(() => {
    fetchTree();
  }, [fetchTree]);

  useFileTreeEvents(projectId, { onFileTreeEvent: onEvent, onReconnect });

  // Resolve a Ctrl+click navigation request (project-relative path) to a node and select it.
  // Selecting a file updates `selectedNodeId`, which drives the auto-reveal/scroll effect above.
  useEffect(() => {
    if (!openPathRequest || !tree) return;
    if (openPathNonceReference.current === openPathRequest.nonce) return;
    openPathNonceReference.current = openPathRequest.nonce;
    const target = '/' + openPathRequest.path.replace(/^\/+/, '');
    const node = findNodeByPath(tree, target);
    if (!node) return;
    if (node.type === 'file') {
      onSelectFile(node.id, node.name, node.path, node.type);
    } else {
      revealSelected(node.id);
      setTimeout(() => {
        containerReference.current
          ?.querySelector(`[data-node-id="${node.id}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      }, 0);
    }
  }, [openPathRequest, tree, onSelectFile, revealSelected]);

  const keyCallbacks = useMemo(() => ({
    'file-tree:rename': selectedNodeId ? () => {} : undefined,
    'file-tree:delete': selectedNodeId ? () => {} : undefined,
    'file-tree:new-file': selectedNodeId ? () => {} : undefined,
    'file-tree:new-folder': selectedNodeId ? () => {} : undefined,
    'file-tree:find': openFind,
  }), [selectedNodeId, openFind]);

  useFileTreeKeyHandler(containerReference, bindings, keyCallbacks);

  const handleTreeDragStart = useCallback((event: React.DragEvent) => {
    // Use Element (not HTMLElement) as the guard: browsers fire `dragstart` on
    // the element under the pointer, which is the row's <svg> icon when the user
    // grabs there (WebKit always does this). An SVGElement is an Element but not
    // an HTMLElement, so an HTMLElement-only guard would silently drop those
    // drags — the source id never gets set and, to the user, nothing happens on
    // drop. `closest` walks up to the owning row regardless of the start target.
    const rawTarget = event.target;
    if (!(rawTarget instanceof Element)) return;
    const container = rawTarget.closest('[data-node-id]');
    if (!(container instanceof HTMLElement)) return;
    const nodeId = container.dataset.nodeId;
    if (!nodeId) return;
    event.dataTransfer.setData('text/plain', nodeId);
    // Declare this as a move operation so the browser computes a compatible
    // dropEffect; without it some engines (Firefox, Safari) resolve dropEffect
    // to "none" and silently discard the drop.
    event.dataTransfer.effectAllowed = 'move';
    // A file dragged onto the editor inserts an include::/image:: macro. Carry its project-relative
    // path in a custom type the editor reads on drop (folders are not draggable into the editor).
    const nodePath = container.dataset.nodePath;
    if (nodePath && container.dataset.nodeType === 'file') {
      event.dataTransfer.setData(
        'application/x-asciidoc-node',
        JSON.stringify({ path: nodePath.replace(/^\//, '') }),
      );
      event.dataTransfer.effectAllowed = 'copyMove';
    }
    draggedNodeIdReference.current = nodeId;
    setDraggedNodeId(nodeId);
  }, []);

  const handleTreeDragEnd = useCallback(() => {
    draggedNodeIdReference.current = null;
    setDraggedNodeId(null);
  }, []);

  const handleFolderDrop = useCallback((targetFolderId: string, sourceNodeId: string) => {
    if (!tree) return;
    // Prefer the id captured on `dragstart` over the dataTransfer payload. The setData→getData
    // round-trip is an unreliable cross-browser link in HTML5 DnD — `getData('text/plain')` can
    // come back empty on `drop` even though `setData` ran, which surfaces as "nothing happens on
    // drop". The tracked ref is always set for an in-tree drag; fall back to the payload only for a
    // drag that did not originate in this tree (where the ref is null).
    const effectiveSourceId = draggedNodeIdReference.current ?? sourceNodeId;
    const sourceNode = findNodeInTree(tree, effectiveSourceId);
    if (!sourceNode) return;
    // No-op: dropping onto the same parent
    if (sourceNode.parentId === targetFolderId) return;
    // No-op: dropping a folder onto itself
    if (sourceNode.id === targetFolderId) return;

    const targetFolder = findNodeInTree(tree, targetFolderId);
    if (!targetFolder) return;

    const hasConflict = targetFolder.children.some((c) => c.name === sourceNode.name && c.id !== sourceNode.id);

    setMoveDialog({
      sourceId: effectiveSourceId,
      targetId: targetFolderId,
      sourcePath: sourceNode.path,
      targetPath: targetFolder.path,
      hasConflict,
    });
    draggedNodeIdReference.current = null;
    setDraggedNodeId(null);
  }, [tree]);

  // Move the dragged node to the project root when it is dropped on the tree's empty (root) area.
  // Returns true when it consumed an in-tree drag, so DragDropZone skips its OS-file upload path.
  const handleRootDrop = useCallback((): boolean => {
    if (!tree || !draggedNodeIdReference.current) return false;
    handleFolderDrop(tree.id, draggedNodeIdReference.current);
    return true;
  }, [tree, handleFolderDrop]);

  const handleMoveConfirm = useCallback(async () => {
    if (!moveDialog) return;
    setMoveDialog(null);
    try {
      await moveFileNode(projectId, moveDialog.sourceId, moveDialog.targetId);
      await fetchTree();
    } catch {
      setOperationError('Failed to move file. Please try again.');
    }
  }, [moveDialog, projectId, fetchTree, setOperationError]);

  const handleMoveAndRename = useCallback(async () => {
    if (!moveDialog) return;
    const sourceNode = tree ? findNodeInTree(tree, moveDialog.sourceId) : null;
    setMoveDialog(null);
    if (!sourceNode) return;
    const newName = `${sourceNode.name.replace(/(\.[^.]+)$/, '')} (1)${sourceNode.name.match(/(\.[^.]+)$/)?.[0] ?? ''}`;
    try {
      await renameFileNode(projectId, moveDialog.sourceId, newName);
      await moveFileNode(projectId, moveDialog.sourceId, moveDialog.targetId);
      await fetchTree();
    } catch {
      setOperationError('Failed to move and rename file. Please try again.');
    }
  }, [moveDialog, tree, projectId, fetchTree, setOperationError]);

  return (
    <div
      ref={containerReference}
      data-testid="file-tree"
      data-drag-active={draggedNodeId ? 'true' : undefined}
      tabIndex={0}
      className="outline-none"
      onKeyDown={handleKeyDown}
      onDragStart={handleTreeDragStart}
      onDragEnd={handleTreeDragEnd}
    >
      {/* Header row: Files label + root actions (owner-only) + optional collapse button. Fixed h-9 to
          match the Outline view's header so the two left-panel views line up. */}
      <div className="flex items-center justify-between px-2 border-b shrink-0 h-9">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Files</span>
        <div className="flex items-center gap-0.5">
          {/* The header actions menu is shown only to users who can modify the file tree. `canEdit`
              here is the file-mutation permission (editor/owner) — it EXCLUDES the global-admin bypass
              (see page.tsx / `canModifyFiles`), so a global admin who is only a viewer of this project
              (e.g. the read-only demo) is treated like any other viewer and sees no menu, rather than
              New File / Upload buttons the API would then reject. */}
          {tree && canEdit && (
            <span data-testid="tree-root-actions">
              <FileTreeActions
                projectId={projectId}
                fileNodeId={tree.id}
                parentId=""
                nodeType="folder"
                nodeName="root"
                hasChildren={tree.children.length > 0}
                isRoot
                canCreate={canEdit}
                onUpdate={fetchTree}
                onError={setOperationError}
                onFind={openFind}
                onCollapseAll={collapseAll}
                onExpandAll={expandAll}
                onRevealInTree={handleRevealFile}
                hasSelection={!!selectedNodeId}
              />
            </span>
          )}
          {onCollapse && (
            <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="collapse sidebar" onClick={onCollapse}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {fetchError && (
        <div className="p-4 text-sm text-muted-foreground">
          <p>Failed to load files.</p>
          <button onClick={fetchTree} className="underline" aria-label="retry">Retry</button>
        </div>
      )}

      {!fetchError && !tree && (
        <div className="p-4 text-sm text-muted-foreground">Loading...</div>
      )}

      <MoveConfirmationDialog
        open={!!moveDialog}
        onOpenChange={(open) => { if (!open) setMoveDialog(null); }}
        sourcePath={moveDialog?.sourcePath ?? ''}
        destinationPath={moveDialog?.targetPath ?? ''}
        hasConflict={moveDialog?.hasConflict ?? false}
        onConfirm={handleMoveConfirm}
        onConfirmAndRename={handleMoveAndRename}
      />

      {tree && (
        <>
          {findOpen && (
            <FindPanel
              query={find.query}
              onQueryChange={handleQueryChange}
              matchCount={find.matchCount}
              currentMatchIndex={find.currentMatchIndex}
              onNext={handleNext}
              onPrev={handlePrevious}
              onDismiss={handleDismissFind}
            />
          )}
          {operationError && (
            <div role="alert" className="flex items-center justify-between px-2 py-1 text-xs text-destructive border-b bg-destructive/10">
              <span>{operationError}</span>
              <button onClick={() => setOperationError(null)} aria-label="dismiss error" className="ml-2 underline">Dismiss</button>
            </div>
          )}
          <DragDropZone targetFolderId={tree.id} projectId={projectId} onComplete={fetchTree} onNodeMove={handleRootDrop} className="min-h-[200px]" data-testid="file-tree-drop-zone">
            {tree.children.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No files yet. Create your first file.</p>
            ) : (
              tree.children.map((node) => (
                <FileTreeNode
                  key={node.id}
                  node={node}
                  depth={0}
                  projectId={projectId}
                  canEdit={canEdit}
                  selectedNodeId={selectedNodeId}
                  onSelect={onSelectFile}
                  onContextMenu={() => {}}
                  onUpdate={fetchTree}
                  onError={setOperationError}
                  isExpanded={expandedState.get(node.id) ?? false}
                  onToggle={toggleExpand}
                  expandedState={expandedState}
                  onFolderDrop={handleFolderDrop}
                  presenceByFile={presenceByFile}
                />
              ))
            )}
          </DragDropZone>
        </>
      )}
    </div>
  );
}
