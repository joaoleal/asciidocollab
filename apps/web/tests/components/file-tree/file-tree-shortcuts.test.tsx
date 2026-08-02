import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileTree } from '@/components/file-tree/file-tree';
import { createFileNode, createFolder, deleteFileNode, renameFileNode } from '@/lib/api/file-tree';

// This suite renders the REAL FileTreeNode and FileTreeActions underneath FileTree, because the
// behaviour under test spans all three: a shortcut is captured by the tree container, but the dialog
// it must open lives in the per-node actions menu. Mocking either of them away would hide exactly the
// wiring gap this suite exists to catch — every one of these shortcuts was, until recently, bound to
// an empty function.

jest.mock('@/hooks/use-file-tree-events', () => ({
  useFileTreeEvents: jest.fn(),
}));

// The user's bindings come from the server; here they are pinned to the shipped default so the test
// describes the shortcut the user actually presses rather than whatever a fixture happens to store.
jest.mock('@/hooks/use-key-bindings', () => ({
  useKeyBindings: jest.fn(() => new Map([
    ['file-tree:rename', 'F2'],
    ['file-tree:delete', 'Delete'],
    ['file-tree:new-file', 'Ctrl+N'],
    ['file-tree:new-folder', 'Ctrl+Shift+N'],
  ])),
}));

jest.mock('@/hooks/use-drop-upload', () => ({
  useDropUpload: () => ({ onFiles: jest.fn(), progress: [], clearProgress: jest.fn() }),
}));

