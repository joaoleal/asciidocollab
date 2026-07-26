import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import { EditorState } from '@codemirror/state';
import { EditorView, type Command } from '@codemirror/view';
import { LRLanguage, LanguageSupport } from '@codemirror/language';
import {
  AUTO_WRAP_MARKS,
  autoWrapInputHandler,
  formatKeymap,
  wrapWith,
} from '@/lib/codemirror/asciidoc-format-keymap';
import { createTestBlockTokenizer, createTestBlockContext } from '../../helpers/asciidoc-test-tokenizer';

/**
 * Coverage for the formatting keymap: the pure `wrapWith`
 * helper, the Mod-b/i/` wrap commands, the Mod-/ comment toggle, and the
 * type-over-selection auto-wrap input handler — all driven through a real,
 * mounted `EditorView` in jsdom.
 */

// A language built from the AsciiDoc grammar (the generated parser is ESM and not
// loadable in jest), carrying `commentTokens` so `toggleComment` (bound to Mod-/)
// has a line-comment configuration to act on.
const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');
const lezerParser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
});
const asciidocLang = new LanguageSupport(
  LRLanguage.define({
    name: 'asciidoc',
    parser: lezerParser,
    languageData: { commentTokens: { line: '//' } },
  }),
);

const mounted: EditorView[] = [];

/** Builds a mounted EditorView with the doc + selection and the auto-wrap handler. */
function setup(doc: string, anchor: number, head: number = anchor): EditorView {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [asciidocLang, autoWrapInputHandler],
    }),
    parent,
  });
  mounted.push(view);
  return view;
}

/** Runs a command and returns the resulting doc + main selection span. */
function runCommand(view: EditorView, command: Command): { handled: boolean; doc: string; from: number; to: number } {
  const handled = command(view);
  const { from, to } = view.state.selection.main;
  return { handled, doc: view.state.doc.toString(), from, to };
}

/** Finds a binding's `run` command in `formatKeymap` by key. */
function bindingFor(key: string): Command {
  const binding = formatKeymap.find((entry) => entry.key === key);
  if (binding?.run === undefined) throw new Error(`no binding for ${key}`);
  return binding.run;
}

/** Invokes the registered auto-wrap input handler the way CodeMirror's input pipeline would. */
function typeInput(view: EditorView, from: number, to: number, text: string): boolean {
  const [handler] = view.state.facet(EditorView.inputHandler);
  return handler(view, from, to, text, () => view.state.update({ changes: { from, to, insert: text } }));
}

afterEach(() => {
  for (const view of mounted.splice(0)) view.destroy();
});

describe('AUTO_WRAP_MARKS', () => {
  test('contains every emphasis mark and nothing extra', () => {
    expect([...AUTO_WRAP_MARKS].toSorted()).toEqual(['#', '*', '^', '_', '`', '~']);
  });
});

describe('wrapWith (pure helper)', () => {
  test('wraps a non-empty selection and spans the inner text', () => {
    expect(wrapWith('word', '*')).toEqual({ insert: '*word*', innerFrom: 1, innerTo: 5 });
  });

  test('uses the placeholder for an empty selection', () => {
    expect(wrapWith('', '*', 'bold')).toEqual({ insert: '*bold*', innerFrom: 1, innerTo: 5 });
  });

  test('empty selection with the default (empty) placeholder yields bare marks', () => {
    expect(wrapWith('', '`')).toEqual({ insert: '``', innerFrom: 1, innerTo: 1 });
  });

  test('multi-character marks offset the inner span by the mark length', () => {
    expect(wrapWith('hi', '##')).toEqual({ insert: '##hi##', innerFrom: 2, innerTo: 4 });
  });
});

describe('formatKeymap — binding metadata', () => {
  test('registers Mod-b/i/`// in order, all with preventDefault', () => {
    expect(formatKeymap.map((entry) => entry.key)).toEqual(['Mod-b', 'Mod-i', 'Mod-`', 'Mod-/']);
    for (const binding of formatKeymap) expect(binding.preventDefault).toBe(true);
  });
});

describe('wrap commands — apply to a selection', () => {
  test('Mod-b wraps the selection in `*` and selects the inner text', () => {
    const view = setup('a word b', 2, 6); // select "word"
    const r = runCommand(view, bindingFor('Mod-b'));
    expect(r.handled).toBe(true);
    expect(r.doc).toBe('a *word* b');
    expect([r.from, r.to]).toEqual([3, 7]);
  });

  test('Mod-i wraps the selection in `_`', () => {
    const view = setup('word', 0, 4);
    const r = runCommand(view, bindingFor('Mod-i'));
    expect(r.doc).toBe('_word_');
    expect([r.from, r.to]).toEqual([1, 5]);
  });

  test('Mod-` wraps the selection in a backtick', () => {
    const view = setup('code', 0, 4);
    const r = runCommand(view, bindingFor('Mod-`'));
    expect(r.doc).toBe('`code`');
    expect([r.from, r.to]).toEqual([1, 5]);
  });
});

describe('wrap commands — empty cursor inserts placeholder', () => {
  test('Mod-b at an empty cursor inserts `*bold*` and selects the placeholder', () => {
    const view = setup('xy', 1, 1);
    const r = runCommand(view, bindingFor('Mod-b'));
    expect(r.doc).toBe('x*bold*y');
    expect([r.from, r.to]).toEqual([2, 6]);
  });

  test('Mod-i at an empty cursor inserts `_italic_`', () => {
    const view = setup('', 0, 0);
    const r = runCommand(view, bindingFor('Mod-i'));
    expect(r.doc).toBe('_italic_');
    expect([r.from, r.to]).toEqual([1, 7]);
  });

  test('Mod-` at an empty cursor inserts the `code` placeholder', () => {
    const view = setup('', 0, 0);
    const r = runCommand(view, bindingFor('Mod-`'));
    expect(r.doc).toBe('`code`');
    expect([r.from, r.to]).toEqual([1, 5]);
  });
});

describe('Mod-/ — toggleComment', () => {
  test('comments an uncommented line then uncomments it on a second run', () => {
    const view = setup('hello', 0, 0);
    const toggle = bindingFor('Mod-/');

    expect(toggle(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('// hello');

    expect(toggle(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('hello');
  });
});

describe('autoWrapInputHandler', () => {
  test('typing an emphasis mark over a selection wraps it and selects the inner text', () => {
    const view = setup('a word b', 2, 6); // select "word"
    const handled = typeInput(view, 2, 6, '*');
    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe('a *word* b');
    expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([3, 7]);
  });

  test('returns false for an empty selection (from === to) and changes nothing', () => {
    const view = setup('word', 2, 2);
    const handled = typeInput(view, 2, 2, '*');
    expect(handled).toBe(false);
    expect(view.state.doc.toString()).toBe('word');
  });

  test('returns false for a non-emphasis character even over a selection', () => {
    const view = setup('word', 0, 4);
    const handled = typeInput(view, 0, 4, 'a');
    expect(handled).toBe(false);
    expect(view.state.doc.toString()).toBe('word');
  });

  test('wraps with each of the other emphasis marks', () => {
    for (const mark of ['_', '`', '#', '~', '^']) {
      const view = setup('x', 0, 1);
      const handled = typeInput(view, 0, 1, mark);
      expect(handled).toBe(true);
      expect(view.state.doc.toString()).toBe(`${mark}x${mark}`);
    }
  });
});
