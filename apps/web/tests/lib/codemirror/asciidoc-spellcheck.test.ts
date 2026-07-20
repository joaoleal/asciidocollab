/* @jest-environment jsdom */

import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LRLanguage, LanguageSupport, ensureSyntaxTree } from '@codemirror/language';
import type { Diagnostic } from '@codemirror/lint';
import {
  tokenizeWords,
  selectMisspelled,
  SPELLCHECK_SKIP_NODES,
  headerMetadataRanges,
} from '@/lib/codemirror/asciidoc-spellcheck';
import { createTestBlockTokenizer } from '../../helpers/asciidoc-test-tokenizer';

// Build the parser from the grammar source (as the fold tests do) rather than
// importing the production language module: the generated `asciidoc-parser.js`
// is ESM that the node-project Jest transform does not compile.
const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');
const lezerParser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
});
const langExtension = new LanguageSupport(LRLanguage.define({ name: 'asciidoc', parser: lezerParser }));

// A tiny Hunspell dictionary: enough for nspell to build and to know a few words.
// Hunspell `.dic` starts with a word count, then one stem per line.
const FAKE_AFF = String.raw`SET UTF-8
TRY esianrtolcdugmphbyfvkwz
`;
const FAKE_DIC = ['6', 'hello', 'world', 'code', 'title', 'good', 'once'].join('\n') + '\n';

/** Response stand-in for a successful same-origin dictionary fetch. */
function okResponse(body: string): Partial<Response> {
  return { ok: true, text: async () => body };
}

/**
 * Run a callback against a freshly-imported copy of the spellcheck module so the
 * module-level `checkerPromise` cache starts empty (otherwise a null/loaded
 * result from one test would leak into the next).
 */
async function withFreshModule(
  run: (module_: typeof import('@/lib/codemirror/asciidoc-spellcheck')) => Promise<void>,
): Promise<void> {
  let imported: typeof import('@/lib/codemirror/asciidoc-spellcheck') | undefined;
  await jest.isolateModulesAsync(async () => {
    imported = await import('@/lib/codemirror/asciidoc-spellcheck');
  });
  if (!imported) throw new Error('module import failed');
  await run(imported);
}

/** A live view with the AsciiDoc language so `syntaxTree` yields real skip nodes. */
function makeView(documentText: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc: documentText, extensions: [langExtension] }),
  });
  // Force a full parse so the tree-walk sees real block nodes (e.g. ListingBlock).
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('tokenizeWords', () => {
  test('splits prose into word tokens with absolute offsets', () => {
    const tokens = tokenizeWords('hello world', 10);
    expect(tokens.map((t) => t.word)).toEqual(['hello', 'world']);
    expect(tokens[0]).toMatchObject({ from: 10, to: 15 });
    expect(tokens[1]).toMatchObject({ from: 16, to: 21 });
  });
  test('keeps internal apostrophes, ignores digits/punctuation', () => {
    expect(tokenizeWords("don't 42 ok!").map((t) => t.word)).toEqual(["don't", 'ok']);
  });
});

describe('headerMetadataRanges', () => {
  test('marks the author and revision lines under a document title', () => {
    const text = '= Title\nThe Brand Team <a@b.co>\nv1.0, 2026-07-18\n\nBody.\n';
    const ranges = headerMetadataRanges(text);
    expect(ranges.map(([from, to]) => text.slice(from, to))).toEqual([
      'The Brand Team <a@b.co>',
      'v1.0, 2026-07-18',
    ]);
  });
  test('returns nothing when there is no document title', () => {
    expect(headerMetadataRanges('Just a paragraph.\nSecond line.\n')).toEqual([]);
    expect(headerMetadataRanges('== Section heading\nText.\n')).toEqual([]);
  });
  test('stops at a blank line, attribute entry, or comment', () => {
    expect(headerMetadataRanges('= Title\n\nBody.\n')).toEqual([]);
    expect(headerMetadataRanges('= Title\n:toc:\nBody.\n')).toEqual([]);
    expect(headerMetadataRanges('= Title\n// note\nBody.\n')).toEqual([]);
  });
});

