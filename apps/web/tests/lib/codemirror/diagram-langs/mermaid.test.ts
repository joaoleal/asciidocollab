/**
 * Unit tests for the editor's mermaid inner-highlighting resolver.
 *
 * `mermaidParserForSource` inspects a mermaid block body's FIRST content line and
 * returns the CodeMirror `Parser` the mixed-language routing should inject for
 * that diagram type:
 *   - a grammar-backed parser (`codemirror-lang-mermaid`) for the covered types
 *     (flowchart/graph, sequence, gantt, pie, journey, requirement, mindmap),
 *   - a consistent lexical `StreamParser` fallback for every other KNOWN mermaid
 *     diagram type (class, state, ER, gitGraph, …),
 *   - `null` for an unknown/unrecognized keyword, so the routing injects nothing
 *     and the body degrades to plain highlighting (never breaks the document).
 *
 * The grammar-backed cases are asserted by parser identity and by walking the
 * produced tree (nodes/edges highlight). The lexical fallback is driven directly
 * as a `StreamParser` — the harness mimics how CodeMirror feeds it line by line —
 * so its token classification (type keyword, `%%` comments, quoted labels,
 * arrows, node-shape brackets) is checked without a DOM.
 */
import { StringStream, type StreamParser } from '@codemirror/language';
import { type Parser, type Tree } from '@lezer/common';
import { flowchartLanguage, sequenceLanguage } from 'codemirror-lang-mermaid';

import {
  mermaidParserForSource,
  mermaidLexicalFallback,
  mermaidFallbackParser,
} from '@/lib/codemirror/diagram-langs/mermaid';

/** All node names present in a parsed tree (document order). */
function nodeNames(tree: Tree): string[] {
  const names: string[] = [];
  const cursor = tree.cursor();
  do {
    names.push(cursor.name);
  } while (cursor.next());
  return names;
}

/**
 * Drive a `StreamParser` over `source` the way CodeMirror does — one fresh
 * `StringStream` per line, a single shared state — and collect the styled tokens.
 * A progress guard keeps a misbehaving tokenizer from looping forever.
 */
function tokenize(
  parser: StreamParser<unknown>,
  source: string,
): { text: string; tag: string | null }[] {
  const state = parser.startState ? parser.startState(2) : ({} as unknown);
  const out: { text: string; tag: string | null }[] = [];
  for (const line of source.split('\n')) {
    const stream = new StringStream(line, 2, 2, undefined);
    if (stream.eol()) {
      parser.blankLine?.(state, 2);
      continue;
    }
    let guard = 0;
    while (!stream.eol()) {
      const start = stream.pos;
      const tag = parser.token(stream, state);
      if (stream.pos <= start) stream.next();
      out.push({ text: line.slice(start, stream.pos), tag });
      if (++guard > 5000) break;
    }
  }
  return out;
}

describe('mermaidParserForSource (grammar-backed types)', () => {
  test('routes a flowchart body to the flowchart grammar and highlights nodes/edges', () => {
    const parser = mermaidParserForSource('flowchart TD\n  A[Start] --> B(End)\n');
    expect(parser).toBe(flowchartLanguage.parser);

    const names = nodeNames((parser as Parser).parse('flowchart TD\n  A[Start] --> B(End)\n'));
    expect(names).toContain('NodeId'); // node
    expect(names).toContain('Link'); // edge
  });

  test('routes the `graph` keyword to the same flowchart grammar', () => {
    expect(mermaidParserForSource('graph LR\n  A --> B\n')).toBe(flowchartLanguage.parser);
  });

  test('routes a sequenceDiagram body to the sequence grammar and highlights arrows', () => {
    const parser = mermaidParserForSource('sequenceDiagram\n  Alice->>John: Hi\n');
    expect(parser).toBe(sequenceLanguage.parser);

    const names = nodeNames((parser as Parser).parse('sequenceDiagram\n  Alice->>John: Hi\n'));
    expect(names).toContain('Arrow');
  });
});

describe('mermaidParserForSource (lexical fallback for non-covered known types)', () => {
  test('routes an erDiagram body to the lexical fallback parser', () => {
    expect(mermaidParserForSource('erDiagram\n  CUSTOMER ||--o{ ORDER : places\n')).toBe(
      mermaidFallbackParser,
    );
  });

  test('routes a gitGraph body to the lexical fallback parser', () => {
    expect(mermaidParserForSource('gitGraph\n  commit\n')).toBe(mermaidFallbackParser);
  });
});

