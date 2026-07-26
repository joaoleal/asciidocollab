import {
  hasIncludeLevelOffsetOption,
  applyLevelOffsetEntry,
  applyLineAttributes,
  attributeEntryLineRanges,
  resolveAttributeReferences,
  resolveAttributeScope,
  extractSymbols,
  definitionSymbols,
} from '../src/index';

// Direct coverage for the public helpers the domain/editor callers use but the higher-level extraction
// tests exercise only indirectly (the include assembler's offset/attribute tracking and the editor's
// `{attr}` fold), so the single-source engine tests own all of its exported surface.

describe('hasIncludeLevelOffsetOption', () => {
  test.each([
    ['leveloffset=+1', true],
    ['leveloffset=-2', true],
    ['leveloffset = 3', true],
    ['tags=body', false],
    ['', false],
    ['lines=1..3', false],
  ])('returns %s for %j', (attributeList, expected) => {
    expect(hasIncludeLevelOffsetOption(attributeList)).toBe(expected);
  });
});

describe('applyLevelOffsetEntry', () => {
  test('a relative +N/-N shifts the current offset', () => {
    expect(applyLevelOffsetEntry(':leveloffset: +2', 1, 0)).toBe(3);
    expect(applyLevelOffsetEntry(':leveloffset: -1', 3, 0)).toBe(2);
  });

  test('an absolute N replaces the current offset', () => {
    expect(applyLevelOffsetEntry(':leveloffset: 4', 1, 0)).toBe(4);
  });

  test('an unset (suffix or prefix) or empty value returns to the base', () => {
    expect(applyLevelOffsetEntry(':leveloffset!:', 3, 1)).toBe(1);
    expect(applyLevelOffsetEntry(':!leveloffset:', 3, 1)).toBe(1);
    expect(applyLevelOffsetEntry(':leveloffset:', 3, 1)).toBe(1);
  });

  test('a non-`:leveloffset:` line leaves the offset unchanged', () => {
    expect(applyLevelOffsetEntry('== Heading', 3, 0)).toBe(3);
  });
});

describe('applyLineAttributes', () => {
  test('applies a set entry, an unset, and an inline `{set:}` in document order', () => {
    const attributes = new Map<string, string>();
    applyLineAttributes(':author: Ada', attributes);
    expect(attributes.get('author')).toBe('Ada');

    applyLineAttributes('body {set:feature:on} more', attributes);
    expect(attributes.get('feature')).toBe('on');

    applyLineAttributes(':author!:', attributes);
    expect(attributes.has('author')).toBe(false);

    applyLineAttributes(':!feature:', attributes);
    expect(attributes.has('feature')).toBe(false);
  });
});

/** The exact text each attribute-entry span covers, so a range is asserted as what a consumer masks. */
function spanned(content: string): string[] {
  return attributeEntryLineRanges(content).map(({ from, to }) => content.slice(from, to));
}

describe('attributeEntryLineRanges', () => {
  test('covers the whole entry — name and value — for every set form', () => {
    const content = ':toc: left\n:toclevels: 3\n:product-name: AsciidoCollab\n';
    expect(spanned(content)).toEqual([':toc: left\n', ':toclevels: 3\n', ':product-name: AsciidoCollab\n']);
  });

  test('covers a valueless entry (`:experimental:`) and both unset forms', () => {
    expect(spanned(':experimental:\n:sectnums!:\n:!toc:\n')).toEqual([
      ':experimental:\n',
      ':sectnums!:\n',
      ':!toc:\n',
    ]);
  });

  test('covers every `\\`-continuation line of a wrapped value as one span', () => {
    const content = ':description: first part \\\nsecond part\n\nBody.\n';
    expect(spanned(content)).toEqual([':description: first part \\\nsecond part\n']);
  });

  test('excludes an attribute-looking line inside a verbatim block or a `//` comment', () => {
    expect(attributeEntryLineRanges('----\n:toc: left\n----\n')).toEqual([]);
    expect(attributeEntryLineRanges('////\n:toc: left\n////\n')).toEqual([]);
    expect(attributeEntryLineRanges('// :toc: left\n')).toEqual([]);
  });

  test('excludes an INDENTED entry — Asciidoctor recognizes no indented attribute entry', () => {
    expect(attributeEntryLineRanges('  :toc: left\n')).toEqual([]);
  });

  test('excludes a body line that merely contains a colon', () => {
    expect(attributeEntryLineRanges('Note: this line is prose.\nSee section 2: the details.\n')).toEqual([]);
  });

  test('is the superset of the value view: the unset entries it adds carry no value span', () => {
    // The two views agree on set entries; only unsets (no value to resolve against) differ.
    const content = ':a: 1\n:b!:\n:c: 3\n';
    expect(spanned(content)).toEqual([':a: 1\n', ':b!:\n', ':c: 3\n']);
    expect(resolveAttributeReferences(':a: 1\n:b!:\n:c: {a}\n')).toEqual([]);
  });
});

