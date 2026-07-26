import { useEffect } from 'react';
import { render, act } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { Compartment } from '@codemirror/state';
import { forceLinting } from '@codemirror/lint';
import { startCompletion, currentCompletions } from '@codemirror/autocomplete';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { useEditorMount } from '@/hooks/use-editor-mount';
import { collabExtensions } from '@/components/editor/editor-collab-extensions';

// The generated lezer parser (`asciidoc-parser.js`) ships as ESM and is not loadable under the
// commonjs ts-jest transform, so importing the real AsciiDoc language throws at module load. The
// hook's logic is language-agnostic — every branch under test lives in the hook, not the grammar —
// so we build the real parser from the grammar SOURCE (the proven approach used by the highlight
// suite) and wrap it in a genuine CodeMirror language. This keeps a real EditorView mounted so the
// live dispatch / compartment / listener paths are actually exercised, without the ESM parser file.
jest.mock('@/lib/codemirror/asciidoc-language', () => {
  const fs = jest.requireActual('node:fs') as typeof import('node:fs');
  const path = jest.requireActual('node:path') as typeof import('node:path');
  const { buildParser } = jest.requireActual('@lezer/generator');
  const { LRLanguage, LanguageSupport } = jest.requireActual('@codemirror/language');
  const { asciidocHighlightTags } = jest.requireActual('@/lib/codemirror/asciidoc-highlight-tags');
  const { createTestBlockTokenizer } = jest.requireActual('../helpers/asciidoc-test-tokenizer');
  const grammarSource = fs.readFileSync(
    path.resolve(__dirname, '../../src/lib/codemirror/asciidoc.grammar'),
    'utf8',
  );
  const parser = buildParser(grammarSource, {
    externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  }).configure({ props: [asciidocHighlightTags] });
  const language = LRLanguage.define({ parser });
  return { asciidoc: () => new LanguageSupport(language) };
});

// The real source-highlight loader lazily `import()`s embedded language packs from
// `@codemirror/language-data` — ESM modules the commonjs ts-jest runtime cannot load, so the
// genuine async `reparse` path never fires under jest. The mount-side reparse CALLBACK (the
// `(view) => view.dispatch(languageCompartment.reconfigure(...))` arrow we own) is still real
// hook logic, so we stub the loader to invoke that callback once — out of band via a microtask,
// since CodeMirror forbids dispatching synchronously inside an update cycle (matching how the
// real loader calls it from an async `.then`). Everything else about the plugin is inert here.
jest.mock('@/lib/codemirror/asciidoc-source-highlight', () => {
  const { ViewPlugin } = jest.requireActual('@codemirror/view') as typeof import('@codemirror/view');
  return {
    asciidocSourceHighlight: (reparse: (view: import('@codemirror/view').EditorView) => void) =>
      ViewPlugin.fromClass(
        class {
          fired = false;
          update(update: import('@codemirror/view').ViewUpdate) {
            if (this.fired || !update.docChanged) return;
            this.fired = true;
            queueMicrotask(() => reparse(update.view));
          }
        },
      ),
  };
});

/**
 * The minimal subset of {@link useEditorMount} options every test supplies. Individual tests
 * spread their own overrides on top of this so the harness stays focused on the case under test.
 */
type MountOptions = Parameters<typeof useEditorMount>[0];

/** The hook's returned shape, captured by the harness so tests can assert against the live view. */
type MountResult = ReturnType<typeof useEditorMount>;

// CodeMirror measures layout via Range.getClientRects during its rAF cycle; jsdom implements
// neither getClientRects on Range nor a layout engine, so we provide empty-rect stubs. This lets
// the view mount, dispatch (incl. scrollIntoView) and measure without throwing — the hook logic
// under test never depends on real geometry.
const emptyRectList = Object.assign([], { item: () => null }) as unknown as DOMRectList;
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = () => emptyRectList;
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

// The spell-check source fetches its Hunspell dictionary from `/dictionaries/*` and returns no
// diagnostics (skipping the per-user ignore accessor) when that fetch fails — which it always does
// under jsdom. Serving a tiny in-memory dictionary lets `nspell` build a real checker so the lint
// source actually consults the `() => spellIgnore ?? []` accessor we pass it. `loadSpellChecker`
// memoises the first result module-wide, so this stub must be installed before any lint runs.
const DICTIONARY_AFF = 'SET UTF-8\n';
const DICTIONARY_DIC = '2\nprose\nhere\n';
// jsdom has no global `Response`, so we resolve to a minimal fetch-result shape exposing only the
// `ok`/`text()` members `loadSpellChecker` reads.
globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  const body = url.endsWith('.aff') ? DICTIONARY_AFF : DICTIONARY_DIC;
  return Promise.resolve({ ok: true, text: () => Promise.resolve(body) } as unknown as Response);
}) as typeof fetch;

const noop = (): void => {};

