import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import { highlightTree } from '@lezer/highlight';
import type { LRParser } from '@lezer/lr';
import { asciidocHighlightStyle } from '@/lib/codemirror/asciidoc-theme';
import { asciidocHighlightTags } from '@/lib/codemirror/asciidoc-highlight-tags';
import { createTestBlockTokenizer, createTestBlockContext } from '../../helpers/asciidoc-test-tokenizer';
import { hasToken, tokenAt } from './helpers/tokenize';

/**
 * A diagram block DECLARATION (`[mermaid]`, `[graphviz]`, `[vega]`, `[vegalite]`) sitting
 * immediately above a delimited-block delimiter (`----` / `....`) is tokenized distinctly from a
 * generic `[source,lang]` listing declaration, so the editor can colour "this block renders to an
 * image" differently from an ordinary source block. A `[...]` line that is NOT immediately followed
 * by a block delimiter, and a `[source,ruby]` listing, are NOT diagram declarations.
 */

const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');

const parser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
}).configure({ props: [asciidocHighlightTags] }) as LRParser;

/** Returns the highlight class string applied at `pos` when `source` is parsed + highlighted. */
function classAt(source: string, pos: number): string {
  const tree = parser.parse(source);
  let result = '';
  highlightTree(tree, asciidocHighlightStyle, (from, to, classes) => {
    if (from <= pos && to > pos) result = classes;
  });
  return result;
}

const DECL_NODE = 'DiagramBlockDeclaration';

describe('AsciiDoc diagram block declaration', () => {
  test.each([
    ['mermaid', '----'],
    ['graphviz', '----'],
    ['vega', '----'],
    ['vegalite', '----'],
    ['vega-lite', '----'],
    ['mermaid', '....'],
  ])('a [%s] line above a %s delimiter is a diagram declaration node', (name, fence) => {
    const source = `[${name}]\n${fence}\ngraph\n${fence}\n`;
    expect(hasToken(source, DECL_NODE)).toBe(true);
    // The declaration node covers the `[name]` line.
    expect(tokenAt(source, DECL_NODE, 1)).toBe(true);
  });

  test('the diagram declaration carries a highlight class distinct from a [source,ruby] listing', () => {
    const diagramClass = classAt('[mermaid]\n----\ngraph\n----\n', 1);
    const sourceClass = classAt('[source,ruby]\n----\nx\n----\n', 1);
    expect(diagramClass).not.toBe('');
    expect(sourceClass).not.toBe('');
    expect(diagramClass).not.toBe(sourceClass);
  });

  test('all four diagram notations share the same declaration highlight class', () => {
    const mermaid = classAt('[mermaid]\n----\nx\n----\n', 1);
    const graphviz = classAt('[graphviz]\n----\nx\n----\n', 1);
    const vega = classAt('[vega]\n----\nx\n----\n', 1);
    const vegalite = classAt('[vegalite]\n----\nx\n----\n', 1);
    expect(mermaid).not.toBe('');
    expect(graphviz).toBe(mermaid);
    expect(vega).toBe(mermaid);
    expect(vegalite).toBe(mermaid);
  });

  test('a [source,ruby] listing is NOT a diagram declaration (no regression)', () => {
    const source = '[source,ruby]\n----\nputs 1\n----\n';
    expect(hasToken(source, DECL_NODE)).toBe(false);
    // It still tokenizes as a generic block-attribute line.
    expect(hasToken(source, 'BlockAttributeLine')).toBe(true);
  });

  test('a [mermaid] line NOT followed by a block delimiter is NOT a diagram declaration', () => {
    // Followed by a blank line then prose — no delimiter immediately after.
    const source = '[mermaid]\nnot a diagram\n';
    expect(hasToken(source, DECL_NODE)).toBe(false);
    expect(hasToken(source, 'BlockAttributeLine')).toBe(true);
  });

  test('a non-diagram [role] line above a delimiter is NOT a diagram declaration', () => {
    const source = '[quote]\n----\nx\n----\n';
    expect(hasToken(source, DECL_NODE)).toBe(false);
  });
});
