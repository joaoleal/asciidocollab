'use client';
import { useEffect, useRef, useState } from 'react';

import {
  MoreHorizontal,
  Search,
  FilePlus,
  FolderPlus,
  Upload,
  FolderUp,
  Copy,
  Pencil,
  Trash2,
  FoldVertical,
  UnfoldVertical,
  LocateFixed,
  Download,
  Archive,
} from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmationDialog } from '@/components/confirmation-dialog';
import { UploadProgressPanel } from './upload-progress-panel';
import { useDropUpload } from '@/hooks/use-drop-upload';
import { createFolder, createFileNode, renameFileNode, deleteFileNode, FileTreeApiError } from '@/lib/api/file-tree';
import { isThemeFilePath } from '@asciidocollab/shared';
import { saveDocumentContent } from '@/lib/api/file-content';
import { themeSeedContent } from '@/lib/pdf/theme-seed';
import { API_BASE_URL } from '@/lib/api/base-url';
import type { NodeActionKind } from './types';

type DialogKind =
  | { type: 'rename'; currentName: string }
  | { type: 'delete' }
  | { type: 'create-file' }
  | { type: 'create-folder' }
  | null;

interface Properties {
  projectId: string;
  fileNodeId: string;
  parentId: string;
  nodeType: 'file' | 'folder';
  nodeName: string;
  /** Project-relative path of this node, used by the "Copy path" action. */
  nodePath?: string;
  hasChildren: boolean;
  onUpdate?: () => void;
  onError?: (message: string | null) => void;
  /** When true, hides Rename and Delete — used for the root folder. */
  isRoot?: boolean;
  /** When true, shows New File and New Folder — pass only for owners. */
  canCreate?: boolean;
  /** When provided, shows a "Find File…" item at the top of the menu. */
  onFind?: () => void;
  /** When provided, shows a "Collapse All" item. */
  onCollapseAll?: () => void;
  /** When provided, shows an "Expand All" item. */
  onExpandAll?: () => void;
  /** When provided, shows a "Reveal in Tree" item. */
  onRevealInTree?: () => void;
  /** Controls whether "Reveal in Tree" is enabled (requires a selected file). */
  hasSelection?: boolean;
  /**
   * Opens one of this node's dialogs whenever the request's nonce changes, for callers that trigger
   * an action from outside the menu (the tree's keyboard shortcuts). Pass `undefined` on every node
   * the request is not aimed at. The nonce CHANGING — not merely being present — is what opens the
   * dialog, so a node that becomes the target while carrying an older value stays closed until the
   * user actually presses the key again.
   */
  actionRequest?: { action: NodeActionKind; nonce: number };
}

/**
 * The value a dialog's text input starts with.
 *
 * Shared by the menu items and the keyboard shortcuts so the two cannot drift: a shortcut that
 * pre-filled a different default from its menu item would be a second, subtly different action
 * wearing the same name.
 */
function initialInputValue(kind: NonNullable<DialogKind>): string {
  switch (kind.type) {
    case 'rename': {
      return kind.currentName;
    }
    case 'create-file': {
      return 'new-document.adoc';
    }
    case 'create-folder': {
      return 'New Folder';
    }
    case 'delete': {
      return '';
    }
  }
}

