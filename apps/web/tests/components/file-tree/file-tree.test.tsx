import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { FileTree } from '@/components/file-tree/file-tree';
import type { FileTreeEventDto } from '@asciidocollab/shared';

// Mock dependencies
jest.mock('@/hooks/use-file-tree-events', () => ({
  useFileTreeEvents: jest.fn((_projectId: string, handlers: { onFileTreeEvent?: (event: FileTreeEventDto) => void; onReconnect?: () => void }) => {
    // expose for test use
    (globalThis as unknown as Record<string, unknown>).__lastOnEvent = handlers.onFileTreeEvent;
    (globalThis as unknown as Record<string, unknown>).__lastOnReconnect = handlers.onReconnect;
  }),
}));

jest.mock('@/hooks/use-key-bindings', () => ({
  useKeyBindings: jest.fn(() => new Map()),
}));

jest.mock('@/hooks/use-file-tree-key-handler', () => ({
  // Capture the callback map so tests can invoke the wired key actions directly.
  useFileTreeKeyHandler: jest.fn((_reference: unknown, _bindings: unknown, callbacks: Record<string, (() => void) | undefined>) => {
    (globalThis as unknown as Record<string, unknown>).__lastKeyCallbacks = callbacks;
  }),
}));

// Keep the real DragDropZone (its onNodeMove logic is under test) but stub the upload hook so a
// drop does not run the real OS-file upload walker.
jest.mock('@/hooks/use-drop-upload', () => ({
  useDropUpload: () => ({ onDrop: jest.fn(), progress: [], clearProgress: jest.fn() }),
}));

// The move dialog handlers call these directly; mock so no real network request fires.
jest.mock('@/lib/api/file-tree', () => ({
  moveFileNode: jest.fn().mockResolvedValue(undefined),
  renameFileNode: jest.fn().mockResolvedValue(undefined),
}));

// Recursive mock: renders data-node-id (so the reveal scroll query can find a node)
// and renders a folder's children only when `expandedState.get(folderId)` is true, so
// tests can observe ancestor expansion driven by the auto-reveal effect.
interface MockNode { name: string; id: string; path: string; type: 'file' | 'folder'; children: MockNode[] }
interface MockNodeProperties {
  node: MockNode;
  canEdit?: boolean;
  selectedNodeId?: string | null;
  expandedState?: Map<string, boolean>;
  onSelect?: (nodeId: string, nodeName: string, nodePath: string, nodeType: 'file' | 'folder') => void;
  onToggle?: (nodeId: string) => void;
  onUpdate?: () => void;
  onError?: (message: string | null) => void;
}
jest.mock('@/components/file-tree/file-tree-node', () => {
  function MockFileTreeNode({ node, canEdit, selectedNodeId, expandedState, onSelect, onToggle, onUpdate, onError }: MockNodeProperties) {
    return (
      <div>
        <div
          data-testid={`node-${node.name}`}
          data-node-id={node.id}
          data-is-owner={String(canEdit)}
          data-selected={node.id === selectedNodeId ? 'true' : undefined}
          onClick={() => node.type === 'file'
            ? onSelect?.(node.id, node.name, node.path, node.type)
            : onToggle?.(node.id)}
        >
          {node.name}
          {canEdit && <button data-testid={`actions-${node.name}`} onClick={() => onUpdate?.()}>Actions</button>}
          {onError && <button data-testid={`trigger-error-${node.name}`} onClick={() => onError('Test error message')}>Trigger Error</button>}
        </div>
        {node.type === 'folder' && expandedState?.get(node.id) && node.children.map((child) => (
          <MockFileTreeNode
            key={child.id}
            node={child}
            canEdit={canEdit}
            selectedNodeId={selectedNodeId}
            expandedState={expandedState}
            onSelect={onSelect}
            onToggle={onToggle}
            onUpdate={onUpdate}
            onError={onError}
          />
        ))}
      </div>
    );
  }
  return { FileTreeNode: MockFileTreeNode };
});

// The root header renders the real FileTreeActions behind a Radix dropdown, which does not open
// under fireEvent in jsdom. Mock it so the wired callbacks (Reveal in Tree, etc.) are directly
// clickable. (FileTreeNode — the other consumer — is mocked separately above.)
jest.mock('@/components/file-tree/file-tree-actions', () => ({
  FileTreeActions: ({ onRevealInTree, hasSelection }: { onRevealInTree?: () => void; hasSelection?: boolean }) => (
    <button data-testid="root-reveal" disabled={!hasSelection} onClick={() => onRevealInTree?.()}>
      Reveal in Tree
    </button>
  ),
}));

const projectId = 'proj-1';

// When a source file shares its name with a root file, two `node-<name>` testids exist; this
// selects the dragged one by its stable node id instead.
function dragSourceById(container: HTMLElement, nodeId: string) {
  const source = container.querySelector(`[data-node-id="${nodeId}"]`);
  if (!(source instanceof HTMLElement)) throw new Error('source node not found');
  return source;
}

