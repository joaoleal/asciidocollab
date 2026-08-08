/* @jest-environment jsdom */

/**
 * Unit tests for in-editor source-language highlighting.
 *
 * The jsdom environment (set by the single-star pragma above — `/** *\/` would
 * trip the jsdoc/check-tag-names lint rule, the pattern used by
 * `asciidoc-fold-persist.test.ts`) is required because `asciidocSourceHighlight`
 * is a CodeMirror `ViewPlugin`: exercising its lazy loader + reparse needs a real
 * `EditorView`, and that needs a DOM.
 *
 * `sourceMixedWrap` is a `parseMixed` wrap whose injection only happens while a
 * parser walks a `[source,<lang>]` block. The production AsciiDoc grammar's block
 * delimiters and body are anonymous (lowercase) tokens, so a `ListingBlock` node
 * has NO child nodes — the wrap therefore derives the body span from the block
 * text, not from `firstChild`/`lastChild`. Most cases below drive the wrap with a
 * tiny purpose-built grammar (fast, and lets us model delimiter edge-cases); the
 * `sourceMixedWrap over the real AsciiDoc grammar` suite additionally runs the
 * actual generated parser (`asciidoc-parser.js`, loadable here via ts-jest's
 * `allowJs`) so the real anonymous-delimiter shape is covered. A tiny embedded
 * "language" parser stands in for a real language pack; the wrap injects it as a
 * mounted overlay tree, which `resolveInner` reveals.
 *
 * The lazy loader is mocked at the `source-languages` boundary so the embedded
 * parser resolves synchronously, without a real `@codemirror/language-data` pack.
 * The mock keeps real `canonicalSourceLanguageName` (used by
 * `extractSourceLanguage`) and only swaps `resolveSourceLanguage`, the seam the
 * loader calls. The loader fills a module-wide parser cache the wrap reads, so the
 * two are driven together: the plugin loads a language, then the wrap injects it.
 */
import { buildParser } from '@lezer/generator';
import { type Parser, type Tree } from '@lezer/common';
import type { LRParser } from '@lezer/lr';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

jest.mock('@/lib/codemirror/source-languages', () => {
  const actual = jest.requireActual('@/lib/codemirror/source-languages');
  return { __esModule: true, ...actual, resolveSourceLanguage: jest.fn() };
});

import {
  extractSourceLanguage,
  collectSourceLanguages,
  sourceMixedWrap,
  asciidocSourceHighlight,
} from '@/lib/codemirror/asciidoc-source-highlight';
import { asciidocLanguage } from '@/lib/codemirror/asciidoc-language';
import { resolveSourceLanguage } from '@/lib/codemirror/source-languages';

// The mocked seam, typed as a jest mock for `mockReturnValue`/`mockReset`.
const resolveSourceLanguageMock = resolveSourceLanguage as unknown as jest.Mock;

// Outer grammar standing in for AsciiDoc: a `[source,<lang>]` decl line, then a
// listing block (`<<<` … `>>>`) or literal block (`{{{` … `}}}`) whose delimiters
// are NAMED nodes so `firstChild`/`lastChild` resolve, as `sourceMixedWrap` needs.
const OUTER_GRAMMAR = String.raw`
@top Document { item* }
item { SourceDecl | ListingBlock | LiteralBlock }
SourceDecl { Decl }
ListingBlock { Open Body? Close }
LiteralBlock { LOpen Body? LClose }
@tokens {
  Decl { "[" ![\n]* "\n" }
  Open { "<<<\n" }
  Close { ">>>\n" }
  LOpen { "{{{\n" }
  LClose { "}}}\n" }
  Body { (![\[<>{}] ![\n]* "\n")+ }
  @precedence { Open, Close, LOpen, LClose, Decl, Body }
}
`;

// Embedded "language" parser: tags every body line as a `Code` node under
// `Program`. Its presence in the injected (mounted) overlay tree proves injection.
const EMBEDDED_GRAMMAR = String.raw`@top Program { Code* } @tokens { Code { ![\n]+ "\n"? } }`;

