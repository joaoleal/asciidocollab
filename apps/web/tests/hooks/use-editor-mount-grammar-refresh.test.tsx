import { render, act } from '@testing-library/react';
import { useEditorMount } from '@/hooks/use-editor-mount';

// The generated lezer parser ships as ESM and cannot load under the commonjs ts-jest transform, so the
// language is built from the grammar SOURCE — the approach the other mount suites use.
jest.mock('@/lib/codemirror/asciidoc-language', () => {
  const fs = jest.requireActual('node:fs') as typeof import('node:fs');
  const path = jest.requireActual('node:path') as typeof import('node:path');
  const { buildParser } = jest.requireActual('@lezer/generator');
  const { LRLanguage, LanguageSupport } = jest.requireActual('@codemirror/language');
  const { createTestBlockTokenizer, createTestBlockContext } = jest.requireActual('../helpers/asciidoc-test-tokenizer');
  const grammarSource = fs.readFileSync(
    path.resolve(__dirname, '../../src/lib/codemirror/asciidoc.grammar'),
    'utf8',
  );
  const parser = buildParser(grammarSource, {
    externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
    contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
  });
  return { asciidoc: () => new LanguageSupport(LRLanguage.define({ parser })) };
});

const noop = (): void => {};

// A worker client that is ready the moment it is warmed up, so the hook's grammar path activates
// without the real harper.js ESM/WASM package (which cannot load under jest).
const clientCalls = { resetWords: 0, importIgnoredLints: 0 };
jest.mock('@/lib/codemirror/harper/harper-worker-client', () => ({
  ...(jest.requireActual('@/lib/codemirror/harper/harper-worker-client') as object),
  createHarperWorkerClient: () => ({
    getStatus: () => 'ready',
    onStatusChange: () => noop,
    isReady: () => true,
    setDialect: async () => {},
    warmUp: async () => {},
    lint: async () => [],
    resetWords: async () => {
      clientCalls.resetWords += 1;
    },
    importIgnoredLints: async () => {
      clientCalls.importIgnoredLints += 1;
    },
    dispose: async () => {},
  }),
}));

// The refresh helper is the mechanism under test here: the hook must reach for it whenever a grammar
// input outside the document changes. Its own behaviour is covered by the linter-extension suite.
const refreshCalls = { count: 0 };
jest.mock('@/lib/codemirror/editor-grammar-linter', () => ({
  ...(jest.requireActual('@/lib/codemirror/editor-grammar-linter') as object),
  refreshGrammarLints: () => {
    refreshCalls.count += 1;
  },
}));

type MountOptions = Parameters<typeof useEditorMount>[0];

/** Renders the hook against a real container node so a genuine editor view is mounted. */
function Harness({ options }: { options: MountOptions }): React.JSX.Element {
  const result = useEditorMount(options);
  return <div ref={result.containerReference} />;
}

/** Options that mount an editor with grammar checking active. */
function grammarOptions(overrides: Partial<MountOptions> = {}): MountOptions {
  return {
    content: 'The wrold turns.\n',
    canEdit: true,
    includePaths: [],
    onDocChange: noop,
    onCursorChange: noop,
    onOutlineChange: noop,
    grammarEnabled: true,
    grammarLanguageIsEnglish: true,
    ...overrides,
  };
}

/** Spins the event loop so the hook's warm-up promise and its follow-up effects settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 10; index++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('useEditorMount grammar refresh wiring', () => {
  beforeEach(() => {
    refreshCalls.count = 0;
    clientCalls.resetWords = 0;
    clientCalls.importIgnoredLints = 0;
  });

  test('leaves the open file\'s underlines alone when the check scope changes', async () => {
    let utilities!: ReturnType<typeof render>;
    act(() => {
      utilities = render(<Harness options={grammarOptions({ lintScope: 'this-file' })} />);
    });
    await settle();
    const afterActivation = refreshCalls.count;

    act(() => {
      utilities.rerender(<Harness options={grammarOptions({ lintScope: 'whole-document' })} />);
    });
    await settle();
    // Both scopes underline exactly the open file's issues, so widening the scope must not disturb
    // them; it only adds the OTHER files to the panel's list.
    expect(refreshCalls.count).toBe(afterActivation);

    act(() => {
      utilities.unmount();
    });
  });

  test('re-lints after the dictionary and the ignored-lints blob are reconciled into the worker', async () => {
    let utilities!: ReturnType<typeof render>;
    act(() => {
      utilities = render(<Harness options={grammarOptions({ dictionaryTerms: ['asciidoctor'] })} />);
    });
    await settle();
    expect(clientCalls.resetWords).toBe(1);
    const afterDictionary = refreshCalls.count;
    expect(afterDictionary).toBeGreaterThan(0);

    act(() => {
      utilities.rerender(
        <Harness options={grammarOptions({ dictionaryTerms: ['asciidoctor'], ignoredLintsBlob: 'blob' })} />,
      );
    });
    await settle();
    expect(clientCalls.importIgnoredLints).toBe(1);
    expect(refreshCalls.count).toBeGreaterThan(afterDictionary);

    act(() => {
      utilities.unmount();
    });
  });
});