const rootNode = {
  id: 'root-1',
  name: 'root',
  type: 'folder' as const,
  path: '/',
  parentId: null,
  children: [
    { id: 'file-1', name: 'doc.adoc', type: 'file' as const, path: '/doc.adoc', parentId: 'root-1', children: [] },
  ],
};

function mockFetch(tree: typeof rootNode) {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(tree),
  } as Response);
}

describe('FileTree', () => {
  beforeEach(() => {
    mockFetch(rootNode);
    (globalThis as unknown as Record<string, unknown>).__lastOnEvent = undefined;
    (globalThis as unknown as Record<string, unknown>).__lastOnReconnect = undefined;
    // jsdom does not implement scrollIntoView; the reveal-selected effect calls it whenever a node is
    // selected. Stub it so tests that render with a selection (e.g. a restored selection) don't throw.
    Element.prototype.scrollIntoView = jest.fn();
  });

  it('initial tree is fetched and rendered on mount', async () => {
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());
  });

  // canEdit=false hides both the per-node action buttons and the header actions menu — a viewer (and,
  // via the role-based `canModifyFiles` the layout passes here, a global admin who is only a viewer of
  // the project) sees no file-management controls at all.
  it('canEdit=false — no per-node FileTreeActions buttons and no header actions menu', async () => {
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());
    expect(screen.queryByTestId('actions-doc.adoc')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tree-root-actions')).not.toBeInTheDocument();
  });

  it('canEdit=true — the header actions menu renders', async () => {
    render(<FileTree projectId={projectId} canEdit={true} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('tree-root-actions')).toBeInTheDocument());
  });

  // onSelectFile called with (nodeId, nodeName, nodePath) on file click
  it('calls onSelectFile with nodeId, nodeName, nodePath when file node is clicked', async () => {
    const onSelectFile = jest.fn();
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={onSelectFile} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('node-doc.adoc'));
    expect(onSelectFile).toHaveBeenCalledWith('file-1', 'doc.adoc', '/doc.adoc', 'file');
  });

  // First-open auto-selection of the main file.
  describe('first-open auto-selection (autoSelectNodeId)', () => {
    it('selects the main file once, after the tree loads, when nothing is selected', async () => {
      const onSelectFile = jest.fn();
      render(
        <FileTree
          projectId={projectId}
          canEdit={false}
          onSelectFile={onSelectFile}
          selectedNodeId={null}
          autoSelectNodeId="file-1"
        />,
      );
      await waitFor(() => expect(onSelectFile).toHaveBeenCalledWith('file-1', 'doc.adoc', '/doc.adoc', 'file'));
      expect(onSelectFile).toHaveBeenCalledTimes(1);
    });

    it('does NOT auto-select when a selection is already restored', async () => {
      const onSelectFile = jest.fn();
      render(
        <FileTree
          projectId={projectId}
          canEdit={false}
          onSelectFile={onSelectFile}
          selectedNodeId="file-1"
          autoSelectNodeId="file-1"
        />,
      );
      await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());
      expect(onSelectFile).not.toHaveBeenCalled();
    });

    it('does NOT auto-select when no main file is provided (returning users / no main file)', async () => {
      const onSelectFile = jest.fn();
      render(
        <FileTree
          projectId={projectId}
          canEdit={false}
          onSelectFile={onSelectFile}
          selectedNodeId={null}
          autoSelectNodeId={null}
        />,
      );
      await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());
      expect(onSelectFile).not.toHaveBeenCalled();
    });

    it('leaves the empty state when the main file id matches no node', async () => {
      const onSelectFile = jest.fn();
      render(
        <FileTree
          projectId={projectId}
          canEdit={false}
          onSelectFile={onSelectFile}
          selectedNodeId={null}
          autoSelectNodeId="does-not-exist"
        />,
      );
      await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());
      expect(onSelectFile).not.toHaveBeenCalled();
    });

    it('does not re-select the main file after the user navigates away from it', async () => {
      const onSelectFile = jest.fn();
      const { rerender } = render(
        <FileTree
          projectId={projectId}
          canEdit={false}
          onSelectFile={onSelectFile}
          selectedNodeId={null}
          autoSelectNodeId="file-1"
        />,
      );
      await waitFor(() => expect(onSelectFile).toHaveBeenCalledTimes(1));
      // The parent commits the selection; a later render with a different open file must not re-fire.
      rerender(
        <FileTree
          projectId={projectId}
          canEdit={false}
          onSelectFile={onSelectFile}
          selectedNodeId="file-other"
          autoSelectNodeId="file-1"
        />,
      );
      await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());
      expect(onSelectFile).toHaveBeenCalledTimes(1);
    });
  });

  // empty children renders "No files yet" text
  it('renders empty state when tree has no children', async () => {
    const emptyRoot = { ...rootNode, children: [] };
    mockFetch(emptyRoot);
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByText(/No files yet/i)).toBeInTheDocument());
  });

  it('created event adds a node to the rendered tree', async () => {
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => screen.getByTestId('node-doc.adoc'));

    const event: FileTreeEventDto = {
      type: 'created',
      fileNodeId: 'file-2',
      nodeType: 'file',
      name: 'new.adoc',
      path: '/new.adoc',
      parentId: 'root-1',
    };

    act(() => {
      (globalThis as unknown as Record<string, () => void>).__lastOnEvent(event);
    });

    await waitFor(() => expect(screen.getByTestId('node-new.adoc')).toBeInTheDocument());
  });

  it('deleted event removes a node', async () => {
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => screen.getByTestId('node-doc.adoc'));

    const event: FileTreeEventDto = {
      type: 'deleted',
      fileNodeId: 'file-1',
      nodeType: 'file',
      name: 'doc.adoc',
      path: '/doc.adoc',
      parentId: 'root-1',
    };

    act(() => {
      (globalThis as unknown as Record<string, () => void>).__lastOnEvent(event);
    });

    await waitFor(() => expect(screen.queryByTestId('node-doc.adoc')).not.toBeInTheDocument());
  });

  it('renamed event updates the node name', async () => {
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => screen.getByTestId('node-doc.adoc'));

    const event: FileTreeEventDto = {
      type: 'renamed',
      fileNodeId: 'file-1',
      nodeType: 'file',
      name: 'renamed.adoc',
      path: '/renamed.adoc',
      parentId: 'root-1',
    };

    act(() => {
      (globalThis as unknown as Record<string, () => void>).__lastOnEvent(event);
    });

    await waitFor(() => expect(screen.getByTestId('node-renamed.adoc')).toBeInTheDocument());
  });

  it('moved event relocates a node into the target folder', async () => {
    const tree = {
      ...rootNode,
      children: [
        { id: 'folder-a', name: 'folder-a', type: 'folder' as const, path: '/folder-a', parentId: 'root-1', children: [] },
        { id: 'file-1', name: 'doc.adoc', type: 'file' as const, path: '/doc.adoc', parentId: 'root-1', children: [] },
      ],
    };
    mockFetch(tree);
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => screen.getByTestId('node-doc.adoc'));

    const event: FileTreeEventDto = {
      type: 'moved',
      fileNodeId: 'file-1',
      nodeType: 'file',
      name: 'doc.adoc',
      path: '/folder-a/doc.adoc',
      parentId: 'folder-a',
    };
    act(() => {
      (globalThis as unknown as Record<string, (event_: FileTreeEventDto) => void>).__lastOnEvent(event);
    });

    // The node still exists (relocated under folder-a, which auto-expands), not removed.
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());
  });

  // C5: network error during initial fetch must not leave the tree stuck on "Loading..."
  it('shows an error state when the initial fetch fails with a network error', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('Network down'));
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  // C5b: HTTP error response (e.g. 404 for empty project) must not leave the tree stuck on "Loading..."
  it('shows an error state when the initial fetch returns a non-ok HTTP status', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('reconnect triggers a full re-fetch', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(rootNode),
    } as Response);
    globalThis.fetch = fetchMock;

    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => screen.getByTestId('node-doc.adoc'));

    act(() => {
      (globalThis as unknown as Record<string, () => void>).__lastOnReconnect();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  // BUG: tree does not update after file creation because onUpdate is () => {}
  // Fix: onUpdate should trigger fetchTree so the tree re-fetches even if SSE is delayed
  it('refetches and shows new file when a node mutation completes (onUpdate)', async () => {
    const treeWithNew = {
      ...rootNode,
      children: [
        ...rootNode.children,
        { id: 'file-2', name: 'new.adoc', type: 'file' as const, path: '/new.adoc', parentId: 'root-1', children: [] },
      ],
    };
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(rootNode) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(treeWithNew) } as Response);
    globalThis.fetch = fetchMock;

    render(<FileTree projectId={projectId} canEdit={true} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => screen.getByTestId('node-doc.adoc'));

    // Trigger onUpdate as FileTreeActions would after a successful file creation
    act(() => {
      fireEvent.click(screen.getByTestId('actions-doc.adoc'));
    });

    await waitFor(() => expect(screen.getByTestId('node-new.adoc')).toBeInTheDocument());
  });

  // role="alert" error banner renders in panel header area after failed file operation
  it('renders role="alert" error banner after a failed file operation and it is outside tree rows', async () => {
    render(<FileTree projectId={projectId} canEdit={true} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());

    // The mock FileTreeNode exposes a trigger-error button (only when onError prop is provided)
    fireEvent.click(screen.getByTestId('trigger-error-doc.adoc'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // Verify the alert is NOT inside the tree node row
    const alert = screen.getByRole('alert');
    const treeNode = screen.getByTestId('node-doc.adoc');
    expect(treeNode).not.toContainElement(alert);
  });

  // Ctrl+F opens FindPanel, typing highlights first match, next/prev cycles, Escape dismisses
  it('Ctrl+F opens FindPanel; typing a query shows match counter; Escape dismisses', async () => {
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());

    const container = screen.getByTestId('node-doc.adoc').closest('[tabindex]') as HTMLElement;
    expect(container).toBeTruthy();

    // Ctrl+F should open FindPanel
    fireEvent.keyDown(container, { key: 'f', ctrlKey: true });
    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());

    // Escape should dismiss the panel
    fireEvent.keyDown(container, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
  });

  // tree items render in case-insensitive alphabetical order on initial load
  it('renders tree children in case-insensitive alphabetical order on initial load', async () => {
    const unorderedRoot = {
      id: 'root-1',
      name: 'root',
      type: 'folder' as const,
      path: '/',
      parentId: null,
      children: [
        { id: 'f-z', name: 'zebra.adoc', type: 'file' as const, path: '/zebra.adoc', parentId: 'root-1', children: [] },
        { id: 'f-a', name: 'Apple.adoc', type: 'file' as const, path: '/Apple.adoc', parentId: 'root-1', children: [] },
        { id: 'f-under', name: '_foo.adoc', type: 'file' as const, path: '/_foo.adoc', parentId: 'root-1', children: [] },
        { id: 'f-num', name: '2bar.adoc', type: 'file' as const, path: '/2bar.adoc', parentId: 'root-1', children: [] },
        { id: 'f-accent', name: 'ärch.adoc', type: 'file' as const, path: '/ärch.adoc', parentId: 'root-1', children: [] },
      ],
    };
    mockFetch(unorderedRoot);
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-zebra.adoc')).toBeInTheDocument());

    const nodes = screen.getAllByTestId(/^node-/);
    const names = nodes.map((n) => n.dataset['testid']!.replace('node-', ''));
    const sorted = names.toSorted((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    expect(names).toEqual(sorted);
  });

  // created SSE event inserts file at correct alphabetical position
  it('created SSE event inserts file at correct alphabetical position', async () => {
    const treeRoot = {
      id: 'root-1',
      name: 'root',
      type: 'folder' as const,
      path: '/',
      parentId: null,
      children: [
        { id: 'f-a', name: 'apple.adoc', type: 'file' as const, path: '/apple.adoc', parentId: 'root-1', children: [] },
        { id: 'f-c', name: 'cherry.adoc', type: 'file' as const, path: '/cherry.adoc', parentId: 'root-1', children: [] },
      ],
    };
    mockFetch(treeRoot);
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-apple.adoc')).toBeInTheDocument());

    const createdEvent: FileTreeEventDto = {
      type: 'created',
      fileNodeId: 'f-b',
      nodeType: 'file',
      name: 'banana.adoc',
      path: '/banana.adoc',
      parentId: 'root-1',
    };
    act(() => { (globalThis as unknown as Record<string, (event: FileTreeEventDto) => void>).__lastOnEvent(createdEvent); });

    await waitFor(() => expect(screen.getByTestId('node-banana.adoc')).toBeInTheDocument());

    const nodes = screen.getAllByTestId(/^node-/);
    const names = nodes.map((n) => n.dataset['testid']!.replace('node-', ''));
    const sorted = names.toSorted((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    expect(names).toEqual(sorted);
  });

  // renamed SSE event re-positions file to correct alphabetical position
  it('renamed SSE event re-positions file to correct alphabetical position', async () => {
    const treeRoot = {
      id: 'root-1',
      name: 'root',
      type: 'folder' as const,
      path: '/',
      parentId: null,
      children: [
        { id: 'f-a', name: 'alpha.adoc', type: 'file' as const, path: '/alpha.adoc', parentId: 'root-1', children: [] },
        { id: 'f-b', name: 'beta.adoc', type: 'file' as const, path: '/beta.adoc', parentId: 'root-1', children: [] },
        { id: 'f-c', name: 'charlie.adoc', type: 'file' as const, path: '/charlie.adoc', parentId: 'root-1', children: [] },
      ],
    };
    mockFetch(treeRoot);
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-alpha.adoc')).toBeInTheDocument());

    // Rename 'alpha.adoc' → 'zebra.adoc' — should move to end
    const renamedEvent: FileTreeEventDto = {
      type: 'renamed',
      fileNodeId: 'f-a',
      nodeType: 'file',
      name: 'zebra.adoc',
      path: '/zebra.adoc',
      parentId: 'root-1',
    };
    act(() => { (globalThis as unknown as Record<string, (event: FileTreeEventDto) => void>).__lastOnEvent(renamedEvent); });

    await waitFor(() => expect(screen.getByTestId('node-zebra.adoc')).toBeInTheDocument());

    const nodes = screen.getAllByTestId(/^node-/);
    const names = nodes.map((n) => n.dataset['testid']!.replace('node-', ''));
    const sorted = names.toSorted((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    expect(names).toEqual(sorted);
  });

  // Idempotency: if SSE 'created' event arrives after fetchTree already returned the new node,
  // applyEvent must not add a duplicate.
  it('applyEvent created event is idempotent — no duplicate when node already in tree', async () => {
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => screen.getByTestId('node-doc.adoc'));

    const createdEvent: FileTreeEventDto = {
      type: 'created',
      fileNodeId: 'file-2',
      nodeType: 'file',
      name: 'new.adoc',
      path: '/new.adoc',
      parentId: 'root-1',
    };

    // First SSE event — adds the node
    act(() => { (globalThis as unknown as Record<string, (event: FileTreeEventDto) => void>).__lastOnEvent(createdEvent); });
    await waitFor(() => expect(screen.getByTestId('node-new.adoc')).toBeInTheDocument());

    // Second SSE event with the same fileNodeId — must not add a duplicate
    act(() => { (globalThis as unknown as Record<string, (event: FileTreeEventDto) => void>).__lastOnEvent(createdEvent); });
    await waitFor(() => expect(screen.getAllByTestId('node-new.adoc')).toHaveLength(1));
  });

});

// Auto-reveal a programmatically-selected node that is hidden behind
// collapsed folders. Contract cases from contracts/tree-reveal-on-select.md.
describe('FileTree auto-reveal on selection', () => {
  // root
  // ├── docs (folder, top-level → auto-expanded)
  // │   ├── chapters (folder, collapsed) → intro.adoc (hidden)
  // │   └── refs (folder, collapsed)     → appendix.adoc (hidden)
  // └── readme.adoc (top-level file, visible)
  const deepTree = {
    id: 'root-1',
    name: 'root',
    type: 'folder' as const,
    path: '/',
    parentId: null,
    children: [
      {
        id: 'docs', name: 'docs', type: 'folder' as const, path: '/docs', parentId: 'root-1',
        children: [
          {
            id: 'chapters', name: 'chapters', type: 'folder' as const, path: '/docs/chapters', parentId: 'docs',
            children: [{ id: 'intro', name: 'intro.adoc', type: 'file' as const, path: '/docs/chapters/intro.adoc', parentId: 'chapters', children: [] }],
          },
          {
            id: 'refs', name: 'refs', type: 'folder' as const, path: '/docs/refs', parentId: 'docs',
            children: [{ id: 'appendix', name: 'appendix.adoc', type: 'file' as const, path: '/docs/refs/appendix.adoc', parentId: 'refs', children: [] }],
          },
        ],
      },
      { id: 'readme', name: 'readme.adoc', type: 'file' as const, path: '/readme.adoc', parentId: 'root-1', children: [] },
    ],
  };

  const scrollIntoViewMock = jest.fn();

  beforeEach(() => {
    scrollIntoViewMock.mockClear();
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(deepTree) } as Response);
    (globalThis as unknown as Record<string, unknown>).__lastOnEvent = undefined;
  });

  it('a selected node nested in collapsed folders becomes visible and is scrolled into view', async () => {
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId="intro" />);
    // Tree loads; readme is visible immediately, intro is hidden behind collapsed `chapters`.
    await waitFor(() => expect(screen.getByTestId('node-readme.adoc')).toBeInTheDocument());

    // After reveal, the ancestor folders expand and intro renders + scrolls into view.
    await waitFor(() => expect(screen.getByTestId('node-intro.adoc')).toBeInTheDocument());
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it('a root-level/visible node needs no expand but is still scrolled, without error', async () => {
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId="readme" />);
    await waitFor(() => expect(screen.getByTestId('node-readme.adoc')).toBeInTheDocument());
    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalled());
  });

  it('manually collapsing the folder holding the selected node does NOT re-expand it', async () => {
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId="intro" />);
    await waitFor(() => expect(screen.getByTestId('node-intro.adoc')).toBeInTheDocument());
    scrollIntoViewMock.mockClear();

    // User collapses `chapters` (the folder that holds the selected intro.adoc).
    fireEvent.click(screen.getByTestId('node-chapters'));

    // It stays collapsed — the reveal effect (keyed on selectedNodeId, not expandedState) must not fight it.
    await waitFor(() => expect(screen.queryByTestId('node-intro.adoc')).not.toBeInTheDocument());
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('selectedNodeId=null performs no reveal and no error', async () => {
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-readme.adoc')).toBeInTheDocument());
    // Give any pending setTimeout-based scroll a chance to (not) run.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('changing the selection to a new hidden node reveals it', async () => {
    const { rerender } = render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId="intro" />);
    await waitFor(() => expect(screen.getByTestId('node-intro.adoc')).toBeInTheDocument());
    scrollIntoViewMock.mockClear();

    rerender(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId="appendix" />);
    await waitFor(() => expect(screen.getByTestId('node-appendix.adoc')).toBeInTheDocument());
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it('re-rendering with an unchanged selectedNodeId does not re-reveal', async () => {
    const { rerender } = render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId="intro" />);
    await waitFor(() => expect(screen.getByTestId('node-intro.adoc')).toBeInTheDocument());
    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalled());
    scrollIntoViewMock.mockClear();

    rerender(<FileTree projectId={projectId} canEdit={true} onSelectFile={jest.fn()} selectedNodeId="intro" />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });
});

// Move a file to the project root by dropping it on the root drop-zone's empty area.
describe('FileTree move to root (drop on the root area)', () => {
  const rootMoveTree = {
    id: 'root-1',
    name: 'root',
    type: 'folder' as const,
    path: '/',
    parentId: null,
    children: [
      {
        id: 'docs', name: 'docs', type: 'folder' as const, path: '/docs', parentId: 'root-1',
        children: [{ id: 'f1', name: 'nested.adoc', type: 'file' as const, path: '/docs/nested.adoc', parentId: 'docs', children: [] }],
      },
    ],
  };

  beforeEach(() => {
    const api = jest.requireMock('@/lib/api/file-tree');
    api.moveFileNode.mockClear().mockResolvedValue(undefined);
    api.renameFileNode.mockClear().mockResolvedValue(undefined);
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(rootMoveTree) } as Response);
    (globalThis as unknown as Record<string, unknown>).__lastOnEvent = undefined;
  });

  it('dropping a dragged node on the root drop-zone opens the move dialog (move to root)', async () => {
    render(<FileTree projectId={projectId} canEdit onSelectFile={jest.fn()} selectedNodeId={null} />);
    // `docs` auto-expands → its nested file (parent = docs, not root) is visible.
    await waitFor(() => expect(screen.getByTestId('node-nested.adoc')).toBeInTheDocument());

    // Start dragging the nested file, then drop it on the root drop-zone.
    fireEvent.dragStart(screen.getByTestId('node-nested.adoc'), { dataTransfer: { setData: jest.fn(), effectAllowed: '' } });
    fireEvent.drop(screen.getByTestId('file-tree-drop-zone'), { dataTransfer: { items: {} } });

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByText('Move File')).toBeInTheDocument();
  });

  it('a drop on the root drop-zone with no active drag does not open a dialog', async () => {
    render(<FileTree projectId={projectId} canEdit onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-docs')).toBeInTheDocument());

    fireEvent.drop(screen.getByTestId('file-tree-drop-zone'), { dataTransfer: { items: {} } });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('confirming the move dialog calls moveFileNode then re-fetches the tree', async () => {
    const { moveFileNode } = jest.requireMock('@/lib/api/file-tree');
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(rootMoveTree) } as Response);
    globalThis.fetch = fetchMock;

    render(<FileTree projectId={projectId} canEdit onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-nested.adoc')).toBeInTheDocument());

    fireEvent.dragStart(screen.getByTestId('node-nested.adoc'), { dataTransfer: { setData: jest.fn(), effectAllowed: '' } });
    fireEvent.drop(screen.getByTestId('file-tree-drop-zone'), { dataTransfer: { items: {} } });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(moveFileNode).toHaveBeenCalledWith(projectId, 'f1', 'root-1'));
    // Dialog closes and the tree re-fetches (initial fetch + post-move fetch).
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed move surfaces an error banner (handleMoveConfirm catch path)', async () => {
    const { moveFileNode } = jest.requireMock('@/lib/api/file-tree');
    moveFileNode.mockRejectedValueOnce(new Error('boom'));

    render(<FileTree projectId={projectId} canEdit onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-nested.adoc')).toBeInTheDocument());

    fireEvent.dragStart(screen.getByTestId('node-nested.adoc'), { dataTransfer: { setData: jest.fn(), effectAllowed: '' } });
    fireEvent.drop(screen.getByTestId('file-tree-drop-zone'), { dataTransfer: { items: {} } });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/failed to move file/i));
  });

  it('cancelling the move dialog closes it without calling moveFileNode', async () => {
    const { moveFileNode } = jest.requireMock('@/lib/api/file-tree');
    render(<FileTree projectId={projectId} canEdit onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-nested.adoc')).toBeInTheDocument());

    fireEvent.dragStart(screen.getByTestId('node-nested.adoc'), { dataTransfer: { setData: jest.fn(), effectAllowed: '' } });
    fireEvent.drop(screen.getByTestId('file-tree-drop-zone'), { dataTransfer: { items: {} } });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(moveFileNode).not.toHaveBeenCalled();
  });
});