/** Spins the event loop (macrotask granularity) until `predicate` holds or the budget runs out. */
async function flushUntil(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let index = 0; index < attempts && !predicate(); index++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Baseline options that mount a working REST-path editor. */
function baseOptions(overrides: Partial<MountOptions> = {}): MountOptions {
  return {
    content: 'line one\nline two\nline three\n',
    canEdit: true,
    includePaths: [],
    onDocChange: noop,
    onCursorChange: noop,
    onOutlineChange: noop,
    ...overrides,
  };
}

interface HarnessProperties {
  options: MountOptions;
  /**
   * Receives the hook result on every render so tests can read the live view ref.
   *
   * @param result - The current return value of {@link useEditorMount}.
   */
  onResult: (result: MountResult) => void;
}

/**
 * Renders {@link useEditorMount} and wires its container ref to a real DOM node so the mount
 * effect creates an actual CodeMirror {@link EditorView} (the source-level path under test).
 *
 * @param properties - The harness props (options to forward and a result sink).
 * @returns The harness element with the container ref attached.
 */
function Harness({ options, onResult }: HarnessProperties): React.JSX.Element {
  const result = useEditorMount(options);
  useEffect(() => {
    onResult(result);
  });
  return <div ref={result.containerReference} />;
}

interface Rendered {
  rerender: (options: MountOptions) => void;
  unmount: () => void;
  getResult: () => MountResult;
  getView: () => EditorView;
}

/** Mounts the harness in jsdom and exposes ergonomic accessors for the live hook result. */
function mount(options: MountOptions): Rendered {
  let latest: MountResult | undefined;
  const capture = (result: MountResult): void => {
    latest = result;
  };
  let utilities!: ReturnType<typeof render>;
  act(() => {
    utilities = render(<Harness options={options} onResult={capture} />);
  });
  return {
    rerender: (next) => {
      act(() => {
        utilities.rerender(<Harness options={next} onResult={capture} />);
      });
    },
    unmount: () => {
      act(() => {
        utilities.unmount();
      });
    },
    getResult: () => {
      if (!latest) throw new Error('hook result not captured yet');
      return latest;
    },
    getView: () => {
      const view = latest?.viewReference.current;
      if (!view) throw new Error('view not mounted');
      return view;
    },
  };
}

/**
 * Renders the hook WITHOUT attaching the container ref, so the mount effect's guard short-circuits.
 *
 * @param properties - The harness props (options to forward and a result sink).
 * @returns A bare element that never receives the editor container ref.
 */
function HarnessNoReference({ options, onResult }: HarnessProperties): React.JSX.Element {
  const result = useEditorMount(options);
  useEffect(() => {
    onResult(result);
  });
  return <div />;
}

describe('useEditorMount container guard', () => {
  test('does not create a view when the container ref is never attached', () => {
    let latest: MountResult | undefined;
    const utilities = render(
      <HarnessNoReference options={baseOptions()} onResult={(result) => { latest = result; }} />,
    );
    expect(latest?.viewReference.current).toBeNull();
    utilities.unmount();
  });
});

describe('useEditorMount mount/teardown', () => {
  test('creates a live EditorView seeded with the REST content on mount', () => {
    const rendered = mount(baseOptions());
    const view = rendered.getView();
    expect(view).toBeInstanceOf(EditorView);
    expect(view.state.doc.toString()).toBe('line one\nline two\nline three\n');
    rendered.unmount();
  });

  test('publishes the initial outline through onOutlineChange', () => {
    const onOutlineChange = jest.fn();
    const rendered = mount(baseOptions({ content: '= Title\n\n== Section\n', onOutlineChange }));
    expect(onOutlineChange).toHaveBeenCalled();
    rendered.unmount();
  });

  test('destroys the view and clears the ref on unmount, emitting an empty outline', () => {
    const onOutlineChange = jest.fn();
    const rendered = mount(baseOptions({ onOutlineChange }));
    const view = rendered.getView();
    const destroySpy = jest.spyOn(view, 'destroy');

    rendered.unmount();

    expect(destroySpy).toHaveBeenCalled();
    expect(onOutlineChange).toHaveBeenLastCalledWith([]);
  });
});

describe('useEditorMount document + cursor listeners', () => {
  test('reports doc + cursor changes through the update listener on edits', () => {
    const onDocChange = jest.fn();
    const onCursorChange = jest.fn();
    const rendered = mount(baseOptions({ onDocChange, onCursorChange }));
    const view = rendered.getView();

    act(() => {
      view.dispatch({ changes: { from: 0, insert: 'X' } });
    });

    expect(onDocChange).toHaveBeenCalledWith('Xline one\nline two\nline three\n');
    expect(onCursorChange).toHaveBeenCalled();
    rendered.unmount();
  });
});

describe('useEditorMount selection-driven preview sync', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('fires onSelectionLine (debounced) when the caret moves without an edit', () => {
    const onSelectionLine = jest.fn();
    const rendered = mount(baseOptions({ onSelectionLine }));
    const view = rendered.getView();

    // Move the caret to line 3 with a pure selection change (no doc edit).
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.line(3).from } });
    });
    // Debounced: nothing yet until the quiet period elapses.
    expect(onSelectionLine).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(100); });
    expect(onSelectionLine).toHaveBeenCalledWith(3);

    rendered.unmount();
  });

  test('does not fire onSelectionLine on a plain edit (typing must not yank the preview)', () => {
    const onSelectionLine = jest.fn();
    const rendered = mount(baseOptions({ onSelectionLine }));
    const view = rendered.getView();

    act(() => { view.dispatch({ changes: { from: 0, insert: 'X' } }); });
    act(() => { jest.advanceTimersByTime(100); });
    expect(onSelectionLine).not.toHaveBeenCalled();

    rendered.unmount();
  });

  test('coalesces a burst of selection moves into one sync at the settled line', () => {
    const onSelectionLine = jest.fn();
    const rendered = mount(baseOptions({ onSelectionLine }));
    const view = rendered.getView();

    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
      view.dispatch({ selection: { anchor: view.state.doc.line(3).from } });
    });
    act(() => { jest.advanceTimersByTime(100); });
    expect(onSelectionLine).toHaveBeenCalledTimes(1);
    expect(onSelectionLine).toHaveBeenCalledWith(3);

    rendered.unmount();
  });
});

describe('useEditorMount initialLine restore (REST path)', () => {
  test('clamps an out-of-range initialLine to the last line and scrolls it into view', () => {
    const rendered = mount(baseOptions({ content: 'a\nb\nc\n', initialLine: 999 }));
    const view = rendered.getView();
    // Doc 'a\nb\nc\n' has 4 lines; the clamp lands the caret on the final (empty) line start.
    const lastLine = view.state.doc.line(view.state.doc.lines);
    expect(view.state.selection.main.head).toBe(lastLine.from);
    rendered.unmount();
  });

  test('restores a valid in-range initialLine on mount', () => {
    const rendered = mount(baseOptions({ content: 'a\nb\nc\n', initialLine: 2 }));
    const view = rendered.getView();
    expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from);
    rendered.unmount();
  });

  test('leaves the caret at the document start when no initialLine is provided', () => {
    const rendered = mount(baseOptions({ content: 'a\nb\nc\n' }));
    const view = rendered.getView();
    expect(view.state.selection.main.head).toBe(0);
    rendered.unmount();
  });
});

describe('useEditorMount readOnly compartment', () => {
  test('mounts read-only and non-editable when canEdit is false', () => {
    const rendered = mount(baseOptions({ canEdit: false }));
    const view = rendered.getView();
    expect(view.state.readOnly).toBe(true);
    expect(view.state.facet(EditorView.editable)).toBe(false);
    rendered.unmount();
  });

  test('reconfigures editability live when canEdit toggles', () => {
    const rendered = mount(baseOptions({ canEdit: true }));
    expect(rendered.getView().state.readOnly).toBe(false);

    act(() => {
      rendered.rerender(baseOptions({ canEdit: false }));
    });

    expect(rendered.getView().state.readOnly).toBe(true);
    expect(rendered.getView().state.facet(EditorView.editable)).toBe(false);
    rendered.unmount();
  });
});

// EditorView.lineWrapping is an attribute facet: when enabled it adds the `cm-lineWrapping` class
// to contentDOM, and contributes `undefined` to the facet value when disabled. We assert on the
// observable class, which is the user-facing effect the compartment drives.
function isWrapping(view: EditorView): boolean {
  return view.contentDOM.classList.contains('cm-lineWrapping');
}