// A degenerate variant: a `ListingBlock` is a SINGLE `Open` delimiter, so
// `firstChild === lastChild`. It models the malformed-tree guard in the wrap
// (`open === close`) that valid two-delimiter blocks never reach.
const SINGLE_DELIM_GRAMMAR = String.raw`
@top Document { item* }
item { SourceDecl | ListingBlock }
SourceDecl { Decl }
ListingBlock { Open }
@tokens {
  Decl { "[" ![\n]* "\n" }
  Open { "<<<\n" }
  @precedence { Open, Decl }
}
`;

// A `ListingBlock` whose delimiter is an ANONYMOUS token, so it has no child
// nodes at all (`firstChild === null`). Models the wrap's `!open` / `!close` guard.
const CHILDLESS_GRAMMAR = String.raw`
@top Document { item* }
item { SourceDecl | ListingBlock }
SourceDecl { Decl }
ListingBlock { delim }
@tokens {
  Decl { "[" ![\n]* "\n" }
  delim { "<<<\n" }
  @precedence { delim, Decl }
}
`;

const embeddedParser = buildParser(EMBEDDED_GRAMMAR) as unknown as Parser;
const outerParser = (buildParser(OUTER_GRAMMAR) as unknown as LRParser).configure({
  wrap: sourceMixedWrap,
});
const singleDelimParser = (buildParser(SINGLE_DELIM_GRAMMAR) as unknown as LRParser).configure({
  wrap: sourceMixedWrap,
});
const childlessParser = (buildParser(CHILDLESS_GRAMMAR) as unknown as LRParser).configure({
  wrap: sourceMixedWrap,
});

/** A fake `LanguageDescription` whose `load()` resolves to the embedded parser. */
function fakeDescription(parser: Parser): { load: () => Promise<unknown> } {
  return { load: () => Promise.resolve({ language: { parser } }) };
}

/** Mount a live (DOM-connected) view carrying only the source-highlight loader. */
function mountView(documentText: string, reparse: (view: EditorView) => void): EditorView {
  const parent = document.createElement('div');
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({ doc: documentText, extensions: [asciidocSourceHighlight(reparse)] }),
  });
}

/** Flush the loader's promise chain (microtasks) so a resolved `load()` runs `reparse`. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const liveViews: EditorView[] = [];

/** Track a view for teardown and return it. */
function track(view: EditorView): EditorView {
  liveViews.push(view);
  return view;
}

/**
 * Populate the module-wide parser cache for `token`'s canonical language by
 * running the loader plugin over a doc that declares it (mocked `load()` resolves
 * the embedded parser synchronously). Distinct tokens keep tests cache-isolated.
 */
async function loadLanguage(token: string): Promise<void> {
  resolveSourceLanguageMock.mockReturnValue(fakeDescription(embeddedParser));
  track(mountView(`[source,${token}]\n<<<\nx\n>>>\n`, () => {}));
  await flush();
}

/** Parse `documentText` with the wrap-configured outer parser. */
function parseOuter(documentText: string): Tree {
  return outerParser.parse(documentText);
}

/** Name of the most-specific node at `offset` — reveals mounted overlay trees too. */
function innermostNameAt(tree: Tree, offset: number): string {
  return tree.resolveInner(offset, 1).name;
}

beforeEach(() => {
  resolveSourceLanguageMock.mockReset();
});

afterEach(() => {
  for (const view of liveViews.splice(0)) view.destroy();
});

describe('extractSourceLanguage', () => {
  test('resolves a known language from a [source,lang] declaration', () => {
    expect(extractSourceLanguage('[source,ruby]')).toBe('Ruby');
    expect(extractSourceLanguage('[source, js]')).toBe('JavaScript');
    expect(extractSourceLanguage('[source,python]')).toBe('Python');
  });

  test('resolves the [,lang] shorthand (empty style ⇒ source)', () => {
    // `[,ruby]` is AsciiDoc shorthand for `[source,ruby]`; it must highlight the same.
    expect(extractSourceLanguage('[,ruby]')).toBe('Ruby');
    expect(extractSourceLanguage('[, js]')).toBe('JavaScript');
    expect(extractSourceLanguage('[,python]')).toBe('Python');
  });

  test('returns null for an unknown language (no injection)', () => {
    expect(extractSourceLanguage('[source,cobol]')).toBeNull();
  });

  test('returns null for a non-source attribute line', () => {
    expect(extractSourceLanguage('[cols="1,1"]')).toBeNull();
    expect(extractSourceLanguage('plain text')).toBeNull();
  });
});