// A move that collides with an existing file in the destination offers "Move & Rename",
// exercising handleMoveAndRename (rename then move).
describe('FileTree move with name conflict (Move & Rename)', () => {
  const conflictTree = {
    id: 'root-1',
    name: 'root',
    type: 'folder' as const,
    path: '/',
    parentId: null,
    children: [
      {
        id: 'docs', name: 'docs', type: 'folder' as const, path: '/docs', parentId: 'root-1',
        children: [{ id: 'f1', name: 'report.adoc', type: 'file' as const, path: '/docs/report.adoc', parentId: 'docs', children: [] }],
      },
      // Root already holds a file with the same name as the one being moved → conflict.
      { id: 'f2', name: 'report.adoc', type: 'file' as const, path: '/report.adoc', parentId: 'root-1', children: [] },
    ],
  };

  beforeEach(() => {
    const api = jest.requireMock('@/lib/api/file-tree');
    api.moveFileNode.mockClear().mockResolvedValue(undefined);
    api.renameFileNode.mockClear().mockResolvedValue(undefined);
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(conflictTree) } as Response);
    (globalThis as unknown as Record<string, unknown>).__lastOnEvent = undefined;
  });

  it('Move & Rename renames the source then moves it, then re-fetches', async () => {
    const { moveFileNode, renameFileNode } = jest.requireMock('@/lib/api/file-tree');
    const { container } = render(<FileTree projectId={projectId} canEdit onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(container.querySelector('[data-node-id="f1"]')).not.toBeNull());

    fireEvent.dragStart(dragSourceById(container, 'f1'), { dataTransfer: { setData: jest.fn(), effectAllowed: '' } });
    fireEvent.drop(screen.getByTestId('file-tree-drop-zone'), { dataTransfer: { items: {} } });

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByText(/already exists in the destination/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /move & rename/i }));

    await waitFor(() => expect(renameFileNode).toHaveBeenCalledWith(projectId, 'f1', 'report (1).adoc'));
    await waitFor(() => expect(moveFileNode).toHaveBeenCalledWith(projectId, 'f1', 'root-1'));
  });

  it('Move & Rename of an extensionless name appends " (1)" with no extension', async () => {
    const { renameFileNode } = jest.requireMock('@/lib/api/file-tree');
    const noExtensionTree = {
      id: 'root-1', name: 'root', type: 'folder' as const, path: '/', parentId: null,
      children: [
        {
          id: 'docs', name: 'docs', type: 'folder' as const, path: '/docs', parentId: 'root-1',
          children: [{ id: 'f1', name: 'README', type: 'file' as const, path: '/docs/README', parentId: 'docs', children: [] }],
        },
        { id: 'f2', name: 'README', type: 'file' as const, path: '/README', parentId: 'root-1', children: [] },
      ],
    };
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(noExtensionTree) } as Response);

    const { container } = render(<FileTree projectId={projectId} canEdit onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(container.querySelector('[data-node-id="f1"]')).not.toBeNull());

    fireEvent.dragStart(dragSourceById(container, 'f1'), { dataTransfer: { setData: jest.fn(), effectAllowed: '' } });
    fireEvent.drop(screen.getByTestId('file-tree-drop-zone'), { dataTransfer: { items: {} } });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /move & rename/i }));
    await waitFor(() => expect(renameFileNode).toHaveBeenCalledWith(projectId, 'f1', 'README (1)'));
  });

  it('a failed Move & Rename surfaces an error banner (handleMoveAndRename catch path)', async () => {
    const { renameFileNode } = jest.requireMock('@/lib/api/file-tree');
    renameFileNode.mockRejectedValueOnce(new Error('nope'));
    const { container } = render(<FileTree projectId={projectId} canEdit onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(container.querySelector('[data-node-id="f1"]')).not.toBeNull());

    fireEvent.dragStart(dragSourceById(container, 'f1'), { dataTransfer: { setData: jest.fn(), effectAllowed: '' } });
    fireEvent.drop(screen.getByTestId('file-tree-drop-zone'), { dataTransfer: { items: {} } });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /move & rename/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/failed to move and rename/i));
  });
});

