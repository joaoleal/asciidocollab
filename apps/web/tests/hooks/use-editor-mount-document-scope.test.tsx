import { render, act } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';
import { useEditorMount } from '@/hooks/use-editor-mount';
import { refreshGrammarLints } from '@/lib/codemirror/editor-grammar-linter';
import { getDocumentScopeSnapshot, resetDocumentScope } from '@/lib/codemirror/harper/document-scope-store';
import type { PositionedGrammarDiagnostic } from '@/lib/codemirror/harper/grammar-diagnostics';
import type { ProjectSymbolIndex } from '@/lib/codemirror/asciidoc-symbol-index';
import type { XrefTarget } from '@/lib/codemirror/asciidoc-link-handler';
import type { SegmentInput, SegmentLints } from '@/lib/codemirror/harper/harper-worker-client';

// The generated lezer parser ships as ESM and cannot load under the commonjs ts-jest transform, so the
// language is built from the grammar SOURCE. Both exports are provided: the editor mounts with
// `asciidoc()`, and the cross-file pass parses included files with `asciidocLanguage.parser`.
jest.mock('@/lib/codemirror/asciidoc-language', () => {
  const fs = jest.requireActual('node:fs') as typeof import('node:fs');
  const path = jest.requireActual('node:path') as typeof import('node:path');
  const { buildParser } = jest.requireActual('@lezer/generator');
  const { LRLanguage, LanguageSupport } = jest.requireActual('@codemirror/language');
  const { createTestBlockTokenizer } = jest.requireActual('../helpers/asciidoc-test-tokenizer');
  const grammarSource = fs.readFileSync(
    path.resolve(__dirname, '../../src/lib/codemirror/asciidoc.grammar'),
    'utf8',
  );
  const parser = buildParser(grammarSource, {
    externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  });
  const language = LRLanguage.define({ parser });
  return { asciidoc: () => new LanguageSupport(language), asciidocLanguage: language };
});

const noop = (): void => {};

// A worker client that is ready immediately and flags every "wrold" — the real harper.js ESM/WASM
// package cannot load under jest, but everything above the client seam is the production code.
jest.mock('@/lib/codemirror/harper/harper-worker-client', () => ({
  ...(jest.requireActual('@/lib/codemirror/harper/harper-worker-client') as object),
  createHarperWorkerClient: () => ({
    getStatus: () => 'ready',
    onStatusChange: () => noop,
    isReady: () => true,
    setDialect: async () => {},
    warmUp: async () => {},
    async lint(segments: SegmentInput[]): Promise<SegmentLints[] | null> {
      return segments.map((segment) => {
        const at = segment.text.indexOf('wrold');
        return {
          id: segment.id,
          lints:
            at === -1
              ? []
              : [
                  {
                    span: { start: at, end: at + 5 },
                    kind: 'Spelling',
                    rule: 'SpellCheck',
                    message: '“wrold” may be misspelled',
                    suggestions: [],
                  },
                ],
        };
      });
    },
    dispose: async () => {},
  }),
}));

const OPEN_FILE = 'book.adoc';
const CHAPTER = 'chapters/intro.adoc';
const CONTENT: Readonly<Record<string, string>> = {
  [OPEN_FILE]: 'The wrold turns.\n',
  [CHAPTER]: '= Intro\n\nAll clean here.\n\nAnother wrold appears.\n',
};

/** Build a symbol index over a fixed two-file project, rooted wherever the caller says. */
function fakeIndex(nodes: string[], activePath: string): ProjectSymbolIndex {
  const empty: ReadonlyMap<string, string> = new Map();
  return {
    tree: { rootFileId: nodes[0], nodes, edges: [], unresolved: [] },
    activeFileId: activePath,
    symbols: [],
    references: [],
    attributes: empty,
    inheritedAttributes: () => empty,
    effectiveAttributes: () => empty,
    resolveXref: () => 'unresolved',
    resolveAttribute: () => 'unresolved',
    inheritedOffset: () => 0,
    pathOf: (fileId: string) => fileId,
    lineOf: () => 1,
    getContent: (fileId: string) => CONTENT[fileId] ?? null,
    resolveInclude: () => null,
  };
}

type MountOptions = Parameters<typeof useEditorMount>[0];

/** The live editor view of the harness below, so a test can ask the lint plugin for a pass. */
let mountedView: { current: EditorView | null } | null = null;

/** Renders the hook against a real container node so a genuine editor view is mounted. */
function Harness({ options }: { options: MountOptions }): React.JSX.Element {
  const result = useEditorMount(options);
  mountedView = result.viewReference;
  return <div ref={result.containerReference} />;
}

/** Ask the lint plugin for a pass now — the editor's own debounce never elapses under the test clock. */
async function lintOpenFile(): Promise<void> {
  act(() => {
    const view = mountedView?.current;
    if (view) refreshGrammarLints(view);
  });
  await settle();
}

const openFileDiagnostics: PositionedGrammarDiagnostic[][] = [];
const xrefNavigations: XrefTarget[] = [];