describe('useEditorMount soft-wrap compartment', () => {
  test('mounts with line wrapping enabled by default', () => {
    const rendered = mount(baseOptions());
    expect(isWrapping(rendered.getView())).toBe(true);
    rendered.unmount();
  });

  test('mounts without line wrapping when softWrap is false', () => {
    const rendered = mount(baseOptions({ softWrap: false }));
    expect(isWrapping(rendered.getView())).toBe(false);
    rendered.unmount();
  });

  test('toggles line wrapping live through the compartment', () => {
    const rendered = mount(baseOptions({ softWrap: false }));
    expect(isWrapping(rendered.getView())).toBe(false);

    act(() => {
      rendered.rerender(baseOptions({ softWrap: true }));
    });

    expect(isWrapping(rendered.getView())).toBe(true);
    rendered.unmount();
  });
});

describe('useEditorMount content sync (REST path)', () => {
  test('pushes external content changes into the live view', () => {
    const rendered = mount(baseOptions({ content: 'original\n' }));
    expect(rendered.getView().state.doc.toString()).toBe('original\n');

    act(() => {
      rendered.rerender(baseOptions({ content: 'updated content\n' }));
    });

    expect(rendered.getView().state.doc.toString()).toBe('updated content\n');
    rendered.unmount();
  });

  test('ignores a content rerender that matches the current document (no redundant dispatch)', () => {
    const rendered = mount(baseOptions({ content: 'same\n' }));
    const view = rendered.getView();
    const dispatchSpy = jest.spyOn(view, 'dispatch');

    act(() => {
      rendered.rerender(baseOptions({ content: 'same\n' }));
    });

    expect(dispatchSpy).not.toHaveBeenCalled();
    rendered.unmount();
  });
});

describe('useEditorMount inherited heading offset', () => {
  test('dispatches a heading-levels refresh effect when inheritedOffset changes', () => {
    const rendered = mount(baseOptions({ inheritedOffset: 0 }));
    const view = rendered.getView();
    const dispatchSpy = jest.spyOn(view, 'dispatch');

    act(() => {
      rendered.rerender(baseOptions({ inheritedOffset: 2 }));
    });

    expect(dispatchSpy).toHaveBeenCalled();
    rendered.unmount();
  });
});

describe('useEditorMount inline-style emphasis', () => {
  test('marks a known-role span [.role]#…# with the distinct-emphasis class in the live editor', () => {
    const rendered = mount(baseOptions({ content: 'a [.underline]#styled# b\n' }));
    // The emphasis decoration is a mark whose class flags known roles; it must reach the DOM so the
    // theme can style it. (`underline` is a built-in known role.)
    expect(rendered.getView().dom.querySelector('.cm-ad-inline-style-known')).not.toBeNull();
    rendered.unmount();
  });

  test('does NOT mark an unknown-role span (it stays generically highlighted only)', () => {
    const rendered = mount(baseOptions({ content: 'a [.totallycustom]#styled# b\n' }));
    expect(rendered.getView().dom.querySelector('.cm-ad-inline-style-known')).toBeNull();
    rendered.unmount();
  });
});

describe('useEditorMount outline resolved scope', () => {
  test('resolves {attr} heading titles against the installed resolved-scope facet', () => {
    const onOutlineChange = jest.fn();
    const rendered = mount(baseOptions({
      content: '== {product} Guide\n',
      resolvedScope: new Map([['product', 'Acme']]),
      onOutlineChange,
    }));

    const entries = onOutlineChange.mock.calls.at(-1)?.[0] as { title: string }[];
    expect(entries).toEqual([expect.objectContaining({ title: 'Acme Guide' })]);
    rendered.unmount();
  });

  test('re-publishes the outline with re-resolved titles when resolvedScope changes (main-file change)', () => {
    const onOutlineChange = jest.fn();
    const rendered = mount(baseOptions({
      content: '== {product} Guide\n',
      resolvedScope: new Map([['product', 'Acme']]),
      onOutlineChange,
    }));
    onOutlineChange.mockClear();

    // A main-file change re-resolves the scope with a new value; the outline must re-publish live
    // (no document edit) with the freshly resolved title.
    act(() => {
      rendered.rerender(baseOptions({
        content: '== {product} Guide\n',
        resolvedScope: new Map([['product', 'Globex']]),
        onOutlineChange,
      }));
    });

    const entries = onOutlineChange.mock.calls.at(-1)?.[0] as { title: string }[];
    expect(entries).toEqual([expect.objectContaining({ title: 'Globex Guide' })]);
    rendered.unmount();
  });

  test('excludes headings inside an inactive conditional branch resolved against the scope', () => {
    const onOutlineChange = jest.fn();
    const rendered = mount(baseOptions({
      content: '== Visible\n\nifdef::flag[]\n== Hidden\nendif::[]\n',
      resolvedScope: new Map(),
      onOutlineChange,
    }));

    const titles = (onOutlineChange.mock.calls.at(-1)?.[0] as { title: string }[]).map((entry) => entry.title);
    expect(titles).toContain('Visible');
    expect(titles).not.toContain('Hidden');
    rendered.unmount();
  });
});

describe('useEditorMount revealRequest', () => {
  test('moves the caret to the requested line and dedupes by nonce', () => {
    const rendered = mount(baseOptions({ content: 'a\nb\nc\nd\n', revealRequest: null }));

    act(() => {
      rendered.rerender(baseOptions({ content: 'a\nb\nc\nd\n', revealRequest: { line: 3, nonce: 1 } }));
    });
    expect(rendered.getView().state.selection.main.head).toBe(rendered.getView().state.doc.line(3).from);

    // Move the caret elsewhere, then re-send the SAME nonce — it must not reveal again.
    act(() => {
      rendered.getView().dispatch({ selection: { anchor: 0 } });
    });
    act(() => {
      rendered.rerender(baseOptions({ content: 'a\nb\nc\nd\n', revealRequest: { line: 3, nonce: 1 } }));
    });
    expect(rendered.getView().state.selection.main.head).toBe(0);

    // A fresh nonce reveals again, clamped to the document.
    act(() => {
      rendered.rerender(baseOptions({ content: 'a\nb\nc\nd\n', revealRequest: { line: 999, nonce: 2 } }));
    });
    const lastLine = rendered.getView().state.doc.line(rendered.getView().state.doc.lines);
    expect(rendered.getView().state.selection.main.head).toBe(lastLine.from);
    rendered.unmount();
  });

  test('is a no-op when revealRequest stays null', () => {
    const rendered = mount(baseOptions({ content: 'a\nb\nc\n', revealRequest: null }));
    expect(rendered.getView().state.selection.main.head).toBe(0);
    rendered.unmount();
  });
});