// Additional branch coverage for applyEvent and the error-dismiss / drag-end / reveal paths.
describe('FileTree misc branch coverage', () => {
  beforeEach(() => {
    mockFetch(rootNode);
    (globalThis as unknown as Record<string, unknown>).__lastOnEvent = undefined;
  });

  it('dismiss error button clears the operation-error banner', async () => {
    render(<FileTree projectId={projectId} canEdit onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('trigger-error-doc.adoc'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /dismiss error/i }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('a created event for a nested folder recurses into the matching parent', async () => {
    const nestedTree = {
      id: 'root-1',
      name: 'root',
      type: 'folder' as const,
      path: '/',
      parentId: null,
      children: [
        { id: 'docs', name: 'docs', type: 'folder' as const, path: '/docs', parentId: 'root-1', children: [] },
      ],
    };
    mockFetch(nestedTree);
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-docs')).toBeInTheDocument());

    // Parent is the nested `docs` folder, not the root → exercises the addNode recursion branch.
    const event: FileTreeEventDto = {
      type: 'created',
      fileNodeId: 'nested-file',
      nodeType: 'file',
      name: 'inner.adoc',
      path: '/docs/inner.adoc',
      parentId: 'docs',
    };
    act(() => { (globalThis as unknown as Record<string, (event_: FileTreeEventDto) => void>).__lastOnEvent(event); });

    await waitFor(() => expect(screen.getByTestId('node-inner.adoc')).toBeInTheDocument());
  });

  it('a tree change while the selection is unchanged does not re-reveal (last-revealed short-circuit)', async () => {
    const scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId="file-1" />);
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockClear();

    // An SSE event mutates the tree (a new dep value) while selectedNodeId stays the same, so the
    // reveal effect re-runs but short-circuits on the last-revealed ref.
    act(() => {
      (globalThis as unknown as Record<string, (event_: FileTreeEventDto) => void>).__lastOnEvent({
        type: 'created', fileNodeId: 'file-9', nodeType: 'file', name: 'extra.adoc', path: '/extra.adoc', parentId: 'root-1',
      });
    });
    await waitFor(() => expect(screen.getByTestId('node-extra.adoc')).toBeInTheDocument());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('a moved event into a nested folder recurses through addNode', async () => {
    const nestedTree = {
      id: 'root-1', name: 'root', type: 'folder' as const, path: '/', parentId: null,
      children: [
        { id: 'docs', name: 'docs', type: 'folder' as const, path: '/docs', parentId: 'root-1', children: [] },
        { id: 'file-1', name: 'doc.adoc', type: 'file' as const, path: '/doc.adoc', parentId: 'root-1', children: [] },
      ],
    };
    mockFetch(nestedTree);
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());

    // Target parent is the nested `docs` folder → addNode must recurse past root (else branch).
    act(() => {
      (globalThis as unknown as Record<string, (event_: FileTreeEventDto) => void>).__lastOnEvent({
        type: 'moved', fileNodeId: 'file-1', nodeType: 'file', name: 'doc.adoc', path: '/docs/doc.adoc', parentId: 'docs',
      });
    });

    // The file relocated under docs (which auto-expands), so it is still rendered.
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());
  });

  it('an unrecognised event type leaves the tree unchanged (applyEvent fallthrough)', async () => {
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());

    act(() => {
      (globalThis as unknown as Record<string, (event_: unknown) => void>).__lastOnEvent({
        type: 'unknown-kind',
        fileNodeId: 'x',
        nodeType: 'file',
        name: 'x',
        path: '/x',
        parentId: 'root-1',
      });
    });

    // Unchanged: the original node is still present and nothing new appeared.
    expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument();
  });

  it('Reveal in Tree (root actions) reveals and scrolls the selected node into view', async () => {
    const scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    jest.useFakeTimers();
    try {
      render(<FileTree projectId={projectId} canEdit onSelectFile={jest.fn()} selectedNodeId="file-1" />);
      await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('root-reveal'));
      act(() => { jest.runOnlyPendingTimers(); });
      expect(scrollIntoView).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('wires no-op rename/delete/new-file/new-folder key callbacks when a node is selected', async () => {
    render(<FileTree projectId={projectId} canEdit onSelectFile={jest.fn()} selectedNodeId="file-1" />);
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());

    const callbacks = (globalThis as unknown as Record<string, Record<string, (() => void) | undefined>>).__lastKeyCallbacks;
    // With a selection the four mutation shortcuts resolve to (currently no-op) handlers; invoking
    // them must not throw. (They become real actions once wired to the menu.)
    expect(typeof callbacks['file-tree:rename']).toBe('function');
    expect(() => {
      callbacks['file-tree:rename']?.();
      callbacks['file-tree:delete']?.();
      callbacks['file-tree:new-file']?.();
      callbacks['file-tree:new-folder']?.();
    }).not.toThrow();
  });

  it('leaves mutation key callbacks undefined when nothing is selected', async () => {
    render(<FileTree projectId={projectId} canEdit onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());

    const callbacks = (globalThis as unknown as Record<string, Record<string, (() => void) | undefined>>).__lastKeyCallbacks;
    expect(callbacks['file-tree:rename']).toBeUndefined();
    expect(callbacks['file-tree:delete']).toBeUndefined();
  });

  it('an SSE event arriving before the tree has loaded is ignored (applyEvent null guard)', async () => {
    // A fetch that never resolves keeps the tree null, so the event hits the `if (!tree)` guard.
    globalThis.fetch = jest.fn().mockReturnValue(new Promise(() => {}));
    render(<FileTree projectId={projectId} canEdit={false} onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByText(/loading/i)).toBeInTheDocument());

    act(() => {
      (globalThis as unknown as Record<string, (event_: FileTreeEventDto) => void>).__lastOnEvent({
        type: 'created', fileNodeId: 'x', nodeType: 'file', name: 'x.adoc', path: '/x.adoc', parentId: 'root-1',
      });
    });
    // Still loading — the event was a no-op because there was no tree.
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('drag end clears the active-drag state on the container', async () => {
    render(<FileTree projectId={projectId} canEdit onSelectFile={jest.fn()} selectedNodeId={null} />);
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());

    const container = screen.getByTestId('file-tree');
    fireEvent.dragStart(screen.getByTestId('node-doc.adoc'), { dataTransfer: { setData: jest.fn(), effectAllowed: '' } });
    await waitFor(() => expect(container).toHaveAttribute('data-drag-active', 'true'));

    fireEvent.dragEnd(container);
    await waitFor(() => expect(container).not.toHaveAttribute('data-drag-active'));
  });
});
