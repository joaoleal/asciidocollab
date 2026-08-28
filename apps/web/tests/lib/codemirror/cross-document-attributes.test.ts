/*
 * @jest-environment jsdom
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  computeKnownAttributeMarks,
  asciidocCrossDocumentAttributes,
  refreshCrossDocumentAttributesEffect,
  KNOWN_CROSS_DOC_ATTRIBUTE_CLASS,
} from '@/lib/codemirror/cross-document-attributes';

// jsdom environment — the ViewPlugin builds mark decorations and EditorView needs a DOM host.

/** Mount a CM6 view whose cross-doc scope is the supplied set of known attribute names. */
function mountView(documentContent: string, known: Set<string>): EditorView {
  const plugin = asciidocCrossDocumentAttributes(() => known);
  const state = EditorState.create({
    doc: documentContent,
    extensions: [plugin],
  });
  const view = new EditorView({ state, parent: document.body });
  return view;
}

describe('computeKnownAttributeMarks', () => {
  test('marks a {name} reference whose definition is in the inherited cross-document scope', () => {
    // `productName` is defined only in a parent/included file → it arrives via the resolved scope.
    const source = 'See {productName} for details.\n';
    const marks = computeKnownAttributeMarks(source, new Set(['productname']));
    expect(marks).toHaveLength(1);
    expect(source.slice(marks[0].from, marks[0].to)).toBe('{productName}');
  });

  test('does not mark a {name} reference that is absent from the resolved scope (unknown)', () => {
    const source = 'See {mystery} here.\n';
    expect(computeKnownAttributeMarks(source, new Set(['productname']))).toHaveLength(0);
  });

  test('matches attribute names case-insensitively (Asciidoctor semantics)', () => {
    const source = 'Value {ProductName}.\n';
    const marks = computeKnownAttributeMarks(source, new Set(['productname']));
    expect(marks).toHaveLength(1);
  });

  test('marks every occurrence across the document', () => {
    const source = '{a} and {a} again, but {b} unknown.\n';
    const marks = computeKnownAttributeMarks(source, new Set(['a']));
    expect(marks).toHaveLength(2);
  });

  test('does not treat an attribute definition line as a reference', () => {
    // `:productName:` is an entry, not a `{ref}` — no mark even though the name is known.
    const source = ':productName: Acme\n';
    expect(computeKnownAttributeMarks(source, new Set(['productname']))).toHaveLength(0);
  });
});

describe('asciidocCrossDocumentAttributes ViewPlugin', () => {
  test('applies the known mark decoration to a cross-document reference', () => {
    const view = mountView('Use {productName} now.\n', new Set(['productname']));
    expect(view.dom.querySelector(`.${KNOWN_CROSS_DOC_ATTRIBUTE_CLASS}`)).not.toBeNull();
    view.destroy();
  });

  test('marks nothing when no known-name set is supplied at all', () => {
    // The caller-less form is what the editor mounts with before the project index has resolved: with
    // nothing known, every reference is a local one and must stay undecorated.
    expect(computeKnownAttributeMarks('Use {productName} now.\n')).toEqual([]);
  });

  test('decorates nothing when mounted without a known-name accessor', () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'Use {productName} now.\n',
        extensions: [asciidocCrossDocumentAttributes()],
      }),
      parent: document.body,
    });
    expect(view.dom.querySelector(`.${KNOWN_CROSS_DOC_ATTRIBUTE_CLASS}`)).toBeNull();
    view.destroy();
  });

  test('does not decorate an unknown reference', () => {
    const view = mountView('Use {mystery} now.\n', new Set(['productname']));
    expect(view.dom.querySelector(`.${KNOWN_CROSS_DOC_ATTRIBUTE_CLASS}`)).toBeNull();
    view.destroy();
  });

  test('recomputes when the scope refresh effect is dispatched (live update)', () => {
    // Start with an empty scope (reference unknown), then the scope resolves the attribute and a
    // refresh effect is dispatched — the reference must become marked without a document edit.
    const known = new Set<string>();
    const plugin = asciidocCrossDocumentAttributes(() => known);
    const view = new EditorView({
      state: EditorState.create({
        doc: 'Use {productName} now.\n',
        extensions: [plugin],
      }),
      parent: document.body,
    });
    expect(view.dom.querySelector(`.${KNOWN_CROSS_DOC_ATTRIBUTE_CLASS}`)).toBeNull();

    known.add('productname'); // the index resolved the parent's definition
    view.dispatch({ effects: refreshCrossDocumentAttributesEffect.of() });
    expect(view.dom.querySelector(`.${KNOWN_CROSS_DOC_ATTRIBUTE_CLASS}`)).not.toBeNull();
    view.destroy();
  });
});
