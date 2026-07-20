import { renderHook, act, waitFor } from '@testing-library/react';
import { useProjectFolders } from '@/hooks/use-project-folders';
import { fetchProjectFileTree } from '@/lib/api/file-tree';
import type { FileTreeNode } from '@/components/file-tree/types';

jest.mock('@/lib/api/file-tree', () => ({ fetchProjectFileTree: jest.fn() }));

const mockFetch = fetchProjectFileTree as jest.MockedFunction<typeof fetchProjectFileTree>;

function node(partial: Partial<FileTreeNode> & Pick<FileTreeNode, 'type' | 'path'>): FileTreeNode {
  return { id: partial.path, name: partial.path, parentId: null, children: [], ...partial };
}

describe('useProjectFolders', () => {
  beforeEach(() => mockFetch.mockReset());

  it('builds the folder tree + flat list (excluding the root and files), sorted', async () => {
    mockFetch.mockResolvedValue(
      node({
        type: 'folder',
        path: '/',
        name: 'root',
        children: [
          node({ type: 'file', path: 'main.adoc', name: 'main.adoc' }),
          node({
            type: 'folder',
            path: 'branding',
            name: 'branding',
            children: [
              node({ type: 'folder', path: 'branding/fonts', name: 'fonts' }),
              node({ type: 'file', path: 'branding/logo.png', name: 'logo.png' }),
            ],
          }),
          node({ type: 'folder', path: 'assets', name: 'assets' }),
        ],
      }),
    );
    const { result } = renderHook(() => useProjectFolders('p1'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Flat list (pre-order) — files pruned, root excluded.
    expect(result.current.folders).toEqual(['assets', 'branding', 'branding/fonts']);
    // Nested tree — sorted by name at each level, files pruned.
    expect(result.current.tree).toEqual([
      { path: 'assets', name: 'assets', children: [] },
      { path: 'branding', name: 'branding', children: [{ path: 'branding/fonts', name: 'fonts', children: [] }] },
    ]);
    // File paths (folders pruned, sorted) — what the PDF section resolves the theme over.
    expect(result.current.files).toEqual(['branding/logo.png', 'main.adoc']);
    expect(mockFetch).toHaveBeenCalledWith('p1');
  });

  it('surfaces a load error and leaves folders empty', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useProjectFolders('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Failed to load project folders.');
    expect(result.current.folders).toEqual([]);
  });

  it('ignores a resolved load after unmount (no state update)', async () => {
    let resolve!: (value: FileTreeNode) => void;
    mockFetch.mockReturnValue(
      new Promise<FileTreeNode>((resolveFunction) => {
        resolve = resolveFunction;
      }),
    );
    const { unmount } = renderHook(() => useProjectFolders('p1'));
    unmount();
    await act(async () => {
      resolve(node({ type: 'folder', path: '/' }));
    });
    expect(mockFetch).toHaveBeenCalled();
  });
});
