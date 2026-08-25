import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { FileTreeNode } from '@/components/file-tree/file-tree-node';

// The open-by-others marker renders the shared DiceBear avatar; stub it so the tree tests don't
// generate SVG in jsdom (they assert on the marker, not the avatar image).
jest.mock('@/components/avatar', () => ({
  Avatar: ({ displayName }: { displayName: string }) =>
    require('react').createElement('span', { 'data-testid': 'participant-avatar', 'data-display-name': displayName }),
}));

jest.mock('@/components/file-tree/drag-drop-zone', () => ({
  DragDropZone: ({ children, targetFolderId }: { children: React.ReactNode; targetFolderId: string }) => (
    <div data-testid={`drop-zone-${targetFolderId}`}>{children}</div>
  ),
}));

jest.mock('@/components/file-tree/file-tree-actions', () => ({
  FileTreeActions: ({ nodeType, onUpdate, onError }: { nodeType: string; onUpdate?: () => void; onError?: (m: string | null) => void }) => (
    <button
      data-testid="file-tree-actions"
      data-has-on-error={String(typeof onError === 'function')}
      onClick={onUpdate}
    >
      {nodeType} actions
    </button>
  ),
}));

const fileNode = {
  id: 'file-1',
  name: 'document.adoc',
  type: 'file' as const,
  path: '/document.adoc',
  parentId: 'folder-root',
  children: [],
};

const folderNode = {
  id: 'folder-1',
  name: 'src',
  type: 'folder' as const,
  path: '/src',
  parentId: 'folder-root',
  children: [fileNode],
};

