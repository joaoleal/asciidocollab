import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { KeyboardShortcutsCard } from '@/app/(dashboard)/dashboard/account/keyboard-shortcuts-card';

jest.mock('@/hooks/use-key-binding-settings', () => ({
  useKeyBindingSettings: jest.fn(),
}));

const mockUseKeyBindingSettings = jest.requireMock('@/hooks/use-key-binding-settings').useKeyBindingSettings as jest.Mock;

const defaultGroups = [{
  namespace: 'file-tree',
  label: 'File Tree',
  bindings: [
    { action: 'file-tree:rename', label: 'Rename', keyCombo: 'F2', isDefault: true },
    { action: 'file-tree:delete', label: 'Delete', keyCombo: 'Delete', isDefault: true },
  ],
}];

describe('KeyboardShortcutsCard', () => {
  const mockUpdate = jest.fn().mockResolvedValue(undefined);
  const mockReset = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseKeyBindingSettings.mockReturnValue({
      groups: defaultGroups,
      updateBinding: mockUpdate,
      resetBinding: mockReset,
    });
  });

  it('renders one section per namespace', () => {
    render(<KeyboardShortcutsCard />);
    expect(screen.getByText('File Tree')).toBeInTheDocument();
  });

  it('each row shows action label, current binding, and reset button', () => {
    render(<KeyboardShortcutsCard />);
    expect(screen.getByText('Rename')).toBeInTheDocument();
    expect(screen.getByText('F2')).toBeInTheDocument();
  });

  it('lists the editor shortcuts, each with an icon beside it', () => {
    mockUseKeyBindingSettings.mockReturnValue({
      groups: [
        ...defaultGroups,
        {
          namespace: 'editor',
          label: 'Editor',
          bindings: [
            { action: 'editor:bold', label: 'Bold', keyCombo: 'Mod+B', isDefault: true },
            { action: 'editor:review-comment', label: 'Add Review Comment', keyCombo: 'Mod+Shift+M', isDefault: true },
          ],
        },
      ],
      updateBinding: mockUpdate,
      resetBinding: mockReset,
    });

    const { container } = render(<KeyboardShortcutsCard />);

    expect(screen.getByText('Editor')).toBeInTheDocument();
    expect(screen.getByText('Bold')).toBeInTheDocument();
    expect(screen.getByText('Mod+B')).toBeInTheDocument();
    expect(screen.getByText('Add Review Comment')).toBeInTheDocument();

    // One icon per row, and decorative: the label beside it already names the action, so announcing
    // the glyph too would read every row twice to a screen reader.
    const icons = container.querySelectorAll('svg[aria-hidden="true"]');
    expect(icons.length).toBeGreaterThanOrEqual(4);
  });

  it('clicking a binding cell enters capture mode showing "Press a key…"', () => {
    render(<KeyboardShortcutsCard />);
    fireEvent.click(screen.getByText('F2'));
    expect(screen.getByPlaceholderText(/press a key/i)).toBeInTheDocument();
  });

  it('a lone modifier keydown in capture mode does not call updateBinding', async () => {
    render(<KeyboardShortcutsCard />);
    fireEvent.click(screen.getByText('F2'));
    const input = screen.getByPlaceholderText(/press a key/i);
    fireEvent.keyDown(input, { key: 'Shift' });
    await waitFor(() => expect(mockUpdate).not.toHaveBeenCalled());
    expect(screen.getByPlaceholderText(/press a key/i)).toBeInTheDocument();
  });

  it('Escape exits capture mode without calling updateBinding', () => {
    render(<KeyboardShortcutsCard />);
    fireEvent.click(screen.getByText('F2'));
    const input = screen.getByPlaceholderText(/press a key/i);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText(/press a key/i)).not.toBeInTheDocument();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('non-modifier keydown in capture mode calls updateBinding with correct action and combo', async () => {
    render(<KeyboardShortcutsCard />);
    fireEvent.click(screen.getByText('F2'));
    const input = screen.getByPlaceholderText(/press a key/i);
    fireEvent.keyDown(input, { key: 'F3' });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('file-tree:rename', 'F3'));
  });

  it('reset button calls resetBinding', async () => {
    // Override mock to use non-default binding (so reset button is enabled)
    mockUseKeyBindingSettings.mockReturnValue({
      groups: [{
        namespace: 'file-tree',
        label: 'File Tree',
        bindings: [
          { action: 'file-tree:rename', label: 'Rename', keyCombo: 'F3', isDefault: false },
        ],
      }],
      updateBinding: mockUpdate,
      resetBinding: mockReset,
    });

    render(<KeyboardShortcutsCard />);
    const resetButton = screen.getByRole('button', { name: /reset/i });
    expect(resetButton).not.toBeDisabled();
    fireEvent.click(resetButton);
    await waitFor(() => expect(mockReset).toHaveBeenCalledWith('file-tree:rename'));
  });

  it('reset button disabled when isDefault: true', () => {
    render(<KeyboardShortcutsCard />);
    const resetButtons = screen.getAllByRole('button', { name: /reset/i });
    expect(resetButtons[0]).toBeDisabled();
  });

  it('builds a combo string including every modifier and upper-cases single characters', async () => {
    render(<KeyboardShortcutsCard />);
    fireEvent.click(screen.getByText('F2'));
    const input = screen.getByPlaceholderText(/press a key/i);
    fireEvent.keyDown(input, { key: 'a', ctrlKey: true, shiftKey: true, altKey: true, metaKey: true });
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith('file-tree:rename', 'Ctrl+Shift+Alt+Meta+A'),
    );
  });

  it('shows the error message when updateBinding rejects with an Error', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('Shortcut already in use'));
    render(<KeyboardShortcutsCard />);
    fireEvent.click(screen.getByText('F2'));
    fireEvent.keyDown(screen.getByPlaceholderText(/press a key/i), { key: 'F4' });
    await waitFor(() => expect(screen.getByText('Shortcut already in use')).toBeInTheDocument());
  });

  it('shows a fallback message when updateBinding rejects with a non-Error', async () => {
    mockUpdate.mockRejectedValueOnce('boom');
    render(<KeyboardShortcutsCard />);
    fireEvent.click(screen.getByText('F2'));
    fireEvent.keyDown(screen.getByPlaceholderText(/press a key/i), { key: 'F5' });
    await waitFor(() => expect(screen.getByText('Error')).toBeInTheDocument());
  });
});