describe('collectSourceLanguages', () => {
  test('returns the distinct resolved languages declared in a document', () => {
    const source = [
      '[source,js]',
      '----',
      'x',
      '----',
      '',
      '[source,python]',
      '----',
      'y',
      '----',
      '',
      '[source,js]', // duplicate
      '----',
      'z',
      '----',
    ].join('\n');
    expect(collectSourceLanguages(source).toSorted()).toEqual(['JavaScript', 'Python']);
  });

  test('ignores unknown languages', () => {
    expect(collectSourceLanguages('[source,brainfuck]\n----\n+\n----\n')).toEqual([]);
  });

  test('returns [] for a document with no source blocks', () => {
    expect(collectSourceLanguages('= Title\n\nplain paragraph\n')).toEqual([]);
  });
});

describe('sourceMixedWrap', () => {
  test('injects the loaded parser over a listing-block body', async () => {
    await loadLanguage('js');
    // body of "[source,js]\n<<<\n…\n>>>\n" lives at 16..(close.from); offset 18 is inside it.
    const tree = parseOuter('[source,js]\n<<<\nconst x = 1;\n>>>\n');
    expect(innermostNameAt(tree, 18)).toBe('Code');
    // …and the outer AsciiDoc highlighting still owns the delimiter (offset 13).
    expect(innermostNameAt(tree, 13)).toBe('Open');
  });

  test('also injects over a literal-block body', async () => {
    await loadLanguage('python');
    const tree = parseOuter('[source,python]\n{{{\nprint(1)\n}}}\n');
    // decl is 16 chars, LOpen 16..20, body starts at 20.
    expect(innermostNameAt(tree, 22)).toBe('Code');
  });

  test('does not inject when the declared language is not yet loaded', () => {
    // Ruby has not been loaded in this run: the wrap reads the cache synchronously
    // and finds nothing, so the body stays under the outer grammar (`Body`).
    const tree = parseOuter('[source,ruby]\n<<<\nx = 1\n>>>\n');
    expect(innermostNameAt(tree, 20)).toBe('Body');
  });

  test('does not inject for a block with no [source,lang] declaration', async () => {
    await loadLanguage('go');
    const tree = parseOuter('<<<\ncode\n>>>\n');
    expect(innermostNameAt(tree, 5)).toBe('Body');
  });

  test('does not inject when the body is empty (delimiters are adjacent)', async () => {
    await loadLanguage('rust');
    // "[source,rust]\n<<<\n>>>\n": Open ends where Close begins, so from >= to.
    const tree = parseOuter('[source,rust]\n<<<\n>>>\n');
    // The body is empty; resolving at the seam yields the block, never `Code`.
    expect(innermostNameAt(tree, 18)).not.toBe('Code');
  });

  test('does not inject for a malformed block whose only child is the open delimiter', async () => {
    await loadLanguage('javascript');
    // `firstChild === lastChild` (a single delimiter), so the wrap bails out even
    // though the language is loaded — there is no body span to overlay.
    const tree = singleDelimParser.parse('[source,javascript]\n<<<\n');
    expect(innermostNameAt(tree, 21)).not.toBe('Code');
  });

  test('does not inject for a malformed block with no delimiter children at all', async () => {
    await loadLanguage('javascript');
    // `firstChild === null`, so the wrap bails out before computing a body span.
    const tree = childlessParser.parse('[source,javascript]\n<<<\n');
    expect(innermostNameAt(tree, 21)).not.toBe('Code');
  });

  test('stops the back-scan at a non-attribute, non-title line before the block', async () => {
    await loadLanguage('php');
    // A paragraph line sits between the decl and the block, ending the back-scan,
    // so no language is resolved for the block and nothing is injected.
    const tree = parseOuter('[source,php]\n<<<\n>>>\n[a paragraph\n<<<\n$x;\n>>>\n');
    const secondBody = '[source,php]\n<<<\n>>>\n[a paragraph\n<<<\n'.length;
    expect(innermostNameAt(tree, secondBody + 1)).toBe('Body');
  });

  test('skips a block title (.Foo) line between the declaration and the block', async () => {
    await loadLanguage('ruby');
    // A `.Title` line sits between the `[source,ruby]` decl and the block. The
    // back-scan skips it (it starts with `.`) and still resolves the language,
    // so the body is injected.
    const documentText = '[source,ruby]\n.Title\n<<<\nx = 1\n>>>\n';
    const bodyOffset = '[source,ruby]\n.Title\n<<<\n'.length;
    expect(innermostNameAt(parseOuter(documentText), bodyOffset + 1)).toBe('Code');
  });
});