const isCorrect = (word: string) => ['hello', 'world'].includes(word.toLowerCase());

describe('selectMisspelled', () => {
  test('flags words rejected by the checker', () => {
    const tokens = tokenizeWords('hello wrld');
    expect(selectMisspelled(tokens, isCorrect, []).map((t) => t.word)).toEqual(['wrld']);
  });
  test('respects the per-user ignore list (case-insensitive)', () => {
    const tokens = tokenizeWords('hello Wrld');
    expect(selectMisspelled(tokens, isCorrect, ['wrld'])).toHaveLength(0);
  });
  test('skips single-letter words', () => {
    const tokens = tokenizeWords('a b hello');
    expect(selectMisspelled(tokens, isCorrect, [])).toHaveLength(0);
  });
});

describe('SPELLCHECK_SKIP_NODES', () => {
  test('skips verbatim, macro, and attribute nodes (not prose)', () => {
    expect(SPELLCHECK_SKIP_NODES.has('ListingBlock')).toBe(true);
    expect(SPELLCHECK_SKIP_NODES.has('Monospace')).toBe(true);
    expect(SPELLCHECK_SKIP_NODES.has('InlineMacro')).toBe(true);
    expect(SPELLCHECK_SKIP_NODES.has('AttributeEntry')).toBe(true);
    // New non-prose inline nodes — URLs, macros, math, anchors, callouts,
    // entities, and passthroughs must not be spell-checked as prose.
    for (const node of ['Link', 'InlineStem', 'UiMacro', 'Callout', 'Entity', 'Passthrough', 'InlineAnchor', 'BiblioAnchor', 'InlineSet']) {
      expect(SPELLCHECK_SKIP_NODES.has(node)).toBe(true);
    }
    // RoleSpan is NOT a full skip node — only its `[.role]` name is markup; the body is prose.
    expect(SPELLCHECK_SKIP_NODES.has('RoleSpan')).toBe(false);
    // Prose-bearing nodes are NOT skipped.
    expect(SPELLCHECK_SKIP_NODES.has('Paragraph')).toBe(false);
    expect(SPELLCHECK_SKIP_NODES.has('Heading1')).toBe(false);
    expect(SPELLCHECK_SKIP_NODES.has('SmartQuote')).toBe(false); // contains prose
  });

  test('a bare URL (Link) is not flagged as misspelled prose', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC)) as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      const view = makeView('Visit https://exampledomain.test now\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'en', true)(view);
      const words = diagnostics.map((diagnostic: Diagnostic) => view.state.sliceDoc(diagnostic.from, diagnostic.to));
      expect(words).not.toContain('exampledomain');
      view.destroy();
    });
  });

  test('the author byline (name/brand/email) is not spell-checked', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC)) as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      const view = makeView('= Guided Tour\nThe Zyxwv Team <hello@zyxwv.test>\nv1.0, 2026-07-18\n\nOrdinary prose.\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'en', true)(view);
      const words = diagnostics.map((diagnostic: Diagnostic) => view.state.sliceDoc(diagnostic.from, diagnostic.to));
      expect(words).not.toContain('Zyxwv');
      expect(words).not.toContain('zyxwv');
      view.destroy();
    });
  });

  test('an attribute reference {name} is not flagged as misspelled prose', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC)) as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      const view = makeView('Welcome to {product-brandx} today.\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'en', true)(view);
      const words = diagnostics.map((diagnostic: Diagnostic) => view.state.sliceDoc(diagnostic.from, diagnostic.to));
      expect(words).not.toContain('brandx');
      view.destroy();
    });
  });

  test('role spans and the word fragments they split are not flagged', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC)) as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      // Renders as "Once upon an infinite loop." — `##O##nce` splits "Once"; the role names
      // (underline/big) are markup, and the `nce` fragment is glued to the span.
      const view = makeView('[.underline]##O##nce [.big]##upon## an infinite loop.\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'en', true)(view);
      const words = diagnostics.map((diagnostic: Diagnostic) => view.state.sliceDoc(diagnostic.from, diagnostic.to));
      expect(words).not.toContain('nce');       // fragment glued to the span
      expect(words).not.toContain('underline'); // role name (markup)
      expect(words).not.toContain('big');       // role name (markup)
      view.destroy();
    });
  });

  test('an unconstrained span splitting a VALID word (`[.underline]##O##nce` → "Once") is not flagged', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC)) as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      const view = makeView('[.underline]##O##nce\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'en', true)(view);
      expect(diagnostics).toHaveLength(0); // reconstructs to "Once", which is in the dictionary
      view.destroy();
    });
  });

  test('an unconstrained span splitting a MISSPELLED word (`[.underline]##O##nceasa` → "Onceasa") is flagged', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC)) as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      const view = makeView('[.underline]##O##nceasa\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'en', true)(view);
      expect(diagnostics.length).toBeGreaterThan(0); // reconstructs to "Onceasa", not a word
      // The diagnostic underlines the visible (mis)spelled word, including the dropped `##` delimiters.
      expect(diagnostics.some((d) => view.state.sliceDoc(d.from, d.to).includes('nceasa'))).toBe(true);
      view.destroy();
    });
  });

  test('a misspelled word inside a role-span BODY is still flagged (only the role name is markup)', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC)) as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      // The role name `[.lead]` is markup, but the span body `Wrold` is ordinary prose and must be
      // checked — otherwise spell-check is silently disabled for every `[.role]#…#` body.
      const view = makeView('[.lead]#Wrold#\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'en', true)(view);
      const words = diagnostics.map((diagnostic: Diagnostic) => view.state.sliceDoc(diagnostic.from, diagnostic.to));
      expect(words).toContain('Wrold');    // body prose IS checked
      expect(words).not.toContain('lead'); // role name is markup
      view.destroy();
    });
  });

  test('a misspelled word glued to a non-span skip node (Entity) is still flagged', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC)) as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      // The glued-fragment rule is for word-splitting role spans only; a standalone word glued to an
      // entity/link/macro is real prose, not a markup fragment, so it must still be checked.
      const view = makeView('Tom &amp;wrold here\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'en', true)(view);
      const words = diagnostics.map((diagnostic: Diagnostic) => view.state.sliceDoc(diagnostic.from, diagnostic.to));
      expect(words).toContain('wrold');
      view.destroy();
    });
  });

  test('the name/value in `{set:name:value}` (InlineSet) are not flagged as misspelled', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC)) as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      const view = makeView('Prose with {set:myyvarvar:myvalue} inside.\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'en', true)(view);
      const words = diagnostics.map((diagnostic: Diagnostic) => view.state.sliceDoc(diagnostic.from, diagnostic.to));
      expect(words).not.toContain('myyvarvar');
      expect(words).not.toContain('myvalue');
      view.destroy();
    });
  });
});