describe('mermaidParserForSource (first-content-line detection)', () => {
  test('skips leading blank lines, `%%` comments and a `%%{init}%%` directive', () => {
    const source = '\n%% a note\n%%{init: {"theme":"dark"}}%%\nsequenceDiagram\n  A->>B: hi\n';
    expect(mermaidParserForSource(source)).toBe(sequenceLanguage.parser);
  });

  test('skips a YAML frontmatter block before the diagram keyword', () => {
    const source = '---\ntitle: Demo\n---\nflowchart TD\n  A --> B\n';
    expect(mermaidParserForSource(source)).toBe(flowchartLanguage.parser);
  });
});

describe('mermaidParserForSource (safe degradation)', () => {
  test('returns null for an unknown first-line keyword without throwing', () => {
    expect(() => mermaidParserForSource('totallyNotADiagram foo bar\n  x -> y\n')).not.toThrow();
    expect(mermaidParserForSource('totallyNotADiagram foo bar\n')).toBeNull();
  });

  test('returns null when the first content line opens with punctuation rather than a word', () => {
    // A partial diagram an author is midway through typing has no keyword to route on; injecting
    // nothing degrades it to plain highlighting rather than breaking the document.
    expect(mermaidParserForSource('--> B\n')).toBeNull();
    expect(mermaidParserForSource('{"theme": "dark"}\n')).toBeNull();
  });

  test('returns null for empty / whitespace / comment-only bodies', () => {
    expect(mermaidParserForSource('')).toBeNull();
    expect(mermaidParserForSource('   \n\t\n')).toBeNull();
    expect(mermaidParserForSource('%% only a comment\n')).toBeNull();
  });
});

describe('mermaidLexicalFallback (StreamParser)', () => {
  const source =
    'mysteryDiagram\n' + //
    '%% a comment\n' +
    'A --> "a label" B\n' +
    'C ==> D\n' +
    'E[shape]\n';
  const tokens = tokenize(mermaidLexicalFallback, source);
  const tagOf = (text: string): string | null | undefined =>
    tokens.find((token) => token.text === text)?.tag;

  test('highlights the diagram-type keyword on the first content line', () => {
    expect(tagOf('mysteryDiagram')).toBe('keyword');
  });

  test('highlights a `%%` line comment', () => {
    expect(tokens.some((token) => token.text.startsWith('%%') && token.tag === 'comment')).toBe(true);
  });

  test('highlights arrows / edges', () => {
    expect(tagOf('-->')).toBe('operator');
    expect(tagOf('==>')).toBe('operator');
  });

  test('highlights a quoted label', () => {
    expect(tagOf('"a label"')).toBe('string');
  });

  test('highlights node-shape brackets', () => {
    expect(tagOf('[')).toBe('bracket');
    expect(tagOf(']')).toBe('bracket');
  });

  test('highlights a single-quoted label', () => {
    const quoted = tokenize(mermaidLexicalFallback, "mysteryDiagram\nA --> 'a label' B\n");
    expect(quoted.find((token) => token.text === "'a label'")?.tag).toBe('string');
  });

  test('treats a leading YAML frontmatter block, fences included, as metadata', () => {
    // The frontmatter sits before the diagram type and is not diagram syntax: styling it as content
    // would put keyword/arrow colours on `title:` lines that mean nothing to mermaid.
    const framed = tokenize(mermaidLexicalFallback, '---\ntitle: Demo\nconfig: {}\n---\nmysteryDiagram\n');
    expect(framed.filter((token) => token.tag === 'meta').map((token) => token.text)).toEqual([
      '---',
      'title: Demo',
      'config: {}',
      '---',
    ]);
    // The keyword after the closing fence is still recognised as the diagram type.
    expect(framed.find((token) => token.text === 'mysteryDiagram')?.tag).toBe('keyword');
  });

  test('never throws on odd input', () => {
    expect(() => tokenize(mermaidLexicalFallback, '{[(<>)]}\n%%%\n"unterminated\n---\n')).not.toThrow();
  });
});