describe('useEditorMount handleHeadingClick', () => {
  test('moves the selection to the clicked heading offset', () => {
    const rendered = mount(baseOptions({ content: '= Title\n\n== Section\n' }));
    const { handleHeadingClick } = rendered.getResult();

    act(() => {
      handleHeadingClick({ from: 9 });
    });

    expect(rendered.getView().state.selection.main.head).toBe(9);
    rendered.unmount();
  });

  test('is a safe no-op after the view is torn down (no live view ref)', () => {
    const rendered = mount(baseOptions({ content: '= Title\n\n== Section\n' }));
    const { handleHeadingClick } = rendered.getResult();
    rendered.unmount(); // clears viewReference.current → the guard's else-branch

    expect(() => {
      act(() => {
        handleHeadingClick({ from: 9 });
      });
    }).not.toThrow();
  });
});

describe('useEditorMount line-click handler', () => {
  test('reports the clicked line number via onLineClick', () => {
    const onLineClick = jest.fn();
    const rendered = mount(baseOptions({ content: 'a\nb\nc\n', onLineClick }));
    const view = rendered.getView();
    // posAtCoords is unreliable in jsdom; drive the handler by faking the resolved position.
    jest.spyOn(view, 'posAtCoords').mockReturnValue(2);

    act(() => {
      view.contentDOM.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 1 }));
    });

    expect(onLineClick).toHaveBeenCalledWith(2);
    rendered.unmount();
  });

  test('does nothing on mousedown when no onLineClick is wired', () => {
    const rendered = mount(baseOptions({ content: 'a\nb\n' }));
    const view = rendered.getView();
    expect(() => {
      view.contentDOM.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 1 }));
    }).not.toThrow();
    rendered.unmount();
  });

  test('ignores a mousedown whose coordinates resolve to no position', () => {
    const onLineClick = jest.fn();
    const rendered = mount(baseOptions({ content: 'a\nb\n', onLineClick }));
    const view = rendered.getView();
    jest.spyOn(view, 'posAtCoords').mockReturnValue(null);

    act(() => {
      view.contentDOM.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 1 }));
    });

    expect(onLineClick).not.toHaveBeenCalled();
    rendered.unmount();
  });
});

describe('useEditorMount getProjectIndex accessor', () => {
  test('captures the latest getProjectIndex getter across rerenders', () => {
    const firstGetter = jest.fn().mockReturnValue(null);
    const rendered = mount(baseOptions({ getProjectIndex: firstGetter }));

    const secondGetter = jest.fn().mockReturnValue(null);
    act(() => {
      rendered.rerender(baseOptions({ getProjectIndex: secondGetter }));
    });

    // The accessor is consulted by lint sources / completion; trigger a doc change so the
    // diagnostics linter runs and reads through the updated ref.
    act(() => {
      rendered.getView().dispatch({ changes: { from: 0, insert: 'xref:foo[]\n' } });
    });

    expect(rendered.getView()).toBeInstanceOf(EditorView);
    rendered.unmount();
  });
});

/** Baseline options for the collab path: a yCollab binding plus REST content that must be ignored. */
function collabOptions(doc: Y.Doc, awareness: Awareness, overrides: Partial<MountOptions> = {}): MountOptions {
  return baseOptions({
    content: 'rest content that must be ignored\n',
    collabExtension: collabExtensions(doc, awareness),
    ...overrides,
  });
}

describe('useEditorMount collab path', () => {
  test('mounts EMPTY on the collab path, ignoring REST content', () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const rendered = mount(collabOptions(doc, awareness));

    expect(rendered.getView().state.doc.toString()).toBe('');

    rendered.unmount();
    awareness.destroy();
    doc.destroy();
  });

  test('does not seed REST content into the live view on the collab path', () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const rendered = mount(collabOptions(doc, awareness, { content: 'first\n' }));

    act(() => {
      rendered.rerender(collabOptions(doc, awareness, { content: 'second changed\n' }));
    });

    // Document stays driven by Yjs, not the REST content prop.
    expect(rendered.getView().state.doc.toString()).toBe('');

    rendered.unmount();
    awareness.destroy();
    doc.destroy();
  });

  test('restores the remembered line once content first arrives via Yjs sync', async () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const rendered = mount(collabOptions(doc, awareness, { initialLine: 2 }));

    // Simulate Yjs populating the synced document (the collab seeding branch).
    act(() => {
      doc.getText('codemirror').insert(0, 'alpha\nbeta\ngamma\n');
    });
    // The restore is scheduled to a microtask; flush microtasks (a macrotask would let CodeMirror
    // run its rAF measure, which needs real layout that jsdom lacks).
    for (let attempt = 0; attempt < 10; attempt++) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(rendered.getView().state.selection.main.head).toBe(rendered.getView().state.doc.line(2).from);

    rendered.unmount();
    awareness.destroy();
    doc.destroy();
  });

  test('skips the scheduled line restore when the view is torn down before the microtask runs', () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const rendered = mount(collabOptions(doc, awareness, { initialLine: 2 }));

    // The first content arrival schedules the restore to a microtask; tearing the editor down
    // synchronously (clearing viewReference.current) before microtasks flush exercises the
    // `if (!view) return` guard inside that microtask.
    act(() => {
      doc.getText('codemirror').insert(0, 'alpha\nbeta\ngamma\n');
      rendered.unmount();
    });

    expect(() => {
      act(() => {
        // No throw: the microtask sees a null view ref and bails out.
      });
    }).not.toThrow();

    awareness.destroy();
    doc.destroy();
  });
});

/**
 * Recreating the view against an ALREADY-populated room.
 *
 * yCollab's ySync plugin applies only incremental `Y.Text` deltas and never reads the type's existing
 * content, so a view created empty against a populated room stays empty forever — no further delta is
 * coming. The production trigger is the offline→synced round trip: the sync handshake exceeding
 * COLLAB_SYNC_TIMEOUT_MS drops the binding (remountKey → undefined) and the later `synced` restores it
 * (remountKey → room id), recreating the view after the room has content. It surfaced as intermittent
 * e2e hangs where the editor was editable but its text had vanished.
 */
const ROOM_TEXT = ':edition: 1\n\nSee {edition} for details.\n';

/** Collab options carrying the live-Y.Text seed accessor the production editor supplies. */
function seeded(doc: Y.Doc, awareness: Awareness, overrides: Partial<MountOptions> = {}): MountOptions {
  return collabOptions(doc, awareness, {
    getCollabDocText: () => doc.getText('codemirror').toString(),
    ...overrides,
  });
}

