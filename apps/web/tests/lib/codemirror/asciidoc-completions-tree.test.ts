/* @jest-environment jsdom */

/**
 * Live-view behaviour checks for the table completion sources (table
 * cell/skeleton) against a fully-parsed document. The headless `EditorState`
 * parses lazily, so these mount a real `EditorView` (jsdom) and force a complete
 * parse before invoking the sources — the closest stand-in for the editor at
 * runtime — confirming column counting, the no-trigger-inside-a-block guard, and
 * the no-skeleton-inside-an-existing-table rule all hold over a real tree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LRLanguage, LanguageSupport, forceParsing } from '@codemirror/language';
import {
  tableCellCompletionSource,
  tableSnippetCompletionSource,
} from '@/lib/codemirror/asciidoc-completions';
import { createTestBlockTokenizer, createTestBlockContext } from '../../helpers/asciidoc-test-tokenizer';

const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');
const lezerParser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
});
const langExtension = new LanguageSupport(LRLanguage.define({ name: 'asciidoc', parser: lezerParser }));

type Source = (context: CompletionContext) => CompletionResult | null;

function completeInView(source: Source, documentContent: string, triggerPosition: number) {
  const view = new EditorView({
    state: EditorState.create({
      doc: documentContent,
      extensions: [langExtension],
      selection: { anchor: triggerPosition },
    }),
  });
  // Force a synchronous, complete parse into the view's cached tree so the
  // sources' `syntaxTree(state)` calls see the TableBlock / delimited-block nodes.
  forceParsing(view, view.state.doc.length, 5000);
  const context = {
    state: view.state,
    pos: triggerPosition,
    explicit: false,
    matchBefore: (regex: RegExp) => {
      const match = view.state.sliceDoc(0, triggerPosition).match(regex);
      return match
        ? { from: triggerPosition - match[0].length, to: triggerPosition, text: match[0] }
        : null;
    },
  } as CompletionContext;
  try {
    return source(context);
  } finally {
    view.destroy();
  }
}

describe('table completions over a live syntax tree', () => {
  test('tableCellCompletionSource counts columns for a row inside a closed table', () => {
    // Closed table (a TableBlock node exists); cursor on the lone `|` row inside it.
    const documentContent = '|===\n|a |b |c\n|\n|===\n';
    const cursor = documentContent.indexOf('\n|\n') + 2;
    const result = completeInView(tableCellCompletionSource, documentContent, cursor);
    expect(result).not.toBeNull();
    let insertedText = '';
    const mockView = {
      dispatch: (tr: { changes: { insert: string } }) => { insertedText = tr.changes.insert; },
    };
    (result!.options[0].apply as (...arguments_: unknown[]) => void)(mockView, result!.options[0], cursor - 1, cursor);
    expect((insertedText.match(/\|/g) ?? []).length).toBe(3);
  });

  test('a | line inside a parsed listing block does not trigger a table-cell completion', () => {
    // The `|` line lives inside a delimited (listing) block, not a table, so no
    // new-row completion is offered.
    const documentContent = '----\n|not a cell\n----\n';
    const cursor = documentContent.indexOf('\n|') + 2;
    const result = completeInView(tableCellCompletionSource, documentContent, cursor);
    expect(result).toBeNull();
  });

  test('tableSnippetCompletionSource does not fire inside an existing table', () => {
    // A `|===` typed at column 0 inside an existing (parsed) table must not offer
    // the skeleton — it would corrupt the table.
    const documentContent = '|===\n|a |b\n|===';
    const result = completeInView(tableSnippetCompletionSource, documentContent, documentContent.length);
    expect(result).toBeNull();
  });
});
