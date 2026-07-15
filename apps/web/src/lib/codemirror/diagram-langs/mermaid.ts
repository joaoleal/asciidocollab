import { StreamLanguage, type StreamParser } from '@codemirror/language';
import { type Parser } from '@lezer/common';
import {
  flowchartLanguage,
  sequenceLanguage,
  ganttLanguage,
  pieLanguage,
  journeyLanguage,
  requirementLanguage,
  mindmapLanguage,
} from 'codemirror-lang-mermaid';

/**
 * Mermaid inner highlighting for the AsciiDoc editor.
 *
 * A mermaid diagram's first content line declares its type. We select a
 * highlighter from that keyword:
 *
 *   - Grammar-backed (`codemirror-lang-mermaid`) for the types the package's
 *     Lezer grammars actually cover: flowchart/graph, sequence, gantt, pie,
 *     journey, requirement, mindmap.
 *   - A single lexical `StreamParser` fallback for every OTHER known mermaid
 *     diagram type (class, state, ER, gitGraph, timeline, C4, …). The fallback
 *     is deliberately shallow — it highlights the type keyword, `%%` comments,
 *     quoted labels, arrows/edges and node-shape brackets — but consistent and
 *     robust across the long tail of diagram types and future additions.
 *   - An unknown/unrecognized keyword resolves to `null`, so the mixed-language
 *     routing injects nothing and the body degrades to plain highlighting. Odd
 *     or malformed input never throws.
 *
 * Embedded diagram source is inert data — parsed for colour only, never executed.
 */

/**
 * Lezer languages from `codemirror-lang-mermaid`, keyed by the lowercased
 * diagram-type keyword. Aliases (`graph` → flowchart) share a language.
 */
const GRAMMAR_BY_KEYWORD: Readonly<Record<string, { parser: Parser }>> = {
  flowchart: flowchartLanguage,
  graph: flowchartLanguage,
  sequencediagram: sequenceLanguage,
  gantt: ganttLanguage,
  pie: pieLanguage,
  journey: journeyLanguage,
  requirementdiagram: requirementLanguage,
  mindmap: mindmapLanguage,
};

/**
 * Known mermaid diagram-type keywords WITHOUT a bundled Lezer grammar. These use
 * the lexical fallback. Kept as a recognised-set (rather than a catch-all) so a
 * genuinely unknown keyword can degrade to plain highlighting instead.
 */
const LEXICAL_FALLBACK_KEYWORDS: ReadonlySet<string> = new Set([
  'classdiagram',
  'classdiagram-v2',
  'statediagram',
  'statediagram-v2',
  'erdiagram',
  'gitgraph',
  'quadrantchart',
  'c4context',
  'c4container',
  'c4component',
  'c4dynamic',
  'c4deployment',
  'timeline',
  'zenuml',
  'sankey',
  'sankey-beta',
  'xychart',
  'xychart-beta',
  'block',
  'block-beta',
  'packet',
  'packet-beta',
  'kanban',
  'architecture',
  'architecture-beta',
  'radar',
  'treemap',
]);

/** Matches the leading diagram-type keyword (letters, digits, `_`, `-`). */
const KEYWORD_RE = /^([A-Za-z][A-Za-z0-9_-]*)/;

/**
 * The diagram-type keyword on the first CONTENT line, or `null` when there is
 * none. Leading blank lines, `%%` comments (including `%%{init}%%` directives)
 * and a leading `--- … ---` YAML frontmatter block are skipped.
 */
export function firstMermaidKeyword(source: string): string | null {
  let inFrontmatter = false;
  let seenContent = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    // A `---` fence is only frontmatter before any content line has appeared.
    if (line === '---' && (!seenContent || inFrontmatter)) {
      inFrontmatter = !inFrontmatter;
      seenContent = true;
      continue;
    }
    if (inFrontmatter) continue;
    seenContent = true;
    if (line.startsWith('%%')) continue; // comments + `%%{init}%%` directives
    const match = KEYWORD_RE.exec(line);
    return match ? match[1] : null;
  }
  return null;
}

/**
 * Consistent lexical highlighter used for every mermaid diagram type not covered
 * by a bundled grammar. Robust by construction: it never throws and always makes
 * progress, so malformed or partial diagrams stay highlightable.
 */
export const mermaidLexicalFallback: StreamParser<{ sawType: boolean; inFrontmatter: boolean }> = {
  name: 'mermaid-lexical',
  startState: () => ({ sawType: false, inFrontmatter: false }),
  /* eslint-disable unicorn/prefer-regexp-test -- `stream.match(re)` is CodeMirror's StringStream.match, which advances the stream and returns the match; `re.test(stream)` would coerce the stream to a string and consume nothing. */
  token(stream, state) {
    // YAML frontmatter fences (`---`) sit before the diagram type.
    if (stream.sol() && !state.sawType && stream.match(/^---[ \t]*$/)) {
      state.inFrontmatter = !state.inFrontmatter;
      return 'meta';
    }
    if (state.inFrontmatter) {
      if (stream.sol() && stream.match(/^---[ \t]*$/)) {
        state.inFrontmatter = false;
        return 'meta';
      }
      stream.skipToEnd();
      return 'meta';
    }

    // `%%` line comments (and `%%{init}%%` directives).
    if (stream.match(/^%%[^\n]*/)) return 'comment';

    if (stream.eatSpace()) return null;

    // The diagram-type keyword: the first word on the first content line.
    if (stream.sol() && !state.sawType) {
      state.sawType = true;
      if (stream.match(KEYWORD_RE)) return 'keyword';
      // First content line does not start with a word (e.g. punctuation); fall
      // through so the character below is still consumed.
    }

    // Quoted labels.
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string';

    // Arrows / edges: `-->`, `---`, `==>`, `-.->`, `<-->`, `~~~`, …
    if (stream.match(/^<?[-=~.]{2,}[->ox|]*>?/)) return 'operator';

    // Node-shape brackets.
    if (stream.match(/^[[\](){}]/)) return 'bracket';

    // Anything else: consume one character, unstyled.
    stream.next();
    return null;
  },
  /* eslint-enable unicorn/prefer-regexp-test */
};

/** The lexical fallback wrapped as a CodeMirror {@link Parser} for `parseMixed`. */
export const mermaidFallbackParser: Parser = StreamLanguage.define(mermaidLexicalFallback).parser;

/**
 * Resolve the mermaid inner-highlighting {@link Parser} for a block body, chosen
 * from its first content line's diagram-type keyword:
 *   - a grammar-backed parser for a covered type,
 *   - {@link mermaidFallbackParser} for another known type,
 *   - `null` for an unknown keyword or an empty/comment-only body (plain).
 */
export function mermaidParserForSource(source: string): Parser | null {
  const keyword = firstMermaidKeyword(source);
  if (!keyword) return null;
  const key = keyword.toLowerCase();
  const grammar = GRAMMAR_BY_KEYWORD[key];
  if (grammar) return grammar.parser;
  if (LEXICAL_FALLBACK_KEYWORDS.has(key)) return mermaidFallbackParser;
  return null;
}