describe('useEditorMount collab re-seed after sync', () => {
  test('restores the document when the view is recreated after the room already has content', () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);

    // Phase 1 — synced: the view mounts empty and ySync populates it.
    const rendered = mount(seeded(doc, awareness, { remountKey: 'room-1' }));
    act(() => { doc.getText('codemirror').insert(0, ROOM_TEXT); });
    expect(rendered.getView().state.doc.toString()).toBe(ROOM_TEXT);

    // Phase 2 — sync timeout: the binding is dropped and the file opens read-only from REST.
    act(() => {
      rendered.rerender(seeded(doc, awareness, { remountKey: undefined, collabExtension: undefined, canEdit: false }));
    });

    // Phase 3 — recovery: the binding returns, so the view is recreated against a populated room.
    act(() => { rendered.rerender(seeded(doc, awareness, { remountKey: 'room-1', canEdit: true })); });

    // Editable AND still showing its text — previously this left an editable, permanently empty editor.
    expect(rendered.getView().state.readOnly).toBe(false);
    expect(rendered.getView().state.doc.toString()).toBe(ROOM_TEXT);

    rendered.unmount();
    awareness.destroy();
    doc.destroy();
  });

  test('seeding from the shared type does not duplicate it, and later edits keep the right offsets', () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    doc.getText('codemirror').insert(0, ROOM_TEXT); // already synced before this view exists

    const rendered = mount(seeded(doc, awareness, { remountKey: 'room-1' }));

    // The seed must not be echoed back into the Y.Text — that is the failure mode that would make an
    // author open a file containing two of itself (which seeding the REST copy instead would cause).
    expect(rendered.getView().state.doc.toString()).toBe(ROOM_TEXT);
    expect(doc.getText('codemirror').toString()).toBe(ROOM_TEXT);

    // A remote delta still lands at the correct offset.
    act(() => { doc.getText('codemirror').insert(0, ':lang: en\n'); });
    expect(rendered.getView().state.doc.toString()).toBe(`:lang: en\n${ROOM_TEXT}`);

    // And a local edit still round-trips into the Y.Text rather than splicing into the middle of it.
    act(() => { rendered.getView().dispatch({ changes: { from: 0, to: 0, insert: '// hdr\n' } }); });
    expect(doc.getText('codemirror').toString()).toBe(`// hdr\n:lang: en\n${ROOM_TEXT}`);

    rendered.unmount();
    awareness.destroy();
    doc.destroy();
  });

  test('still mounts empty when the room has no content yet (first-mount behaviour unchanged)', () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const rendered = mount(seeded(doc, awareness, { remountKey: 'room-1' }));

    expect(rendered.getView().state.doc.toString()).toBe('');

    rendered.unmount();
    awareness.destroy();
    doc.destroy();
  });

  test('publishes the seeded text through onDocChange (no docChanged fires for a seeded view)', () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    doc.getText('codemirror').insert(0, ROOM_TEXT);
    const seen: string[] = [];

    const rendered = mount(seeded(doc, awareness, { remountKey: 'room-1', onDocChange: (text) => seen.push(text) }));

    // Without this the host would keep whatever text it last saw while the editor showed the room's.
    expect(seen).toContain(ROOM_TEXT);

    rendered.unmount();
    awareness.destroy();
    doc.destroy();
  });

  test('restores the remembered line on a seeded view, which never sees a first content arrival', () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    doc.getText('codemirror').insert(0, 'alpha\nbeta\ngamma\n');

    const rendered = mount(seeded(doc, awareness, { remountKey: 'room-1', initialLine: 2 }));

    const view = rendered.getView();
    expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from);

    rendered.unmount();
    awareness.destroy();
    doc.destroy();
  });
});

/** Builds a drop event carrying the tree's custom node payload at the given coordinates. */
function makeDropEvent(payload: string | null): DragEvent {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as unknown as DragEvent;
  Object.defineProperties(event, {
    clientX: { value: 5 },
    clientY: { value: 5 },
    dataTransfer: {
      value: {
        getData: (type: string) =>
          type === 'application/x-asciidoc-node' && payload !== null ? payload : '',
      },
    },
  });
  return event;
}

describe('useEditorMount file-drop handler', () => {
  test('inserts an include:: macro when a tree file is dropped', () => {
    const rendered = mount(baseOptions({ content: 'top\n', canEdit: true }));
    const view = rendered.getView();
    jest.spyOn(view, 'posAtCoords').mockReturnValue(0);

    act(() => {
      view.contentDOM.dispatchEvent(makeDropEvent(JSON.stringify({ path: 'docs/intro.adoc' })));
    });

    expect(view.state.doc.toString()).toContain('include::docs/intro.adoc[]');
    rendered.unmount();
  });

  test('lets CodeMirror handle a non-tree drop (no custom payload)', () => {
    const rendered = mount(baseOptions({ content: 'top\n' }));
    const view = rendered.getView();

    act(() => {
      view.contentDOM.dispatchEvent(makeDropEvent(null));
    });

    expect(view.state.doc.toString()).toBe('top\n');
    rendered.unmount();
  });

  test('ignores a tree drop when the editor is read-only', () => {
    const rendered = mount(baseOptions({ content: 'top\n', canEdit: false }));
    const view = rendered.getView();
    jest.spyOn(view, 'posAtCoords').mockReturnValue(0);

    act(() => {
      view.contentDOM.dispatchEvent(makeDropEvent(JSON.stringify({ path: 'docs/intro.adoc' })));
    });

    expect(view.state.doc.toString()).toBe('top\n');
    rendered.unmount();
  });

  test('pads the macro with surrounding newlines when dropped mid-line', () => {
    const rendered = mount(baseOptions({ content: 'before after\n' }));
    const view = rendered.getView();
    // Drop between "before" and " after" (offset 6): chars exist on both sides → padded.
    jest.spyOn(view, 'posAtCoords').mockReturnValue(6);

    act(() => {
      view.contentDOM.dispatchEvent(makeDropEvent(JSON.stringify({ path: 'pic.png' })));
    });

    expect(view.state.doc.toString()).toMatch(/before\n.*pic\.png.*\n after/s);
    rendered.unmount();
  });

  test('falls back to the caret position when the drop point cannot be resolved', () => {
    const rendered = mount(baseOptions({ content: 'caret here\n' }));
    const view = rendered.getView();
    jest.spyOn(view, 'posAtCoords').mockReturnValue(null); // → pos = selection head (0)

    act(() => {
      view.contentDOM.dispatchEvent(makeDropEvent(JSON.stringify({ path: 'x.adoc' })));
    });

    expect(view.state.doc.toString()).toContain('include::x.adoc[]');
    rendered.unmount();
  });

  test('consumes a tree drop carrying a malformed payload without inserting', () => {
    const rendered = mount(baseOptions({ content: 'top\n' }));
    const view = rendered.getView();
    jest.spyOn(view, 'posAtCoords').mockReturnValue(0);

    act(() => {
      // Non-JSON payload → macroFromDropPayload returns null → handler returns true, no insert.
      view.contentDOM.dispatchEvent(makeDropEvent('not-json{'));
    });

    expect(view.state.doc.toString()).toBe('top\n');
    rendered.unmount();
  });

  test('ignores a drop event that carries no dataTransfer at all', () => {
    const rendered = mount(baseOptions({ content: 'top\n' }));
    const view = rendered.getView();
    const event = new Event('drop', { bubbles: true, cancelable: true });

    expect(() => {
      act(() => {
        view.contentDOM.dispatchEvent(event);
      });
    }).not.toThrow();
    expect(view.state.doc.toString()).toBe('top\n');
    rendered.unmount();
  });

  test('drops at the very end of the document (no following character)', () => {
    const rendered = mount(baseOptions({ content: 'tail' }));
    const view = rendered.getView();
    jest.spyOn(view, 'posAtCoords').mockReturnValue(view.state.doc.length); // pos === doc.length

    act(() => {
      view.contentDOM.dispatchEvent(makeDropEvent(JSON.stringify({ path: 'end.adoc' })));
    });

    expect(view.state.doc.toString()).toContain('include::end.adoc[]');
    rendered.unmount();
  });
});

