import * as Y from 'yjs';
import type { AnchorDto } from '@asciidocollab/shared';
import {
  findQuoteRange,
  resolveAnchorWithDegradation,
  captureAnchor,
} from '@/lib/review/anchor';

function documentWith(text: string): { doc: Y.Doc; ytext: Y.Text } {
  const document = new Y.Doc();
  const ytext = document.getText('codemirror');
  ytext.insert(0, text);
  return { doc: document, ytext };
}

describe('findQuoteRange', () => {
  test('locates a unique passage', () => {
    const text = 'alpha the target beta';
    expect(findQuoteRange(text, { prefix: 'alpha ', exact: 'the target', suffix: ' beta' })).toEqual({
      from: 6,
      to: 16,
    });
  });

  test('disambiguates repeated passages by surrounding context', () => {
    const text = 'foo dup bar ... baz dup qux';
    // Both "dup" occur; the suffix " qux" should select the second occurrence.
    const range = findQuoteRange(text, { prefix: 'baz ', exact: 'dup', suffix: ' qux' });
    expect(range).not.toBeNull();
    expect(text.slice(range!.from, range!.to)).toBe('dup');
    expect(range!.from).toBe(text.lastIndexOf('dup'));
  });

  test('returns null when the passage is gone', () => {
    expect(findQuoteRange('nothing here', { prefix: '', exact: 'missing', suffix: '' })).toBeNull();
  });

  test('returns null for an empty passage rather than matching everywhere', () => {
    expect(findQuoteRange('some text', { prefix: 'so', exact: '', suffix: 'xt' })).toBeNull();
  });

  test('keeps the best-scoring occurrence when a later one matches its context worse', () => {
    const text = 'foo dup bar ... baz dup qux';
    const range = findQuoteRange(text, { prefix: 'foo ', exact: 'dup', suffix: ' bar' });
    expect(range).toEqual({ from: text.indexOf('dup'), to: text.indexOf('dup') + 3 });
  });
});

describe('resolveAnchorWithDegradation', () => {
  test('located via relpos when it still resolves', () => {
    const { doc: ydoc, ytext } = documentWith('the quick brown fox');
    const created = captureAnchor(ytext, 4, 9, 'the quick brown fox', 1); // "quick"
    const anchor: AnchorDto = { ...created, state: 'located' };
    const result = resolveAnchorWithDegradation(anchor, ytext, ydoc, { documentText: 'the quick brown fox' });
    expect(result.state).toBe('located');
    expect(result.range).toEqual({ from: 4, to: 9 });
  });

  test('degrades to the section when the passage is deleted but the section resolves', () => {
    const { doc: ydoc, ytext } = documentWith('gone');
    const anchor: AnchorDto = {
      quote: { prefix: '', exact: 'deleted passage', suffix: '' },
      sectionId: 'intro/overview',
      state: 'located',
    };
    const result = resolveAnchorWithDegradation(anchor, ytext, ydoc, {
      documentText: 'gone',
      findSectionRange: (id) => (id === 'intro/overview' ? { from: 0, to: 4 } : null),
    });
    expect(result.state).toBe('section');
    expect(result.range).toEqual({ from: 0, to: 4 });
  });

  test('detaches when neither passage nor section resolves', () => {
    const { doc: ydoc, ytext } = documentWith('gone');
    const anchor: AnchorDto = {
      quote: { prefix: '', exact: 'deleted passage', suffix: '' },
      sectionId: 'removed/section',
      state: 'located',
    };
    const result = resolveAnchorWithDegradation(anchor, ytext, ydoc, {
      documentText: 'gone',
      findSectionRange: () => null,
    });
    expect(result.state).toBe('detached');
    expect(result.range).toBeNull();
  });

  test('detaches with no options at all when the relpos no longer resolves', () => {
    const { doc: ydoc, ytext } = documentWith('gone');
    const anchor: AnchorDto = {
      quote: { prefix: '', exact: 'deleted passage', suffix: '' },
      sectionId: 'intro/overview',
      state: 'located',
    };

    const result = resolveAnchorWithDegradation(anchor, ytext, ydoc);

    expect(result).toEqual({ range: null, state: 'detached' });
  });

  test('detaches when the quote is gone and the anchor carries no section id', () => {
    const { doc: ydoc, ytext } = documentWith('gone');
    const anchor: AnchorDto = {
      quote: { prefix: '', exact: 'deleted passage', suffix: '' },
      state: 'located',
    };

    const result = resolveAnchorWithDegradation(anchor, ytext, ydoc, {
      documentText: 'gone',
      findSectionRange: () => ({ from: 0, to: 4 }),
    });

    expect(result).toEqual({ range: null, state: 'detached' });
  });

  test('re-anchors via quote when the relpos is stale but the text survived', () => {
    const { doc: ydoc, ytext } = documentWith('intro paragraph then the commented passage ends here');
    const anchor: AnchorDto = {
      // No relPos → forces the quote tier.
      quote: { prefix: 'then ', exact: 'the commented passage', suffix: ' ends' },
      state: 'located',
    };
    const result = resolveAnchorWithDegradation(anchor, ytext, ydoc, {
      documentText: 'intro paragraph then the commented passage ends here',
    });
    expect(result.state).toBe('located');
    expect(result.range).not.toBeNull();
    expect('intro paragraph then the commented passage ends here'.slice(result.range!.from, result.range!.to)).toBe(
      'the commented passage',
    );
  });
});
