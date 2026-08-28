import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { EditorSymbolRefactor } from '@/components/editor/editor-symbol-refactor';
import type { SymbolUsage, RenameSymbolResult } from '@/lib/api/projects';

const USAGES: SymbolUsage[] = [
  { fileNodeId: 'f1', path: 'book.adoc', kind: 'xref', range: { from: 10, to: 18 } },
  { fileNodeId: 'f2', path: 'chapter.adoc', kind: 'xref', range: { from: 4, to: 12 } },
];

function setup(overrides: Partial<React.ComponentProps<typeof EditorSymbolRefactor>> = {}) {
  const findUsages = jest.fn(async () => USAGES);
  const renameSymbol = jest.fn(
    async (): Promise<RenameSymbolResult> => ({ rewrittenFiles: 2, updatedReferences: 3, warnings: [] }),
  );
  const onNavigate = jest.fn();
  const onRenamed = jest.fn();
  const onClose = jest.fn();
  render(
    <EditorSymbolRefactor
      open
      projectId="p1"
      canEdit
      initial={{ kind: 'anchor', name: 'intro' }}
      findUsages={findUsages}
      renameSymbol={renameSymbol}
      onNavigate={onNavigate}
      onRenamed={onRenamed}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { findUsages, renameSymbol, onNavigate, onRenamed, onClose };
}

describe('EditorSymbolRefactor', () => {
  test('renders nothing when closed', () => {
    const { container } = render(
      <EditorSymbolRefactor
        open={false}
        projectId="p1"
        canEdit
        findUsages={jest.fn()}
        renameSymbol={jest.fn()}
        onNavigate={jest.fn()}
        onRenamed={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test('auto-lists usages for the seeded symbol on open', async () => {
    const { findUsages } = setup();
    await waitFor(() => expect(findUsages).toHaveBeenCalledWith('p1', 'intro', 'anchor'));
    expect(await screen.findByText('book.adoc')).toBeInTheDocument();
    expect(screen.getByText('chapter.adoc')).toBeInTheDocument();
  });

  test('clicking a usage navigates to it', async () => {
    const { onNavigate } = setup();
    fireEvent.click(await screen.findByText('chapter.adoc'));
    expect(onNavigate).toHaveBeenCalledWith(USAGES[1]);
  });

  test('renaming calls the API and reports the outcome', async () => {
    const { renameSymbol, onRenamed } = setup();
    await screen.findByText('book.adoc'); // let the auto-find settle (clears loading)
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'overview' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(renameSymbol).toHaveBeenCalledWith('p1', { symbolKind: 'anchor', oldName: 'intro', newName: 'overview' }),
    );
    expect(onRenamed).toHaveBeenCalledWith({ rewrittenFiles: 2, updatedReferences: 3, warnings: [] }, 'anchor', 'intro', 'overview');
    expect(await screen.findByText(/Renamed across 2 files/)).toBeInTheDocument();
  });

  test('the Rename button is disabled when the new name equals the old', () => {
    setup(); // newName seeds to 'intro' === name
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
  });

  test('a viewer (no edit permission) cannot see the rename control', async () => {
    setup({ canEdit: false });
    await screen.findByText('book.adoc');
    expect(screen.queryByLabelText('New name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
  });

  test('surfaces a rename error from the API', async () => {
    const failing = jest.fn(async () => {
      const error: Error & { code?: string } = new Error('Cannot rename to "summary": a anchor with that name already exists');
      error.code = 'INVALID_SYMBOL_RENAME';
      throw error;
    });
    setup({ renameSymbol: failing });
    await screen.findByText('book.adoc'); // let the auto-find settle (clears loading)
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'summary' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/);
  });

  test('shows the empty state and prompt when no usages / not yet searched', async () => {
    const empty = jest.fn(async () => [] as SymbolUsage[]);
    setup({ findUsages: empty });
    expect(await screen.findByText('No usages found.')).toBeInTheDocument();
  });

  test('prompts to find usages when opened without a seeded symbol', () => {
    setup({ initial: null });
    expect(screen.getByText('Find usages to list references.')).toBeInTheDocument();
  });

  test('surfaces a find-usages error', async () => {
    const failing = jest.fn(async () => {
      throw new Error('network down');
    });
    setup({ findUsages: failing });
    expect(await screen.findByRole('alert')).toHaveTextContent(/network down/);
  });

  test('manual Find usages button runs a fresh search for the typed name', async () => {
    const { findUsages } = setup({ initial: null });
    fireEvent.change(screen.getByLabelText('Symbol name'), { target: { value: 'glossary' } });
    fireEvent.click(screen.getByRole('button', { name: /find usages/i }));
    await waitFor(() => expect(findUsages).toHaveBeenCalledWith('p1', 'glossary', 'anchor'));
  });

  test('Find usages restricts to the attribute kind when the kind is switched', async () => {
    const { findUsages } = setup({ initial: null });
    fireEvent.change(screen.getByLabelText('Symbol kind'), { target: { value: 'attribute' } });
    fireEvent.change(screen.getByLabelText('Symbol name'), { target: { value: 'revision' } });
    fireEvent.click(screen.getByRole('button', { name: /find usages/i }));
    await waitFor(() => expect(findUsages).toHaveBeenCalledWith('p1', 'revision', 'attribute'));
  });

  test('Enter in the name field triggers a find; Enter in the new-name field triggers a rename', async () => {
    const { findUsages, renameSymbol } = setup({ initial: null });
    const nameInput = screen.getByLabelText('Symbol name');
    fireEvent.change(nameInput, { target: { value: 'intro' } });
    fireEvent.keyDown(nameInput, { key: 'Enter' });
    await waitFor(() => expect(findUsages).toHaveBeenCalledWith('p1', 'intro', 'anchor'));
    await screen.findByText('book.adoc');

    const newNameInput = screen.getByLabelText('New name');
    fireEvent.change(newNameInput, { target: { value: 'overview' } });
    fireEvent.keyDown(newNameInput, { key: 'Enter' });
    await waitFor(() =>
      expect(renameSymbol).toHaveBeenCalledWith('p1', { symbolKind: 'anchor', oldName: 'intro', newName: 'overview' }),
    );
  });

  test('renames an attribute when the kind is switched', async () => {
    const { renameSymbol } = setup();
    await screen.findByText('book.adoc');
    fireEvent.change(screen.getByLabelText('Symbol kind'), { target: { value: 'attribute' } });
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'revision' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(renameSymbol).toHaveBeenCalledWith('p1', { symbolKind: 'attribute', oldName: 'intro', newName: 'revision' }),
    );
  });

  test('reports warnings in the rename summary', async () => {
    const withWarnings = jest.fn(
      async (): Promise<RenameSymbolResult> => ({ rewrittenFiles: 1, updatedReferences: 1, warnings: ['could not rewrite x'] }),
    );
    setup({ renameSymbol: withWarnings });
    await screen.findByText('book.adoc');
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'overview' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByText(/1 warning/)).toBeInTheDocument();
  });

  test('Escape closes the dialog from either input', async () => {
    const { onClose } = setup();
    await screen.findByText('book.adoc');
    fireEvent.keyDown(screen.getByLabelText('Symbol name'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByLabelText('New name'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  test('a click on the backdrop closes the dialog, one inside it does not', () => {
    const { onClose } = setup({ initial: null });
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('searching for a blank name does nothing', () => {
    const { findUsages } = setup({ initial: null });
    fireEvent.change(screen.getByLabelText('Symbol name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /find usages/i }));
    expect(findUsages).not.toHaveBeenCalled();
  });

  test('renaming to or from a blank name does nothing', async () => {
    const { renameSymbol } = setup({ initial: null });
    // The button is disabled for a blank name, so the field's Enter shortcut is the way in.
    fireEvent.keyDown(screen.getByLabelText('New name'), { key: 'Enter' });
    await waitFor(() => expect(renameSymbol).not.toHaveBeenCalled());
  });

  test('a slow search cannot overwrite the results of a newer one', async () => {
    let releaseFirst: ((usages: SymbolUsage[]) => void) | undefined;
    const findUsages = jest
      .fn<Promise<SymbolUsage[]>, [string, string, string]>()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockImplementationOnce(async () => USAGES);
    setup({ initial: null, findUsages });

    const nameInput = screen.getByLabelText('Symbol name');
    fireEvent.change(nameInput, { target: { value: 'slow' } });
    fireEvent.click(screen.getByRole('button', { name: /find usages/i }));
    fireEvent.change(nameInput, { target: { value: 'fast' } });
    fireEvent.click(screen.getByRole('button', { name: /find usages/i }));
    expect(await screen.findByText('book.adoc')).toBeInTheDocument();

    await act(async () => {
      releaseFirst?.([{ fileNodeId: 'stale', path: 'stale.adoc', kind: 'xref', range: { from: 0, to: 1 } }]);
    });
    expect(screen.queryByText('stale.adoc')).not.toBeInTheDocument();
    expect(screen.getByText('book.adoc')).toBeInTheDocument();
  });

  test('a slow search that fails cannot replace a newer search’s results with its error', async () => {
    let rejectFirst: ((reason: unknown) => void) | undefined;
    const findUsages = jest
      .fn<Promise<SymbolUsage[]>, [string, string, string]>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(async () => USAGES);
    setup({ initial: null, findUsages });

    const nameInput = screen.getByLabelText('Symbol name');
    fireEvent.change(nameInput, { target: { value: 'slow' } });
    fireEvent.click(screen.getByRole('button', { name: /find usages/i }));
    fireEvent.change(nameInput, { target: { value: 'fast' } });
    fireEvent.click(screen.getByRole('button', { name: /find usages/i }));
    expect(await screen.findByText('book.adoc')).toBeInTheDocument();

    await act(async () => { rejectFirst?.(new Error('the slow one gave up')); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('book.adoc')).toBeInTheDocument();
  });

  test('reports a search that fails with something other than an error', async () => {
    const failing = jest.fn(async (): Promise<SymbolUsage[]> => { throw 'not an error object'; });
    setup({ findUsages: failing });
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to find usages');
  });

  test('reports a rename that fails with something other than an error', async () => {
    const failing = jest.fn(async (): Promise<RenameSymbolResult> => { throw 'not an error object'; });
    setup({ renameSymbol: failing });
    await screen.findByText('book.adoc');
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'overview' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Rename failed');
  });
});