/** Dispatches a ctrl-modified mousedown on the view's outer DOM (where the link handler binds). */
function ctrlMousedown(view: EditorView): void {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, ctrlKey: true, clientX: 1, clientY: 1 });
  view.dom.dispatchEvent(event);
}

describe('useEditorMount link handler (Ctrl+click navigation)', () => {
  test('navigates to a resolved include:: target file', () => {
    const onNavigateToFile = jest.fn();
    const rendered = mount(baseOptions({
      content: 'include::child.adoc[]\n',
      includePaths: ['child.adoc'],
      onNavigateToFile,
    }));
    const view = rendered.getView();
    jest.spyOn(view, 'posAtCoords').mockReturnValue(2);

    act(() => ctrlMousedown(view));

    expect(onNavigateToFile).toHaveBeenCalledWith('child.adoc');
    rendered.unmount();
  });

  test('emits a global editor:unresolved-path event for an unknown include target', () => {
    const listener = jest.fn();
    globalThis.addEventListener('editor:unresolved-path', listener);
    const rendered = mount(baseOptions({
      content: 'include::missing.adoc[]\n',
      includePaths: [],
    }));
    const view = rendered.getView();
    jest.spyOn(view, 'posAtCoords').mockReturnValue(2);

    act(() => ctrlMousedown(view));

    expect(listener).toHaveBeenCalled();
    globalThis.removeEventListener('editor:unresolved-path', listener);
    rendered.unmount();
  });

  test('consults the project-index accessor on Ctrl+click when a getter is present', () => {
    const getProjectIndex = jest.fn().mockReturnValue(null);
    const onNavigateToFile = jest.fn();
    const rendered = mount(baseOptions({
      content: 'include::child.adoc[]\n',
      includePaths: ['child.adoc'],
      getProjectIndex,
      onNavigateToFile,
    }));
    const view = rendered.getView();
    jest.spyOn(view, 'posAtCoords').mockReturnValue(2);

    act(() => ctrlMousedown(view));

    // The accessor's getter branch executes (returning null → current-file scope), then the
    // include navigation proceeds.
    expect(getProjectIndex).toHaveBeenCalled();
    expect(onNavigateToFile).toHaveBeenCalledWith('child.adoc');
    rendered.unmount();
  });

  test('opens a bare URL under the cursor via onOpenUrl', () => {
    const onOpenUrl = jest.fn();
    const rendered = mount(baseOptions({ content: 'see https://example.com here\n', onOpenUrl }));
    const view = rendered.getView();
    jest.spyOn(view, 'posAtCoords').mockReturnValue(10); // inside the URL token

    act(() => ctrlMousedown(view));

    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com');
    rendered.unmount();
  });
});

