'use client';
import { useState } from 'react';
import { ChevronRight, ChevronDown, Folder, ArchiveIcon } from 'lucide-react';
import { cn } from '@/lib/utilities';
import { FileIcon } from './file-icon';
import { DragDropZone } from './drag-drop-zone';
import { FileTreeActions } from './file-tree-actions';
import { OpenByOthersMarker } from './open-by-others-marker';
import type { ParticipantPresence } from '@/hooks/use-collab-presence';
import type { FileTreeNode as FileTreeNodeType } from './types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * True when a drag carries OS files (a file or folder upload) rather than an in-tree node move.
 * In-tree drags set the text/plain type, while OS-file drags expose the Files type. The optional
 * chaining is defensive for synthetic test events that omit the types list.
 */
function isFileDrag(event: React.DragEvent): boolean {
  return event.dataTransfer.types?.includes('Files') ?? false;
}

interface Properties {
  node: FileTreeNodeType;
  depth: number;
  /** When true, renders a "Download as ZIP" link for the project root node. */
  isProjectRoot?: boolean;
  projectId: string;
  canEdit: boolean;
  selectedNodeId: string | null;
  onSelect: (nodeId: string, nodeName: string, nodePath: string, nodeType: 'file' | 'folder') => void;
  onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
  onUpdate?: () => void;
  onError?: (message: string | null) => void;
  isExpanded?: boolean;
  onToggle?: (nodeId: string) => void;
  expandedState?: Map<string, boolean>;
  onFolderDrop?: (targetFolderId: string, sourceNodeId: string) => void;
  /** Feature 024: other users currently editing each file, keyed by file node id. */
  presenceByFile?: ReadonlyMap<string, ParticipantPresence[]>;
}

/** Renders a single file or folder node in the file tree, with expand/collapse and drag-drop support. */
export function FileTreeNode({ node, depth, projectId, canEdit, selectedNodeId, onSelect, onContextMenu, onUpdate, onError, isExpanded = false, onToggle, expandedState, isProjectRoot = false, onFolderDrop, presenceByFile }: Properties) {
  const [zipDownloading, setZipDownloading] = useState(false);
  const handleClick = () => {
    if (node.type === 'folder') {
      onToggle?.(node.id);
    } else {
      onSelect(node.id, node.name, node.path, node.type);
    }
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    onContextMenu(event, node.id);
  };

  const isSelected = node.id === selectedNodeId;
  const hasChildren = node.children.length > 0;

  // The folder a drop on this row targets: a folder drops INTO itself; a file drops into its
  // containing folder (so dropping onto a file behaves like dropping onto its folder).
  const dropTargetFolderId = node.type === 'folder' ? node.id : node.parentId;
  // The row only handles in-tree moves. For an OS-file drag it stays out of the way and lets the
  // event bubble to the wrapping DragDropZone, which uploads into the correct folder. Intercepting
  // it here (as before) swallowed the drop and broke uploads.
  const handleNodeDragOver = dropTargetFolderId
    ? (event: React.DragEvent) => {
        if (isFileDrag(event)) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
      }
    : undefined;
  const handleNodeDrop = dropTargetFolderId
    ? (event: React.DragEvent) => {
        if (isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        onFolderDrop?.(dropTargetFolderId, event.dataTransfer.getData('text/plain'));
      }
    : undefined;

  const nodeContent = (
    <div
      data-testid={`tree-node-${node.name}`}
      data-node-id={node.id}
      data-node-path={node.path}
      data-node-type={node.type}
      aria-current={isSelected ? 'true' : undefined}
      draggable
      className={cn(
        // Selected uses the panel-wide "active" language (primary tint + text + 2px left accent bar),
        // matching the Outline's current row and the rail's active tab. border-l-2 is always present
        // (transparent when unselected) so selecting never shifts the row.
        'group flex items-center gap-1 py-0.5 px-2 cursor-pointer rounded-sm select-none border-l-2',
        isSelected ? 'bg-primary/10 text-primary border-primary' : 'border-transparent hover:bg-accent',
      )}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onDragEnter={handleNodeDragOver}
      onDragOver={handleNodeDragOver}
      onDrop={handleNodeDrop}
    >
      {node.type === 'folder' ? (
        <>
          {isExpanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <Folder className="h-4 w-4 shrink-0 text-primary" />
        </>
      ) : (
        <>
          <span className="w-4" />
          <FileIcon name={node.name} />
        </>
      )}
      <span className="truncate text-sm flex-1">{node.name}</span>
      {node.type === 'file' && <OpenByOthersMarker participants={presenceByFile?.get(node.id) ?? []} />}
      {isProjectRoot && (
        <a
          href={`${API_BASE}/projects/${projectId}/download`}
          download
          aria-disabled={zipDownloading || undefined}
          aria-label="Download as ZIP"
          className={cn(
            'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 shrink-0 p-1 rounded hover:bg-muted',
            zipDownloading && 'pointer-events-none opacity-50',
          )}
          onClick={(event) => {
            if (zipDownloading) { event.preventDefault(); return; }
            setZipDownloading(true);
            setTimeout(() => setZipDownloading(false), 1000);
          }}
        >
          <ArchiveIcon className="h-4 w-4" />
          <span className="sr-only">Download as ZIP</span>
        </a>
      )}
      {canEdit && (
        // Stop clicks on the actions menu (trigger and items) from bubbling to the row's onClick,
        // which would select/open the node — e.g. "Copy path" must not change the open file.
        <span
          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 shrink-0"
          onClick={(event) => event.stopPropagation()}
        >
          <FileTreeActions
            projectId={projectId}
            fileNodeId={node.id}
            parentId={node.parentId ?? ''}
            nodeType={node.type}
            nodeName={node.name}
            nodePath={node.path}
            hasChildren={hasChildren}
            canCreate={node.type === 'folder'}
            onUpdate={onUpdate}
            onError={onError}
          />
        </span>
      )}
    </div>
  );

  if (node.type === 'folder') {
    return (
      <DragDropZone targetFolderId={node.id} projectId={projectId} onComplete={onUpdate}>
        {nodeContent}
        {isExpanded && node.children.map((child) => (
          <FileTreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            projectId={projectId}
            canEdit={canEdit}
            selectedNodeId={selectedNodeId}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            onUpdate={onUpdate}
            onError={onError}
            isExpanded={expandedState?.get(child.id) ?? false}
            onToggle={onToggle}
            expandedState={expandedState}
            onFolderDrop={onFolderDrop}
            presenceByFile={presenceByFile}
          />
        ))}
      </DragDropZone>
    );
  }

  return nodeContent;
}
