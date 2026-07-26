import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import type { Diagnostic } from '@codemirror/lint';
import { hasDictionary } from './spellcheck-languages';
import { extractProseSegments, spanToDocumentRange } from './prose-segments';

/**
 * Prose spell-check. Tree-aware: verbatim blocks, macros,
 * attribute names, URLs and other non-prose nodes are skipped so only prose is
 * checked. Words on a per-user ignore list are never flagged. The dictionary
 * (`nspell` + `dictionary-en`) loads lazily off the typing path.
 *
 * The "what is prose" model (segmentation, skip-node classification, offset map) now lives in the
 * shared `prose-segments.ts` module reused by the Harper grammar linter; this file consumes it and
 * keeps only the nspell-specific word tokenisation + dictionary wiring. When Harper is active it owns
 * prose checking and this source is disabled; it is the Harper-off / engine-unavailable fallback.
 *
 * The tokenisation, skip-node predicate, and ignore filtering are pure and
 * unit-tested; the live `nspell` dictionary + lint wiring is exercised by e2e.
 */

// Re-exported from the shared prose model so existing importers of these symbols keep working.
export { SPELLCHECK_SKIP_NODES, headerMetadataRanges } from './prose-segments';

const WORD_RE = /[A-Za-z][A-Za-z']*/g;

/** A prose word with its document offsets. */
export interface WordToken {
  /** The word text. */
  word: string;
  /** Document offset of the word start. */
  from: number;
  /** Document offset just past the word. */
  to: number;
}

/** Tokenise prose text into word tokens with absolute offsets (`base` = text start offset). */
export function tokenizeWords(text: string, base = 0): WordToken[] {
  const tokens: WordToken[] = [];
  for (const match of text.matchAll(WORD_RE)) {
    const index = match.index ?? 0;
    tokens.push({ word: match[0], from: base + index, to: base + index + match[0].length });
  }
  return tokens;
}

/**
 * Select the misspelled tokens: not accepted by `isCorrect` and not in the
 * (case-insensitive) ignore set. Single-letter words are skipped.
 */
export function selectMisspelled(
  tokens: WordToken[],
  isCorrect: (word: string) => boolean,
  ignore: Iterable<string>,
): WordToken[] {
  const ignored = new Set([...ignore].map((word) => word.toLowerCase()));
  return tokens.filter(
    (token) => token.word.length > 1 && !ignored.has(token.word.toLowerCase()) && !isCorrect(token.word),
  );
}

/** A loaded spell checker: a synchronous correctness test plus a suggestion helper. */
export interface SpellChecker {
  /**
   * Whether a word is spelled correctly.
   *
   * @param word - The word to check.
   * @returns True when the word is in the dictionary.
   */
  correct: (word: string) => boolean;
  /**
   * Suggested corrections for a word.
   *
   * @param word - The (possibly misspelled) word.
   * @returns Up to a few suggested corrections.
   */
  suggest: (word: string) => string[];
}

// One cached load per language so switching languages never re-fetches a dictionary already loaded.
const checkerPromises = new Map<string, Promise<SpellChecker | null>>();

/**
 * Lazily load `language`'s Hunspell dictionary into an nspell checker (best-effort, cached per
 * language). The `aff`/`dic` files are self-hosted under `/dictionaries/<lang>.{aff,dic}` (copied
 * from the `dictionary-<lang>` packages at build time) and fetched same-origin — those packages
 * are Node modules and are never bundled for the browser. Returns null for a language with no
 * bundled dictionary, or on any failure, so spell-check simply does nothing.
 */
export function loadSpellChecker(language: string): Promise<SpellChecker | null> {
  if (!hasDictionary(language)) return Promise.resolve(null);
  const cached = checkerPromises.get(language);
  if (cached) return cached;
  const promise = (async () => {
    try {
      const [{ default: nspell }, aff, dic] = await Promise.all([
        import('nspell'),
        fetch(`/dictionaries/${language}.aff`).then((response) => (response.ok ? response.text() : Promise.reject(new Error('aff')))),
        fetch(`/dictionaries/${language}.dic`).then((response) => (response.ok ? response.text() : Promise.reject(new Error('dic')))),
      ]);
      const speller = nspell(aff, dic);
      return {
        correct: (word: string) => speller.correct(word),
        suggest: (word: string) => speller.suggest(word).slice(0, 5),
      };
    } catch {
      return null;
    }
  })();
  checkerPromises.set(language, promise);
  return promise;
}

/**
 * Async `@codemirror/lint` source flagging misspelled prose words as info diagnostics, with
 * "Add to dictionary" handled by the host via `getIgnore`. Spell-checks against `language`'s
 * dictionary; produces no diagnostics when `enabled` is false or `language` has no bundled
 * dictionary (so a language change / disable is applied by reconfiguring this source).
 */
export function asciidocSpellcheckSource(
  getIgnore: () => Iterable<string>,
  language: string,
  enabled: boolean,
) {
  return async (view: EditorView): Promise<Diagnostic[]> => {
    if (!enabled) return [];
    const checker = await loadSpellChecker(language);
    if (!checker) return [];
    const tree = syntaxTree(view.state);
    const diagnostics: Diagnostic[] = [];
    const text = view.state.doc.toString();

    // The shared prose model does all the exclusion work: verbatim blocks/links/entities/macros are
    // removed, a role-span body rejoins the prose glued around it (`[.underline]##O##nce` → `Once`), and
    // the header byline is dropped. Each returned segment's `map` translates a word's segment-local
    // offsets back to document offsets (a word reconstructed across dropped markup spans those
    // delimiters, so the underline includes them).
    const ignore = getIgnore();
    for (const segment of extractProseSegments(tree, text)) {
      for (const token of selectMisspelled(tokenizeWords(segment.text), checker.correct, ignore)) {
        const { from, to } = spanToDocumentRange(segment, token.from, token.to);
        diagnostics.push({
          from,
          to,
          severity: 'info',
          message: `“${token.word}” may be misspelled`,
        });
      }
    }
    return diagnostics;
  };
}
