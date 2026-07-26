import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import type { LRParser } from '@lezer/lr';
import { EditorState } from '@codemirror/state';
import { LRLanguage, LanguageSupport, ensureSyntaxTree } from '@codemirror/language';
import { createTestBlockTokenizer, createTestBlockContext } from '../../helpers/asciidoc-test-tokenizer';
import { parseTableContext, tableContextField, tableHasExplicitHeader } from '@/lib/codemirror/asciidoc-table-context';
import {
  parseTable,
  addRow,
  removeRow,
  addColumn,
  removeColumn,
  moveColumn,
  formatTable,
} from '@/lib/codemirror/asciidoc-table-operations';

const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');

let parser: LRParser;
try {
  parser = buildParser(grammarSource, {
    externalTokenizer: (_name: string, terms: Record<string, number>) =>
      createTestBlockTokenizer(terms),
    contextTracker: (terms: Record<string, number>) =>
      createTestBlockContext(terms),
  }) as LRParser;
} catch {
  parser = null as unknown as LRParser;
}

const asciidocLanguage = LRLanguage.define({ name: 'asciidoc', parser });
const languageExtension = new LanguageSupport(asciidocLanguage);

// Builds a state, force-parses it so the lazy headless parser produces a real
// syntax tree, then dispatches a selection move so the StateField update() runs
// against that tree. Returns the resolved field value for the moved cursor.
function fieldContextAt(documentContent: string, cursorOffset: number) {
  const state = EditorState.create({
    doc: documentContent,
    extensions: [languageExtension, tableContextField],
    selection: { anchor: 0 },
  });
  ensureSyntaxTree(state, documentContent.length, 5000);
  const transaction = state.update({ selection: { anchor: cursorOffset } });
  return transaction.state.field(tableContextField);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tableBlockRange(document: string): { from: number; to: number } | null {
  const tree = parser.parse(document);
  const cursor = tree.cursor();
  do {
    if (cursor.name === 'TableBlock') return { from: cursor.from, to: cursor.to };
  } while (cursor.next());
  return null;
}

function contextAt(document: string, cursorOffset: number) {
  const range = tableBlockRange(document);
  if (!range) return null;
  const tableText = document.slice(range.from, range.to);
  return parseTableContext(tableText, cursorOffset - range.from);
}

// ── Test documents and cursor offsets ────────────────────────────────────────

// One header row, one body row:
// |===\n       offsets 0-4
// |H1 |H2\n   offsets 5-12  (|=5 H=6 1=7 ' '=8 |=9 H=10 2=11 \n=12)
// \n           offset  13   (blank line / header-body separator)
// |B1 |B2\n   offsets 14-21 (|=14 B=15 1=16 ' '=17 |=18 B=19 2=20 \n=21)
// |===\n       offsets 22-26
const DOC_HEADER_BODY = '|===\n|H1 |H2\n\n|B1 |B2\n|===\n';
const OFFSET_HEADER_ROW = 6;   // inside first-column cell of header
const OFFSET_BODY_ROW0 = 15;   // inside first-column cell of body row 0
const OFFSET_BODY_ROW0_COL1 = 19;  // inside second-column cell of body row 0

// Two body rows (no header):
// |===\n       offsets 0-4
// |A1 |A2\n   offsets 5-12
// |A3 |A4\n   offsets 13-20
// |===\n       offsets 21-25
const DOC_TWO_BODY = '|===\n|A1 |A2\n|A3 |A4\n|===\n';
const OFFSET_TWO_ROW0 = 6;    // inside "|A1 |A2"
const OFFSET_TWO_ROW1 = 14;   // inside "|A3 |A4"

// One header, two body rows:
// |===\n     offsets 0-4
// |H\n       offsets 5-7   (|=5 H=6 \n=7)
// \n         offset  8     (blank separator)
// |R0\n      offsets 9-12  (|=9 R=10 0=11 \n=12)
// |R1\n      offsets 13-16 (|=13 R=14 1=15 \n=16)
// |===\n     offsets 17-21
const DOC_THREE_ROWS = '|===\n|H\n\n|R0\n|R1\n|===\n';
const OFFSET_THREE_HDR = 6;   // inside header "|H"
const OFFSET_THREE_R0 = 10;   // inside first body row "|R0"
const OFFSET_THREE_R1 = 14;   // inside second body row "|R1"

// ── Dead code check ───────────────────────────────────────────────────────────

describe('asciidoc-table-context dead code', () => {
  test('parseTableContext no longer contains the dead headerEnded variable', () => {
    const source: string = fs.readFileSync(
      require.resolve('@/lib/codemirror/asciidoc-table-context'),
      'utf8',
    );
    expect(source).not.toContain('headerEnded');
  });
});

// ── Grammar: TableBlock spans the full table ──────────────────────────────────

describe('TableBlock Lezer node range', () => {
  test('spans the full table including body rows after a blank-line header separator', () => {
    const range = tableBlockRange(DOC_HEADER_BODY);
    expect(range).not.toBeNull();
    // Body row "|B1 |B2" starts at offset 14; the TableBlock node must cover it.
    expect(range!.from <= 14 && range!.to > 14).toBe(true);
  });

  test('sliced table text includes the body row', () => {
    const range = tableBlockRange(DOC_HEADER_BODY);
    expect(range).not.toBeNull();
    const tableText = DOC_HEADER_BODY.slice(range!.from, range!.to);
    expect(tableText).toContain('|B1 |B2');
  });

  test('parseTable on the sliced text correctly identifies the body row', () => {
    const range = tableBlockRange(DOC_HEADER_BODY);
    expect(range).not.toBeNull();
    const tableText = DOC_HEADER_BODY.slice(range!.from, range!.to);
    const parsed = parseTable(tableText);
    expect(parsed.bodyRows).toHaveLength(1);
    expect(parsed.bodyRows[0].cells).toContain('B1');
  });
});

// ── parseTableContext: cursor detection ───────────────────────────────────────

describe('parseTableContext cursor detection', () => {
  test('isInHeader=true when cursor is in the header row', () => {
    const context = contextAt(DOC_HEADER_BODY, OFFSET_HEADER_ROW);
    expect(context).not.toBeNull();
    expect(context!.isInHeader).toBe(true);
  });

  test('isInHeader=false when cursor is in a body row', () => {
    const context = contextAt(DOC_HEADER_BODY, OFFSET_BODY_ROW0);
    expect(context).not.toBeNull();
    expect(context!.isInHeader).toBe(false);
  });

  test('cursorRowIndex=0 for first body row', () => {
    expect(contextAt(DOC_HEADER_BODY, OFFSET_BODY_ROW0)!.cursorRowIndex).toBe(0);
  });

  test('rowCount counts only body rows (not header)', () => {
    expect(contextAt(DOC_HEADER_BODY, OFFSET_BODY_ROW0)!.rowCount).toBe(1);
  });

  test('cursorRowIndex=0 for first row and =1 for second in a no-header table', () => {
    expect(contextAt(DOC_TWO_BODY, OFFSET_TWO_ROW0)!.cursorRowIndex).toBe(0);
    expect(contextAt(DOC_TWO_BODY, OFFSET_TWO_ROW1)!.cursorRowIndex).toBe(1);
  });

  test('rowCount=2 for a two-row no-header table', () => {
    expect(contextAt(DOC_TWO_BODY, OFFSET_TWO_ROW0)!.rowCount).toBe(2);
  });

  test('multi-row table: header is isInHeader, body rows have correct indices', () => {
    const contextHdr = contextAt(DOC_THREE_ROWS, OFFSET_THREE_HDR);
    const contextR0  = contextAt(DOC_THREE_ROWS, OFFSET_THREE_R0);
    const contextR1  = contextAt(DOC_THREE_ROWS, OFFSET_THREE_R1);
    expect(contextHdr!.isInHeader).toBe(true);
    expect(contextR0!.cursorRowIndex).toBe(0);
    expect(contextR1!.cursorRowIndex).toBe(1);
    expect(contextR0!.rowCount).toBe(2);
  });
});

// ── Explicit header option (`[%header]` / `options="header"`) ────────────────
// the header option marks the first row as a header even without a blank-line separator.
// The TableBlock node excludes the attribute line, so the field passes the signal as a parameter;
// `tableHasExplicitHeader` is the single detector shared with the header-cell decoration.

describe('tableHasExplicitHeader', () => {
  test.each([
    ['[%header]', true],
    ['[cols="2,1",options="header"]', true],
    ['[options="header,footer"]', true],
    ['[%header,cols="2"]', true],
    ['[cols="2,1"]', false],
    ['[source,ruby]', false],
    ['', false],
  ])('%s → %s', (line, expected) => {
    expect(tableHasExplicitHeader(line)).toBe(expected);
  });
});

describe('parseTableContext explicit-header option (no blank-line separator)', () => {
  // Two content rows, NO blank separator: `|===\n|H1 |H2\n|B1 |B2\n|===\n`.
  const TABLE = '|===\n|H1 |H2\n|B1 |B2\n|===\n';
  const OFFSET_ROW0 = 6; // inside the first row `|H1`
  const OFFSET_ROW1 = 14; // inside the second row `|B1`

  test('without the option, the first row is a body row (no header)', () => {
    const context = parseTableContext(TABLE, OFFSET_ROW0);
    expect(context!.isInHeader).toBe(false);
    expect(context!.rowCount).toBe(2);
  });

  test('with the option, the first row becomes the header and the rest are body', () => {
    const header = parseTableContext(TABLE, OFFSET_ROW0, true);
    const body = parseTableContext(TABLE, OFFSET_ROW1, true);
    expect(header!.isInHeader).toBe(true);
    expect(body!.isInHeader).toBe(false);
    expect(body!.cursorRowIndex).toBe(0);
    expect(body!.rowCount).toBe(1); // header row no longer counted as a body row
  });

  test('a lone header row stays a single completable body row (not promoted to null)', () => {
    const context = parseTableContext('|===\n|H1 |H2\n|===\n', 6, true);
    expect(context).not.toBeNull();
    expect(context!.rowCount).toBe(1);
  });
});

// ── Action simulations: each action × each cursor position ───────────────────

function simulateAction(
  document: string,
  cursorOffset: number,
  action: (tableText: string, context_: NonNullable<ReturnType<typeof parseTableContext>>) => string | null,
): string | null {
  const range = tableBlockRange(document);
  if (!range) return null;
  const tableText = document.slice(range.from, range.to);
  const context = parseTableContext(tableText, cursorOffset - range.from);
  if (!context) return null;
  return action(tableText, context);
}

// ── Add Row Above ─────────────────────────────────────────────────────────────

describe('Add Row Above', () => {
  test('from header: inserts empty row before the first body row', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_HEADER_ROW, (t, context) =>
      addRow(t, context.cursorRowIndex - 1),
    );
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.bodyRows).toHaveLength(2);
    expect(parsed.bodyRows[0].cells.every((c) => c === '')).toBe(true);
    expect(parsed.bodyRows[1].cells).toContain('B1');
  });

  test('from first body row: inserts empty row before it', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_BODY_ROW0, (t, context) =>
      addRow(t, context.cursorRowIndex - 1),
    );
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.bodyRows).toHaveLength(2);
    expect(parsed.bodyRows[0].cells.every((c) => c === '')).toBe(true);
    expect(parsed.bodyRows[1].cells).toContain('B1');
  });

  test('from second body row: inserts empty row between first and second', () => {
    const result = simulateAction(DOC_THREE_ROWS, OFFSET_THREE_R1, (t, context) =>
      addRow(t, context.cursorRowIndex - 1),
    );
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.bodyRows).toHaveLength(3);
    expect(parsed.bodyRows[0].cells).toContain('R0');
    expect(parsed.bodyRows[1].cells.every((c) => c === '')).toBe(true);
    expect(parsed.bodyRows[2].cells).toContain('R1');
  });
});

