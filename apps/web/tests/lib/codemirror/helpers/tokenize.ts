import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import type { LRParser } from '@lezer/lr';
import type { Tree } from '@lezer/common';
import { createTestBlockTokenizer, createTestBlockContext } from '../../../helpers/asciidoc-test-tokenizer';

/**
 * Shared Lezer tokenizer test harness. Builds the AsciiDoc parser from
 * the grammar source + the test external tokenizer and parses a string into a
 * flat list of `(nodeName, text, level)` tuples — so grammar/tokenizer tests can
 * assert which constructs tokenize (and that adjacent text is unaffected)
 * without a live editor. The parser is built once and cached across calls.
 */

export interface TokenTuple {
  /** Lezer node name (e.g. `Heading1`, `Link`, `Conditional`). */
  nodeName: string;
  /** The source slice the node covers. */
  text: string;
  /** Tree depth from the `Document` root (0 = the top node). */
  level: number;
  from: number;
  to: number;
}

let cachedParser: LRParser | null | undefined;

function getParser(): LRParser {
  if (cachedParser === undefined) {
    const grammarPath = path.resolve(__dirname, '../../../../src/lib/codemirror/asciidoc.grammar');
    const grammarSource = fs.readFileSync(grammarPath, 'utf8');
    try {
      cachedParser = buildParser(grammarSource, {
        externalTokenizer: (_name: string, terms: Record<string, number>) =>
          createTestBlockTokenizer(terms),
        contextTracker: (terms: Record<string, number>) =>
          createTestBlockContext(terms),
      }) as LRParser;
    } catch {
      cachedParser = null;
    }
  }
  if (!cachedParser) throw new Error('AsciiDoc grammar failed to build');
  return cachedParser;
}

/** Parse `source` and return every node as a `(nodeName, text, level)` tuple in document order. */
export function tokenize(source: string): TokenTuple[] {
  const tree: Tree = getParser().parse(source);
  const tuples: TokenTuple[] = [];
  let level = 0;
  tree.iterate({
    enter(node) {
      tuples.push({
        nodeName: node.name,
        text: source.slice(node.from, node.to),
        level,
        from: node.from,
        to: node.to,
      });
      level += 1;
    },
    leave() {
      level -= 1;
    },
  });
  return tuples;
}

/** True when `source` produces at least one node named `nodeName`. */
export function hasToken(source: string, nodeName: string): boolean {
  return tokenize(source).some((token) => token.nodeName === nodeName);
}

/** All tuples of a given node name produced by parsing `source`. */
export function tokensOfType(source: string, nodeName: string): TokenTuple[] {
  return tokenize(source).filter((token) => token.nodeName === nodeName);
}

/** True when some `nodeName` node covers the document offset `position`. */
export function tokenAt(source: string, nodeName: string, position: number): boolean {
  return tokenize(source).some(
    (token) => token.nodeName === nodeName && token.from <= position && token.to > position,
  );
}
