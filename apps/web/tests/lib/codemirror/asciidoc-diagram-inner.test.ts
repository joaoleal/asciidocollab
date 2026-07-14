/* @jest-environment jsdom */

/**
 * Inner highlighting of diagram block bodies.
 *
 * A recognised diagram declaration (`[graphviz]`, `[vega]`, `[vegalite]`,
 * `[mermaid]`) sitting immediately above a delimited block routes the block BODY
 * to a notation-specific parser, scoped by an overlay so highlighting never bleeds
 * into the surrounding AsciiDoc:
 *   - graphviz → the DOT stream parser (synchronous),
 *   - vega / vegalite → the lazily-loaded JSON parser,
 *   - mermaid → a parser chosen from the body's first content line.
 * Math blocks (`[stem]`/`[latexmath]`/`[asciimath]`) are NOT diagram notations and
 * are left untouched, and an ordinary `[source,<lang>]` listing still routes to its
 * language exactly as before.
 *
 * The wrap is exercised through the real `asciidocLanguage.parser` (already
 * configured with `sourceMixedWrap`); `resolveInner` reveals the mounted overlay
 * tree, so a body node name proves which inner parser (if any) was injected. The
 * DOT and mermaid parsers are synchronous, so those cases need no setup. The JSON
 * and `[source,<lang>]` cases go through the async lazy loader; its
 * `resolveSourceLanguage` seam is mocked (a real language-data dynamic import
 * cannot run under ts-jest), and a live view drives the loader to populate the
 * module-wide parser cache the wrap reads — mirroring `asciidoc-source-highlight`.
 */
import { buildParser } from '@lezer/generator';
import { type Parser } from '@lezer/common';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

jest.mock('@/lib/codemirror/source-languages', () => {
  const actual = jest.requireActual('@/lib/codemirror/source-languages');
  return { __esModule: true, ...actual, resolveSourceLanguage: jest.fn() };
});

import { asciidocSourceHighlight } from '@/lib/codemirror/asciidoc-source-highlight';
import { asciidocLanguage } from '@/lib/codemirror/asciidoc-language';
import { resolveSourceLanguage } from '@/lib/codemirror/source-languages';

const resolveSourceLanguageMock = resolveSourceLanguage as unknown as jest.Mock;

// A fake embedded parser that tags every body line as a distinctly-named node, so a
// mounted overlay is recognisable via `resolveInner`. Stands in for a real language
// pack (JSON / Ruby) whose dynamic import cannot run under ts-jest.
function fakeParser(nodeName: string): Parser {
  return buildParser(String.raw`@top Program { ${nodeName}* } @tokens { ${nodeName} { ![\n]+ "\n"? } }`) as unknown as Parser;
}

function fakeDescription(parser: Parser): { load: () => Promise<unknown> } {
  return { load: () => Promise.resolve({ language: { parser } }) };
}

const liveViews: EditorView[] = [];

function mountView(documentText: string): EditorView {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: documentText, extensions: [asciidocSourceHighlight(() => {})] }),
  });
  liveViews.push(view);
  return view;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Drive the lazy loader over `documentText` so any embedded language it declares is
 * loaded (via the mocked resolver) into the module-wide cache the wrap reads.
 */
async function preload(documentText: string, parser: Parser): Promise<void> {
  resolveSourceLanguageMock.mockReturnValue(fakeDescription(parser));
  mountView(documentText);
  await flush();
}

/** Name of the most-specific node at `offset` — descends into mounted overlay trees. */
function nameAt(documentText: string, offset: number): string {
  return asciidocLanguage.parser.parse(documentText).resolveInner(offset, 1).name;
}

beforeEach(() => {
  resolveSourceLanguageMock.mockReset();
});

afterEach(() => {
  for (const view of liveViews.splice(0)) view.destroy();
});

describe('diagram block inner highlighting', () => {
  test('a [graphviz] body is highlighted as DOT', () => {
    const documentText = '[graphviz]\n----\ndigraph G { a -> b }\n----\n';
    // The DOT stream parser tags `digraph` as a `keyword` node inside the body.
    expect(nameAt(documentText, documentText.indexOf('digraph') + 1)).toBe('keyword');
  });

  test('a [vega] body is highlighted as JSON', async () => {
    const jsonNode = fakeParser('JsonValue');
    // A vega block in the document makes the loader preload JSON (mocked resolver).
    await preload('[vega]\n----\n{ "x": 1 }\n----\n', jsonNode);
    const documentText = '[vega]\n----\n{ "mark": "bar" }\n----\n';
    expect(nameAt(documentText, documentText.indexOf('"mark"') + 1)).toBe('JsonValue');
  });

  test('a [vegalite] body is also highlighted as JSON', async () => {
    await preload('[vegalite]\n----\n{ "y": 2 }\n----\n', fakeParser('JsonValue'));
    const documentText = '[vegalite]\n----\n{ "width": 400 }\n----\n';
    expect(nameAt(documentText, documentText.indexOf('"width"') + 1)).toBe('JsonValue');
  });

  test('a [mermaid] flowchart body is highlighted via mermaid', () => {
    const documentText = '[mermaid]\n----\nflowchart TD\n  A-->B\n----\n';
    // codemirror-lang-mermaid names the leading type keyword `DiagramName`.
    expect(nameAt(documentText, documentText.indexOf('flowchart') + 1)).toBe('DiagramName');
  });

  test('highlighting does not bleed past the closing delimiter into following AsciiDoc', () => {
    const documentText = '[graphviz]\n----\ndigraph G {}\n----\n\na normal paragraph\n';
    // The line after the closing `----` is ordinary AsciiDoc, never a DOT node.
    expect(nameAt(documentText, documentText.indexOf('a normal paragraph') + 1)).toBe('Paragraph');
  });

  test('a [stem] math block body is NOT routed to a diagram parser', () => {
    const documentText = '[stem]\n++++\nsqrt(x)\n++++\n';
    // The STEM body stays under the AsciiDoc grammar (`StemBlock`), untouched.
    expect(nameAt(documentText, documentText.indexOf('sqrt') + 1)).toBe('StemBlock');
  });

  test('a [source,ruby] block still routes to its language parser (no regression)', async () => {
    await preload('[source,ruby]\n----\nputs 1\n----\n', fakeParser('Code'));
    const documentText = '[source,ruby]\n----\nputs :hi\n----\n';
    expect(nameAt(documentText, documentText.indexOf('puts') + 1)).toBe('Code');
  });
});