// ── Add Row Below ─────────────────────────────────────────────────────────────

describe('Add Row Below', () => {
  test('from header: inserts empty row after the first body row', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_HEADER_ROW, (t, context) =>
      addRow(t, context.cursorRowIndex),
    );
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.bodyRows).toHaveLength(2);
    expect(parsed.bodyRows[0].cells).toContain('B1');
    expect(parsed.bodyRows[1].cells.every((c) => c === '')).toBe(true);
  });

  test('from first body row: inserts empty row after it', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_BODY_ROW0, (t, context) =>
      addRow(t, context.cursorRowIndex),
    );
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.bodyRows).toHaveLength(2);
    expect(parsed.bodyRows[0].cells).toContain('B1');
    expect(parsed.bodyRows[1].cells.every((c) => c === '')).toBe(true);
  });

  test('from first of two body rows: inserts empty row between first and second', () => {
    const result = simulateAction(DOC_THREE_ROWS, OFFSET_THREE_R0, (t, context) =>
      addRow(t, context.cursorRowIndex),
    );
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.bodyRows).toHaveLength(3);
    expect(parsed.bodyRows[0].cells).toContain('R0');
    expect(parsed.bodyRows[1].cells.every((c) => c === '')).toBe(true);
    expect(parsed.bodyRows[2].cells).toContain('R1');
  });
});

