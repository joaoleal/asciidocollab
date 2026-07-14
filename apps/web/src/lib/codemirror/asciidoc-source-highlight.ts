import { parseMixed, type Input, type NestedParse, type Parser, type SyntaxNodeRef } from '@lezer/common';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import {
  canonicalSourceLanguageName,
  resolveSourceLanguage,
  diagramBodyLanguageName,
  resolveDiagramBodyParser,
} from './source-languages';
import { normalizeDiagramNotation, type DiagramNotation } from './diagram-notations';

/**
 * In-editor source-language highlighting. The body of a
 * `[source,<lang>]` listing block is parsed by the embedded language's parser
 * via `parseMixed`; unknown/absent languages get no injection (plain text) and
 * AsciiDoc highlighting resumes after the block. Embedded code is inert data —
 * never executed (Constitution VI/IX).
 *
 * Languages load lazily from the curated allow-list. The wrap reads a synchronous
 * loaded-parser cache; the loader plugin populates it and reconfigures the
 * language compartment so the block re-parses once its language is available.
 */

/** Canonical language name → loaded embedded parser. */
const loadedParsers = new Map<string, Parser>();
const loadingLanguages = new Set<string>();

// Matches both the explicit `[source,<lang>]` and the `[,<lang>]` shorthand (an empty block style
// defaults to `source`), so e.g. `[,ruby]` highlights the same as `[source,ruby]`. The style slot
// accepts only an empty value or `source` — `[quote,…]` and other styles never inject a language.
const SOURCE_DECL_RE = /^\s*\[(?:source)?\s*,\s*([\w+#.-]+)/i;

/** Extract and resolve the language of a `[source,<lang>]` (or `[,<lang>]`) declaration line, or null. */
export function extractSourceLanguage(line: string): string | null {
  const match = SOURCE_DECL_RE.exec(line);
  return match ? canonicalSourceLanguageName(match[1]) : null;
}

/** Distinct resolved source languages declared anywhere in the document. */
export function collectSourceLanguages(documentText: string): string[] {
  const languages = new Set<string>();
  for (const line of documentText.split('\n')) {
    const language = extractSourceLanguage(line);
    if (language) languages.add(language);
  }
  return [...languages];
}

// A diagram block declaration is a lone bracketed notation — `[mermaid]`, `[graphviz]`,
// `[vega]`, `[vegalite]` (`vega-lite` folded) — optionally carrying further attributes
// (`[mermaid, format=svg]`). Mirrors the block tokenizer: the notation is the first
// attribute, ended by `]`, `,`, or whitespace; a `[[anchor]]` never matches.
const DIAGRAM_DECL_RE = /^\s*\[([A-Za-z][\w-]*)(?:[\s,\]])/;

/** Resolve the diagram notation declared by a line, or null when it is not one. */
export function extractDiagramNotation(line: string): DiagramNotation | null {
  const match = DIAGRAM_DECL_RE.exec(line);
  return match ? normalizeDiagramNotation(match[1]) : null;
}

/**
 * Distinct general-purpose languages (currently only JSON, for vega/vegalite) whose
 * parsers the diagram blocks in the document need, so the lazy loader can preload them.
 */
export function collectDiagramBodyLanguages(documentText: string): string[] {
  const languages = new Set<string>();
  for (const line of documentText.split('\n')) {
    const notation = extractDiagramNotation(line);
    if (!notation) continue;
    const language = diagramBodyLanguageName(notation);
    if (language) languages.add(language);
  }
  return [...languages];
}

/** Find the resolved language for a listing block by scanning back to its `[source,..]` decl. */
function languageForBlock(input: Input, blockFrom: number): string | null {
  const windowStart = Math.max(0, blockFrom - 400);
  const preceding = input.read(windowStart, blockFrom).split('\n');
  for (let index = preceding.length - 1; index >= 0; index--) {
    const trimmed = preceding[index].trim();
    if (trimmed === '') continue;
    const language = extractSourceLanguage(preceding[index]);
    if (language) return language;
    // Only a block title (`.Foo`) or another attribute line (`[..]`) may sit between
    // the source declaration and the delimiter; anything else ends the search.
    if (!trimmed.startsWith('.') && !trimmed.startsWith('[')) return null;
  }
  return null;
}

/** Find the diagram notation for a block by scanning back to its `[notation]` decl. */
function diagramNotationForBlock(input: Input, blockFrom: number): DiagramNotation | null {
  const windowStart = Math.max(0, blockFrom - 400);
  const preceding = input.read(windowStart, blockFrom).split('\n');
  for (let index = preceding.length - 1; index >= 0; index--) {
    const trimmed = preceding[index].trim();
    if (trimmed === '') continue;
    const notation = extractDiagramNotation(preceding[index]);
    if (notation) return notation;
    // Only a block title (`.Foo`) or another attribute line (`[..]`) may sit between the
    // declaration and the delimiter; anything else ends the search.
    if (!trimmed.startsWith('.') && !trimmed.startsWith('[')) return null;
  }
  return null;
}

/**
 * Compute the body span of a delimited block (the range strictly between the
 * opening and closing delimiter lines), or null when there is no body.
 *
 * The AsciiDoc grammar's block delimiters and body are anonymous (lowercase)
 * tokens, so the block node has NO child nodes to read — `firstChild`/`lastChild`
 * are both null. The span is therefore derived from the block text: the body
 * starts after the first line (the opening delimiter) and ends at the start of
 * the last line (the closing delimiter).
 */
function blockBodySpan(input: Input, blockFrom: number, blockTo: number): { from: number; to: number } | null {
  const text = input.read(blockFrom, blockTo);
  const openEnd = text.indexOf('\n');
  if (openEnd === -1) return null;
  const from = blockFrom + openEnd + 1;
  // The closing delimiter is the block's last line; ignore a trailing newline first.
  const end = text.endsWith('\n') ? text.length - 1 : text.length;
  const closeLineStart = text.lastIndexOf('\n', end - 1);
  if (closeLineStart === -1) return null;
  const to = blockFrom + closeLineStart + 1;
  return from < to ? { from, to } : null;
}

/** Mixed-language wrap that injects the embedded language parser into source-block bodies. */
export const sourceMixedWrap = parseMixed((node: SyntaxNodeRef, input: Input): NestedParse | null => {
  if (node.name !== 'ListingBlock' && node.name !== 'LiteralBlock') return null;
  const span = blockBodySpan(input, node.from, node.to);
  if (!span) return null;

  // A recognised diagram declaration (`[mermaid]`/`[graphviz]`/`[vega]`/`[vegalite]`) routes
  // the body to a notation-specific parser. Math blocks (`[stem]`/`[latexmath]`/`[asciimath]`)
  // are not diagram notations, so they never match and are left untouched; a plain
  // `[source,<lang>]` listing falls through to the language path below.
  const notation = diagramNotationForBlock(input, node.from);
  if (notation) {
    const parser = resolveDiagramBodyParser(
      notation,
      input.read(span.from, span.to),
      (name) => loadedParsers.get(name) ?? null,
    );
    return parser ? { parser, overlay: [span] } : null;
  }

  const language = languageForBlock(input, node.from);
  if (!language) return null;
  const parser = loadedParsers.get(language);
  if (!parser) return null;
  return { parser, overlay: [span] };
});

/**
 * Loader extension: lazily loads the languages declared in the document and, once
 * a new one is ready, calls `reparse(view)` so the block re-highlights. `reparse`
 * is supplied by the mount (it reconfigures the language compartment).
 */
export function asciidocSourceHighlight(reparse: (view: EditorView) => void): Extension {
  return ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        this.ensureLoaded(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged) this.ensureLoaded(update.view);
      }

      ensureLoaded(view: EditorView) {
        const documentText = view.state.doc.toString();
        const embedded = new Set([
          ...collectSourceLanguages(documentText),
          ...collectDiagramBodyLanguages(documentText),
        ]);
        for (const language of embedded) {
          if (loadedParsers.has(language) || loadingLanguages.has(language)) continue;
          const description = resolveSourceLanguage(language);
          if (!description) continue;
          loadingLanguages.add(language);
          description
            .load()
            .then((support) => {
              loadedParsers.set(language, support.language.parser);
              loadingLanguages.delete(language);
              // The async import may resolve after the user switched files (remount)
              // or closed the editor; dispatching to a destroyed view throws. The
              // parser is cached module-wide, so a live view re-highlights on its own.
              if (view.dom.isConnected) reparse(view);
            })
            .catch(() => loadingLanguages.delete(language));
        }
      }
    },
  );
}
