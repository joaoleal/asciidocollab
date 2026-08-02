import React, { useRef } from 'react';
import { render, fireEvent, renderHook } from '@testing-library/react';
import { useFileTreeKeyHandler, type FileTreeKeyCallbacks } from '@/hooks/use-file-tree-key-handler';

function TestComponent({ bindings, callbacks }: {
  bindings: Map<string, string>;
  callbacks: FileTreeKeyCallbacks;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFileTreeKeyHandler(ref, bindings, callbacks);
  return (
    <div ref={ref} tabIndex={0} data-testid="container">
      {/* The tree really does contain a text field — the find panel's — so a keystroke arriving from
          one is an ordinary event here, not a contrived one. */}
      <input data-testid="text-field" />
      <div data-testid="editable" contentEditable suppressContentEditableWarning />
    </div>
  );
}

const defaultBindings = new Map([
  ['file-tree:rename', 'F2'],
  ['file-tree:delete', 'Delete'],
  ['file-tree:new-file', 'Ctrl+N'],
  ['file-tree:new-folder', 'Ctrl+Shift+N'],
]);

describe('useFileTreeKeyHandler', () => {
  it('F2 fires the rename callback', () => {
    const onRename = jest.fn();
    const { getByTestId } = render(
      <TestComponent bindings={defaultBindings} callbacks={{ 'file-tree:rename': onRename, 'file-tree:delete': jest.fn(), 'file-tree:new-file': jest.fn(), 'file-tree:new-folder': jest.fn() }} />,
    );
    fireEvent.keyDown(getByTestId('container'), { key: 'F2' });
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('Delete fires the delete callback', () => {
    const onDelete = jest.fn();
    const { getByTestId } = render(
      <TestComponent bindings={defaultBindings} callbacks={{ 'file-tree:rename': jest.fn(), 'file-tree:delete': onDelete, 'file-tree:new-file': jest.fn(), 'file-tree:new-folder': jest.fn() }} />,
    );
    fireEvent.keyDown(getByTestId('container'), { key: 'Delete' });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+N fires the new-file callback', () => {
    const onNewFile = jest.fn();
    const { getByTestId } = render(
      <TestComponent bindings={defaultBindings} callbacks={{ 'file-tree:rename': jest.fn(), 'file-tree:delete': jest.fn(), 'file-tree:new-file': onNewFile, 'file-tree:new-folder': jest.fn() }} />,
    );
    fireEvent.keyDown(getByTestId('container'), { key: 'n', ctrlKey: true });
    expect(onNewFile).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Shift+N fires the new-folder callback', () => {
    const onNewFolder = jest.fn();
    const { getByTestId } = render(
      <TestComponent bindings={defaultBindings} callbacks={{ 'file-tree:rename': jest.fn(), 'file-tree:delete': jest.fn(), 'file-tree:new-file': jest.fn(), 'file-tree:new-folder': onNewFolder }} />,
    );
    fireEvent.keyDown(getByTestId('container'), { key: 'N', ctrlKey: true, shiftKey: true });
    expect(onNewFolder).toHaveBeenCalledTimes(1);
  });

  it('bound key does not fire when its callback is undefined', () => {
    const onDelete = jest.fn();
    const { getByTestId } = render(
      <TestComponent bindings={defaultBindings} callbacks={{ 'file-tree:rename': undefined, 'file-tree:delete': onDelete, 'file-tree:new-file': jest.fn(), 'file-tree:new-folder': jest.fn() }} />,
    );
    // F2 (rename) has no callback — must not crash or fire anything
    fireEvent.keyDown(getByTestId('container'), { key: 'F2' });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('Ctrl+F fires the find callback', () => {
    const onFind = jest.fn();
    const findBindings = new Map([...defaultBindings, ['file-tree:find', 'Ctrl+F']]);
    const { getByTestId } = render(
      <TestComponent bindings={findBindings} callbacks={{ 'file-tree:rename': jest.fn(), 'file-tree:delete': jest.fn(), 'file-tree:new-file': jest.fn(), 'file-tree:new-folder': jest.fn(), 'file-tree:find': onFind }} />,
    );
    fireEvent.keyDown(getByTestId('container'), { key: 'f', ctrlKey: true });
    expect(onFind).toHaveBeenCalledTimes(1);
  });

  it('remapped binding fires correct callback after bindings prop changes', () => {
    const onRename = jest.fn();
    const newBindings = new Map([...defaultBindings, ['file-tree:rename', 'F3']]);

    const { getByTestId, rerender } = render(
      <TestComponent bindings={defaultBindings} callbacks={{ 'file-tree:rename': onRename, 'file-tree:delete': jest.fn(), 'file-tree:new-file': jest.fn(), 'file-tree:new-folder': jest.fn() }} />,
    );

    // F2 should fire rename with default bindings
    fireEvent.keyDown(getByTestId('container'), { key: 'F2' });
    expect(onRename).toHaveBeenCalledTimes(1);

    rerender(<TestComponent bindings={newBindings} callbacks={{ 'file-tree:rename': onRename, 'file-tree:delete': jest.fn(), 'file-tree:new-file': jest.fn(), 'file-tree:new-folder': jest.fn() }} />);

    // After remap, F3 fires rename
    fireEvent.keyDown(getByTestId('container'), { key: 'F3' });
    expect(onRename).toHaveBeenCalledTimes(2);

    // Old binding no longer fires
    const beforeCount = onRename.mock.calls.length;
    fireEvent.keyDown(getByTestId('container'), { key: 'F2' });
    expect(onRename.mock.calls.length).toBe(beforeCount);
  });

  it('pressing a lone modifier key does not fire any callback', () => {
    const onRename = jest.fn();
    const { getByTestId } = render(
      <TestComponent bindings={defaultBindings} callbacks={{ 'file-tree:rename': onRename, 'file-tree:delete': jest.fn(), 'file-tree:new-file': jest.fn(), 'file-tree:new-folder': jest.fn() }} />,
    );
    fireEvent.keyDown(getByTestId('container'), { key: 'Shift' });
    fireEvent.keyDown(getByTestId('container'), { key: 'Control' });
    fireEvent.keyDown(getByTestId('container'), { key: 'Alt' });
    fireEvent.keyDown(getByTestId('container'), { key: 'Meta' });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('an Alt-modified combo fires its callback', () => {
    const onAlt = jest.fn();
    const altBindings = new Map([['file-tree:alt-action', 'Alt+A']]);
    const { getByTestId } = render(
      <TestComponent bindings={altBindings} callbacks={{ 'file-tree:alt-action': onAlt }} />,
    );
    fireEvent.keyDown(getByTestId('container'), { key: 'a', altKey: true });
    expect(onAlt).toHaveBeenCalledTimes(1);
  });

  it('leaves a keystroke alone when it was typed into a text field', () => {
    const onDelete = jest.fn();
    const onNewFile = jest.fn();
    const { getByTestId } = render(
      <TestComponent
        bindings={defaultBindings}
        callbacks={{ 'file-tree:rename': jest.fn(), 'file-tree:delete': onDelete, 'file-tree:new-file': onNewFile, 'file-tree:new-folder': jest.fn() }}
      />,
    );

    // The listener sits on the whole tree, so it hears the find panel's input too. Acting on these
    // would be worse than useless: `Delete` while correcting a typo would delete the SELECTED FILE,
    // and — because the shortcut calls preventDefault — would not even remove the character.
    fireEvent.keyDown(getByTestId('text-field'), { key: 'Delete' });
    fireEvent.keyDown(getByTestId('text-field'), { key: 'n', ctrlKey: true });

    expect(onDelete).not.toHaveBeenCalled();
    expect(onNewFile).not.toHaveBeenCalled();
  });

  it('leaves a keystroke alone when it was typed into rich text', () => {
    const onDelete = jest.fn();
    const { getByTestId } = render(
      <TestComponent
        bindings={defaultBindings}
        callbacks={{ 'file-tree:rename': jest.fn(), 'file-tree:delete': onDelete, 'file-tree:new-file': jest.fn(), 'file-tree:new-folder': jest.fn() }}
      />,
    );

    fireEvent.keyDown(getByTestId('editable'), { key: 'Delete' });

    expect(onDelete).not.toHaveBeenCalled();
  });

  it('leaves a keystroke alone when the focus is outside the tree', () => {
    const onRename = jest.fn();
    const onDelete = jest.fn();
    render(
      <TestComponent bindings={defaultBindings} callbacks={{ 'file-tree:rename': onRename, 'file-tree:delete': onDelete, 'file-tree:new-file': jest.fn(), 'file-tree:new-folder': jest.fn() }} />,
    );

    // These shortcuts belong to the tree and act only while the reader is working in it. Once the
    // focus has moved on — to the editor, most of the time — the same keys mean what that surface
    // says they mean: `Delete` deletes the character in front of the cursor, and taking it to mean
    // the FILE because a file happens to be selected would destroy something never pointed at.
    fireEvent.keyDown(document.body, { key: 'F2' });
    fireEvent.keyDown(document.body, { key: 'Delete' });

    expect(onRename).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('does nothing when the container ref is null', () => {
    const ref = { current: null };
    expect(() => renderHook(() => useFileTreeKeyHandler(ref, defaultBindings, {}))).not.toThrow();
  });
});