// ── Remove Row ────────────────────────────────────────────────────────────────

describe('Remove Row', () => {
  test('from first of two body rows: removes it, leaving the second', () => {
    const result = simulateAction(DOC_THREE_ROWS, OFFSET_THREE_R0, (t, context) => {
      if (context.isInHeader || context.rowCount <= 1) return null;
      const result_ = removeRow(t, context.cursorRowIndex);
      return result_.ok ? result_.value : null;
    });
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.bodyRows).toHaveLength(1);
    expect(parsed.bodyRows[0].cells).toContain('R1');
  });

  test('from second of two body rows: removes it, leaving the first', () => {
    const result = simulateAction(DOC_THREE_ROWS, OFFSET_THREE_R1, (t, context) => {
      if (context.isInHeader || context.rowCount <= 1) return null;
      const result_ = removeRow(t, context.cursorRowIndex);
      return result_.ok ? result_.value : null;
    });
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.bodyRows).toHaveLength(1);
    expect(parsed.bodyRows[0].cells).toContain('R0');
  });

  test('from header: isInHeader=true blocks the action', () => {
    const context = contextAt(DOC_HEADER_BODY, OFFSET_HEADER_ROW);
    expect(context!.isInHeader).toBe(true);
  });

  test('when only one body row: rowCount=1 blocks the action', () => {
    const context = contextAt(DOC_HEADER_BODY, OFFSET_BODY_ROW0);
    expect(context!.rowCount).toBe(1);
  });
});