describe('loadSpellChecker', () => {
  test('builds an nspell checker from the self-hosted aff/dic files', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await withFreshModule(async ({ loadSpellChecker }) => {
      const checker = await loadSpellChecker('en');
      expect(checker).not.toBeNull();
      expect(checker?.correct('hello')).toBe(true);
      expect(checker?.correct('wrld')).toBe(false);
      expect(Array.isArray(checker?.suggest('wrld'))).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledWith('/dictionaries/en.aff');
    expect(fetchMock).toHaveBeenCalledWith('/dictionaries/en.dic');
  });

  test('caps suggestions at five entries', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC)) as unknown as typeof fetch;
    await withFreshModule(async ({ loadSpellChecker }) => {
      const checker = await loadSpellChecker('en');
      expect(checker?.suggest('helo').length).toBeLessThanOrEqual(5);
    });
  });

  test('returns null when a dictionary file is unavailable (non-ok response)', async () => {
    globalThis.fetch = (async () => ({ ok: false, text: async () => '' })) as unknown as typeof fetch;
    await withFreshModule(async ({ loadSpellChecker }) => {
      expect(await loadSpellChecker('en')).toBeNull();
    });
  });

  test('returns null when the fetch itself rejects', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await withFreshModule(async ({ loadSpellChecker }) => {
      expect(await loadSpellChecker('en')).toBeNull();
    });
  });

  test('caches the checker promise across calls (fetches once)', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await withFreshModule(async ({ loadSpellChecker }) => {
      const first = loadSpellChecker('en');
      const second = loadSpellChecker('en');
      expect(first).toBe(second);
      await first;
    });
    // Two files fetched on the first call, none on the cached second call.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('returns null without fetching for a language with no bundled dictionary', async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await withFreshModule(async ({ loadSpellChecker }) => {
      expect(await loadSpellChecker('zh')).toBeNull(); // Mandarin: no Hunspell dictionary
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('asciidocSpellcheckSource', () => {
  test('returns no diagnostics when the dictionary is not loaded', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      const view = makeView('this paragraf has a typ\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'en', true)(view);
      expect(diagnostics).toEqual([]);
      view.destroy();
    });
  });

  test('flags a misspelled prose word as an info diagnostic', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC)) as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      const view = makeView('hello wrld\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'en', true)(view);
      const words = diagnostics.map((diagnostic: Diagnostic) => view.state.sliceDoc(diagnostic.from, diagnostic.to));
      expect(words).toContain('wrld');
      expect(words).not.toContain('hello');
      const flagged = diagnostics.find((diagnostic) => view.state.sliceDoc(diagnostic.from, diagnostic.to) === 'wrld');
      expect(flagged?.severity).toBe('info');
      expect(flagged?.message).toContain('wrld');
      view.destroy();
    });
  });

  test('produces no diagnostics when spellcheck is disabled (enabled=false)', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      const view = makeView('hello wrld\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'en', false)(view);
      expect(diagnostics).toEqual([]);
      view.destroy();
    });
    expect(fetchMock).not.toHaveBeenCalled(); // disabled → no dictionary load
  });

  test('produces no diagnostics for a language without a dictionary', async () => {
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      const view = makeView('hello wrld\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'ja', true)(view);
      expect(diagnostics).toEqual([]);
      view.destroy();
    });
  });

  test('produces no diagnostics for an all-correct document', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC)) as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      const view = makeView('hello world good code\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'en', true)(view);
      expect(diagnostics).toEqual([]);
      view.destroy();
    });
  });

  test('honours the per-user ignore list', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC)) as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      const view = makeView('hello wrld\n');
      const diagnostics = await asciidocSpellcheckSource(() => ['wrld'], 'en', true)(view);
      expect(diagnostics).toEqual([]);
      view.destroy();
    });
  });

  test('skips misspellings inside non-prose nodes (verbatim listing block)', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      okResponse(String(input).endsWith('.aff') ? FAKE_AFF : FAKE_DIC)) as unknown as typeof fetch;
    await withFreshModule(async ({ asciidocSpellcheckSource }) => {
      // The misspelled token "wrldd" lives inside a listing block, so the
      // skip-node range must suppress its diagnostic (the `continue` branch).
      const view = makeView('----\nwrldd\n----\n');
      const diagnostics = await asciidocSpellcheckSource(() => [], 'en', true)(view);
      const words = diagnostics.map((diagnostic) => view.state.sliceDoc(diagnostic.from, diagnostic.to));
      expect(words).not.toContain('wrldd');
      view.destroy();
    });
  });
});