// Regression guard for the production grammar shape. The fabricated grammars above
// give listing/literal blocks NAMED delimiter child nodes; the REAL AsciiDoc grammar's
// delimiters and body are anonymous (lowercase) tokens, so a `ListingBlock` node has
// no child nodes at all (`firstChild`/`lastChild` are null). A wrap that derived the
// body span from those children injected nothing in the real editor — every
// `[source,<lang>]` block rendered unhighlighted. These tests drive the actual
// `asciidocLanguage.parser` (configured with `sourceMixedWrap`) over real `----`/`....`
// blocks so that regression cannot return undetected.
describe('sourceMixedWrap over the real AsciiDoc grammar (regression)', () => {
  test('injects the embedded parser into a real [source,java] listing block', async () => {
    await loadLanguage('java');
    const documentText = '[source,java]\n----\nclass Foo {}\n----\n';
    const tree = asciidocLanguage.parser.parse(documentText);
    const bodyOffset = documentText.indexOf('class') + 2;
    expect(tree.resolveInner(bodyOffset, 1).name).toBe('Code');
    // The delimiter line itself stays under the AsciiDoc grammar (not the embedded parser).
    expect(tree.resolveInner(documentText.indexOf('----') + 1, 1).name).not.toBe('Code');
  });

  test('injects the embedded parser into a real literal block (....)', async () => {
    await loadLanguage('python');
    const documentText = '[source,python]\n....\nprint(1)\n....\n';
    const bodyOffset = documentText.indexOf('print') + 2;
    expect(asciidocLanguage.parser.parse(documentText).resolveInner(bodyOffset, 1).name).toBe('Code');
  });

  test('does not inject a real block whose language is not loaded', () => {
    // `cobol` is not in the allow-list, so nothing is ever cached for it.
    const documentText = '[source,cobol]\n----\nDISPLAY "x"\n----\n';
    const bodyOffset = documentText.indexOf('DISPLAY') + 2;
    expect(asciidocLanguage.parser.parse(documentText).resolveInner(bodyOffset, 1).name).not.toBe('Code');
  });
});