// ── Add Column ────────────────────────────────────────────────────────────────

describe('Add Column', () => {
  test('left of cursor column from body row: inserts column before it', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_BODY_ROW0, (t, context) =>
      addColumn(t, context.cursorColumnIndex, true),
    );
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.bodyRows[0].cells).toHaveLength(3);
    expect(parsed.bodyRows[0].cells[0]).toBe('');
    expect(parsed.bodyRows[0].cells[1]).toBe('B1');
  });

  test('right of cursor column from body row: inserts column after it', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_BODY_ROW0, (t, context) =>
      addColumn(t, context.cursorColumnIndex, false),
    );
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.bodyRows[0].cells).toHaveLength(3);
    expect(parsed.bodyRows[0].cells[0]).toBe('B1');
    expect(parsed.bodyRows[0].cells[1]).toBe('');
    expect(parsed.bodyRows[0].cells[2]).toBe('B2');
  });

  test('also affects header rows when inserting column', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_BODY_ROW0, (t, context) =>
      addColumn(t, context.cursorColumnIndex, true),
    );
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.headerRows[0].cells).toHaveLength(3);
    expect(parsed.headerRows[0].cells[1]).toBe('H1');
  });
});

// ── Remove Column ─────────────────────────────────────────────────────────────

describe('Remove Column', () => {
  test('from body row column 0: removes that column from all rows', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_BODY_ROW0, (t, context) => {
      const result_ = removeColumn(t, context.cursorColumnIndex);
      return result_.ok ? result_.value : null;
    });
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.bodyRows[0].cells).toHaveLength(1);
    expect(parsed.bodyRows[0].cells[0]).toBe('B2');
    expect(parsed.headerRows[0].cells[0]).toBe('H2');
  });

  test('from body row column 1: removes that column', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_BODY_ROW0_COL1, (t, context) => {
      const result_ = removeColumn(t, context.cursorColumnIndex);
      return result_.ok ? result_.value : null;
    });
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.bodyRows[0].cells).toHaveLength(1);
    expect(parsed.bodyRows[0].cells[0]).toBe('B1');
  });
});

