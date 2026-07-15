import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { type Parser } from '@lezer/common';
import { dotLanguage } from './diagram-langs/dot';
import { mermaidParserForSource } from './diagram-langs/mermaid';
import { type DiagramNotation } from './diagram-notations';

/**
 * Curated allow-list of source languages we highlight inside `[source,<lang>]`
 * blocks. Keys are the lowercased language tokens that may appear
 * in an AsciiDoc source declaration (including common aliases); values are the
 * canonical `@codemirror/language-data` language names.
 *
 * Scoped deliberately (~20 entries / ~15 distinct languages) rather than
 * exposing every CodeMirror language pack — keeps the lazy-loaded bundle small
 * and the highlighting predictable.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  javascript: 'JavaScript',
  js: 'JavaScript',
  node: 'JavaScript',
  typescript: 'TypeScript',
  ts: 'TypeScript',
  jsx: 'JSX',
  tsx: 'TSX',
  python: 'Python',
  py: 'Python',
  java: 'Java',
  c: 'C',
  'c++': 'C++',
  cpp: 'C++',
  'c#': 'C#',
  csharp: 'C#',
  cs: 'C#',
  go: 'Go',
  golang: 'Go',
  rust: 'Rust',
  rs: 'Rust',
  ruby: 'Ruby',
  rb: 'Ruby',
  php: 'PHP',
  shell: 'Shell',
  sh: 'Shell',
  bash: 'Shell',
  console: 'Shell',
  sql: 'SQL',
  yaml: 'YAML',
  yml: 'YAML',
  json: 'JSON',
  xml: 'XML',
  html: 'HTML',
  css: 'CSS',
  markdown: 'Markdown',
  md: 'Markdown',
};

/**
 * Resolve a `[source,<lang>]` token to its canonical `@codemirror/language-data`
 * language name, or `null` when the language is not in the curated allow-list.
 * Pure — does not touch `@codemirror/language-data` (safe to unit-test in isolation).
 */
export function canonicalSourceLanguageName(name: string | null | undefined): string | null {
  if (!name) return null;
  return ALLOWLIST[name.trim().toLowerCase()] ?? null;
}

/** Distinct AsciiDoc source-language tokens offered for completion, sorted. */
export function listSourceLanguageTokens(): string[] {
  return Object.keys(ALLOWLIST).toSorted();
}

/**
 * Resolve a `[source,<lang>]` token to a CodeMirror {@link LanguageDescription}
 * (whose `load()` lazily imports the language pack), or `null` when unknown
 * or unsupported by `@codemirror/language-data`.
 */
export function resolveSourceLanguage(name: string | null | undefined): LanguageDescription | null {
  const canonical = canonicalSourceLanguageName(name);
  if (!canonical) return null;
  return languages.find((language) => language.name === canonical) ?? null;
}

/**
 * The canonical general-purpose source language whose parser highlights a diagram
 * notation's body, when that body *is* such a language. Only `vega`/`vegalite`
 * qualify — their bodies are JSON — so the lazy source-language loader can preload
 * that pack. `graphviz` and `mermaid` carry bespoke synchronous highlighters instead
 * and return `null` here.
 */
export function diagramBodyLanguageName(notation: DiagramNotation): string | null {
  return notation === 'vega' || notation === 'vegalite' ? 'JSON' : null;
}

/**
 * Resolve the inner parser that highlights a diagram block body:
 *   - `graphviz` → the DOT stream parser (synchronous),
 *   - `mermaid`  → a parser chosen from the body's first content line, or `null` for
 *     an unknown/empty diagram (injecting nothing),
 *   - `vega` / `vegalite` → the lazily-loaded JSON parser, looked up through
 *     `loadedLanguageParser` (which returns `null` until the loader has cached it).
 *
 * Returns `null` when no parser applies, so the caller injects nothing and the body
 * degrades to plain highlighting. Math notations (`stem`/`latexmath`/`asciimath`)
 * are not diagram notations and never reach this function. Embedded diagram source is
 * inert data — parsed for colour only, never executed (Constitution VI/IX).
 */
export function resolveDiagramBodyParser(
  notation: DiagramNotation,
  body: string,
  loadedLanguageParser: (name: string) => Parser | null,
): Parser | null {
  switch (notation) {
    case 'graphviz': {
      return dotLanguage.parser;
    }
    case 'mermaid': {
      return mermaidParserForSource(body);
    }
    case 'vega':
    case 'vegalite': {
      return loadedLanguageParser(diagramBodyLanguageName(notation)!);
    }
  }
}
