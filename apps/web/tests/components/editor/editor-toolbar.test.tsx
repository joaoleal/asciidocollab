import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('@radix-ui/react-tooltip', () => ({
  Root: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Trigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <button>{children}</button>,
  Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Content: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@/components/editor/editor-settings-panel', () => ({
  EditorSettingsPanel: ({
    fontSize,
    softWrap,
    setSoftWrap,
  }: {
    fontSize: number;
    theme: string;
    softWrap?: boolean;
    setSoftWrap?: (enabled: boolean) => void;
  }) => (
    <div data-testid="settings-panel">
      font={fontSize}
      <span data-testid="settings-softwrap">{String(softWrap)}</span>
      <span data-testid="settings-has-setsoftwrap">{String(typeof setSoftWrap === 'function')}</span>
    </div>
  ),
}));

jest.mock('@radix-ui/react-dropdown-menu', () => ({
  Root: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children: React.ReactNode }) => <button data-testid="more-btn">{children}</button>,
  Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Content: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  Item: ({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) => (
    <button onClick={onSelect}>{children}</button>
  ),
  Separator: () => <hr />,
}));

import { EditorToolbar } from '@/components/editor/editor-toolbar';
import type { EditorView } from '@codemirror/view';

// Create a minimal mock EditorView for dispatch testing
function createMockView(content: string = '') {
  const doc = {
    toString: () => content,
    length: content.length,
    lines: content.split('\n').length,
    lineAt: (_pos: number) => ({ from: 0, to: content.length, number: 1, text: content }),
  };
  const state = {
    doc,
    selection: { main: { from: 0, to: 0, head: 0, anchor: 0, empty: true } },
    sliceDoc: (from: number, to: number) => content.slice(from, to),
  };
  const dispatched: unknown[] = [];
  return {
    state,
    dispatch: (tr: unknown) => { dispatched.push(tr); },
    dispatched,
    focus: jest.fn(),
  } as unknown as EditorView & { dispatched: unknown[] };
}

/**
 * The mock view's selection, which `EditorState` declares read-only. The double is built by casting a
 * plain object to `EditorView`, so the fields really are writable — this says so at the one place a
 * spec needs to move the cursor, instead of pretending the CM6 type allows it.
 */
function mockSelection(view: EditorView): {
  from: number;
  to: number;
  head: number;
  anchor: number;
  empty: boolean;
} {
  return view.state.selection.main as unknown as {
    from: number;
    to: number;
    head: number;
    anchor: number;
    empty: boolean;
  };
}