// ── Move Column ───────────────────────────────────────────────────────────────

describe('Move Column', () => {
  test('column 1 left from body row: swaps columns 0 and 1', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_BODY_ROW0_COL1, (t, context) => {
      const result_ = moveColumn(t, context.cursorColumnIndex, 'left');
      return result_.ok ? result_.value : null;
    });
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.bodyRows[0].cells[0]).toBe('B2');
    expect(parsed.bodyRows[0].cells[1]).toBe('B1');
    expect(parsed.headerRows[0].cells[0]).toBe('H2');
    expect(parsed.headerRows[0].cells[1]).toBe('H1');
  });

  test('column 0 right from body row: swaps columns 0 and 1', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_BODY_ROW0, (t, context) => {
      const result_ = moveColumn(t, context.cursorColumnIndex, 'right');
      return result_.ok ? result_.value : null;
    });
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.bodyRows[0].cells[0]).toBe('B2');
    expect(parsed.bodyRows[0].cells[1]).toBe('B1');
  });
});

// ── Format Table ──────────────────────────────────────────────────────────────

describe('Format Table', () => {
  test('from body row: formats the table without error', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_BODY_ROW0, (t) => formatTable(t));
    expect(result).not.toBeNull();
    expect(result).toContain('|===');
    expect(result).toContain('B1');
  });

  test('from header row: formats the table without error', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_HEADER_ROW, (t) => formatTable(t));
    expect(result).not.toBeNull();
    expect(result).toContain('H1');
  });
});

// ── Issue: columnCount derived from first body row only — misses header width ──

describe('parseTableContext: columnCount uses max across all rows', () => {
  test('returns header pipe count when body rows have fewer pipes', () => {
    // Header has 3 columns; first (only) body row has 2 pipes (e.g. user typed
    // a partial row). columnCount should be 3, not 2.
    const document = '|===\n|A |B |C\n\n|cell1 |cell2\n|===\n';
    const range = tableBlockRange(document);
    expect(range).not.toBeNull();
    const tableText = document.slice(range!.from, range!.to);
    const bodyRow = '|cell1 |cell2';
    const bodyStart = tableText.indexOf(bodyRow);
    const context = parseTableContext(tableText, bodyStart + 1);
    expect(context).not.toBeNull();
    expect(context!.columnCount).toBe(3);
  });
});

// ── Issue: indexOf misidentifies row when body rows have duplicate content ────

describe('parseTableContext: duplicate body row content', () => {
  // Table: header |H, then two body rows both containing "|dup"
  // |===\n  0-4
  // |H\n    5-7
  // \n      8   (header/body separator)
  // |dup\n  9-13  (body row 0)
  // |dup\n  14-18 (body row 1)
  // |===\n  19-23
  const DOC_DUP = '|===\n|H\n\n|dup\n|dup\n|===\n';

  test('cursor in first of two identical rows returns cursorRowIndex=0', () => {
    // position 10 = inside first |dup (char 'd')
    const context = contextAt(DOC_DUP, 10);
    expect(context).not.toBeNull();
    expect(context!.cursorRowIndex).toBe(0);
  });

  test('cursor in second of two identical rows returns cursorRowIndex=1 (not 0)', () => {
    // position 15 = inside second |dup (char 'd')
    const context = contextAt(DOC_DUP, 15);
    expect(context).not.toBeNull();
    expect(context!.cursorRowIndex).toBe(1);
  });

  test('remove-row from second identical row removes the correct row', () => {
    const result = simulateAction(DOC_DUP, 15, (t, context_) => {
      const result_ = removeRow(t, context_.cursorRowIndex);
      return result_.ok ? result_.value : null;
    });
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    // After removing body row 1, only one body row should remain
    expect(parsed.bodyRows).toHaveLength(1);
  });
});