/** Options that mount an editor with grammar checking active over the two-file project. */
function grammarOptions(overrides: Partial<MountOptions> = {}): MountOptions {
  return {
    content: CONTENT[OPEN_FILE],
    canEdit: true,
    includePaths: [],
    onDocChange: noop,
    onCursorChange: noop,
    onOutlineChange: noop,
    grammarEnabled: true,
    grammarLanguageIsEnglish: true,
    getProjectIndex: () => fakeIndex([OPEN_FILE, CHAPTER], OPEN_FILE),
    onNavigateToXref: (target: XrefTarget) => xrefNavigations.push(target),
    onGrammarDiagnostics: (diagnostics) => openFileDiagnostics.push(diagnostics),
    ...overrides,
  };
}

/** Spins the event loop so the warm-up promise, the cross-file pass, and their effects all settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 15; index++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('useEditorMount check-scope wiring', () => {
  beforeEach(() => {
    resetDocumentScope();
    openFileDiagnostics.length = 0;
    xrefNavigations.length = 0;
  });

  test('"This file" reports only the open file, and "Whole document" adds the included file', async () => {
    let utilities!: ReturnType<typeof render>;
    act(() => {
      utilities = render(<Harness options={grammarOptions({ lintScope: 'this-file' })} />);
    });
    await settle();
    await lintOpenFile();

    // This file: the open file's own issue is underlined, and nothing cross-file is reported.
    const thisFileIssues = openFileDiagnostics.at(-1) ?? [];
    expect(thisFileIssues).toHaveLength(1);
    expect(getDocumentScopeSnapshot().state).toBe('inactive');
    expect(getDocumentScopeSnapshot().issues).toEqual([]);

    act(() => {
      utilities.rerender(<Harness options={grammarOptions({ lintScope: 'whole-document' })} />);
    });
    await settle();

    // Whole document: the same open-file underline, PLUS the issue in the included chapter.
    const wholeDocument = getDocumentScopeSnapshot();
    expect(wholeDocument.state).toBe('checked');
    expect(wholeDocument.fileCount).toBe(1);
    expect(wholeDocument.issues).toEqual([
      {
        fileId: CHAPTER,
        path: CHAPTER,
        line: 5,
        category: 'spelling',
        message: '“wrold” may be misspelled',
        rule: 'SpellCheck',
      },
    ]);
    expect(openFileDiagnostics.at(-1)).toHaveLength(1);

    act(() => {
      utilities.unmount();
    });
  });

  test('switching back to "This file" drops the other files again', async () => {
    let utilities!: ReturnType<typeof render>;
    act(() => {
      utilities = render(<Harness options={grammarOptions({ lintScope: 'whole-document' })} />);
    });
    await settle();
    expect(getDocumentScopeSnapshot().issues).toHaveLength(1);

    act(() => {
      utilities.rerender(<Harness options={grammarOptions({ lintScope: 'this-file' })} />);
    });
    await settle();
    expect(getDocumentScopeSnapshot().state).toBe('inactive');
    expect(getDocumentScopeSnapshot().issues).toEqual([]);

    act(() => {
      utilities.unmount();
    });
  });

  test('selecting an issue in another file navigates to that file and line', async () => {
    let utilities!: ReturnType<typeof render>;
    act(() => {
      utilities = render(<Harness options={grammarOptions({ lintScope: 'whole-document' })} />);
    });
    await settle();

    const snapshot = getDocumentScopeSnapshot();
    act(() => {
      snapshot.reveal?.(snapshot.issues[0]);
    });
    expect(xrefNavigations).toEqual([{ fileId: CHAPTER, path: CHAPTER, line: 5, sameFile: false }]);

    act(() => {
      utilities.unmount();
    });
  });

  test('says so when this file pulls in no other file, rather than looking like a second scope', async () => {
    let utilities!: ReturnType<typeof render>;
    act(() => {
      utilities = render(
        <Harness
          options={grammarOptions({
            lintScope: 'whole-document',
            getProjectIndex: () => fakeIndex([OPEN_FILE], OPEN_FILE),
          })}
        />,
      );
    });
    await settle();
    expect(getDocumentScopeSnapshot().state).toBe('alone');

    act(() => {
      utilities.unmount();
    });
  });

  test('says so when the open file is not part of the main document', async () => {
    let utilities!: ReturnType<typeof render>;
    act(() => {
      utilities = render(
        <Harness
          options={grammarOptions({
            lintScope: 'whole-document',
            // The tree is rooted at a main document this file is not reachable from.
            getProjectIndex: () => fakeIndex([CHAPTER], OPEN_FILE),
          })}
        />,
      );
    });
    await settle();
    expect(getDocumentScopeSnapshot().state).toBe('outside-main');
    expect(getDocumentScopeSnapshot().issues).toEqual([]);

    act(() => {
      utilities.unmount();
    });
  });

  test('leaves nothing behind for the next editor when it unmounts', async () => {
    let utilities!: ReturnType<typeof render>;
    act(() => {
      utilities = render(<Harness options={grammarOptions({ lintScope: 'whole-document' })} />);
    });
    await settle();
    expect(getDocumentScopeSnapshot().state).toBe('checked');

    act(() => {
      utilities.unmount();
    });
    expect(getDocumentScopeSnapshot().state).toBe('inactive');
  });
});
