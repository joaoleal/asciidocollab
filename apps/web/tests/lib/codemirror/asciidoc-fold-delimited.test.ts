/* @jest-environment jsdom */

/**
 * Live-view coverage for the tree-based delimited-block fold path of
 * `asciidocFold`. A real `EditorView` (jsdom) is required because
 * the headless `EditorState` runs the Lezer parser lazily — `ensureSyntaxTree`
 * only yields a populated tree once a view drives the parse scheduler. With a
 * populated tree the fold service's `foldDelimitedAt` walk visits real block
 * nodes, exercising the node-spanning and node-before iteration branches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LRLanguage, LanguageSupport, foldable, ensureSyntaxTree } from '@codemirror/language';
import { asciidocFold } from '@/lib/codemirror/asciidoc-fold';
import { createTestBlockTokenizer, createTestBlockContext } from '../../helpers/asciidoc-test-tokenizer';

const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');

const lezerParser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
});

const asciidocLang = LRLanguage.define({ name: 'asciidoc', parser: lezerParser });
const langExtension = new LanguageSupport(asciidocLang);

function makeView(documentContent: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc: documentContent, extensions: [langExtension, asciidocFold] }),
  });
  // Force the whole document to parse so the tree-walk has real block nodes.
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

// The simplified test tokenizer does not materialise the block delimiters as
// child nodes, so `foldDelimitedAt` (which needs first/last delimiter children to
// compute a body range) cannot produce a range from it. This tiny grammar names
// the delimiters as `Delim` child nodes under a `ListingBlock`, mirroring the
// real grammar's `ListingBlock { listingDelim blockBody listingDelim }` shape so
// the production succeeds and the fold-range success branch is exercised.
const childBearingGrammar = String.raw`
@top Document { (ListingBlock | TableBlock | Line)* }
ListingBlock { Delim Line+ Delim }
TableBlock { TableDelim Line+ TableDelim }
Delim { "----" newline }
TableDelim { "|===" newline }
Line { word newline }
@tokens {
  word { (![|\-\n] ![\n]*) }
  newline { "\n" }
  "----"
  "|==="
}
`;
const childBearingParser = buildParser(childBearingGrammar);
const childBearingLang = new LanguageSupport(LRLanguage.define({ name: 'mini', parser: childBearingParser }));

function makeChildBearingView(documentContent: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc: documentContent, extensions: [childBearingLang, asciidocFold] }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

describe('asciidocFold delimited-block tree path', () => {
  test('the tree walk runs over a block opener line without throwing (spanning branch)', () => {
    // Folding the opener line drives `foldDelimitedAt`: the ListingBlock node spans
    // the line (node.from <= lineStart <= node.to), exercising the node-spanning
    // iteration branch and the per-node fold-range probe.
    const view = makeView('----\nline one\nline two\n----\nafter\n');
    try {
      const opener = view.state.doc.line(1);
      expect(() => foldable(view.state, opener.from, opener.to)).not.toThrow();
    } finally {
      view.destroy();
    }
  });

  test('a paragraph line after a closed block walks past the block node (node-before branch)', () => {
    // The trailing paragraph sits after the block; the tree walk visits the block
    // node whose `to` is before this line (node.to < lineStart) and skips its
    // subtree, then visits the paragraph node whose `from` is after the line start.
    const view = makeView('----\ncode\n----\nplain paragraph after the block\n');
    try {
      const after = view.state.doc.line(4);
      expect(foldable(view.state, after.from, after.to)).toBeNull();
    } finally {
      view.destroy();
    }
  });

  test('a table opener line drives the tree walk without throwing', () => {
    const view = makeView('|===\n|a |b\n|c |d\n|===\nafter\n');
    try {
      const opener = view.state.doc.line(1);
      expect(() => foldable(view.state, opener.from, opener.to)).not.toThrow();
    } finally {
      view.destroy();
    }
  });

  test('the fold service returns a section range for a heading line', () => {
    // Drives the foldService `??` chain: the section producer returns first.
    const view = makeView('== One\nbody of one\n\n== Two\nbody two\n');
    try {
      const heading = view.state.doc.line(1);
      const range = foldable(view.state, heading.from, heading.to);
      expect(range).not.toBeNull();
      expect(view.state.doc.sliceString(range!.from, range!.to)).toContain('body of one');
    } finally {
      view.destroy();
    }
  });

  test('the fold service returns a conditional range for an ifdef line', () => {
    const view = makeView('ifdef::env[]\nalpha\nbeta\nendif::[]\n');
    try {
      const opener = view.state.doc.line(1);
      const range = foldable(view.state, opener.from, opener.to);
      expect(range).not.toBeNull();
      expect(view.state.doc.sliceString(range!.from, range!.to)).toContain('alpha');
    } finally {
      view.destroy();
    }
  });

  test('the fold service returns a comment-run range', () => {
    const view = makeView('// one\n// two\n// three\ntext\n');
    try {
      const opener = view.state.doc.line(1);
      expect(foldable(view.state, opener.from, opener.to)).not.toBeNull();
    } finally {
      view.destroy();
    }
  });

  test('the fold service returns an attribute-run range', () => {
    const view = makeView(':author: A\n:version: 1\n:toc:\nbody\n');
    try {
      const opener = view.state.doc.line(1);
      expect(foldable(view.state, opener.from, opener.to)).not.toBeNull();
    } finally {
      view.destroy();
    }
  });

  test('produces a fold range when the block node carries delimiter children', () => {
    // With first/last delimiter children present, `foldDelimitedAt` computes a body
    // range and assigns it (the success branch of the tree walk).
    const view = makeChildBearingView('----\nfoo\nbar\n----\nbaz\n');
    try {
      const opener = view.state.doc.line(1);
      const range = foldable(view.state, opener.from, opener.to);
      expect(range).not.toBeNull();
      const hidden = view.state.doc.sliceString(range!.from, range!.to);
      expect(hidden).toContain('foo');
      expect(hidden).toContain('bar');
    } finally {
      view.destroy();
    }
  });

  test('falls through to the table fold when a block node is a TableBlock', () => {
    // `foldRangeForBlock` returns null for a TableBlock, so the `?? foldRangeForTable`
    // branch in `foldDelimitedAt` produces the range.
    const view = makeChildBearingView('|===\nrow one\nrow two\n|===\ntail\n');
    try {
      const opener = view.state.doc.line(1);
      const range = foldable(view.state, opener.from, opener.to);
      expect(range).not.toBeNull();
      const hidden = view.state.doc.sliceString(range!.from, range!.to);
      expect(hidden).toContain('row one');
      expect(hidden).toContain('row two');
    } finally {
      view.destroy();
    }
  });
});