// ── Issue: trailing newline dropped after any table operation ─────────────────
// serializeTable joins parts with '\n' and produces no trailing newline.
// All public operations must preserve a trailing newline when the input had one.

describe('Trailing newline preservation', () => {
  const WITH_NL    = '|===\n|A |B\n\n|c |d\n|===\n';
  const WITHOUT_NL = '|===\n|A |B\n\n|c |d\n|===';
  const TWO_ROWS   = '|===\n|A |B\n\n|c |d\n|e |f\n|===\n';

  test('formatTable preserves trailing newline when input has one', () => {
    expect(formatTable(WITH_NL).endsWith('\n')).toBe(true);
  });

  test('formatTable does not add trailing newline when input has none', () => {
    expect(formatTable(WITHOUT_NL).endsWith('\n')).toBe(false);
  });

  test('addRow preserves trailing newline', () => {
    expect(addRow(WITH_NL, 0).endsWith('\n')).toBe(true);
  });

  test('removeRow preserves trailing newline', () => {
    const result = removeRow(TWO_ROWS, 0);
    expect(result.ok).toBe(true);
    expect((result as { ok: true; value: string }).value.endsWith('\n')).toBe(true);
  });

  test('addColumn preserves trailing newline', () => {
    expect(addColumn(WITH_NL, 0, true).endsWith('\n')).toBe(true);
  });

  test('removeColumn preserves trailing newline', () => {
    const result = removeColumn(WITH_NL, 0);
    expect(result.ok).toBe(true);
    expect((result as { ok: true; value: string }).value.endsWith('\n')).toBe(true);
  });

  test('moveColumn preserves trailing newline', () => {
    const result = moveColumn(WITH_NL, 0, 'right');
    expect(result.ok).toBe(true);
    expect((result as { ok: true; value: string }).value.endsWith('\n')).toBe(true);
  });
});

// ── Issue: add/remove row or column strips cell padding spaces ────────────────
// parseCells trims cell content. Re-serialising all rows via serializeRow(cells)
// discards any trailing-space padding that formatTable had previously added.
// Operations that do not touch a row's content must preserve its raw line text.

describe('Cell spacing preservation after row/column operations', () => {
  // Table after formatTable: Name is padded to 5 chars, Age/30/25 to 3.
  // |===\n|Name  |Age\n\n|Alice |30 \n|Bob   |25 \n|===\n
  const FORMATTED = '|===\n|Name  |Age\n\n|Alice |30 \n|Bob   |25 \n|===\n';

  test('addRow: existing rows retain their padded cells', () => {
    const result = addRow(FORMATTED, 0);
    expect(result).toContain('|Alice |30 ');
    expect(result).toContain('|Bob   |25 ');
  });

  test('removeRow: surviving rows retain their padded cells', () => {
    const result = removeRow(FORMATTED, 0); // remove Alice row
    expect(result.ok).toBe(true);
    const value = (result as { ok: true; value: string }).value;
    expect(value).toContain('|Bob   |25 ');
  });

  test('addColumn: columns not being inserted retain their padded cells', () => {
    const result = addColumn(FORMATTED, 0, true); // insert before col 0
    // Name column lines must be unchanged (just shifted right by one cell)
    expect(result).toContain('|Alice ');
    expect(result).toContain('|Bob   ');
  });

  test('removeColumn: remaining columns retain their padded cells', () => {
    const result = removeColumn(FORMATTED, 0); // remove Name column
    expect(result.ok).toBe(true);
    const value = (result as { ok: true; value: string }).value;
    // Age column should be unmodified
    expect(value).toContain('|30 ');
    expect(value).toContain('|25 ');
  });
});

// ── Issue: Remove Column is inaccessible when cursor is in the header row ─────
// The toolbar reads cursorColumnIndex from parseTableContext. When isInHeader=true
// the column index must still be computed correctly so that removeColumn removes
// the right column.

