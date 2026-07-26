import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import { EditorState, type Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { LRLanguage, LanguageSupport } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, undo } from '@codemirror/commands';
import { continueList, listContinuationKeymap } from '@/lib/codemirror/asciidoc-list-continuation';
import { createTestBlockTokenizer, createTestBlockContext } from '../../helpers/asciidoc-test-tokenizer';

/**
 * Command-behaviour tests for the Enter continuation command, driven against a real
 * `EditorState`/`EditorView`. The AsciiDoc language is built from the grammar source (the
 * generated parser is ESM and not loadable in jest) so the command's syntax-tree block
 * suppression has a real tree to walk.
 */

const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');
const lezerParser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
});
const asciidocLang = new LanguageSupport(LRLanguage.define({ name: 'asciidoc', parser: lezerParser }));

interface Harness {
  view: EditorView;
  transactions: Transaction[];
}

const mounted: EditorView[] = [];

/** Builds a mounted EditorView with the doc + cursor (or selection), recording transactions. */
function setup(doc: string, anchor: number, head: number = anchor, readOnly = false): Harness {
  const transactions: Transaction[] = [];
  const parent = document.createElement('div');
  document.body.append(parent);
  const state = EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [
      asciidocLang,
      history(),
      EditorState.readOnly.of(readOnly),
      listContinuationKeymap,
      keymap.of([...defaultKeymap, ...historyKeymap]),
    ],
  });
  const view = new EditorView({
    state,
    parent,
    dispatch: (tr, v) => { transactions.push(tr); v.update([tr]); },
  });
  mounted.push(view);
  return { view, transactions };
}

afterEach(() => {
  for (const view of mounted.splice(0)) view.destroy();
});

/** Returns [docString, cursorHead] after running the command once. */
function run(harness: Harness): { handled: boolean; doc: string; head: number } {
  const handled = continueList(harness.view);
  return {
    handled,
    doc: harness.view.state.doc.toString(),
    head: harness.view.state.selection.main.head,
  };
}

describe('continueList — G1 continue (unordered)', () => {
  test('`* first` → new `* ` line, cursor after marker', () => {
    const h = setup('* first', 7);
    const r = run(h);
    expect(r.handled).toBe(true);
    expect(r.doc).toBe('* first\n* ');
    expect(r.head).toBe(10);
  });

  test('`- a` continues `- `', () => {
    const r = run(setup('- a', 3));
    expect(r.doc).toBe('- a\n- ');
    expect(r.head).toBe(6);
  });

  test('`** s` continues `** ` (depth preserved)', () => {
    const r = run(setup('** s', 4));
    expect(r.doc).toBe('** s\n** ');
    expect(r.head).toBe(8);
  });

  test('indentation preserved `  * x`', () => {
    const r = run(setup('  * x', 5));
    expect(r.doc).toBe('  * x\n  * ');
    expect(r.head).toBe(10);
  });
});

describe('continueList — ordered', () => {
  test('implicit `. one` continues `. `', () => {
    const r = run(setup('. one', 5));
    expect(r.doc).toBe('. one\n. ');
    expect(r.head).toBe(8);
  });

  test('implicit `.. sub` continues `.. ` (same dot-depth)', () => {
    const r = run(setup('.. sub', 6));
    expect(r.doc).toBe('.. sub\n.. ');
  });

  test('explicit `1. one` continues `2. ` (next number)', () => {
    const r = run(setup('1. one', 6));
    expect(r.doc).toBe('1. one\n2. ');
    expect(r.head).toBe(10);
  });

  test('explicit `9. nine` continues `10. `', () => {
    const r = run(setup('9. nine', 7));
    expect(r.doc).toBe('9. nine\n10. ');
  });

  test('empty ordered `. ` exits', () => {
    const r = run(setup('. ', 2));
    expect(r.handled).toBe(true);
    expect(r.doc).toBe('');
  });
});