/** Renders the context-menu action buttons (create, rename, delete, tree navigation) for a file tree node. */
export function FileTreeActions({
  projectId, fileNodeId, nodeType, nodeName, nodePath, hasChildren,
  onUpdate, onError, isRoot = false, canCreate = false,
  onFind, onCollapseAll, onExpandAll, onRevealInTree, hasSelection = false, actionRequest,
}: Properties) {
  // Path copied/used in macros is project-root-relative (no leading slash), matching include::/image:: targets.
  const relativePath = (nodePath ?? '').replace(/^\//, '');
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [inputValue, setInputValue] = useState('');

  // Upload support. Uploads target this node's folder (or the root). Files dropped via the OS
  // picker reuse the same upload pipeline as drag-and-drop (useDropUpload), so nested folders
  // and progress reporting behave identically.
  const canUpload = canCreate && nodeType === 'folder';
  const fileInputReference = useRef<HTMLInputElement>(null);
  const folderInputReference = useRef<HTMLInputElement>(null);
  const { onFiles, progress, clearProgress } = useDropUpload(fileNodeId, projectId, onUpdate);

  useEffect(() => {
    // `webkitdirectory`/`directory` enable folder selection but are not in the React DOM types,
    // so they are set imperatively on the hidden folder input.
    const element = folderInputReference.current;
    if (element) {
      element.setAttribute('webkitdirectory', '');
      element.setAttribute('directory', '');
    }
  }, []);

  const handleFilesSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { files } = event.target;
    if (files && files.length > 0) {
      onError?.(null);
      void onFiles(files);
    }
    // Reset so picking the same file/folder again re-triggers the change event.
    event.target.value = '';
  };

  const handleAction = async (action: () => Promise<void>): Promise<boolean> => {
    try {
      onError?.(null);
      await action();
      onUpdate?.();
      return true;
    } catch (error_) {
      if (error_ instanceof FileTreeApiError && error_.status === 409) {
        onError?.('A file or folder with that name already exists.');
      } else {
        onError?.(error_ instanceof Error ? error_.message : 'An error occurred.');
      }
      return false;
    }
  };

  const openDialog = (kind: NonNullable<DialogKind>) => {
    setInputValue(initialInputValue(kind));
    setDialog(kind);
  };

  const closeDialog = () => setDialog(null);

  // Open a dialog when an outside caller (one of the tree's keyboard shortcuts) asks this node for an
  // action. It opens the SAME dialog the corresponding menu item opens, so a shortcut and its menu
  // item are one action: same validation, same handling of a name already taken, same refresh.
  //
  // Tracking the last-seen nonce in a ref makes this fire once per request: the dialog opens when the
  // nonce CHANGES, never merely because one is present, so re-renders — and a node handed a stale
  // value — leave it closed. The setters are inlined rather than calling `openDialog` because that
  // helper is re-created every render; depending on it would reopen the dialog in a loop the moment
  // its own state update re-rendered the component.
  //
  // The two guards mirror the menu exactly. Whatever a shortcut can reach, the menu offers on the
  // same node under the same conditions — a shortcut that opened a dialog the menu withholds would be
  // a way around a restriction the menu is there to express, and the API would refuse it anyway.
  const lastActionRequestReference = useRef(actionRequest?.nonce);
  useEffect(() => {
    if (actionRequest === undefined) return;
    if (lastActionRequestReference.current === actionRequest.nonce) return;
    lastActionRequestReference.current = actionRequest.nonce;
    const { action } = actionRequest;
    if (isRoot && (action === 'rename' || action === 'delete')) return;
    if ((action === 'create-file' || action === 'create-folder') && !(canCreate && nodeType === 'folder')) return;
    const kind: NonNullable<DialogKind> = action === 'rename' ? { type: 'rename', currentName: nodeName } : { type: action };
    setInputValue(initialInputValue(kind));
    setDialog(kind);
  }, [actionRequest, nodeName, isRoot, canCreate, nodeType]);

  const handleConfirm = async () => {
    if (!dialog) return;
    let ok = false;
    switch (dialog.type) {
    case 'rename': {
      ok = await handleAction(() => renameFileNode(projectId, fileNodeId, inputValue));

    break;
    }
    case 'create-file': {
      ok = await handleAction(async () => {
        const created = await createFileNode(projectId, fileNodeId, inputValue);
        // A theme starts as a copy of the renderer's own default rather than empty, so an author has
        // something to edit and their first preview matches what they saw before creating it
        // (FR-010). Seeding is best-effort: a file that exists but could not be seeded is recoverable
        // (the author types into it), whereas failing the whole creation over it is not.
        if (isThemeFilePath(inputValue)) {
          try {
            await saveDocumentContent(projectId, created.fileNodeId, themeSeedContent());
          } catch {
            // Reported rather than swallowed. The file is now EMPTY, and an empty theme is not
            // inert: theme discovery picks it up by name, and the loader turns empty YAML into a
            // theme with no font catalogue rather than falling back — so every export from this
            // project silently renders unstyled until the author acts. Creation still counts as
            // successful, because the file does exist and typing into it is the fix.
            onError?.(
              `${inputValue} was created but could not be filled with the default theme, so it is ` +
                'empty. An empty theme file is still applied to this project and will render it ' +
                'unstyled — open it and add a theme, or delete it.',
            );
          }
        }
      });

    break;
    }
    case 'create-folder': {
      ok = await handleAction(async () => { await createFolder(projectId, fileNodeId, inputValue); });

    break;
    }
    // No default
    }
    if (ok) closeDialog();
  };

  const isInputDialog = dialog?.type === 'rename' || dialog?.type === 'create-file' || dialog?.type === 'create-folder';
  const isDeleteDialog = dialog?.type === 'delete';

  const hasNavActions = !!(onFind || onCollapseAll || onExpandAll || onRevealInTree);
  const hasMutationActions = (canCreate && nodeType === 'folder') || !isRoot;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="actions" className="h-6 w-6 p-0">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* Navigation actions */}
          {onFind && (
            <DropdownMenuItem onSelect={onFind}>
              <Search className="h-4 w-4 mr-2 shrink-0" />
              Find File…
            </DropdownMenuItem>
          )}
          {onCollapseAll && (
            <DropdownMenuItem onSelect={onCollapseAll}>
              <FoldVertical className="h-4 w-4 mr-2 shrink-0" />
              Collapse All
            </DropdownMenuItem>
          )}
          {onExpandAll && (
            <DropdownMenuItem onSelect={onExpandAll}>
              <UnfoldVertical className="h-4 w-4 mr-2 shrink-0" />
              Expand All
            </DropdownMenuItem>
          )}
          {onRevealInTree && (
            <DropdownMenuItem onSelect={onRevealInTree} disabled={!hasSelection}>
              <LocateFixed className="h-4 w-4 mr-2 shrink-0" />
              Reveal in Tree
            </DropdownMenuItem>
          )}

          {/* Separator between navigation and mutation groups */}
          {hasNavActions && hasMutationActions && <DropdownMenuSeparator />}

          {/* File / folder creation */}
          {canCreate && nodeType === 'folder' && (
            <DropdownMenuItem onSelect={() => openDialog({ type: 'create-file' })}>
              <FilePlus className="h-4 w-4 mr-2 shrink-0" />
              New File
            </DropdownMenuItem>
          )}
          {canCreate && nodeType === 'folder' && (
            <DropdownMenuItem onSelect={() => openDialog({ type: 'create-folder' })}>
              <FolderPlus className="h-4 w-4 mr-2 shrink-0" />
              New Folder
            </DropdownMenuItem>
          )}

          {/* Upload from the OS file picker — synchronous .click() keeps the user gesture so the
              browser allows the file dialog to open. */}
          {canUpload && (
            <DropdownMenuItem onSelect={() => fileInputReference.current?.click()}>
              <Upload className="h-4 w-4 mr-2 shrink-0" />
              Upload Files…
            </DropdownMenuItem>
          )}
          {canUpload && (
            <DropdownMenuItem onSelect={() => folderInputReference.current?.click()}>
              <FolderUp className="h-4 w-4 mr-2 shrink-0" />
              Upload Folder…
            </DropdownMenuItem>
          )}

          {/* Download ZIP for the project root */}
          {isRoot && (
            <DropdownMenuItem asChild>
              <a
                href={`${API_BASE_URL}/projects/${projectId}/download`}
                download
                className="flex items-center"
              >
                <Archive className="h-4 w-4 mr-2 shrink-0" />
                Download ZIP
              </a>
            </DropdownMenuItem>
          )}

          {/* Node-level actions (hidden for root) */}
          {!isRoot && relativePath && (
            <DropdownMenuItem onSelect={() => { void navigator.clipboard?.writeText(relativePath); }}>
              <Copy className="h-4 w-4 mr-2 shrink-0" />
              Copy path
            </DropdownMenuItem>
          )}
          {!isRoot && (
            <DropdownMenuItem onSelect={() => openDialog({ type: 'rename', currentName: nodeName })}>
              <Pencil className="h-4 w-4 mr-2 shrink-0" />
              Rename
            </DropdownMenuItem>
          )}
          {!isRoot && nodeType === 'file' && (
            <DropdownMenuItem asChild>
              <a
                href={`${API_BASE_URL}/projects/${projectId}/files/${fileNodeId}/download`}
                download
                className="flex items-center"
              >
                <Download className="h-4 w-4 mr-2 shrink-0" />
                Download
              </a>
            </DropdownMenuItem>
          )}
          {!isRoot && (
            <DropdownMenuItem
              className="text-destructive"
              onSelect={() => openDialog({ type: 'delete' })}
            >
              <Trash2 className="h-4 w-4 mr-2 shrink-0" />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Hidden inputs that back the Upload menu items, plus their progress overlay. */}
      {canUpload && (
        <>
          <input
            ref={fileInputReference}
            type="file"
            multiple
            className="hidden"
            data-testid="upload-files-input"
            onChange={handleFilesSelected}
          />
          <input
            ref={folderInputReference}
            type="file"
            className="hidden"
            data-testid="upload-folder-input"
            onChange={handleFilesSelected}
          />
          {progress.length > 0 && <UploadProgressPanel progress={progress} onDismiss={clearProgress} />}
        </>
      )}

      {/* Rename / Create dialog */}
      <Dialog.Root open={isInputDialog} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-lg bg-background p-6 shadow-lg">
            <Dialog.Title className="text-lg font-semibold mb-4">
              {dialog?.type === 'rename' && 'Rename'}
              {dialog?.type === 'create-file' && 'New File'}
              {dialog?.type === 'create-folder' && 'New Folder'}
            </Dialog.Title>
            <Input
              value={inputValue}
              onChange={(event_) => setInputValue(event_.target.value)}
              onKeyDown={(event_) => { if (event_.key === 'Enter') handleConfirm(); }}
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-3">
              <Button variant="outline" onClick={closeDialog}>Cancel</Button>
              <Button onClick={handleConfirm}>Confirm</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Delete confirmation */}
      <ConfirmationDialog
        open={isDeleteDialog}
        onOpenChange={(open) => { if (!open) closeDialog(); }}
        title={`Delete ${nodeName}?`}
        description={
          nodeType === 'folder' && hasChildren
            ? 'This will also delete all files inside.'
            : `Are you sure you want to delete "${nodeName}"?`
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={async () => {
          const ok = await handleAction(() => deleteFileNode(projectId, fileNodeId));
          if (ok) closeDialog();
        }}
      />

    </>
  );
}