describe('Remove Column from header row', () => {
  // DOC_HEADER_BODY: |===\n|H1 |H2\n\n|B1 |B2\n|===\n
  // OFFSET_HEADER_ROW = 6 (inside H1, column 0 of header)
  // Second header column: cursor at position 10 (H of H2)
  const OFFSET_HEADER_COL1 = 10;

  test('cursorColumnIndex is 1 when cursor is in second header column', () => {
    const context = contextAt(DOC_HEADER_BODY, OFFSET_HEADER_COL1);
    expect(context).not.toBeNull();
    expect(context!.isInHeader).toBe(true);
    expect(context!.cursorColumnIndex).toBe(1);
  });

  test('removeColumn from first header column removes column 0 from all rows', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_HEADER_ROW, (t, context) => {
      expect(context.isInHeader).toBe(true);
      expect(context.cursorColumnIndex).toBe(0);
      const r = removeColumn(t, context.cursorColumnIndex);
      return r.ok ? r.value : null;
    });
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.headerRows[0].cells).toHaveLength(1);
    expect(parsed.headerRows[0].cells[0]).toBe('H2');
    expect(parsed.bodyRows[0].cells).toHaveLength(1);
    expect(parsed.bodyRows[0].cells[0]).toBe('B2');
  });

  test('removeColumn from second header column removes column 1 from all rows', () => {
    const result = simulateAction(DOC_HEADER_BODY, OFFSET_HEADER_COL1, (t, context) => {
      expect(context.isInHeader).toBe(true);
      expect(context.cursorColumnIndex).toBe(1);
      const r = removeColumn(t, context.cursorColumnIndex);
      return r.ok ? r.value : null;
    });
    expect(result).not.toBeNull();
    const parsed = parseTable(result!);
    expect(parsed.headerRows[0].cells).toHaveLength(1);
    expect(parsed.headerRows[0].cells[0]).toBe('H1');
    expect(parsed.bodyRows[0].cells).toHaveLength(1);
    expect(parsed.bodyRows[0].cells[0]).toBe('B1');
  });
});

// ── parseTableContext: [cols=...] attribute line ──────────────────────────────
// A leading line that starts with '[' marks a column spec (hasColSpec) and shifts
// the delimiter scan start by one line.

describe('parseTableContext: leading [cols=...] spec line', () => {
  const TABLE_WITH_SPEC = '[cols="1,1"]\n|===\n|A |B\n|===\n';

  test('hasColSpec is true when the first line starts with [', () => {
    const context = parseTableContext(TABLE_WITH_SPEC, TABLE_WITH_SPEC.indexOf('|A') + 1);
    expect(context).not.toBeNull();
    expect(context!.hasColSpec).toBe(true);
  });

  test('still detects the body row past the spec and delimiter lines', () => {
    const context = parseTableContext(TABLE_WITH_SPEC, TABLE_WITH_SPEC.indexOf('|A') + 1);
    expect(context).not.toBeNull();
    expect(context!.rowCount).toBe(1);
    expect(context!.columnCount).toBe(2);
    expect(context!.isInHeader).toBe(false);
  });

  test('hasColSpec is false for a plain table without a spec line', () => {
    const context = parseTableContext(DOC_TWO_BODY, OFFSET_TWO_ROW0);
    expect(context).not.toBeNull();
    expect(context!.hasColSpec).toBe(false);
  });
});

// ── parseTableContext: null / edge-case returns ───────────────────────────────