describe('continueList — checklist', () => {
  test('`* [ ] Task` continues `* [ ] `', () => {
    const r = run(setup('* [ ] Task', 10));
    expect(r.doc).toBe('* [ ] Task\n* [ ] ');
    expect(r.head).toBe(17);
  });

  test('`* [x] Done` continues UNCHECKED `* [ ] `', () => {
    const r = run(setup('* [x] Done', 10));
    expect(r.doc).toBe('* [x] Done\n* [ ] ');
  });

  test('`- [x] Done` continues `- [ ] ` (dash preserved, unchecked)', () => {
    const r = run(setup('- [x] Done', 10));
    expect(r.doc).toBe('- [x] Done\n- [ ] ');
  });

  test('empty checklist item `* [ ]` exits', () => {
    const r = run(setup('* [ ]', 5));
    expect(r.handled).toBe(true);
    expect(r.doc).toBe('');
  });
});

describe('continueList — description', () => {
  test('`CPU:: The brain` continues `:: ` (cursor after separator)', () => {
    const r = run(setup('CPU:: The brain', 15));
    expect(r.doc).toBe('CPU:: The brain\n:: ');
    expect(r.head).toBe(19);
  });

  test('`Term::: Detail` continues `::: `', () => {
    const r = run(setup('Term::: Detail', 14));
    expect(r.doc).toBe('Term::: Detail\n::: ');
  });

  test('`Term;; Detail` continues `;; `', () => {
    const r = run(setup('Term;; Detail', 13));
    expect(r.doc).toBe('Term;; Detail\n;; ');
  });

  test('bare term `CPU::` continues `:: `', () => {
    const r = run(setup('CPU::', 5));
    expect(r.doc).toBe('CPU::\n:: ');
  });

  test('separator-only `:: ` line exits (separator removed)', () => {
    const r = run(setup(':: ', 3));
    expect(r.handled).toBe(true);
    expect(r.doc).toBe('');
  });
});

describe('continueList — G2 split mid-content', () => {
  test('text after cursor moves into the continued item', () => {
    // '* Hello world', cursor before 'world' (offset 8).
    const r = run(setup('* Hello world', 8));
    expect(r.doc).toBe('* Hello \n* world');
    expect(r.head).toBe(11); // immediately after the inserted '* '
  });
});

describe('continueList — G3 exit on empty item', () => {
  test('`* ` exits to a blank line', () => {
    const r = run(setup('* ', 2));
    expect(r.handled).toBe(true);
    expect(r.doc).toBe('');
    expect(r.head).toBe(0);
  });

  test('`*   ` (trailing whitespace) exits', () => {
    const r = run(setup('*   ', 4));
    expect(r.doc).toBe('');
  });

  test('indented `  * ` exits leaving the indent', () => {
    const r = run(setup('  * ', 4));
    expect(r.doc).toBe('  ');
    expect(r.head).toBe(2);
  });
});

describe('continueList — G4 replace selection then continue', () => {
  test('non-empty selection is replaced, then continuation applies', () => {
    // '* one two', select 'two' (offsets 6..9).
    const r = run(setup('* one two', 6, 9));
    expect(r.doc).toBe('* one \n* ');
    expect(r.head).toBe(9);
  });
});

describe('continueList — G5 fall through off-list', () => {
  test('non-list line returns false and changes nothing', () => {
    const h = setup('hello', 5);
    const r = run(h);
    expect(r.handled).toBe(false);
    expect(r.doc).toBe('hello');
    expect(h.transactions).toHaveLength(0);
  });
});

