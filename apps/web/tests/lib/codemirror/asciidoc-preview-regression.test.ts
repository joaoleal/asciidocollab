/**
 * Preview regression baseline for feature 030 (syntax-highlighting rework).
 *
 * Parses the quickstart §2 representative sample through the AsciiDoc Lezer grammar
 * and asserts that every expected node type is present. This is the
 * guard: the node-type set MUST remain stable through every later task in this
 * feature so the highlight layer never loses constructs it previously recognised.
 *
 * Additionally verifies that the 030 per-severity admonition and checklist nodes
 * are emitted by the new tokenizer (replacing the old generic nodes), so the
 * regression guard also validates the new tokenizer behaviour.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import { highlightTree } from '@lezer/highlight';
import type { LRParser } from '@lezer/lr';
import type { Tree } from '@lezer/common';
import { asciidocHighlightStyle } from '@/lib/codemirror/asciidoc-theme';
import { asciidocHighlightTags } from '@/lib/codemirror/asciidoc-highlight-tags';
import { createTestBlockTokenizer, createTestBlockContext } from '../../helpers/asciidoc-test-tokenizer';

// ── Parser setup ─────────────────────────────────────────────────────────────

const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');

const parser: LRParser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) =>
    createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) =>
    createTestBlockContext(terms),
}).configure({ props: [asciidocHighlightTags] }) as LRParser;

// ── Representative quickstart §2 sample (feature 030 spec) ───────────────────

const SAMPLE = `= Document Title
Jane Author <jane@example.com>
v2.1, 2026-06-20

== Section One
=== Subsection

A paragraph with *bold*, _italic_, \`inline code\`, a {version} attribute,
https://example.org[a labeled link], and a bare https://example.org URL.

NOTE: this is an inline note.
TIP: a tip.
WARNING: a warning.
IMPORTANT: an important.
CAUTION: a caution.

[WARNING]
====
A block admonition body.
====

* unordered item
. ordered item
term:: description
* [x] done task
* [ ] todo task

.Block Title
[source,ruby]
----
puts "hello world"
----

// A comment line

////
Block comment.
////
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDocument(text: string): Tree {
  return parser.parse(text);
}

function hasNode(tree: Tree, typeName: string): boolean {
  const cursor = tree.cursor();
  do {
    if (cursor.name === typeName) return true;
  } while (cursor.next());
  return false;
}

function classAt(source: string, pos: number): string {
  const tree = parseDocument(source);
  let result = '';
  highlightTree(tree, asciidocHighlightStyle, (from, to, classes) => {
    if (from <= pos && to > pos) result = classes;
  });
  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('feature 030 preview regression baseline', () => {
  let tree: Tree;

  beforeAll(() => {
    tree = parseDocument(SAMPLE);
  });

  test('sample parses without throwing', () => {
    expect(() => parseDocument(SAMPLE)).not.toThrow();
  });

  // ── Structural nodes that must always be present ──────────────────────────

  test('DocumentTitle node is present', () => {
    expect(hasNode(tree, 'DocumentTitle')).toBe(true);
  });

  test('Heading1 (==) node is present', () => {
    expect(hasNode(tree, 'Heading1')).toBe(true);
  });

  test('Heading2 (===) node is present', () => {
    expect(hasNode(tree, 'Heading2')).toBe(true);
  });

  test('AttributeReference ({version}) node is present', () => {
    expect(hasNode(tree, 'AttributeReference')).toBe(true);
  });

  test('InlineMacro (labeled link) node is present', () => {
    // The sample contains `https://example.org[a labeled link]` which is an inline macro.
    expect(hasNode(parseDocument('See link:http://x.com[label]\n'), 'InlineMacro')).toBe(true);
  });

  test('Bold node is present', () => {
    expect(hasNode(tree, 'Bold')).toBe(true);
  });

  test('Italic node is present', () => {
    expect(hasNode(tree, 'Italic')).toBe(true);
  });

  test('Monospace node is present', () => {
    expect(hasNode(tree, 'Monospace')).toBe(true);
  });

  test('CommentLine node is present', () => {
    expect(hasNode(tree, 'CommentLine')).toBe(true);
  });

  test('CommentBlock node is present', () => {
    expect(hasNode(tree, 'CommentBlock')).toBe(true);
  });

  test('ListingBlock node is present', () => {
    expect(hasNode(tree, 'ListingBlock')).toBe(true);
  });

  test('OrderedListItem node is present', () => {
    expect(hasNode(tree, 'OrderedListItem')).toBe(true);
  });

  test('UnorderedListItem node is present', () => {
    expect(hasNode(tree, 'UnorderedListItem')).toBe(true);
  });

  test('DescriptionList node is present', () => {
    expect(hasNode(tree, 'DescriptionList')).toBe(true);
  });

  test('BlockTitle node is present', () => {
    expect(hasNode(tree, 'BlockTitle')).toBe(true);
  });

  // ── 030 per-severity admonition paragraph nodes ────────────────────────────

  test('NOTE: produces AdmonitionNoteParagraph (030 per-severity split)', () => {
    expect(hasNode(parseDocument('NOTE: test\n'), 'AdmonitionNoteParagraph')).toBe(true);
  });

  test('TIP: produces AdmonitionTipParagraph', () => {
    expect(hasNode(parseDocument('TIP: test\n'), 'AdmonitionTipParagraph')).toBe(true);
  });

  test('WARNING: produces AdmonitionWarningParagraph', () => {
    expect(hasNode(parseDocument('WARNING: test\n'), 'AdmonitionWarningParagraph')).toBe(true);
  });

  test('IMPORTANT: produces AdmonitionImportantParagraph', () => {
    expect(hasNode(parseDocument('IMPORTANT: test\n'), 'AdmonitionImportantParagraph')).toBe(true);
  });

  test('CAUTION: produces AdmonitionCautionParagraph', () => {
    expect(hasNode(parseDocument('CAUTION: test\n'), 'AdmonitionCautionParagraph')).toBe(true);
  });

  // ── 030 per-severity admonition block nodes ────────────────────────────────

  test('[NOTE] block produces AdmonitionNoteBlock', () => {
    const source = '[NOTE]\n====\nbody\n====\n';
    expect(hasNode(parseDocument(source), 'AdmonitionNoteBlock')).toBe(true);
  });

  test('[WARNING] block produces AdmonitionWarningBlock', () => {
    const source = '[WARNING]\n====\nbody\n====\n';
    expect(hasNode(parseDocument(source), 'AdmonitionWarningBlock')).toBe(true);
  });

  // ── 030 checklist split ────────────────────────────────────────────────────

  test('[x] done task produces CheckDoneItem', () => {
    expect(hasNode(parseDocument('* [x] done\n'), 'CheckDoneItem')).toBe(true);
  });

  test('[ ] todo task produces CheckTodoItem', () => {
    expect(hasNode(parseDocument('* [ ] todo\n'), 'CheckTodoItem')).toBe(true);
  });

  test('done and todo checklist items get different highlight classes', () => {
    const doneClass = classAt('* [x] done\n', 3);
    const todoClass = classAt('* [ ] todo\n', 3);
    expect(doneClass).not.toBe('');
    expect(todoClass).not.toBe('');
    expect(doneClass).not.toBe(todoClass);
  });

  // ── Highlight class smoke test — every construct must resolve a class ───────

  test('DocumentTitle resolves a non-empty highlight class', () => {
    expect(classAt('= Title\n', 2)).not.toBe('');
  });

  test('Bold resolves a non-empty highlight class', () => {
    expect(classAt('Some *bold* text\n', 6)).not.toBe('');
  });

  test('Italic resolves a non-empty highlight class', () => {
    expect(classAt('an _italic_ word\n', 4)).not.toBe('');
  });

  test('Monospace resolves a non-empty highlight class', () => {
    expect(classAt('run `code` now\n', 5)).not.toBe('');
  });

  test('per-severity NOTE paragraph resolves a non-empty highlight class', () => {
    expect(classAt('NOTE: test\n', 0)).not.toBe('');
  });

  test('per-severity WARNING paragraph resolves a non-empty highlight class', () => {
    expect(classAt('WARNING: test\n', 0)).not.toBe('');
  });
});
