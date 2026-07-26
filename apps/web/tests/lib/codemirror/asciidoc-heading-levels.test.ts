/*
 * @jest-environment jsdom
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LRLanguage, LanguageSupport } from '@codemirror/language';
import {
  asciidocHeadingLevels,
  headingLevelClass,
  refreshHeadingLevelsEffect,
  MAX_HEADING_LEVEL,
  computeHeadingLevels,
  parseLevelOffset,
  type HeadingLevelInfo,
} from '@/lib/codemirror/asciidoc-heading-levels';
import { createTestBlockTokenizer, createTestBlockContext } from '../../helpers/asciidoc-test-tokenizer';

// The CodeMirror projection of the effective-heading-level rule. The effective-level computation
// itself (computeHeadingLevels / parseLevelOffset) lives in ./asciidoc-effective-levels and is
// re-exported here; this suite covers the CSS class mapping plus the live ViewPlugin decorations.
//
// The file opens with a single-star `@jest-environment jsdom` docblock (not a JSDoc `/** */`
// comment) so eslint-plugin-jsdoc does not flag the Jest pragma as an unknown tag; jest-docblock
// still reads it and mounts the EditorView in a DOM. The pragma must be the very first comment.

const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');
const lezerParser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
});
const asciidocLang = new LanguageSupport(LRLanguage.define({ name: 'asciidoc', parser: lezerParser }));

const mounted: EditorView[] = [];

/** Mounts a live EditorView with the AsciiDoc language + the heading-levels plugin. */
function mount(documentContent: string, getInheritedOffset: () => number = () => 0): EditorView {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: documentContent,
      extensions: [asciidocLang, asciidocHeadingLevels(getInheritedOffset)],
    }),
    parent,
  });
  mounted.push(view);
  return view;
}

/** Reads the rendered `.cm-line` class lists in document order. */
function lineClasses(view: EditorView): string[] {
  return [...view.dom.querySelectorAll('.cm-line')].map((line) => line.className);
}

/** Builds a heading-info record with sensible defaults for the class-mapping unit tests. */
function info(overrides: Partial<HeadingLevelInfo>): HeadingLevelInfo {
  return { line: 1, from: 0, rawLevel: 0, effectiveLevel: 0, discrete: false, beyondMax: false, ...overrides };
}

afterEach(() => {
  for (const view of mounted.splice(0)) view.destroy();
});

describe('re-exports', () => {
  test('forwards the shared effective-level helpers', () => {
    expect(MAX_HEADING_LEVEL).toBe(5);
    expect(typeof computeHeadingLevels).toBe('function');
    expect(typeof parseLevelOffset).toBe('function');
    expect(parseLevelOffset(':leveloffset: +1')).toEqual({ kind: 'relative', delta: 1 });
  });
});

describe('headingLevelClass', () => {
  for (let level = 0; level <= MAX_HEADING_LEVEL; level++) {
    test(`maps effective level ${level} to cm-ad-h${level}`, () => {
      expect(headingLevelClass(info({ effectiveLevel: level }))).toBe(`cm-ad-h${level}`);
    });
  }

  test('appends the discrete class for a [discrete] heading', () => {
    expect(headingLevelClass(info({ effectiveLevel: 2, discrete: true }))).toBe('cm-ad-h2 cm-ad-discrete');
  });

  test('emits a class even for an out-of-range effective level (cutoff handled by the plugin)', () => {
    expect(headingLevelClass(info({ effectiveLevel: 6, beyondMax: true }))).toBe('cm-ad-h6');
  });
});

describe('asciidocHeadingLevels — ViewPlugin decorations', () => {
  test('styles each heading line by its effective level', () => {
    const documentContent = '= L0\n\n== L1\n\n=== L2\n\n==== L3\n\n===== L4\n\n====== L5';
    const classes = lineClasses(mount(documentContent));
    expect(classes).toEqual([
      'cm-line cm-ad-h0',
      'cm-line',
      'cm-line cm-ad-h1',
      'cm-line',
      'cm-line cm-ad-h2',
      'cm-line',
      'cm-line cm-ad-h3',
      'cm-line',
      'cm-line cm-ad-h4',
      'cm-line',
      'cm-line cm-ad-h5',
    ]);
  });

  test('marks a [discrete] heading with the discrete class', () => {
    const view = mount('[discrete]\n== Floating');
    expect(lineClasses(view)).toEqual(['cm-line', 'cm-line cm-ad-h1 cm-ad-discrete']);
  });

  test('leaves non-heading lines unstyled', () => {
    const view = mount('Just a paragraph.');
    expect(lineClasses(view)).toEqual(['cm-line']);
  });

  test('default getInheritedOffset (omitted) treats the file as the include root', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: '== Sub', extensions: [asciidocLang, asciidocHeadingLevels()] }),
      parent,
    });
    mounted.push(view);
    expect(lineClasses(view)).toEqual(['cm-line cm-ad-h1']);
  });
});

describe('asciidocHeadingLevels — inherited offset', () => {
  test('a non-zero inherited offset shifts the effective level', () => {
    // `== Sub` is raw level 1; an inherited offset of +2 makes its effective level 3.
    const view = mount('== Sub', () => 2);
    expect(lineClasses(view)).toEqual(['cm-line cm-ad-h3']);
  });

  // ── Attribute-form :leveloffset: combined with the inherited include offset ──
  test('attribute-form :leveloffset: +1 composes with the inherited offset', () => {
    // The file is included with an inherited offset of +1; a `== After` heading is effective 2,
    // and after an attribute-form `:leveloffset: +1` the next heading is effective 3.
    const view = mount('== Before\n\n:leveloffset: +1\n\n== After', () => 1);
    expect(lineClasses(view)).toEqual([
      'cm-line cm-ad-h2', // == Before — raw 1 + inherited 1
      'cm-line',
      'cm-line', // :leveloffset: +1
      'cm-line',
      'cm-line cm-ad-h3', // == After — raw 1 + inherited 1 + attribute form 1
    ]);
  });

  test('attribute-form :leveloffset!: resets to the inherited base, not to zero', () => {
    const view = mount(':leveloffset: +2\n\n== A\n\n:leveloffset!:\n\n== B', () => 1);
    expect(lineClasses(view)).toEqual([
      'cm-line', // :leveloffset: +2
      'cm-line',
      'cm-line cm-ad-h4', // == A — raw 1 + inherited 1 + attribute form 2
      'cm-line',
      'cm-line', // :leveloffset!:
      'cm-line',
      'cm-line cm-ad-h2', // == B — raw 1 + inherited base 1 (reset)
    ]);
  });
});

describe('asciidocHeadingLevels — max-level cutoff', () => {
  test('a heading whose effective level exceeds the max is flagged as suppressed, not styled', () => {
    // `======` is raw level 5; +1 inherited offset → effective level 6 (> MAX). The grammar still
    // tokenises it as a heading, so the line is tagged to neutralise that colour (see theme).
    const view = mount('====== TooDeep', () => 1);
    expect(lineClasses(view)).toEqual(['cm-line cm-ad-suppressed-heading']);
  });

  test('an in-document :leveloffset: pushing a heading past the max suppresses it', () => {
    // `=== Section 2` is raw level 2; with `:leveloffset: +6` the effective level is 8 (> MAX).
    const view = mount('== Section Foo\n\n:leveloffset: +6\n\n=== Section 2');
    expect(lineClasses(view)).toEqual([
      'cm-line cm-ad-h1', // == Section Foo
      'cm-line',
      'cm-line', // :leveloffset: +6
      'cm-line',
      'cm-line cm-ad-suppressed-heading', // === Section 2 — beyond max
    ]);
  });

  test('an in-range heading at the same offset is still styled', () => {
    // `======` is raw level 5; with no offset its effective level is 5 (== MAX) ⇒ styled.
    const view = mount('====== Deep', () => 0);
    expect(lineClasses(view)).toEqual(['cm-line cm-ad-h5']);
  });
});

describe('asciidocHeadingLevels — update paths', () => {
  test('a document edit recomputes the decorations', () => {
    const view = mount('Just text');
    expect(lineClasses(view)).toEqual(['cm-line']);

    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '== Promoted' } });
    expect(lineClasses(view)).toEqual(['cm-line cm-ad-h1']);
  });

  test('refreshHeadingLevelsEffect re-evaluates levels when the offset changed without a doc edit', () => {
    let offset = 0;
    const view = mount('== Sub', () => offset);
    expect(lineClasses(view)).toEqual(['cm-line cm-ad-h1']);

    // The inherited offset changes out-of-band (e.g. the project main file was reconfigured);
    // dispatching the refresh effect re-reads it without any document change.
    offset = 2;
    view.dispatch({ effects: refreshHeadingLevelsEffect.of() });
    expect(lineClasses(view)).toEqual(['cm-line cm-ad-h3']);
  });

  test('an unrelated transaction (no doc change, no refresh effect) leaves decorations intact', () => {
    let offset = 0;
    const view = mount('== Sub', () => offset);
    expect(lineClasses(view)).toEqual(['cm-line cm-ad-h1']);

    // Change the backing offset but dispatch a no-op selection transaction: the plugin's update()
    // runs but neither docChanged nor the refresh effect fire, so the stale decorations remain.
    offset = 2;
    view.dispatch({ selection: { anchor: 0 } });
    expect(lineClasses(view)).toEqual(['cm-line cm-ad-h1']);
  });
});

// 030 — heading `=` marker run decoration.
describe('030 — heading = marker recedes via cm-ad-heading-marker', () => {
  test('= marker span exists and carries the heading-marker class', () => {
    const view = mount('= Title');
    const markerSpan = view.dom.querySelector('.cm-ad-heading-marker');
    expect(markerSpan).not.toBeNull();
    expect(markerSpan!.textContent).toBe('=');
  });

  test('== marker span covers exactly the two = characters', () => {
    const view = mount('== Section');
    const markerSpan = view.dom.querySelector('.cm-ad-heading-marker');
    expect(markerSpan).not.toBeNull();
    expect(markerSpan!.textContent).toBe('==');
  });

  test('=== marker span covers three = characters', () => {
    const view = mount('=== Sub');
    const markerSpan = view.dom.querySelector('.cm-ad-heading-marker');
    expect(markerSpan).not.toBeNull();
    expect(markerSpan!.textContent).toBe('===');
  });

  test('beyondMax headings do not get a heading-marker span', () => {
    // Mount with inheritedOffset = 5 so a `= Title` line becomes effectiveLevel 5+0 = 5 = MAX.
    // `== Section` at rawLevel 1 becomes effectiveLevel 6 → beyondMax → no marker decoration.
    const view = mount('== Section', () => 5);
    expect(view.dom.querySelector('.cm-ad-heading-marker')).toBeNull();
  });
});
