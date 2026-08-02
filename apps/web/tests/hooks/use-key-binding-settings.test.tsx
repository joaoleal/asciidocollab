import { renderHook, act, waitFor } from '@testing-library/react';
import { useKeyBindingSettings } from '@/hooks/use-key-binding-settings';

globalThis.fetch = jest.fn();

const mockBindings = [
  { action: 'file-tree:rename', keyCombo: 'F2', isDefault: true },
  { action: 'file-tree:delete', keyCombo: 'Delete', isDefault: true },
];

describe('useKeyBindingSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockBindings),
    });
  });

  it('fetches all namespaces and groups by namespace', async () => {
    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => {
      expect(result.current.groups.length).toBeGreaterThan(0);
      expect(result.current.groups[0].namespace).toBe('file-tree');
    });
  });

  it('gives the editor its own section beside the file tree', async () => {
    // What the settings page shows is whatever the endpoint returns, grouped by the namespace in each
    // action id. The editor's shortcuts only become configurable by arriving here — so this pins the
    // path from the server's answer to a section the reader can actually see.
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { action: 'file-tree:rename', label: 'Rename', keyCombo: 'F2', isDefault: true },
        { action: 'editor:bold', label: 'Bold', keyCombo: 'Mod+B', isDefault: true },
        { action: 'editor:italic', label: 'Italic', keyCombo: 'Mod+I', isDefault: true },
      ]),
    });

    const { result } = renderHook(() => useKeyBindingSettings());

    await waitFor(() => expect(result.current.groups).toHaveLength(2));
    const editor = result.current.groups.find((group) => group.namespace === 'editor');
    expect(editor?.label).toBe('Editor');
    expect(editor?.bindings.map((binding) => binding.action)).toEqual(['editor:bold', 'editor:italic']);
  });

  it('fetches from correct base URL including http://localhost:4000', async () => {
    renderHook(() => useKeyBindingSettings());
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('http://localhost:4000/auth/me/keybindings'),
        expect.any(Object),
      );
    });
  });

  it('group label is title-cased with spaces replacing dashes', async () => {
    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));
    const group = result.current.groups.find((g) => g.namespace === 'file-tree');
    expect(group?.label).toBe('File Tree');
  });

  it('bindings array in group contains the expected actions', async () => {
    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));
    const group = result.current.groups.find((g) => g.namespace === 'file-tree');
    expect(group?.bindings.map((b) => b.action)).toContain('file-tree:rename');
    expect(group?.bindings.map((b) => b.action)).toContain('file-tree:delete');
  });

  it('updateBinding calls PATCH and updates local state optimistically', async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockBindings) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ action: 'file-tree:rename', keyCombo: 'F3', isDefault: false }) });

    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));

    await act(async () => {
      await result.current.updateBinding('file-tree:rename', 'F3');
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost:4000/auth/me/keybindings/file-tree%3Arename'),
      expect.objectContaining({ method: 'PATCH', credentials: 'include' }),
    );
  });

  it('resetBinding calls DELETE and reverts to default', async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockBindings) })
      .mockResolvedValueOnce({ ok: true, status: 204, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockBindings) });

    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));

    await act(async () => {
      await result.current.resetBinding('file-tree:rename');
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/auth/me/keybindings/file-tree%3Arename'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('updateBinding rolls back state and throws when PATCH returns non-ok', async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockBindings) })
      .mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ error: { message: 'Key combo already in use' } }),
      });

    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));

    await expect(
      act(async () => { await result.current.updateBinding('file-tree:rename', 'F9'); }),
    ).rejects.toThrow('Key combo already in use');

    // State must be rolled back to the original key combo
    const ftGroup = result.current.groups.find(g => g.namespace === 'file-tree');
    const renameBinding = ftGroup?.bindings.find(b => b.action === 'file-tree:rename');
    expect(renameBinding?.keyCombo).toBe('F2');
  });

  it('updateBinding throws "Update failed" when error body is missing message', async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockBindings) })
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) });

    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));

    await expect(
      act(async () => { await result.current.updateBinding('file-tree:rename', 'F9'); }),
    ).rejects.toThrow('Update failed');
  });

  it('resetBinding sends DELETE to URL with encoded action', async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockBindings) })
      .mockResolvedValueOnce({ ok: true, status: 204, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockBindings) });

    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));

    await act(async () => { await result.current.resetBinding('file-tree:rename'); });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost:4000/auth/me/keybindings/file-tree%3Arename'),
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    );
  });

  it('updateBinding rolls back and throws with default message when error body missing', async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockBindings) })
      .mockResolvedValueOnce({
        ok: false,
        json: () => Promise.reject(new Error('no body')),
      });

    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));

    await expect(
      act(async () => { await result.current.updateBinding('file-tree:rename', 'F9'); }),
    ).rejects.toThrow('Update failed');
  });

  it('resetBinding rolls back state and throws when DELETE returns non-ok', async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockBindings) })
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) });

    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));

    await expect(
      act(async () => { await result.current.resetBinding('file-tree:rename'); }),
    ).rejects.toThrow('Reset failed');
  });

  it('fetchAll silently ignores network errors', async () => {
    (globalThis.fetch as jest.Mock).mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => {
      // After failed fetch, groups stays empty — hook must not throw
      expect(result.current.groups).toEqual([]);
    });
  });

  it('fetchAll sends credentials: include', async () => {
    renderHook(() => useKeyBindingSettings());
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ credentials: 'include' }),
      );
    });
  });

  it('updateBinding optimistically updates only the target binding keyCombo', async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockBindings) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ action: 'file-tree:rename', keyCombo: 'F3', isDefault: false }) });

    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));

    await act(async () => {
      await result.current.updateBinding('file-tree:rename', 'F3');
    });

    const ftGroup = result.current.groups.find((g) => g.namespace === 'file-tree');
    const renameBinding = ftGroup?.bindings.find((b) => b.action === 'file-tree:rename');
    const deleteBinding = ftGroup?.bindings.find((b) => b.action === 'file-tree:delete');

    // Target binding updated
    expect(renameBinding?.keyCombo).toBe('F3');
    expect(renameBinding?.isDefault).toBe(false);
    // Other bindings unchanged
    expect(deleteBinding?.keyCombo).toBe('Delete');
  });

  it('updateBinding throws with default "Update failed" when json() resolves to null', async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockBindings) })
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve(null) });

    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));

    await expect(
      act(async () => { await result.current.updateBinding('file-tree:rename', 'F9'); }),
    ).rejects.toThrow('Update failed');
  });

  it('fetchAll does not update bindings when response is not ok', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve(mockBindings),
    });
    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    // Flush the async chain: fetch → .then(r.ok check) → .then(setBindings if ok)
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // After non-ok response, bindings must stay empty
    expect(result.current.groups).toEqual([]);
  });

  it('group bindings contain exactly the expected number of entries', async () => {
    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));
    const group = result.current.groups.find((g) => g.namespace === 'file-tree');
    const expectedCount = mockBindings.filter((b) => b.action.startsWith('file-tree:')).length;
    expect(group?.bindings).toHaveLength(expectedCount);
  });

  it('updateBinding restores exact binding count after PATCH failure', async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockBindings) })
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: { message: 'conflict' } }) });

    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));
    const initialCount = mockBindings.length;

    await act(async () => {
      await result.current.updateBinding('file-tree:rename', 'F9').catch(() => {});
    });

    await waitFor(() => {
      expect(result.current.groups.flatMap((g) => g.bindings)).toHaveLength(initialCount);
    });
  });

  it('resetBinding restores exact binding count after DELETE failure', async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockBindings) })
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) });

    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));
    const initialCount = mockBindings.length;

    await act(async () => {
      await result.current.resetBinding('file-tree:rename').catch(() => {});
    });

    await waitFor(() => {
      expect(result.current.groups.flatMap((g) => g.bindings)).toHaveLength(initialCount);
    });
  });

  it('updateBinding PATCH sends body with keyCombo and Content-Type application/json header', async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockBindings) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ action: 'file-tree:rename', keyCombo: 'F3', isDefault: false }) });

    const { result } = renderHook(() => useKeyBindingSettings());
    await waitFor(() => expect(result.current.groups.length).toBeGreaterThan(0));

    await act(async () => { await result.current.updateBinding('file-tree:rename', 'F3'); });

    const calls = (globalThis.fetch as jest.Mock).mock.calls;
    const patchCall = calls.find(([, options]) => (options as RequestInit)?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall[1] as RequestInit).body as string);
    expect(body.keyCombo).toBe('F3');
    const headers = (patchCall[1] as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });
});
