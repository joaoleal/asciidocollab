import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import { EditorState } from '@codemirror/state';
import { LRLanguage, LanguageSupport } from '@codemirror/language';
import { outlineField, outlineResolvedScopeFacet } from '@/lib/codemirror/asciidoc-outline';
import type { SectionOutlineEntry } from '@/lib/codemirror/asciidoc-outline';
import { outlineIncludeContextFacet } from '@/lib/codemirror/asciidoc-heading-levels';
import type { IncludeResolutionContext } from '@/lib/codemirror/asciidoc-effective-levels';
import {
  inheritedHeadingOffsetFacet,
  refreshHeadingLevelsEffect,
} from '@/lib/codemirror/asciidoc-heading-levels';
import { createTestBlockTokenizer, createTestBlockContext } from '../../helpers/asciidoc-test-tokenizer';

const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');

const lezerParser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
});

const asciidocLang = LRLanguage.define({ name: 'asciidoc', parser: lezerParser });
const asciidocExtension = new LanguageSupport(asciidocLang);

function makeEditorState(documentContent: string): EditorState {
  return EditorState.create({
    doc: documentContent,
    extensions: [outlineField, asciidocExtension],
  });
}

function getOutline(documentContent: string): SectionOutlineEntry[] {
  const state = makeEditorState(documentContent);
  return state.field(outlineField);
}

