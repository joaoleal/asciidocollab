import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import type { Diagnostic } from '@codemirror/lint';
import { hasDictionary } from './spellcheck-languages';

/**
 * Prose spell-check. Tree-aware: verbatim blocks, macros,
 * attribute names, URLs and other non-prose nodes are skipped so only prose is
 * checked. Words on a per-user ignore list are never flagged. The dictionary
 * (`nspell` + `dictionary-en`) loads lazily off the typing path.
 *
 * The tokenisation, skip-node predicate, and ignore filtering are pure and
 * unit-tested; the live `nspell` dictionary + lint wiring is exercised by e2e.
 */

/** Grammar node names whose text is NOT prose and must not be spell-checked. */
export const SPELLCHECK_SKIP_NODES = new Set([
  'ListingBlock', 'LiteralBlock', 'PassthroughBlock', 'CommentBlock', 'CommentLine',
  'StemBlock', 'Monospace', 'AttributeEntry', 'AttributeReference', 'BlockMacro',
  'InlineMacro', 'CrossReference', 'Footnote', 'Conditional', 'BlockAttributeLine',
  'DocumentTitle',
  // Inline non-prose constructs: URLs, UI/math macros, inline passthrough,
  // anchors, callouts, and entities are verbatim/identifier content, not prose.
  'Link', 'InlineStem', 'UiMacro', 'Passthrough', 'InlineAnchor', 'BiblioAnchor',
  'Callout', 'Entity',
  // `{set:name:value}` — the attribute name and value are identifiers, not prose.
  'InlineSet',
]);

// `[.role]##body##` is a single token, but only the role NAME is markup — the body is ordinary prose
// and must stay spell-checked. RoleSpan is handled out-of-band (skip the `[.role]` prefix only) rather
// than added to SPELLCHECK_SKIP_NODES, which would suppress the body too.
const ROLE_SPAN_NODE = 'RoleSpan';

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

/**
 * Byte ranges of the document-header author and revision lines, which AsciiDoc
 * treats as metadata (names, emails, brand words, version + date), not prose.
 *
 * These lines are only present when the document opens with a level-0 title: the
 * author line immediately follows it and the optional revision line follows that,
 * with the header ending at the first blank line, attribute entry (`:`), or
 * comment (`//`). The block tokenizer never emits the grammar's stub
 * `AuthorLine`/`RevisionLine` nodes (they need header context it cannot enforce),
 * so the spell-checker excludes these lines by position instead of by node name.
 *
 * @param text - The full document text.
 * @returns Up to two `[from, to)` ranges (author, then revision), or none.
 */
export function headerMetadataRanges(text: string): Array<[number, number]> {
  // A document header exists only when the first line is a level-0 title (`= `);
  // `==`+ are section headings, not a title, so require exactly one `=`.
  if (!/^=[ \t]/.test(text)) return [];
  const ranges: Array<[number, number]> = [];
  const firstBreak = text.indexOf('\n');
  if (firstBreak === -1) return [];
  let start = firstBreak + 1; // first char of the line after the title
  for (let line = 0; line < 2; line++) {
    const nextBreak = text.indexOf('\n', start);
    const end = nextBreak === -1 ? text.length : nextBreak;
    const content = text.slice(start, end);
    // The header ends at a blank line; an attribute entry or comment is not an
    // author/revision line (attributes are already skipped as their own nodes).
    if (content.trim() === '' || content.startsWith(':') || content.startsWith('//')) break;
    ranges.push([start, end]);
    if (nextBreak === -1) break;
    start = nextBreak + 1;
  }
  return ranges;
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

    // Classify every document char so a role-span body is checked as the word it renders to. Role-span
    // MARKUP (`[.role]` and the `#`/`##` delimiters) is DROPped so the styled body rejoins the prose
    // glued around it into one word — `[.underline]##O##nce` → `Once` (a valid word, not flagged), while
    // `[.underline]##O##nceasa` → `Onceasa` (flagged). Every other non-prose node (verbatim blocks,
    // links, entities, macros, `{set:…}`) becomes a BOUNDARY so its text is never checked AND a word
    // glued to it stays a separate, checkable word (`&amp;wrold` still checks `wrold`).
    // NOTE: only RoleSpan is reconstructed here. Unconstrained bold/italic (`a**b**c`, `un__der__score`)
    // split a word across markup the same way but are not skip nodes, so their `*`/`_` marks are treated
    // as ordinary punctuation by WORD_RE (each fragment checked separately) — a known, separate gap; the
    // general fix is one "rendered inline text" model that drops every inline-formatting delimiter.
    const KEEP = 0, DROP = 1, BOUNDARY = 2;
    const cls = new Uint8Array(text.length);
    tree.cursor().iterate((node) => {
      if (node.name === ROLE_SPAN_NODE) {
        const spanText = text.slice(node.from, node.to);
        const bracketEnd = spanText.indexOf(']'); // end of the `[.role]` name
        let delimiter = bracketEnd + 1, hashes = 0;
        while (bracketEnd !== -1 && spanText[delimiter] === '#') { hashes++; delimiter++; }
        if (bracketEnd === -1 || hashes === 0) {
          // Malformed span — treat it all as a boundary rather than leaking markup as prose.
          for (let index = node.from; index < node.to; index++) cls[index] = BOUNDARY;
          return;
        }
        const bodyFrom = node.from + delimiter;            // first body char (after `[.role]##`)
        const bodyTo = node.from + spanText.length - hashes; // first trailing `#`
        for (let index = node.from; index < bodyFrom; index++) cls[index] = DROP; // `[.role]##` prefix
        for (let index = bodyTo; index < node.to; index++) cls[index] = DROP;     // `##` suffix
        return; // body chars stay KEEP so they join the surrounding prose
      }
      if (SPELLCHECK_SKIP_NODES.has(node.name)) {
        for (let index = node.from; index < node.to; index++) cls[index] = BOUNDARY;
      }
    });

    // The author/revision byline is parsed as an ordinary paragraph (the grammar's
    // AuthorLine/RevisionLine tokens are never emitted), so exclude those header
    // lines by position — a name or brand word there is metadata, not misspelled prose.
    for (const [from, to] of headerMetadataRanges(text)) {
      for (let index = from; index < to; index++) cls[index] = BOUNDARY;
    }

    // Materialise the visible text and a per-char map back to document offsets (boundary runs collapse
    // to a single space — it is only ever a word separator, never part of a flagged word).
    const parts: string[] = [];
    const offsetMap: number[] = [];
    for (let index = 0; index < text.length; ) {
      const kind = cls[index];
      if (kind === KEEP) { parts.push(text[index]); offsetMap.push(index); index++; }
      else if (kind === DROP) { index++; }
      else { parts.push(' '); offsetMap.push(index); index++; while (index < text.length && cls[index] === BOUNDARY) index++; }
    }
    const visible = parts.join('');

    // Each token's offsets index `visible`; map its start/end back to the document for the diagnostic
    // (a word reconstructed across markup spans the dropped delimiters, so the underline includes them).
    for (const token of selectMisspelled(tokenizeWords(visible), checker.correct, getIgnore())) {
      diagnostics.push({
        from: offsetMap[token.from],
        to: offsetMap[token.to - 1] + 1,
        severity: 'info',
        message: `“${token.word}” may be misspelled`,
      });
    }
    return diagnostics;
  };
}
