import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';
import type { TableContext } from '@/lib/codemirror/asciidoc-table-context';
import { EditorTableContextToolbar } from '@/components/editor/editor-table-context-toolbar';
import { parseTable } from '@/lib/codemirror/asciidoc-table-operations';

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

function createMockView(tableText: string = '') {
  const dispatched: unknown[] = [];
  return {
    state: {
      doc: {
        toString: () => tableText,
        sliceString: (_from: number, _to: number) => tableText,
      },
    },
    dispatch: (tr: unknown) => { dispatched.push(tr); },
    dispatched,
    focus: jest.fn(),
  } as unknown as EditorView & { dispatched: unknown[] };
}

function makeContext(overrides?: Partial<TableContext>): TableContext {
  return {
    tableFrom: 0,
    tableTo: 20,
    cursorRowIndex: 0,
    cursorColumnIndex: 0,
    rowCount: 2,
    columnCount: 2,
    hasColSpec: false,
    isInHeader: false,
    ...overrides,
  };
}

const TABLE_2X2 = '|===\n|a |b\n|c |d\n|===';

describe('EditorTableContextToolbar', () => {
  test('renders all 9 action buttons', () => {
    const view = createMockView(TABLE_2X2);
    const context = makeContext();
    render(
      <EditorTableContextToolbar
        view={view}
        context={context}
        tableText={TABLE_2X2}
        tableFrom={0}
      />,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(9);
  });

  test('renders buttons for row operations (add above, add below, remove)', () => {
    const view = createMockView(TABLE_2X2);
    const context = makeContext();
    render(
      <EditorTableContextToolbar
        view={view}
        context={context}
        tableText={TABLE_2X2}
        tableFrom={0}
      />,
    );

    expect(screen.getByRole('button', { name: /add row above/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add row below/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove row/i })).toBeInTheDocument();
  });

  test('renders buttons for column operations', () => {
    const view = createMockView(TABLE_2X2);
    const context = makeContext();
    render(
      <EditorTableContextToolbar
        view={view}
        context={context}
        tableText={TABLE_2X2}
        tableFrom={0}
      />,
    );

    expect(screen.getByRole('button', { name: /add column left/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add column right/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove column/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /move column left/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /move column right/i })).toBeInTheDocument();
  });

  test('renders format table button', () => {
    const view = createMockView(TABLE_2X2);
    const context = makeContext();
    render(
      <EditorTableContextToolbar
        view={view}
        context={context}
        tableText={TABLE_2X2}
        tableFrom={0}
      />,
    );

    expect(screen.getByRole('button', { name: /format table/i })).toBeInTheDocument();
  });

  test('remove row button is disabled when rowCount is 1', () => {
    const view = createMockView('|===\n|a |b\n|===');
    const context = makeContext({ rowCount: 1 });
    render(
      <EditorTableContextToolbar
        view={view}
        context={context}
        tableText='|===\n|a |b\n|==='
        tableFrom={0}
      />,
    );

    const removeRowButton = screen.getByRole('button', { name: /remove row/i });
    expect(removeRowButton).toHaveAttribute('aria-disabled', 'true');
  });

  test('remove column button is disabled when columnCount is 1', () => {
    const view = createMockView('|===\n|a\n|b\n|===');
    const context = makeContext({ columnCount: 1 });
    render(
      <EditorTableContextToolbar
        view={view}
        context={context}
        tableText='|===\n|a\n|b\n|==='
        tableFrom={0}
      />,
    );

    const removeColButton = screen.getByRole('button', { name: /remove column/i });
    expect(removeColButton).toHaveAttribute('aria-disabled', 'true');
  });

  test('move column left is disabled when cursor is at first column', () => {
    const view = createMockView(TABLE_2X2);
    const context = makeContext({ cursorColumnIndex: 0 });
    render(
      <EditorTableContextToolbar
        view={view}
        context={context}
        tableText={TABLE_2X2}
        tableFrom={0}
      />,
    );

    const moveLeftButton = screen.getByRole('button', { name: /move column left/i });
    expect(moveLeftButton).toHaveAttribute('aria-disabled', 'true');
  });

  test('move column right is disabled when cursor is at last column', () => {
    const view = createMockView(TABLE_2X2);
    const context = makeContext({ cursorColumnIndex: 1, columnCount: 2 });
    render(
      <EditorTableContextToolbar
        view={view}
        context={context}
        tableText={TABLE_2X2}
        tableFrom={0}
      />,
    );

    const moveRightButton = screen.getByRole('button', { name: /move column right/i });
    expect(moveRightButton).toHaveAttribute('aria-disabled', 'true');
  });

  test('clicking an enabled action button dispatches a view change', () => {
    const view = createMockView(TABLE_2X2);
    const context = makeContext();
    render(
      <EditorTableContextToolbar
        view={view}
        context={context}
        tableText={TABLE_2X2}
        tableFrom={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add row below/i }));
    expect((view as unknown as { dispatched: unknown[] }).dispatched.length).toBeGreaterThan(0);
  });

  test('clicking format table dispatches a view change', () => {
    const view = createMockView(TABLE_2X2);
    const context = makeContext();
    render(
      <EditorTableContextToolbar
        view={view}
        context={context}
        tableText={TABLE_2X2}
        tableFrom={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /format table/i }));
    expect((view as unknown as { dispatched: unknown[] }).dispatched.length).toBeGreaterThan(0);
  });

  test('all buttons have accessible labels', () => {
    const view = createMockView(TABLE_2X2);
    const context = makeContext();
    render(
      <EditorTableContextToolbar
        view={view}
        context={context}
        tableText={TABLE_2X2}
        tableFrom={0}
      />,
    );

    const buttons = screen.getAllByRole('button');
    for (const button of buttons) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
      expect(name.length).toBeGreaterThan(0);
    }
  });

  // Issue 1: stale tableFrom/tableTo props used instead of live positions from view.state
  test('dispatches with live positions from view.state.field, not stale tableFrom prop', () => {
    const LIVE_FROM = 50;
    const LIVE_TO = 50 + TABLE_2X2.length;
    const staleContext = makeContext({ tableFrom: 0, tableTo: 20 });
    const liveContext = makeContext({ tableFrom: LIVE_FROM, tableTo: LIVE_TO });

    const dispatched: Array<{ changes: { from: number; to: number; insert: string } }> = [];
    const view = {
      state: {
        doc: {
          toString: () => TABLE_2X2,
          sliceString: jest.fn().mockReturnValue(TABLE_2X2),
        },
        field: jest.fn().mockReturnValue(liveContext),
      },
      dispatch: jest.fn((tr: { changes: { from: number; to: number; insert: string } }) => {
        dispatched.push(tr);
      }),
      focus: jest.fn(),
    } as unknown as EditorView;

    render(
      <EditorTableContextToolbar
        view={view}
        context={staleContext}
        tableText={TABLE_2X2}
        tableFrom={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add row below/i }));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.changes.from).toBe(LIVE_FROM);
    expect(dispatched[0]?.changes.to).toBe(LIVE_TO);
  });

  // ── action coverage: each enabled button dispatches a change ─────────────────

  const clickableActions: Array<[string, Partial<TableContext>]> = [
    ['Add Row Above',     {}],
    ['Remove Row',        { rowCount: 2, isInHeader: false }],
    ['Add Column Left',   {}],
    ['Add Column Right',  {}],
    ['Remove Column',     { columnCount: 2 }],
    ['Move Column Left',  { cursorColumnIndex: 1, columnCount: 2 }],
    ['Move Column Right', { cursorColumnIndex: 0, columnCount: 2 }],
  ];

  for (const [label, contextOverrides] of clickableActions) {
    test(`clicking "${label}" dispatches to the view`, () => {
      const view = createMockView(TABLE_2X2);
      const context = makeContext(contextOverrides);
      render(
        <EditorTableContextToolbar
          view={view}
          context={context}
          tableText={TABLE_2X2}
          tableFrom={0}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: new RegExp(label, 'i') }));
      expect((view as unknown as { dispatched: unknown[] }).dispatched.length).toBeGreaterThan(0);
    });
  }

  // Issue 3: "Add Row Below" from header inserts at body[1] instead of body[0]
  test('Add Row Below from header cursor inserts new row at body[0], not body[1]', () => {
    const TABLE_WITH_HEADER = '|===\n|H1 |H2\n\n|A |B\n|C |D\n|===';
    const headerContext = makeContext({
      tableFrom: 0,
      tableTo: TABLE_WITH_HEADER.length,
      isInHeader: true,
      cursorRowIndex: 0,
      rowCount: 2,
      columnCount: 2,
    });

    const dispatched: Array<{ changes: { insert: string } }> = [];
    const view = {
      state: {
        doc: {
          toString: () => TABLE_WITH_HEADER,
          sliceString: jest.fn().mockReturnValue(TABLE_WITH_HEADER),
        },
        field: jest.fn().mockReturnValue(headerContext),
      },
      dispatch: jest.fn((tr: { changes: { insert: string } }) => {
        dispatched.push(tr);
      }),
      focus: jest.fn(),
    } as unknown as EditorView;

    render(
      <EditorTableContextToolbar
        view={view}
        context={headerContext}
        tableText={TABLE_WITH_HEADER}
        tableFrom={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add row below/i }));

    expect(dispatched).toHaveLength(1);
    const inserted = dispatched[0]?.changes.insert ?? '';
    const parsed = parseTable(inserted);
    // New empty row should be the first body row; 'A' and 'C' rows should follow
    expect(parsed.bodyRows).toHaveLength(3);
    expect(parsed.bodyRows[0].cells.every((c) => c === '')).toBe(true);
    expect(parsed.bodyRows[1].cells).toContain('A');
  });
});