describe('asciidoc-outline StateField', () => {
  test('extracts correct level, title text, and line number for levels 1–5', () => {
    const documentContent = [
      '= Document Title',
      '',
      '== Level 1 Heading',
      '',
      '=== Level 2 Heading',
      '',
      '==== Level 3 Heading',
      '',
      '===== Level 4 Heading',
      '',
      '====== Level 5 Heading',
      '',
    ].join('\n');

    const outline = getOutline(documentContent);
    expect(outline.length).toBeGreaterThanOrEqual(5);

    const levels = outline.map((entry) => entry.level);
    expect(levels).toContain(1);
    expect(levels).toContain(2);
    expect(levels).toContain(3);
    expect(levels).toContain(4);
    expect(levels).toContain(5);

    const heading1 = outline.find((entry) => entry.level === 1);
    expect(heading1?.title).toContain('Level 1 Heading');
  });

  test('returns empty array for a document with no headings', () => {
    const documentContent = 'Just some regular paragraph text.\nNo headings here.\n';
    const outline = getOutline(documentContent);
    expect(outline).toEqual([]);
  });

  test('handles headings that immediately follow delimited blocks', () => {
    const documentContent = [
      '----',
      'code block',
      '----',
      '',
      '== After Code Block',
      '',
    ].join('\n');

    const outline = getOutline(documentContent);
    expect(outline.length).toBeGreaterThan(0);
    expect(outline[0].title).toContain('After Code Block');
  });

  test('StateField updates when a heading is added in a CM6 transaction', () => {
    const initial = 'Some text\n';
    let state = makeEditorState(initial);
    expect(state.field(outlineField)).toEqual([]);

    state = state.update({
      changes: { from: state.doc.length, insert: '\n== New Heading\n' },
    }).state;

    const updated = state.field(outlineField);
    expect(updated.length).toBeGreaterThan(0);
    expect(updated[0].title).toContain('New Heading');
  });

  test('StateField updates when a heading is removed', () => {
    const initial = '== A Heading\n\nSome text\n';
    let state = makeEditorState(initial);
    expect(state.field(outlineField).length).toBeGreaterThan(0);

    const headingLine = state.doc.line(1);
    state = state.update({
      changes: { from: headingLine.from, to: headingLine.to + 1, insert: '' },
    }).state;

    expect(state.field(outlineField)).toEqual([]);
  });

  test('StateField is preserved across a selection-only (no-doc-change) transaction', () => {
    const state = makeEditorState('== A Heading\n\nSome text\n');
    const before = state.field(outlineField);
    const after = state.update({ selection: { anchor: 1 } }).state.field(outlineField);
    // No doc change → the same outline reference is kept.
    expect(after).toBe(before);
  });

  test('excludes a heading preceded by a [discrete] attribute line', () => {
    const documentContent = [
      '== Real Section',
      '',
      '[discrete]',
      '== Discrete Heading',
      '',
    ].join('\n');

    const outline = getOutline(documentContent);
    const titles = outline.map((entry) => entry.title);
    expect(titles).toContain('Real Section');
    expect(titles).not.toContain('Discrete Heading');
  });

  test('excludes a heading preceded by a [float] attribute line', () => {
    const documentContent = [
      '== Real Section',
      '',
      '[float]',
      '== Floating Heading',
      '',
    ].join('\n');

    const outline = getOutline(documentContent);
    const titles = outline.map((entry) => entry.title);
    expect(titles).toContain('Real Section');
    expect(titles).not.toContain('Floating Heading');
  });

  test('keeps a heading whose previous line is an unrelated attribute (not discrete/float)', () => {
    const documentContent = [
      '[.lead]',
      '== Lead Heading',
      '',
    ].join('\n');

    const outline = getOutline(documentContent);
    const titles = outline.map((entry) => entry.title);
    expect(titles).toContain('Lead Heading');
  });

  test('excludes a 7-equals line — beyond the max section level, it is not a heading', () => {
    // 7 leading equals is not a valid section marker (max is 6 = level 5), so it is body text.
    const outline = getOutline('======= Deep Heading\n');
    expect(outline).toEqual([]);
  });

  test('shifts the outline level by an in-document :leveloffset:', () => {
    const documentContent = [
      '== Section Foo',
      '',
      ':leveloffset: +1',
      '',
      '=== Section 2',
      '',
    ].join('\n');

    const outline = getOutline(documentContent);
    // `== Section Foo` is level 1; `=== Section 2` is raw level 2 + offset 1 ⇒ level 3 (not 2).
    expect(outline).toEqual([
      expect.objectContaining({ title: 'Section Foo', level: 1 }),
      expect.objectContaining({ title: 'Section 2', level: 3 }),
    ]);
  });

  test('traces an include:: — an included file\'s persisting :leveloffset: shifts later outline levels', () => {
    // Regression: previously the outline called computeHeadingLevels WITHOUT an include context, so an
    // offset introduced by an included file was invisible in the outline while the styled headings
    // (which DO trace includes) shifted — the two disagreed. With the include-context facet wired, the
    // outline matches: main includes shifter (which sets :leveloffset: +2, persisting), so `== After`
    // renders at effective level 3 (<h4>) — exactly what the heading decorations and the preview show.
    const files: Record<string, string> = {
      'main.adoc': 'include::shifter.adoc[]\n\n== After\n',
      'shifter.adoc': ':leveloffset: +2\n',
    };
    const context: IncludeResolutionContext = {
      fileId: 'main.adoc',
      getContent: (id) => files[id] ?? null,
      resolveInclude: (_from, target) => (files[target] === undefined ? null : target),
      seedAttributes: new Map(),
    };
    const state = EditorState.create({
      doc: files['main.adoc'],
      extensions: [outlineField, outlineIncludeContextFacet.of(() => context)],
    });
    expect(state.field(outlineField)).toEqual([expect.objectContaining({ title: 'After', level: 3 })]);
  });

  test('a throwing include accessor degrades gracefully instead of crashing the editor mount', () => {
    // extractHeadings runs in a StateField whose throw is FATAL (breaks EditorState.create / the mount),
    // unlike the fault-isolated decoration ViewPlugin. A misbehaving index accessor must therefore not
    // propagate: the outline falls back to offset-only levels (no include tracing) and still renders.
    const throwing: IncludeResolutionContext = {
      fileId: 'main.adoc',
      getContent: () => { throw new Error('boom'); },
      resolveInclude: () => { throw new Error('boom'); },
      seedAttributes: new Map(),
    };
    let state: EditorState | undefined;
    expect(() => {
      state = EditorState.create({
        doc: 'include::child.adoc[]\n\n== After\n',
        extensions: [outlineField, outlineIncludeContextFacet.of(() => throwing)],
      });
    }).not.toThrow();
    // Offset-only fallback: the include is not traced, so == After stays at level 1, outline still built.
    expect(state!.field(outlineField)).toEqual([expect.objectContaining({ title: 'After', level: 1 })]);
  });

  test('without an include context the outline does not trace includes (single-file default unchanged)', () => {
    // The facet defaults to `() => null`, so a standalone install ignores include:: directives entirely
    // — `== After` stays at level 1. This pins the backward-compatible default.
    const outline = getOutline('include::shifter.adoc[]\n\n== After\n');
    expect(outline).toEqual([expect.objectContaining({ title: 'After', level: 1 })]);
  });

  test('excludes a heading pushed beyond the max level by :leveloffset:', () => {
    const documentContent = [
      '== Section Foo',
      '',
      ':leveloffset: +6',
      '',
      '=== Section 2',
      '',
    ].join('\n');

    const outline = getOutline(documentContent);
    // `=== Section 2` becomes effective level 8 (> max) ⇒ not a heading, excluded from the outline.
    expect(outline.map((entry) => entry.title)).toEqual(['Section Foo']);
  });

  test('includes the document title at level 0, in document order before sections', () => {
    const outline = getOutline('= Title\n\n== Section\n');
    expect(outline).toEqual([
      expect.objectContaining({ title: 'Title', level: 0 }),
      expect.objectContaining({ title: 'Section', level: 1 }),
    ]);
  });

  test('still excludes a [discrete] heading even though the title (level 0) is now kept', () => {
    const outline = getOutline('= Title\n\n[discrete]\n== Discrete\n\n== Real\n');
    expect(outline.map((entry) => entry.title)).toEqual(['Title', 'Real']);
  });

  test('applies the inherited include-path offset from the facet', () => {
    // An ancestor include supplies an offset of +2, so `== Sub` (raw level 1) becomes level 3.
    const state = EditorState.create({
      doc: '== Sub',
      extensions: [outlineField, asciidocExtension, inheritedHeadingOffsetFacet.of(() => 2)],
    });
    expect(state.field(outlineField)).toEqual([expect.objectContaining({ title: 'Sub', level: 3 })]);
  });

  test('recomputes when the inherited offset changes out-of-band (refresh effect)', () => {
    let offset = 0;
    const initial = EditorState.create({
      doc: '====== Deep',
      extensions: [outlineField, asciidocExtension, inheritedHeadingOffsetFacet.of(() => offset)],
    });
    // `======` is raw level 5: in range at offset 0, beyond max once the offset rises to +1.
    expect(initial.field(outlineField).map((entry) => entry.title)).toEqual(['Deep']);

    offset = 1;
    const refreshed = initial.update({ effects: refreshHeadingLevelsEffect.of() }).state;
    expect(refreshed.field(outlineField)).toEqual([]);
  });

  test('resolves {attr} references in a heading title against the resolved scope', () => {
    const scope = new Map<string, string>([['productname', 'Acme']]);
    const state = EditorState.create({
      doc: '== {productName} Guide',
      extensions: [outlineField, asciidocExtension, outlineResolvedScopeFacet.of(() => scope)],
    });
    expect(state.field(outlineField)).toEqual([
      expect.objectContaining({ title: 'Acme Guide', level: 1 }),
    ]);
  });

  test('leaves an unresolved {attr} reference verbatim in the title', () => {
    const state = EditorState.create({
      doc: '== {unknown} Guide',
      extensions: [outlineField, asciidocExtension, outlineResolvedScopeFacet.of(() => new Map())],
    });
    expect(state.field(outlineField)).toEqual([
      expect.objectContaining({ title: '{unknown} Guide' }),
    ]);
  });

  test('excludes a heading inside an inactive ifdef branch', () => {
    const documentContent = [
      '== Always',
      '',
      'ifdef::draft[]',
      '== Draft Only',
      'endif::[]',
      '',
      '== After',
      '',
    ].join('\n');
    // `draft` is NOT in scope ⇒ the ifdef branch is inactive ⇒ its heading is excluded.
    const state = EditorState.create({
      doc: documentContent,
      extensions: [outlineField, asciidocExtension, outlineResolvedScopeFacet.of(() => new Map())],
    });
    expect(state.field(outlineField).map((entry) => entry.title)).toEqual(['Always', 'After']);
  });

  test('a single-line ifdef::flag[text] (inline content form, no endif) does NOT gate later headings', () => {
    const documentContent = [
      'ifdef::draft[Draft watermark]',
      '',
      '== Real Section',
      '',
      '== Another',
      '',
    ].join('\n');
    // The inline content form has non-empty brackets and no matching `endif`, so it is NOT a region
    // opener. Treating it as one (the bug) would push an unbalanced inactive frame and drop every
    // following heading. Both headings must survive — matching what the preview renders.
    const state = EditorState.create({
      doc: documentContent,
      extensions: [outlineField, asciidocExtension, outlineResolvedScopeFacet.of(() => new Map())],
    });
    expect(state.field(outlineField).map((entry) => entry.title)).toEqual(['Real Section', 'Another']);
  });

  test('keeps a heading inside an active ifdef branch', () => {
    const documentContent = [
      'ifdef::draft[]',
      '== Draft Only',
      'endif::[]',
      '',
    ].join('\n');
    const scope = new Map<string, string>([['draft', '']]);
    const state = EditorState.create({
      doc: documentContent,
      extensions: [outlineField, asciidocExtension, outlineResolvedScopeFacet.of(() => scope)],
    });
    expect(state.field(outlineField).map((entry) => entry.title)).toEqual(['Draft Only']);
  });

  test('excludes a heading inside an active-by-default ifndef branch that resolves inactive', () => {
    const documentContent = [
      'ifndef::draft[]',
      '== Released Only',
      'endif::[]',
      '',
    ].join('\n');
    // `draft` IS in scope ⇒ the ifndef branch is inactive ⇒ its heading is excluded.
    const scope = new Map<string, string>([['draft', '']]);
    const state = EditorState.create({
      doc: documentContent,
      extensions: [outlineField, asciidocExtension, outlineResolvedScopeFacet.of(() => scope)],
    });
    expect(state.field(outlineField)).toEqual([]);
  });

  test('recomputes resolved titles/inactive marking when the scope changes out-of-band', () => {
    let scope: ReadonlyMap<string, string> = new Map();
    const initial = EditorState.create({
      doc: ['== {productName}', '', 'ifdef::draft[]', '== Draft', 'endif::[]', ''].join('\n'),
      extensions: [outlineField, asciidocExtension, outlineResolvedScopeFacet.of(() => scope)],
    });
    expect(initial.field(outlineField).map((entry) => entry.title)).toEqual(['{productName}']);

    scope = new Map<string, string>([['productname', 'Acme'], ['draft', '']]);
    const refreshed = initial.update({ effects: refreshHeadingLevelsEffect.of() }).state;
    expect(refreshed.field(outlineField).map((entry) => entry.title)).toEqual(['Acme', 'Draft']);
  });
});