describe('continueList — G6 suppress in verbatim blocks (ancestor walk)', () => {
  test('inside a ---- listing block → plain newline (false)', () => {
    const h = setup('----\n* x\n----\n', 6); // cursor on '* x' line
    const r = run(h);
    expect(r.handled).toBe(false);
    expect(h.transactions).toHaveLength(0);
  });

  test('inside a .... literal block → plain newline (false)', () => {
    const h = setup('....\n* x\n....\n', 6);
    const r = run(h);
    expect(r.handled).toBe(false);
    expect(h.transactions).toHaveLength(0);
  });

  test('inside a ,=== CSV table → plain newline, no list marker injected', () => {
    const h = setup(',===\n* x\n,===\n', 6); // cursor on the `* x` cell line
    const r = run(h);
    expect(r.handled).toBe(false);
    expect(h.transactions).toHaveLength(0);
  });

  test('inside a :=== DSV table → plain newline, no list marker injected', () => {
    const h = setup(':===\n* x\n:===\n', 6);
    const r = run(h);
    expect(r.handled).toBe(false);
    expect(h.transactions).toHaveLength(0);
  });
});

describe('continueList — G7 single-step undo', () => {
  test('one undo reverts a Continue to the pre-Enter state', () => {
    const h = setup('* first', 7);
    run(h);
    expect(h.view.state.doc.toString()).toBe('* first\n* ');
    undo(h.view);
    expect(h.view.state.doc.toString()).toBe('* first');
  });

  test('one undo reverts an Exit', () => {
    const h = setup('* ', 2);
    run(h);
    expect(h.view.state.doc.toString()).toBe('');
    undo(h.view);
    expect(h.view.state.doc.toString()).toBe('* ');
  });
});

describe('continueList — F2 source-only minimal change', () => {
  test('the Continue change set is a single insertion at the cursor', () => {
    const h = setup('* first', 7);
    run(h);
    expect(h.transactions).toHaveLength(1);
    const changes: Array<{ fromA: number; toA: number; insert: string }> = [];
    h.transactions[0].changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ fromA, toA, insert: inserted.toString() });
    });
    expect(changes).toEqual([{ fromA: 7, toA: 7, insert: '\n* ' }]);
  });
});

describe('continueList — F3 attached-block continuation line (`+`)', () => {
  test('cursor on a `+` line → plain newline (false)', () => {
    const r = run(setup('* item\n+', 8));
    expect(r.handled).toBe(false);
    expect(r.doc).toBe('* item\n+');
  });
});

// ── Code-review fixes ──────────────────────────────────────────────────────────

describe('continueList — #1 read-only documents are never mutated', () => {
  test('Enter on a list line in a read-only editor falls through and changes nothing', () => {
    const h = setup('* first', 7, 7, /* readOnly */ true);
    const r = run(h);
    expect(r.handled).toBe(false);
    expect(r.doc).toBe('* first');
    expect(h.transactions).toHaveLength(0);
  });
});

describe('continueList — #2 Enter at/before the marker does not duplicate it', () => {
  test('cursor at column 0 of `* hello` → plain newline (false), no doubled marker', () => {
    const h = setup('* hello', 0);
    const r = run(h);
    expect(r.handled).toBe(false);
    expect(r.doc).toBe('* hello');
    expect(h.transactions).toHaveLength(0);
  });

  test('cursor between the marker and its space (column 1) → plain newline (false)', () => {
    const r = run(setup('* hello', 1));
    expect(r.handled).toBe(false);
    expect(r.doc).toBe('* hello');
  });

  test('cursor inside the leading indent of `  * x` → plain newline (false)', () => {
    const r = run(setup('  * x', 1));
    expect(r.handled).toBe(false);
    expect(r.doc).toBe('  * x');
  });
});

describe('continueList — #5 selection continuation uses the line where content resumes', () => {
  test('forward selection from a list line into a plain line continues from the list line', () => {
    // '* item one\nplain' — select from offset 4 (mid list line) to offset 13 (mid plain line).
    const r = run(setup('* item one\nplain', 4, 13));
    expect(r.handled).toBe(true);
    expect(r.doc).toBe('* it\n* ain');
  });
});

describe('continueList — #4 prose with a mid-line separator is not continued', () => {
  test('`see the note:: really` → plain newline (false)', () => {
    const r = run(setup('see the note:: really', 21));
    expect(r.handled).toBe(false);
    expect(r.doc).toBe('see the note:: really');
  });
});