describe('resolveAttributeReferences', () => {
  test('resolves a reference to an attribute defined on an earlier line', () => {
    expect(resolveAttributeReferences(':v: 1.2.3\n\nRelease {v}.\n')).toEqual([
      { from: expect.any(Number), to: expect.any(Number), value: '1.2.3' },
    ]);
  });

  test('leaves forward and unknown references unresolved', () => {
    expect(resolveAttributeReferences('See {v}.\n\n:v: 9\n')).toEqual([]);
    expect(resolveAttributeReferences('Use {missing}.\n')).toEqual([]);
  });

  test('does not resolve a definition or reference inside a verbatim block', () => {
    expect(resolveAttributeReferences('----\n:v: hidden\n----\n\n{v}\n')).toEqual([]);
    expect(resolveAttributeReferences(':v: 1\n\n----\n{v}\n----\n')).toEqual([]);
  });

  test('resolves against an inherited seed, case-insensitively', () => {
    const [resolved] = resolveAttributeReferences('{Product}\n', new Map([['product', 'Acme']]));
    expect(resolved.value).toBe('Acme');
  });

  test('resolves an inline `{set:}` to the LEFT of a same-line reference (column order)', () => {
    const [resolved] = resolveAttributeReferences('{set:x:on} then {x}\n');
    expect(resolved.value).toBe('on');
  });

  test('a `{ref}` inside an attribute entry value span is not folded standalone', () => {
    // `{a}` is part of `:b:`'s value (expanded into it), not a foldable reference of its own.
    expect(resolveAttributeReferences(':a: 1\n:b: {a}\n')).toEqual([]);
  });
});

describe('definitionSymbols', () => {
  // A heading carrying an explicit `[[intro]]` emits BOTH a section (id `intro`) and an anchor
  // `intro`; a plain heading emits an auto-id section; `:attr:` an attribute.
  const content = '[[intro]]\n== Introduction\n\n== Auto Heading\n\n:attr: val\n';

  test('anchor family keeps anchors + auto sections but drops a section an explicit anchor declares', () => {
    const result = definitionSymbols(extractSymbols('', content), 'anchor');
    const names = result.map((symbol) => `${symbol.kind}:${symbol.name}`).toSorted();
    expect(names).toEqual(['anchor:intro', 'section:_auto_heading']);
    // The section named `intro` is the double-report that must be dropped.
    expect(result.some((symbol) => symbol.kind === 'section' && symbol.name === 'intro')).toBe(false);
  });

  test('attribute family returns only attribute definitions', () => {
    const result = definitionSymbols(extractSymbols('', content), 'attribute');
    expect(result).toEqual([expect.objectContaining({ kind: 'attribute', name: 'attr' })]);
  });

  test('omitting the family returns both families, de-duped', () => {
    const names = definitionSymbols(extractSymbols('', content)).map((symbol) => `${symbol.kind}:${symbol.name}`).toSorted();
    expect(names).toEqual(['anchor:intro', 'attribute:attr', 'section:_auto_heading']);
  });
});

const noContent = (): null => null;
const noInclude = (): null => null;

describe('resolveAttributeScope with missing content', () => {
  test('resolveAttributeScope of a missing standalone file is an empty standalone scope', () => {
    const scope = resolveAttributeScope({ rootFileId: null, fileId: 'x', readContent: noContent, resolveInclude: noInclude });
    expect(scope.origin).toBe('standalone');
    expect(scope.values.size).toBe(0);
  });
});