describe('FileTreeNode', () => {
  it('renders with data-node-id attribute matching node id', () => {
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
      />,
    );
    expect(screen.getByTestId('tree-node-document.adoc')).toHaveAttribute('data-node-id', fileNode.id);
  });

  it('renders file node name', () => {
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
      />,
    );
    expect(screen.getByText('document.adoc')).toBeInTheDocument();
  });

  it('renders folder node as collapsible via controlled isExpanded/onToggle props', () => {
    const onToggle = jest.fn();

    const { rerender } = render(
      <FileTreeNode
        node={folderNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        isExpanded={false}
        onToggle={onToggle}
      />,
    );

    // Initially collapsed (isExpanded=false)
    expect(screen.queryByText('document.adoc')).not.toBeInTheDocument();

    // Click fires onToggle, not internal state
    fireEvent.click(screen.getByText('src'));
    expect(onToggle).toHaveBeenCalledWith(folderNode.id);

    // Parent re-renders with isExpanded=true
    rerender(
      <FileTreeNode
        node={folderNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        isExpanded={true}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByText('document.adoc')).toBeInTheDocument();
  });

  it('calls onSelect on click with nodeId, nodeName, nodePath, nodeType', () => {
    const onSelect = jest.fn();
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={onSelect}
        onContextMenu={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByText('document.adoc'));
    expect(onSelect).toHaveBeenCalledWith(fileNode.id, fileNode.name, fileNode.path, 'file');
  });

  it('does NOT call onSelect when a folder node is clicked — only toggles expand', () => {
    const onSelect = jest.fn();
    const onToggle = jest.fn();
    render(
      <FileTreeNode
        node={folderNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={onSelect}
        onContextMenu={jest.fn()}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByText('src'));
    expect(onToggle).toHaveBeenCalledWith(folderNode.id);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('calls onContextMenu on right-click', () => {
    const onContextMenu = jest.fn();
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={onContextMenu}
      />,
    );
    fireEvent.contextMenu(screen.getByText('document.adoc'));
    expect(onContextMenu).toHaveBeenCalledWith(expect.any(Object), fileNode.id);
  });

  it('folder nodes are wrapped in DragDropZone', () => {
    render(
      <FileTreeNode
        node={folderNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
      />,
    );
    expect(screen.getByTestId(`drop-zone-${folderNode.id}`)).toBeInTheDocument();
  });

  // selectedNodeId matches node.id → the active "selected" highlight class is applied
  // (primary tint, unified with the Outline current row + rail active tab).
  it('applies the selected highlight class when selectedNodeId matches node id', () => {
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={fileNode.id}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
      />,
    );
    const nodeElement = screen.getByText('document.adoc').closest('div');
    expect(nodeElement).toHaveClass('bg-primary/10', 'text-primary', 'border-primary');
  });

  // canEdit=false → no action button rendered
  it('does not render action button when canEdit=false', () => {
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('file-tree-actions')).not.toBeInTheDocument();
  });

  // canEdit=true → action button rendered
  it('renders action button when canEdit=true', () => {
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit={true}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
      />,
    );
    expect(screen.getByTestId('file-tree-actions')).toBeInTheDocument();
  });

  // onError prop is threaded through FileTreeNode to FileTreeActions
  it('passes onError prop through to FileTreeActions', () => {
    const onError = jest.fn();
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit={true}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        onError={onError}
      />,
    );
    // FileTreeActions mock renders a button; clicking it calls onUpdate (not onError directly)
    // We need the mock to also surface onError — update the mock to pass onError as data
    const actionsButton = screen.getByTestId('file-tree-actions');
    expect(actionsButton).toHaveAttribute('data-has-on-error', 'true');
  });

  // BUG: FileTreeNode hardcodes onUpdate={() => {}} so mutations never propagate up
  // Fix: FileTreeNode must accept and forward an onUpdate prop to FileTreeActions
  it('forwards onUpdate prop to FileTreeActions — calling it invokes the prop', () => {
    const onUpdate = jest.fn();
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit={true}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.click(screen.getByTestId('file-tree-actions'));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});

// ── Download as ZIP ───────────────────────────────────────────────────────────

describe('FileTreeNode — Download as ZIP (root project node)', () => {
  const rootFolderNode = {
    id: 'root-1',
    name: 'My Project',
    type: 'folder' as const,
    path: '/',
    parentId: null,
    children: [],
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders "Download as ZIP" link for root project nodes (parentId=null)', () => {
    render(
      <FileTreeNode
        node={rootFolderNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        isProjectRoot
      />,
    );
    const link = screen.getByRole('link', { name: /download as zip/i });
    expect(link).toBeInTheDocument();
  });

  it('Download as ZIP link points to the project ZIP download endpoint', () => {
    render(
      <FileTreeNode
        node={rootFolderNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        isProjectRoot
      />,
    );
    const link = screen.getByRole('link', { name: /download as zip/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/projects/proj-1/download'));
    expect(link).toHaveAttribute('download');
  });

  it('does NOT render "Download as ZIP" for non-root nodes', () => {
    const nonRoot = { ...rootFolderNode, parentId: 'some-parent', id: 'child-1' };
    render(
      <FileTreeNode
        node={nonRoot}
        depth={1}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
      />,
    );
    expect(screen.queryByRole('link', { name: /download as zip/i })).not.toBeInTheDocument();
  });

  it('Download as ZIP link is disabled immediately on click', () => {
    render(
      <FileTreeNode
        node={rootFolderNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        isProjectRoot
      />,
    );
    const link = screen.getByRole('link', { name: /download as zip/i });
    fireEvent.click(link);
    // After click, link should have aria-disabled or pointer-events-none
    expect(link).toHaveAttribute('aria-disabled', 'true');
  });

  it('Download as ZIP re-enables after 1 second', () => {
    render(
      <FileTreeNode
        node={rootFolderNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        isProjectRoot
      />,
    );
    const link = screen.getByRole('link', { name: /download as zip/i });
    fireEvent.click(link);
    expect(link).toHaveAttribute('aria-disabled', 'true');

    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(link).not.toHaveAttribute('aria-disabled');
  });

  it('ignores a second ZIP click while a download is already in progress', () => {
    render(
      <FileTreeNode
        node={rootFolderNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        isProjectRoot
      />,
    );
    const link = screen.getByRole('link', { name: /download as zip/i });
    fireEvent.click(link);
    fireEvent.click(link); // second click hits the in-progress guard
    expect(link).toHaveAttribute('aria-disabled', 'true');
  });

  it('handles drag-over and drop on a folder row', () => {
    const onFolderDrop = jest.fn();
    render(
      <FileTreeNode
        node={folderNode}
        depth={0}
        projectId="proj-1"
        canEdit
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        onFolderDrop={onFolderDrop}
        isExpanded
        onToggle={jest.fn()}
      />,
    );
    const row = screen.getByTestId('tree-node-src');
    fireEvent.dragEnter(row, { dataTransfer: { dropEffect: '' } });
    fireEvent.dragOver(row, { dataTransfer: { dropEffect: '' } });
    fireEvent.drop(row, { dataTransfer: { getData: () => 'file-1' } });
    expect(onFolderDrop).toHaveBeenCalledWith('folder-1', 'file-1');
  });

  it('handles drop on a FILE row → moves the dragged node into the file\'s parent folder', () => {
    const onFolderDrop = jest.fn();
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        onFolderDrop={onFolderDrop}
      />,
    );
    const row = screen.getByTestId('tree-node-document.adoc');
    fireEvent.dragEnter(row, { dataTransfer: { dropEffect: '' } });
    fireEvent.dragOver(row, { dataTransfer: { dropEffect: '' } });
    fireEvent.drop(row, { dataTransfer: { getData: () => 'other-file' } });
    // fileNode.parentId is 'folder-root' → the move targets that containing folder.
    expect(onFolderDrop).toHaveBeenCalledWith('folder-root', 'other-file');
  });

  it('a file with no parent folder is not a drop target', () => {
    const onFolderDrop = jest.fn();
    render(
      <FileTreeNode
        node={{ ...fileNode, parentId: null }}
        depth={0}
        projectId="proj-1"
        canEdit
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        onFolderDrop={onFolderDrop}
      />,
    );
    const row = screen.getByTestId('tree-node-document.adoc');
    fireEvent.drop(row, { dataTransfer: { getData: () => 'x' } });
    expect(onFolderDrop).not.toHaveBeenCalled();
  });

  it('ignores an OS-file drag so it bubbles to the DragDropZone for upload (no move)', () => {
    const onFolderDrop = jest.fn();
    render(
      <FileTreeNode
        node={folderNode}
        depth={0}
        projectId="proj-1"
        canEdit
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        onFolderDrop={onFolderDrop}
      />,
    );
    const row = screen.getByTestId('tree-node-src');
    // A drop carrying the "Files" type is an upload, not an in-tree move.
    fireEvent.drop(row, { dataTransfer: { types: ['Files'], getData: () => '' } });
    expect(onFolderDrop).not.toHaveBeenCalled();
  });

  it('still handles an in-tree move drop (types = text/plain)', () => {
    const onFolderDrop = jest.fn();
    render(
      <FileTreeNode
        node={folderNode}
        depth={0}
        projectId="proj-1"
        canEdit
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        onFolderDrop={onFolderDrop}
      />,
    );
    const row = screen.getByTestId('tree-node-src');
    fireEvent.drop(row, { dataTransfer: { types: ['text/plain'], getData: () => 'file-1' } });
    expect(onFolderDrop).toHaveBeenCalledWith('folder-1', 'file-1');
  });

  it('renders actions for a node with no parent (root-level)', () => {
    render(
      <FileTreeNode
        node={{ ...fileNode, parentId: null }}
        depth={0}
        projectId="proj-1"
        canEdit
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
      />,
    );
    expect(screen.getByTestId('file-tree-actions')).toBeInTheDocument();
  });

  it('ignores an OS-file drag-over so it bubbles to the DragDropZone (no preventDefault path)', () => {
    const onFolderDrop = jest.fn();
    render(
      <FileTreeNode
        node={folderNode}
        depth={0}
        projectId="proj-1"
        canEdit
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        onFolderDrop={onFolderDrop}
      />,
    );
    const row = screen.getByTestId('tree-node-src');
    // dragOver/dragEnter carrying the Files type must early-return (no move handling).
    fireEvent.dragOver(row, { dataTransfer: { types: ['Files'], dropEffect: '' } });
    fireEvent.dragEnter(row, { dataTransfer: { types: ['Files'], dropEffect: '' } });
    fireEvent.drop(row, { dataTransfer: { types: ['Files'], getData: () => '' } });
    expect(onFolderDrop).not.toHaveBeenCalled();
  });

  it('renders the open-by-others marker for a file other users have open', () => {
    const presenceByFile = new Map([
      ['file-1', [{ clientId: 1, userId: 'u1', name: 'Ada', color: '#f00', colorLight: '#fcc' }]],
    ]);
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        presenceByFile={presenceByFile}
      />,
    );
    expect(screen.getByTestId('open-by-others-marker')).toBeInTheDocument();
  });

  it('renders no marker for a file with a presence map but no entry for this node', () => {
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        presenceByFile={new Map()}
      />,
    );
    expect(screen.queryByTestId('open-by-others-marker')).not.toBeInTheDocument();
  });

  it('renders a git status badge for a file with a non-unchanged status', () => {
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        statusByFileNodeId={{ 'file-1': 'modified' }}
      />,
    );
    expect(screen.getByRole('img', { name: 'Modified' })).toBeInTheDocument();
  });

  it('renders no git status badge for a file with an unchanged status', () => {
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        statusByFileNodeId={{ 'file-1': 'unchanged' }}
      />,
    );
    expect(screen.queryByRole('img', { name: /modified|staged|untracked|removed|conflicted/i })).not.toBeInTheDocument();
  });

  it('renders no git status badge for a file missing from the status map', () => {
    render(
      <FileTreeNode
        node={fileNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        statusByFileNodeId={{}}
      />,
    );
    expect(screen.queryByRole('img', { name: /modified|staged|untracked|removed|conflicted/i })).not.toBeInTheDocument();
  });

  it('renders no git status badge for a folder node, even if the status map carries its id', () => {
    render(
      <FileTreeNode
        node={folderNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        statusByFileNodeId={{ 'folder-1': 'modified' }}
      />,
    );
    expect(screen.queryByRole('img', { name: 'Modified' })).not.toBeInTheDocument();
  });

  it('renders a roll-up badge on a folder when a descendant file has a changed status', () => {
    render(
      <FileTreeNode
        node={folderNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        statusByFileNodeId={{ 'file-1': 'modified' }}
      />,
    );
    expect(screen.getByRole('img', { name: 'Contains changes: Modified' })).toBeInTheDocument();
  });

  it('renders a roll-up badge on a folder for a status on a DEEPLY nested descendant', () => {
    const grandchild = { id: 'gc', name: 'deep.adoc', type: 'file' as const, path: '/src/sub/deep.adoc', parentId: 'sub', children: [] };
    const childFolder = { id: 'sub', name: 'sub', type: 'folder' as const, path: '/src/sub', parentId: 'folder-1', children: [grandchild] };
    const parent = { ...folderNode, children: [childFolder] };
    render(
      <FileTreeNode
        node={parent}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        statusByFileNodeId={{ gc: 'conflicted' }}
      />,
    );
    expect(screen.getByRole('img', { name: 'Contains changes: Conflicted' })).toBeInTheDocument();
  });

  it('renders no roll-up badge on a folder when every descendant is unchanged', () => {
    render(
      <FileTreeNode
        node={folderNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        statusByFileNodeId={{ 'file-1': 'unchanged' }}
      />,
    );
    expect(screen.queryByRole('img', { name: /contains changes/i })).not.toBeInTheDocument();
  });

  it('passes the status map down to child nodes when a folder is expanded', () => {
    render(
      <FileTreeNode
        node={folderNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        isExpanded
        onToggle={jest.fn()}
        statusByFileNodeId={{ 'file-1': 'staged' }}
      />,
    );
    expect(screen.getByRole('img', { name: 'Staged' })).toBeInTheDocument();
  });

  it('expands a nested child folder according to expandedState', () => {
    const grandchild = { id: 'gc', name: 'deep.adoc', type: 'file' as const, path: '/src/sub/deep.adoc', parentId: 'sub', children: [] };
    const childFolder = { id: 'sub', name: 'sub', type: 'folder' as const, path: '/src/sub', parentId: 'folder-1', children: [grandchild] };
    const parent = { ...folderNode, children: [childFolder] };
    render(
      <FileTreeNode
        node={parent}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        isExpanded
        onToggle={jest.fn()}
        expandedState={new Map([['sub', true]])}
      />,
    );
    // The nested folder is expanded via expandedState → its grandchild renders.
    expect(screen.getByText('deep.adoc')).toBeInTheDocument();
  });

  it('renders folder children with a collapsed default when no expandedState is supplied', () => {
    render(
      <FileTreeNode
        node={folderNode}
        depth={0}
        projectId="proj-1"
        canEdit={false}
        selectedNodeId={null}
        onSelect={jest.fn()}
        onContextMenu={jest.fn()}
        isExpanded
        onToggle={jest.fn()}
      />,
    );
    expect(screen.getByText('document.adoc')).toBeInTheDocument();
  });
});