describe('EditorToolbar', () => {
  test('renders four labelled groups (Text Formatting, Structure, Blocks, Inline/References)', () => {
    const view = createMockView('');
    render(<EditorToolbar view={view} />);

    expect(screen.getByRole('group', { name: /text formatting/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /structure/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /blocks/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /inline/i })).toBeInTheDocument();
  });

  test('clicking Bold with no selection inserts *bold* placeholder', () => {
    const view = createMockView('');
    render(<EditorToolbar view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /bold/i }));
    const tr = (view as unknown as { dispatched: Array<{ changes: { insert: string } }> }).dispatched[0];
    expect(tr.changes.insert).toBe('*bold*');
  });

  test('clicking Bold with selected text wraps it in * ... *', () => {
    const view = createMockView('hello world');
    mockSelection(view).from = 0;
    mockSelection(view).to = 5;
    mockSelection(view).empty = false;
    (view.state as { sliceDoc: (f: number, t: number) => string }).sliceDoc = (_f, _t) => 'hello';

    render(<EditorToolbar view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /bold/i }));
    const tr = (view as unknown as { dispatched: Array<{ changes: { insert: string } }> }).dispatched[0];
    expect(tr.changes.insert).toBe('*hello*');
  });

  test('clicking Code Block inserts a [source,<lang>] declaration with delimiters, cursor at the language', () => {
    const view = createMockView('');
    render(<EditorToolbar view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /code block/i }));
    const tr = (view as unknown as {
      dispatched: Array<{ changes: { insert: string }; selection: { anchor: number; head: number } }>;
    }).dispatched[0];
    expect(tr.changes.insert).toContain('[source,');
    expect(tr.changes.insert).toContain('----');
    // The language placeholder is selected so the author types it immediately.
    expect(tr.changes.insert.slice(tr.selection.anchor, tr.selection.head)).toBe('language');
  });

  test('clicking Heading 2 inserts == prefix at line start', () => {
    const view = createMockView('');
    render(<EditorToolbar view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /heading 2/i }));
    const tr = (view as unknown as { dispatched: Array<{ changes: { insert: string } }> }).dispatched[0];
    expect(tr.changes.insert).toBe('== ');
  });

  test('clicking NOTE inserts [NOTE] admonition snippet', () => {
    const view = createMockView('');
    render(<EditorToolbar view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /^note$/i }));
    const tr = (view as unknown as { dispatched: Array<{ changes: { insert: string } }> }).dispatched[0];
    expect(tr.changes.insert).toContain('[NOTE]');
  });

  test('clicking Link inserts link: snippet', () => {
    const view = createMockView('');
    render(<EditorToolbar view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /^link$/i }));
    const tr = (view as unknown as { dispatched: Array<{ changes: { insert: string } }> }).dispatched[0];
    expect(tr.changes.insert).toContain('link:');
  });

  test('clicking Image inserts image:: snippet', () => {
    const view = createMockView('');
    render(<EditorToolbar view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /^image$/i }));
    const tr = (view as unknown as { dispatched: Array<{ changes: { insert: string } }> }).dispatched[0];
    expect(tr.changes.insert).toContain('image::');
  });

  test('all buttons in each group are keyboard-accessible', () => {
    const view = createMockView('');
    render(<EditorToolbar view={view} />);
    const buttons = screen.getAllByRole('button');
    // Each button should have an accessible name
    for (const button of buttons) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
      expect(name.length).toBeGreaterThan(0);
    }
  });

  describe('settings gear in toolbar', () => {
    test('settings gear button is always visible in the toolbar', () => {
      const view = createMockView('');
      render(<EditorToolbar view={view} />);
      expect(screen.getByRole('button', { name: /editor settings/i })).toBeInTheDocument();
    });

    test('settings panel is hidden by default', () => {
      const view = createMockView('');
      render(<EditorToolbar view={view} />);
      expect(screen.queryByTestId('settings-panel')).toBeNull();
    });

    test('clicking the gear opens the settings panel', () => {
      const view = createMockView('');
      render(
        <EditorToolbar
          view={view}
          fontSize={16}
          theme="default"
          setFontSize={jest.fn()}
          setTheme={jest.fn()}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /editor settings/i }));
      expect(screen.getByTestId('settings-panel')).toBeInTheDocument();
    });

    test('clicking the gear a second time closes the settings panel', () => {
      const view = createMockView('');
      render(
        <EditorToolbar
          view={view}
          fontSize={16}
          theme="default"
          setFontSize={jest.fn()}
          setTheme={jest.fn()}
        />
      );
      const gear = screen.getByRole('button', { name: /editor settings/i });
      fireEvent.click(gear);
      expect(screen.getByTestId('settings-panel')).toBeInTheDocument();
      fireEvent.click(gear);
      expect(screen.queryByTestId('settings-panel')).toBeNull();
    });

    test('the gear reflects the panel state via aria-expanded and the active affordance', () => {
      const view = createMockView('');
      render(
        <EditorToolbar
          view={view}
          fontSize={16}
          theme="default"
          setFontSize={jest.fn()}
          setTheme={jest.fn()}
        />
      );
      const gear = screen.getByRole('button', { name: /editor settings/i });
      // Closed: no expanded state, no active styling.
      expect(gear).toHaveAttribute('aria-expanded', 'false');
      expect(gear.className).not.toMatch(/bg-accent/);
      // Open: expanded + active styling.
      fireEvent.click(gear);
      expect(gear).toHaveAttribute('aria-expanded', 'true');
      expect(gear.className).toMatch(/bg-accent/);
      // Closed again: reverts.
      fireEvent.click(gear);
      expect(gear).toHaveAttribute('aria-expanded', 'false');
      expect(gear.className).not.toMatch(/bg-accent/);
    });

    test('passes softWrap + setSoftWrap to the settings panel so the Soft Wrap control renders', () => {
      const view = createMockView('');
      render(
        <EditorToolbar
          view={view}
          fontSize={14}
          theme="default"
          softWrap={false}
          setFontSize={jest.fn()}
          setTheme={jest.fn()}
          setSoftWrap={jest.fn()}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /editor settings/i }));
      expect(screen.getByTestId('settings-softwrap')).toHaveTextContent('false');
      expect(screen.getByTestId('settings-has-setsoftwrap')).toHaveTextContent('true');
    });

    test('action groups are hidden when canEdit is false', () => {
      const view = createMockView('');
      render(<EditorToolbar view={view} canEdit={false} />);
      expect(screen.queryByRole('group', { name: /text formatting/i })).toBeNull();
      expect(screen.queryByRole('group', { name: /structure/i })).toBeNull();
    });

    test('action groups are visible when canEdit is true (default)', () => {
      const view = createMockView('');
      render(<EditorToolbar view={view} canEdit={true} />);
      expect(screen.getByRole('group', { name: /text formatting/i })).toBeInTheDocument();
    });
  });

  describe('Go to Symbol / Refactor buttons', () => {
    test('the buttons are absent when no callbacks are provided', () => {
      const view = createMockView('');
      render(<EditorToolbar view={view} />);
      expect(screen.queryByRole('button', { name: /go to symbol/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /refactor/i })).toBeNull();
    });

    test('Go to Symbol button fires its callback', () => {
      const view = createMockView('');
      const onGoToSymbol = jest.fn();
      render(<EditorToolbar view={view} onGoToSymbol={onGoToSymbol} />);
      fireEvent.click(screen.getByRole('button', { name: /go to symbol/i }));
      expect(onGoToSymbol).toHaveBeenCalledTimes(1);
    });

    test('Refactor button seeds the dialog with the symbol under the cursor', () => {
      const view = createMockView('{product}');
      mockSelection(view).head = 3; // inside {product}
      const onRefactor = jest.fn();
      render(<EditorToolbar view={view} onRefactor={onRefactor} />);
      fireEvent.click(screen.getByRole('button', { name: /refactor/i }));
      expect(onRefactor).toHaveBeenCalledWith({ kind: 'attribute', name: 'product' });
    });

    test('Refactor button passes null when the cursor is not on a symbol', () => {
      const view = createMockView('plain text');
      mockSelection(view).head = 2;
      const onRefactor = jest.fn();
      render(<EditorToolbar view={view} onRefactor={onRefactor} />);
      fireEvent.click(screen.getByRole('button', { name: /refactor/i }));
      expect(onRefactor).toHaveBeenCalledWith(null);
    });

    test('Refactor button passes null when there is no view yet', () => {
      const onRefactor = jest.fn();
      render(<EditorToolbar view={null} onRefactor={onRefactor} />);
      fireEvent.click(screen.getByRole('button', { name: /refactor/i }));
      expect(onRefactor).toHaveBeenCalledWith(null);
    });
  });

  // ── action coverage: every toolbar button dispatches to the view ──────────
  const actionLabels: Array<[string, RegExp]> = [
    ['Italic',           /^italic$/i],
    ['Monospace',        /^monospace$/i],
    ['Highlight',        /^highlight$/i],
    ['Subscript',        /^subscript$/i],
    ['Superscript',      /^superscript$/i],
    ['Heading 1',        /^heading 1$/i],
    ['Heading 3',        /^heading 3$/i],
    ['Heading 4',        /^heading 4$/i],
    ['Heading 5',        /^heading 5$/i],
    ['Ordered List',     /^ordered list$/i],
    ['Unordered List',   /^unordered list$/i],
    ['Checklist',        /^checklist$/i],
    ['Description List', /^description list$/i],
    ['Example Block',    /^example block$/i],
    ['Sidebar',          /^sidebar$/i],
    ['Blockquote',       /^blockquote$/i],
    ['NOTE',             /^note$/i],
    ['TIP',              /^tip$/i],
    ['WARNING',          /^warning$/i],
    ['IMPORTANT',        /^important$/i],
    ['CAUTION',          /^caution$/i],
    ['STEM Block',       /^stem block$/i],
    ['Comment Block',    /^comment block$/i],
    ['Table',            /^table$/i],
    ['Caption',          /^caption$/i],
    ['Link',             /^link$/i],
    ['Cross-reference',  /^cross-reference$/i],
    ['Footnote',         /^footnote$/i],
    ['Image',            /^image$/i],
  ];

  for (const [label, pattern] of actionLabels) {
    test(`${label} button dispatches to the view`, () => {
      const view = createMockView('some text');
      render(<EditorToolbar view={view} />);
      fireEvent.click(screen.getByRole('button', { name: pattern }));
      expect((view as unknown as { dispatched: unknown[] }).dispatched.length).toBeGreaterThan(0);
    });
  }
});