describe('asciidocSourceHighlight (lazy loader plugin)', () => {
  test('loads the declared language and reparses a live (connected) view', async () => {
    resolveSourceLanguageMock.mockReturnValue(fakeDescription(embeddedParser));
    const reparse = jest.fn();
    // `md` (→ Markdown) is unique to this test so the load is not short-circuited
    // by the module cache that earlier tests populated.
    track(mountView('[source,md]\n<<<\nx\n>>>\n', reparse));

    await flush();
    expect(resolveSourceLanguageMock).toHaveBeenCalledWith('Markdown');
    expect(reparse).toHaveBeenCalledTimes(1);
  });

  test('is a no-op for a document with no source blocks', async () => {
    const reparse = jest.fn();
    track(mountView('= Title\n\nplain paragraph\n', reparse));

    await flush();
    expect(resolveSourceLanguageMock).not.toHaveBeenCalled();
    expect(reparse).not.toHaveBeenCalled();
  });

  test('is a no-op when the language is not in the allow-list', async () => {
    const reparse = jest.fn();
    track(mountView('[source,cobol]\n<<<\nDISPLAY\n>>>\n', reparse));

    await flush();
    // `collectSourceLanguages` already dropped the unknown language, so the seam
    // is never consulted and nothing reparses.
    expect(resolveSourceLanguageMock).not.toHaveBeenCalled();
    expect(reparse).not.toHaveBeenCalled();
  });

  test('is a no-op when the resolver returns null (unsupported by language-data)', async () => {
    resolveSourceLanguageMock.mockReturnValue(null);
    const reparse = jest.fn();
    // `typescript` is in the allow-list but loaded/cached by no other test, so the
    // cache cannot short-circuit the resolve. (Java is deliberately cached by the
    // real-grammar regression suite, so it cannot serve as the uncached language here.)
    track(mountView('[source,typescript]\n<<<\nx\n>>>\n', reparse));

    await flush();
    expect(resolveSourceLanguageMock).toHaveBeenCalledWith('TypeScript');
    expect(reparse).not.toHaveBeenCalled();
  });

  test('uses the module cache on the second load of the same language (no re-resolve)', async () => {
    resolveSourceLanguageMock.mockReturnValue(fakeDescription(embeddedParser));
    // `csharp` is unique to this test, so the FIRST mount actually loads it.
    const firstReparse = jest.fn();
    track(mountView('[source,csharp]\n<<<\nx\n>>>\n', firstReparse));
    await flush();
    expect(firstReparse).toHaveBeenCalledTimes(1);

    resolveSourceLanguageMock.mockClear();
    // A second view declaring the same (now-cached) language must not re-resolve/-load.
    const secondReparse = jest.fn();
    track(mountView('[source,cs]\n<<<\ny\n>>>\n', secondReparse));
    await flush();
    expect(resolveSourceLanguageMock).not.toHaveBeenCalled();
    expect(secondReparse).not.toHaveBeenCalled();
  });

  test('does not reparse when the view is disconnected before the load resolves', async () => {
    let resolveLoad: ((value: unknown) => void) | undefined;
    resolveSourceLanguageMock.mockReturnValue({
      load: () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    });
    const reparse = jest.fn();
    // `yaml` is unique here so a real (pending) load is started.
    const view = mountView('[source,yaml]\n<<<\nk: v\n>>>\n', reparse);

    // Destroy/disconnect the view before the pending load resolves.
    view.destroy();
    resolveLoad?.({ language: { parser: embeddedParser } });
    await flush();

    expect(reparse).not.toHaveBeenCalled();
  });

  test('swallows a rejected load and clears the loading flag (allowing a later retry)', async () => {
    resolveSourceLanguageMock.mockReturnValue({ load: () => Promise.reject(new Error('boom')) });
    const reparse = jest.fn();
    // A fresh, uncached language so the loader actually runs.
    track(mountView('[source,sql]\n<<<\nSELECT 1\n>>>\n', reparse));

    await flush();
    expect(reparse).not.toHaveBeenCalled();

    // The loading flag was cleared on failure, so a retry re-resolves and can succeed.
    resolveSourceLanguageMock.mockReturnValue(fakeDescription(embeddedParser));
    const retryReparse = jest.fn();
    track(mountView('[source,sql]\n<<<\nSELECT 1\n>>>\n', retryReparse));
    await flush();
    expect(retryReparse).toHaveBeenCalledTimes(1);
  });

  test('ignores non-document updates (e.g. selection-only changes)', async () => {
    resolveSourceLanguageMock.mockReturnValue(fakeDescription(embeddedParser));
    const reparse = jest.fn();
    const view = track(mountView('= Title\nsome text\n', reparse));
    await flush();
    resolveSourceLanguageMock.mockClear();

    // A selection move is not a doc change, so `update()` must not re-scan/-load.
    view.dispatch({ selection: { anchor: 2 } });
    await flush();
    expect(resolveSourceLanguageMock).not.toHaveBeenCalled();
    expect(reparse).not.toHaveBeenCalled();
  });

  test('loads a newly declared language when the document changes (update path)', async () => {
    resolveSourceLanguageMock.mockReturnValue(fakeDescription(embeddedParser));
    const reparse = jest.fn();
    // Start with no source blocks so the constructor finds nothing to load.
    const view = track(mountView('= Title\n', reparse));
    await flush();
    expect(reparse).not.toHaveBeenCalled();

    // A doc change introducing a [source,xml] block triggers ensureLoaded via update().
    view.dispatch({
      changes: { from: view.state.doc.length, insert: '\n[source,xml]\n<<<\n<a/>\n>>>\n' },
    });
    await flush();
    expect(resolveSourceLanguageMock).toHaveBeenCalledWith('XML');
    expect(reparse).toHaveBeenCalledTimes(1);
  });
});