describe('parseTableContext: edge cases', () => {
  test('returns null when the table has no content rows (only delimiters)', () => {
    const emptyTable = '|===\n|===\n';
    expect(parseTableContext(emptyTable, 5)).toBeNull();
  });

  test('cursor on the |=== delimiter line keeps column index at 0', () => {
    const context = parseTableContext(DOC_TWO_BODY, 0);
    expect(context).not.toBeNull();
    expect(context!.cursorColumnIndex).toBe(0);
    expect(context!.cursorRowIndex).toBe(0);
  });

  test('cursor before any pipe on a body row clamps column index to 0', () => {
    // A body line beginning with text rather than a pipe → pipe count - 1 < 0.
    const noLeadingPipe = '|===\nplain text\n|===\n';
    const context = parseTableContext(noLeadingPipe, noLeadingPipe.indexOf('plain') + 1);
    expect(context).not.toBeNull();
    expect(context!.cursorColumnIndex).toBe(0);
  });

  test('cursor at the very end of the table text resolves a context', () => {
    const context = parseTableContext(DOC_TWO_BODY, DOC_TWO_BODY.length);
    expect(context).not.toBeNull();
  });
});

// ── tableContextField: StateField create() and update() ───────────────────────

describe('tableContextField', () => {
  test('create() returns null for a fresh state', () => {
    const state = EditorState.create({
      doc: DOC_HEADER_BODY,
      extensions: [languageExtension, tableContextField],
    });
    expect(state.field(tableContextField)).toBeNull();
  });

  test('update() populates the context when the cursor moves into a table body', () => {
    const context = fieldContextAt(DOC_HEADER_BODY, OFFSET_BODY_ROW0);
    expect(context).not.toBeNull();
    expect(context!.tableFrom).toBe(0);
    expect(context!.tableTo).toBeGreaterThan(OFFSET_BODY_ROW0);
    expect(context!.cursorRowIndex).toBe(0);
    expect(context!.isInHeader).toBe(false);
    expect(context!.rowCount).toBe(1);
    expect(context!.columnCount).toBe(2);
  });

  test('update() reports isInHeader when the cursor is in a header row', () => {
    const context = fieldContextAt(DOC_HEADER_BODY, OFFSET_HEADER_ROW);
    expect(context).not.toBeNull();
    expect(context!.isInHeader).toBe(true);
  });

  test('update() returns null when the cursor is outside any table', () => {
    const documentContent = 'Just a paragraph.\n\n' + DOC_HEADER_BODY;
    const context = fieldContextAt(documentContent, 3);
    expect(context).toBeNull();
  });

  test('update() returns null when the cursor sits in a non-table block', () => {
    // A listing block precedes the table; cursor inside the listing block must
    // not match the TableBlock node (wrong-table / descend-skip branches).
    const documentContent = '----\ncode\n----\n\n' + DOC_TWO_BODY;
    const listingInside = documentContent.indexOf('code') + 1;
    expect(fieldContextAt(documentContent, listingInside)).toBeNull();
  });

  test('update() preserves the previous value when neither doc nor selection changes', () => {
    const state = EditorState.create({
      doc: DOC_TWO_BODY,
      extensions: [languageExtension, tableContextField],
    });
    ensureSyntaxTree(state, DOC_TWO_BODY.length, 5000);
    // A transaction with no selection and no doc change must short-circuit and
    // return the prior field value (null here).
    const transaction = state.update({ scrollIntoView: true });
    expect(transaction.state.field(tableContextField)).toBeNull();
  });

  test('update() stays null when the matched table has no body rows', () => {
    // The cursor is inside a TableBlock node, but parseTableContext returns null
    // for a body-less table, so the field's `if (context)` guard is false.
    const documentContent = '|===\n|===\n';
    const state = EditorState.create({
      doc: documentContent,
      extensions: [languageExtension, tableContextField],
      selection: { anchor: 0 },
    });
    ensureSyntaxTree(state, documentContent.length, 5000);
    const transaction = state.update({ selection: { anchor: 5 } });
    expect(transaction.state.field(tableContextField)).toBeNull();
  });

  test('update() recomputes when the document changes', () => {
    const state = EditorState.create({
      doc: DOC_TWO_BODY,
      extensions: [languageExtension, tableContextField],
      selection: { anchor: OFFSET_TWO_ROW0 },
    });
    ensureSyntaxTree(state, DOC_TWO_BODY.length, 5000);
    const transaction = state.update({
      changes: { from: OFFSET_TWO_ROW0, insert: 'X' },
    });
    const context = transaction.state.field(tableContextField);
    expect(context).not.toBeNull();
    expect(context!.tableFrom).toBe(0);
  });
});