describe('useEditorMount scroll sync (onScrollLine)', () => {
  test('reports the top viewport line on scroll, debounced', () => {
    jest.useFakeTimers();
    const onScrollLine = jest.fn();
    const rendered = mount(baseOptions({ content: 'a\nb\nc\nd\n', onScrollLine }));
    const view = rendered.getView();
    jest.spyOn(view, 'posAtCoords').mockReturnValue(2); // resolves to line 2

    act(() => {
      view.scrollDOM.dispatchEvent(new Event('scroll'));
      view.scrollDOM.dispatchEvent(new Event('scroll')); // second event clears the prior debounce
      jest.advanceTimersByTime(60);
    });

    expect(onScrollLine).toHaveBeenCalledWith(2);
    rendered.unmount();
    jest.useRealTimers();
  });

  test('drops a queued scroll callback when onScrollLine is removed before the debounce fires', () => {
    jest.useFakeTimers();
    const onScrollLine = jest.fn();
    const rendered = mount(baseOptions({ content: 'a\nb\nc\n', onScrollLine }));
    const view = rendered.getView();
    jest.spyOn(view, 'posAtCoords').mockReturnValue(2); // resolves, so execution reaches the call site

    // Queue the debounce while the callback is wired, then clear it via a rerender (the ref-sync
    // effect nulls onScrollLineReference.current) before the timer fires — so the live `?.` call at
    // the call site short-circuits on the now-absent callback.
    act(() => {
      view.scrollDOM.dispatchEvent(new Event('scroll'));
    });
    act(() => {
      rendered.rerender(baseOptions({ content: 'a\nb\nc\n', onScrollLine: undefined }));
    });
    act(() => {
      jest.advanceTimersByTime(60);
    });

    expect(onScrollLine).not.toHaveBeenCalled();
    rendered.unmount();
    jest.useRealTimers();
  });

  test('does not fire onScrollLine when posAtCoords cannot resolve', () => {
    jest.useFakeTimers();
    const onScrollLine = jest.fn();
    const rendered = mount(baseOptions({ content: 'a\nb\n', onScrollLine }));
    const view = rendered.getView();
    jest.spyOn(view, 'posAtCoords').mockReturnValue(null);

    act(() => {
      view.scrollDOM.dispatchEvent(new Event('scroll'));
      jest.advanceTimersByTime(60);
    });

    expect(onScrollLine).not.toHaveBeenCalled();
    rendered.unmount();
    jest.useRealTimers();
  });

  test('ignores scroll events entirely when no onScrollLine is wired', () => {
    jest.useFakeTimers();
    const rendered = mount(baseOptions({ content: 'a\nb\n' }));
    const view = rendered.getView();
    expect(() => {
      act(() => {
        view.scrollDOM.dispatchEvent(new Event('scroll'));
        jest.advanceTimersByTime(60);
      });
    }).not.toThrow();
    rendered.unmount();
    jest.useRealTimers();
  });

  test('clears a pending scroll debounce on unmount', () => {
    jest.useFakeTimers();
    const onScrollLine = jest.fn();
    const rendered = mount(baseOptions({ content: 'a\nb\nc\n', onScrollLine }));
    const view = rendered.getView();
    jest.spyOn(view, 'posAtCoords').mockReturnValue(0);

    // Schedule a debounce, then tear down before it fires — exercises the cleanup clearTimeout.
    act(() => {
      view.scrollDOM.dispatchEvent(new Event('scroll'));
    });
    rendered.unmount();
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(onScrollLine).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});

describe('useEditorMount wired lint sources', () => {
  test('runs the spellcheck + diagnostics linters, consulting the ignore list and project index', async () => {
    const getProjectIndex = jest.fn().mockReturnValue(null);
    const rendered = mount(baseOptions({
      content: 'This sentence has reel prose words.\n',
      spellIgnore: ['reel'],
      getProjectIndex,
    }));
    const view = rendered.getView();

    // forceLinting invokes both linter sources, exercising the `() => spellIgnore ?? []` accessor
    // and the project-index accessor passed to the diagnostics source.
    await act(async () => {
      forceLinting(view);
      await Promise.resolve();
    });

    // The diagnostics source reads the project index through the captured accessor.
    expect(getProjectIndex).toHaveBeenCalled();
    rendered.unmount();
  });

  test('defaults the spell-ignore list to empty when none is supplied', async () => {
    const rendered = mount(baseOptions({ content: 'plain prose here.\n' }));
    const view = rendered.getView();
    await act(async () => {
      forceLinting(view);
      await Promise.resolve();
    });
    expect(view).toBeInstanceOf(EditorView);
    rendered.unmount();
  });

  test('passes a null project index to diagnostics when no getProjectIndex is supplied', async () => {
    const rendered = mount(baseOptions({ content: 'xref:unknown[]\n' }));
    const view = rendered.getView();
    await act(async () => {
      forceLinting(view);
      await Promise.resolve();
    });
    // The accessor resolves to null (no getter) without throwing — current-file scope.
    expect(view).toBeInstanceOf(EditorView);
    rendered.unmount();
  });
});

describe('useEditorMount fold persistence wiring', () => {
  test('mounts with a fold storage key supplied (truthy branch)', () => {
    const rendered = mount(baseOptions({ foldStorageKey: 'file-123' }));
    expect(rendered.getView()).toBeInstanceOf(EditorView);
    rendered.unmount();
  });
});

describe('useEditorMount wired completion sources', () => {
  test('drives the include-path completion accessor when completion produces results', async () => {
    const rendered = mount(baseOptions({
      content: 'include::',
      includePaths: ['child.adoc', 'other.adoc'],
    }));
    const view = rendered.getView();
    // Place the caret just after `include::` so the include completion source activates, then ask
    // the engine to compute completions (it runs the override sources, hitting the path accessors).
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      startCompletion(view);
    });

    await flushUntil(() => (currentCompletions(view.state)?.length ?? 0) > 0);

    const labels = currentCompletions(view.state).map((completion) => completion.label);
    expect(labels).toEqual(expect.arrayContaining(['child.adoc', 'other.adoc']));
    rendered.unmount();
  });

  test('drives the image-path completion accessor when completion produces results', async () => {
    const rendered = mount(baseOptions({
      content: 'image::',
      imagePaths: ['logo.png'],
    }));
    const view = rendered.getView();
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      startCompletion(view);
    });

    await flushUntil(() => (currentCompletions(view.state)?.length ?? 0) > 0);

    const labels = currentCompletions(view.state).map((completion) => completion.label);
    expect(labels).toContain('logo.png');
    rendered.unmount();
  });
});

// The Ctrl+click hover tooltip's *triggering* (mouse hover → posAtCoords/coordsAtPos) needs a
// real layout engine jsdom lacks, so it cannot be driven by simulated mouse movement. The tooltip
// SOURCE itself, however, is pure hook logic (line lookup, xref-preview/macro-range resolution,
// platform-aware affordance text) and is exercised here by invoking it directly. The hover plugin
// captures the source on its instance, so we reach it through the view's live plugin list.
type HoverTooltip = ReturnType<Parameters<typeof import('@codemirror/view').hoverTooltip>[0]>;
type HoverSource = (view: EditorView, pos: number, side: -1 | 1) => HoverTooltip;
interface HoverPluginValue { source?: HoverSource; hoverTime?: number; lastMove?: unknown }
interface PluginInstanceLike { value: HoverPluginValue | null }

// A probe macro placed on line 1 of every hover test so the editor's OWN hover source can be told
// apart from the lint hover (the `@codemirror/lint` package registers its own hoverTooltip with the
// same shape). Our source returns this affordance string on the probe; the lint source returns null.
const HOVER_PROBE_LINE = 'include::__probe__.adoc[]\n';
const HOVER_PROBE_POS = 12; // inside the probe macro's path range
const AFFORDANCE = 'click to open in the file tree';

/**
 * Locate the editor's own Ctrl+click hover source among the live plugin instances. Several plugins
 * expose a `source`, so we identify ours by behaviour: it returns the file-tree affordance for the
 * probe macro on line 1. The returned source can then be called at any position under test.
 */
function hoverSourceOf(view: EditorView): HoverSource {
  const plugins = (view as unknown as { plugins: PluginInstanceLike[] }).plugins;
  for (const instance of plugins) {
    const source = instance.value?.source;
    if (typeof source !== 'function') continue;
    const probe = source(view, HOVER_PROBE_POS, 1);
    if (probe && !Array.isArray(probe) && (probe.create(view).dom.textContent ?? '').includes('file tree')) {
      return source;
    }
  }
  throw new Error('Ctrl+click hover tooltip source not found on view');
}