// Radix renders its dialog through a portal with focus traps that jsdom cannot drive; this inline
// stand-in keeps the open/closed contract (nothing in the DOM while closed) so a rendered rename
// input is unambiguous evidence that the dialog opened for exactly one node.
jest.mock('@radix-ui/react-dialog', () => ({
  Root: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="dialog-root">{children}</div> : null,
  Portal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Overlay: () => null,
  Content: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog-content">{children}</div>,
  Title: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  Close: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

jest.mock('@/lib/api/file-tree', () => ({
  createFolder: jest.fn().mockResolvedValue({ fileNodeId: 'new-folder', path: '/new-folder' }),
  createFileNode: jest.fn().mockResolvedValue({ fileNodeId: 'new-file', path: '/new-file.adoc' }),
  renameFileNode: jest.fn().mockResolvedValue(undefined),
  moveFileNode: jest.fn().mockResolvedValue(undefined),
  deleteFileNode: jest.fn().mockResolvedValue(undefined),
  FileTreeApiError: class FileTreeApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));

const projectId = 'proj-1';

const rootNode = {
  id: 'root-1',
  name: 'root',
  type: 'folder' as const,
  path: '/',
  parentId: null,
  children: [
    {
      id: 'folder-1',
      name: 'parts',
      type: 'folder' as const,
      path: '/parts',
      parentId: 'root-1',
      children: [
        { id: 'file-3', name: 'appendix.adoc', type: 'file' as const, path: '/parts/appendix.adoc', parentId: 'folder-1', children: [] },
      ],
    },
    { id: 'file-1', name: 'intro.adoc', type: 'file' as const, path: '/intro.adoc', parentId: 'root-1', children: [] },
    { id: 'file-2', name: 'chapter.adoc', type: 'file' as const, path: '/chapter.adoc', parentId: 'root-1', children: [] },
  ],
};

function renderTree(selectedNodeId: string | null, canEdit = true) {
  return render(
    <FileTree
      projectId={projectId}
      canEdit={canEdit}
      onSelectFile={jest.fn()}
      selectedNodeId={selectedNodeId}
    />,
  );
}

async function renderLoadedTree(selectedNodeId: string | null, canEdit = true) {
  renderTree(selectedNodeId, canEdit);
  await waitFor(() => expect(screen.getByTestId('tree-node-intro.adoc')).toBeInTheDocument());
}

function pressShortcut(init: { key: string; ctrlKey?: boolean; shiftKey?: boolean }) {
  fireEvent.keyDown(screen.getByTestId('file-tree'), init);
}

function pressRenameShortcut() {
  pressShortcut({ key: 'F2' });
}

describe('acting on a file tree node from the keyboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(rootNode),
    } as Response);
    // jsdom has no scrollIntoView, and selecting a node makes the tree scroll it into view.
    Element.prototype.scrollIntoView = jest.fn();
  });

  it('opens the rename dialog for the selected node, pre-filled with its current name', async () => {
    await renderLoadedTree('file-1');

    pressRenameShortcut();

    const input = await screen.findByRole('textbox');
    expect(input).toHaveValue('intro.adoc');
  });

  it('renames the node the user has selected, not some other node in the tree', async () => {
    await renderLoadedTree('file-2');

    pressRenameShortcut();

    // Exactly one dialog is open, and it belongs to the selected node — a shortcut that opened every
    // node's dialog (or the wrong one) would show a different count or a different name here.
    const inputs = await screen.findAllByRole('textbox');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toHaveValue('chapter.adoc');
  });

  it('confirming the dialog renames the node through the file tree API', async () => {
    await renderLoadedTree('file-1');

    pressRenameShortcut();

    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'overview.adoc' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() =>
      expect(renameFileNode).toHaveBeenCalledWith(projectId, 'file-1', 'overview.adoc'),
    );
  });

  it('does nothing when no node is selected', async () => {
    await renderLoadedTree(null);

    pressRenameShortcut();

    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
  });

  it('does nothing for a viewer who cannot modify the file tree', async () => {
    await renderLoadedTree('file-1', false);

    pressRenameShortcut();

    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
  });

  it('reopens the dialog after it has been dismissed once, so the shortcut is not single-use', async () => {
    await renderLoadedTree('file-1');

    pressRenameShortcut();
    fireEvent.click(await screen.findByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());

    pressRenameShortcut();

    expect(await screen.findByRole('textbox')).toHaveValue('intro.adoc');
  });

  it('asks before deleting the selected node, and deletes it once confirmed', async () => {
    await renderLoadedTree('file-1');

    pressShortcut({ key: 'Delete' });

    // Deleting goes through the same confirmation the menu item raises. A shortcut that deleted
    // outright would be a keystroke away from losing a file, with no way back.
    expect(await screen.findByText('Delete intro.adoc?')).toBeInTheDocument();
    expect(deleteFileNode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(deleteFileNode).toHaveBeenCalledWith(projectId, 'file-1'));
  });

  it('creates a new file in the folder holding the selection', async () => {
    await renderLoadedTree('file-3');

    pressShortcut({ key: 'n', ctrlKey: true });

    // Only files are ever selected — clicking a folder expands it — so "here" means the folder the
    // selected file sits in, which is where the reader is looking.
    const input = await screen.findByRole('textbox');
    expect(input).toHaveValue('new-document.adoc');

    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() =>
      expect(createFileNode).toHaveBeenCalledWith(projectId, 'folder-1', 'new-document.adoc'),
    );
  });

  it('creates a new folder in the folder holding the selection', async () => {
    await renderLoadedTree('file-3');

    pressShortcut({ key: 'n', ctrlKey: true, shiftKey: true });

    const input = await screen.findByRole('textbox');
    expect(input).toHaveValue('New Folder');

    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(createFolder).toHaveBeenCalledWith(projectId, 'folder-1', 'New Folder'));
  });

  it('creates at the project root when the selected file sits there', async () => {
    await renderLoadedTree('file-1');

    pressShortcut({ key: 'n', ctrlKey: true });

    fireEvent.click(await screen.findByRole('button', { name: /confirm/i }));

    // A file directly under the root resolves to the root's own menu, which carries the same two
    // create items — so the shortcut works everywhere in the tree rather than only inside folders.
    await waitFor(() =>
      expect(createFileNode).toHaveBeenCalledWith(projectId, 'root-1', 'new-document.adoc'),
    );
  });

  it('does nothing for a viewer, whichever shortcut they press', async () => {
    await renderLoadedTree('file-1', false);

    pressShortcut({ key: 'Delete' });
    pressShortcut({ key: 'n', ctrlKey: true });
    pressShortcut({ key: 'n', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(screen.queryByText('Delete intro.adoc?')).not.toBeInTheDocument();
    expect(deleteFileNode).not.toHaveBeenCalled();
    expect(createFileNode).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
  });
});