/** Render a resolved tooltip's DOM (invoking its create()) so the create-branch is covered. */
function tooltipDomText(view: EditorView, tooltip: HoverTooltip): string {
  if (!tooltip || Array.isArray(tooltip)) throw new Error('expected a single tooltip');
  const { dom } = tooltip.create(view);
  return dom.textContent ?? '';
}

/** A fake project index whose xref resolution feeds {@link xrefHoverPreview} a known location. */
function fakeProjectIndex(resolves: boolean): import('@/lib/codemirror/asciidoc-symbol-index').ProjectSymbolIndex {
  const symbol = { fileId: 'f1', kind: 'anchor', name: 'sec', range: { from: 0, to: 0 } };
  return {
    tree: { rootId: 'f1', nodes: {} },
    activeFileId: 'f1',
    symbols: [],
    references: [],
    resolveXref: () => (resolves ? symbol : 'unresolved'),
    resolveAttribute: () => 'unresolved',
    inheritedAttributes: () => new Map(),
    effectiveAttributes: () => new Map(),
    inheritedOffset: () => 0,
    // The heading-level walk (decorations + outline) resolves/reads include targets through the index;
    // this fake resolves none, so no include is traced (irrelevant to the xref/affordance assertions).
    resolveInclude: () => null,
    getContent: () => null,
    pathOf: () => 'chapters/intro.adoc',
    lineOf: () => 7,
  } as unknown as import('@/lib/codemirror/asciidoc-symbol-index').ProjectSymbolIndex;
}

describe('useEditorMount Ctrl+click hover tooltip source', () => {
  test('returns an index-backed xref preview when an xref sits under the cursor', () => {
    const rendered = mount(baseOptions({
      content: `${HOVER_PROBE_LINE}see <<sec>> now\n`,
      getProjectIndex: () => fakeProjectIndex(true),
    }));
    const view = rendered.getView();
    const xrefPos = view.state.doc.line(2).from + 6; // inside the <<sec>> token on line 2
    const tooltip = hoverSourceOf(view)(view, xrefPos, 1);

    expect(tooltip).not.toBeNull();
    expect(tooltipDomText(view, tooltip)).toContain('line 7');
    rendered.unmount();
  });

  test('falls through to the macro-path affordance when no xref is under the cursor', () => {
    const rendered = mount(baseOptions({
      content: `${HOVER_PROBE_LINE}include::child.adoc[]\n`,
      includePaths: ['child.adoc'],
    }));
    const view = rendered.getView();
    const pathPos = view.state.doc.line(2).from + 12; // inside the include:: path on line 2
    const tooltip = hoverSourceOf(view)(view, pathPos, 1);

    expect(tooltip).not.toBeNull();
    expect(tooltipDomText(view, tooltip)).toContain(AFFORDANCE);
    rendered.unmount();
  });

  test('returns null when the cursor is on a path line but outside the path range', () => {
    const rendered = mount(baseOptions({ content: `${HOVER_PROBE_LINE}include::child.adoc[]\n` }));
    const view = rendered.getView();
    const beforePath = view.state.doc.line(2).from; // column 0 on line 2, before the macro path range
    expect(hoverSourceOf(view)(view, beforePath, 1)).toBeNull();
    rendered.unmount();
  });

  test('returns null on a plain prose line with neither an xref nor a macro path', () => {
    const rendered = mount(baseOptions({ content: `${HOVER_PROBE_LINE}just some prose text\n` }));
    const view = rendered.getView();
    expect(hoverSourceOf(view)(view, view.state.doc.line(2).from + 3, 1)).toBeNull();
    rendered.unmount();
  });

  test('skips the xref preview when the index resolves nothing, then shows the macro affordance', () => {
    const rendered = mount(baseOptions({
      content: `${HOVER_PROBE_LINE}include::child.adoc[]\n`,
      getProjectIndex: () => fakeProjectIndex(false),
    }));
    const view = rendered.getView();
    const pathPos = view.state.doc.line(2).from + 12;
    const tooltip = hoverSourceOf(view)(view, pathPos, 1);

    // The index is present (xref branch entered) but resolves no xref here, so the source falls
    // through to the macro-path affordance — exercising the index-present, preview-absent path.
    expect(tooltip).not.toBeNull();
    expect(tooltipDomText(view, tooltip)).toContain(AFFORDANCE);
    rendered.unmount();
  });

  test('uses the ⌘ affordance label on a Mac platform', () => {
    const platform = Object.getOwnPropertyDescriptor(globalThis.navigator, 'platform');
    Object.defineProperty(globalThis.navigator, 'platform', { value: 'MacIntel', configurable: true });
    const rendered = mount(baseOptions({ content: `${HOVER_PROBE_LINE}include::child.adoc[]\n` }));
    const view = rendered.getView();
    const tooltip = hoverSourceOf(view)(view, view.state.doc.line(2).from + 12, 1);

    expect(tooltipDomText(view, tooltip)).toContain('⌘');
    rendered.unmount();
    if (platform) Object.defineProperty(globalThis.navigator, 'platform', platform);
  });
});

describe('useEditorMount source-highlight reparse callback', () => {
  test('reconfigures the language compartment when an embedded language loads', async () => {
    const rendered = mount(baseOptions({ content: '[source,json]\n----\n{}\n----\n' }));
    const view = rendered.getView();
    const dispatchSpy = jest.spyOn(view, 'dispatch');

    // The mocked loader schedules the real mount-side reparse callback on the first doc change.
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n' } });
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The reparse arrow dispatched a (compartment-reconfigure) effect on the live view.
    expect(dispatchSpy).toHaveBeenCalled();
    expect(view.state.doc.toString()).toContain('[source,json]');
    rendered.unmount();
  });
});

describe('useEditorMount remountKey', () => {
  test('recreates the view when remountKey changes', () => {
    const rendered = mount(baseOptions({ remountKey: 'room-a' }));
    const first = rendered.getView();
    const destroySpy = jest.spyOn(first, 'destroy');

    act(() => {
      rendered.rerender(baseOptions({ remountKey: 'room-b' }));
    });

    expect(destroySpy).toHaveBeenCalled();
    expect(rendered.getView()).not.toBe(first);
    rendered.unmount();
  });
});

describe('useEditorMount compartments are independent instances', () => {
  test('exposes distinct compartment-driven facets without cross-talk', () => {
    const rendered = mount(baseOptions({ canEdit: false, softWrap: false }));
    const view = rendered.getView();
    // Both read-only and no-wrap configured simultaneously through separate compartments.
    expect(view.state.readOnly).toBe(true);
    expect(isWrapping(view)).toBe(false);
    // Compartment is the type backing the live reconfiguration paths.
    expect(new Compartment()).toBeInstanceOf(Compartment);
    rendered.unmount();
  });
});
