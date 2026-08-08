import {
  extractReferences,
  extractSymbols,
  extractAttributeDefinitions,
  extractOwnAttributes,
  resolveReference,
  buildIncludeGraph,
  buildIncludeGraphWithInheritance,
  inheritedLevelOffset,
  effectiveLevelOffset,
  resolveAttributeScope,
  parseIncludeTags,
  parseIncludeLines,
  headingToId,
  parseIncludeLevelOffset,
  type ProjectSymbol,
  type Reference,
} from '../src/index';
import path from 'node:path';

/** An in-memory `readContent` fake: maps a file id to its content, or null when absent. */
const read = (files: Record<string, string>) => (id: string) => files[id] ?? null;
/** Resolves every include target to its own id (content availability is decided separately by the reader). */
const resolveToSelfId = (_from: string, target: string): string | null => target;

describe('extractReferences', () => {
  test('extracts xref, include, image, and attributeRef', () => {
    const content = 'See <<intro>> and xref:other[].\ninclude::part.adoc[]\nimage::pic.png[]\nVersion {ver}.\n';
    const kinds = extractReferences('f1', content).map((r) => `${r.kind}:${r.target}`);
    expect(kinds).toContain('xref:intro');
    expect(kinds).toContain('xref:other');
    expect(kinds).toContain('include:part.adoc');
    expect(kinds).toContain('image:pic.png');
    expect(kinds).toContain('attributeRef:ver');
  });

  test('reference ranges map back to the source text', () => {
    const content = 'x <<a>> y';
    const [reference] = extractReferences('f1', content);
    expect(content.slice(reference.range.from, reference.range.to)).toBe('<<a>>');
  });

  test('ignores references inside verbatim/comment blocks (so rename/find-references skip code samples)', () => {
    const content = [
      'Real <<intro>>.',
      '----',
      'puts "<<notreal>> {undefinedAttr}"',
      'image::not-real.png[]',
      '----',
      '////',
      'comment <<commentxref>> include::ghost.adoc[]',
      '////',
      '// line <<linexref>>',
    ].join('\n');
    const targets = extractReferences('f1', content).map((r) => r.target);
    expect(targets).toContain('intro');
    expect(targets).not.toContain('notreal');
    expect(targets).not.toContain('undefinedAttr');
    expect(targets).not.toContain('not-real.png');
    expect(targets).not.toContain('commentxref');
    expect(targets).not.toContain('ghost.adoc');
    expect(targets).not.toContain('linexref');
  });

  test('references inside non-verbatim delimited blocks (example/sidebar) are still real', () => {
    const targets = extractReferences('f1', '====\n<<inExample>>\n====').map((r) => r.target);
    expect(targets).toContain('inExample');
  });

  test('an INDENTED fence is content, not a delimiter — references after it are not dropped from rename/find', () => {
    // A column-0 requirement matters here: the domain extractor backs find-references and rename, so
    // over-masking would silently leave references un-rewritten and dangling after a rename.
    const targets = extractReferences('f1', '* item\n  ----\n  x\n\nReal <<keep>>.\n').map((r) => r.target);
    expect(targets).toContain('keep');
  });
});

describe('extractSymbols', () => {
  test('extracts sections (auto-id), anchors, and attributes', () => {
    const content = '== My Section\n\n[[anchor-one]]\nText.\n\n:author: Jane\n';
    const symbols = extractSymbols('f1', content);
    expect(symbols).toContainEqual(expect.objectContaining({ kind: 'section', name: '_my_section' }));
    expect(symbols).toContainEqual(expect.objectContaining({ kind: 'anchor', name: 'anchor-one' }));
    expect(symbols).toContainEqual(expect.objectContaining({ kind: 'attribute', name: 'author' }));
  });

  test('an unset attribute (:name!:) is not a definition', () => {
    expect(extractSymbols('f1', ':toc!:\n').filter((s) => s.kind === 'attribute')).toHaveLength(0);
  });

  test('an explicit id above a heading overrides the section auto-id (anchor itself remains)', () => {
    const symbols = extractSymbols('f1', '[#install-guide]\n====== Install\n');
    expect(symbols).toContainEqual(expect.objectContaining({ kind: 'section', name: 'install-guide' }));
    expect(symbols.some((s) => s.name === '_install')).toBe(false);
    expect(symbols.some((s) => s.kind === 'anchor' && s.name === 'install-guide')).toBe(true);
  });

  test('same-text headings with distinct explicit ids yield distinct section ids', () => {
    const symbols = extractSymbols('f1', '====== Dup\n\n[#install-guide]\n====== Dup\n');
    expect(symbols.filter((s) => s.kind === 'section').map((s) => s.name)).toEqual(['_dup', 'install-guide']);
  });

  test('a heading glued under prose is paragraph text, not a section (block-boundary rule)', () => {
    const symbols = extractSymbols('f1', 'Some prose text\n== Section Foo\n');
    expect(symbols.filter((s) => s.kind === 'section')).toHaveLength(0);
  });

  test('a heading after a closed delimited block (no blank line) is still a section', () => {
    const symbols = extractSymbols('f1', '****\nSidebar block\n****\n== Section Foo\n');
    expect(symbols).toContainEqual(expect.objectContaining({ kind: 'section', name: '_section_foo' }));
  });

  test('headings inside a verbatim block are not sections, but the one after is', () => {
    const symbols = extractSymbols('f1', '== Real\n\n----\n== Not a heading\n----\n\n== Also Real\n');
    expect(symbols.filter((s) => s.kind === 'section').map((s) => s.name)).toEqual(['_real', '_also_real']);
  });

  test('anchors and attribute definitions inside verbatim/comment blocks are not symbols', () => {
    const content = [
      '[[real-anchor]]',
      '----',
      '[[fake-anchor]]',
      ':fakeattr: x',
      '----',
      '////',
      'anchor:commentanchor[]',
      '////',
    ].join('\n');
    const named = extractSymbols('f1', content).map((s) => `${s.kind}:${s.name}`);
    expect(named).toContain('anchor:real-anchor');
    expect(named).not.toContain('anchor:fake-anchor');
    expect(named).not.toContain('attribute:fakeattr');
    expect(named).not.toContain('anchor:commentanchor');
  });
});

describe('extractAttributeDefinitions', () => {
  test('captures name→value pairs, downcased, skipping unset definitions', () => {
    const defs = extractAttributeDefinitions(':PartsDir: shared/parts\n:empty:\n:draft!:\nbody\n');
    expect(defs).toEqual([
      { name: 'partsdir', value: 'shared/parts' },
      { name: 'empty', value: '' },
    ]);
  });
});

describe('extractOwnAttributes', () => {
  test('captures `:name:` entries and inline `{set:}` assignments alike, downcased, document order', () => {
    const own = extractOwnAttributes(':Author: Ada\n{set:basedir:src/main}\n:draft!:\n');
    expect(Object.fromEntries(own)).toEqual({ author: 'Ada', basedir: 'src/main' });
  });

  test('an inline `{set:name!}` unset removes a previously set attribute', () => {
    const own = extractOwnAttributes(':x: 1\n{set:x!}\n');
    expect(own.has('x')).toBe(false);
  });
});

describe('extractSymbols inline `{set:}`', () => {
  test('an inline `{set:name:value}` defines an `attribute` symbol; `{set:name!}` does not', () => {
    const named = extractSymbols('f1', '{set:basedir:src}\n{set:gone!}\n')
      .filter((s) => s.kind === 'attribute')
      .map((s) => s.name);
    expect(named).toEqual(['basedir']);
  });

  test('a `{set:}` that is value text of a `:name: value` entry is not a phantom attribute symbol (#4)', () => {
    const named = extractSymbols('f1', ':greeting: hi {set:secret:x}\n').map((s) => `${s.kind}:${s.name}`);
    expect(named).toContain('attribute:greeting');
    expect(named).not.toContain('attribute:secret');
  });
});

// A simple relative-path include resolver for the fixtures. The extraction engine takes
// `resolveInclude` as an injected callback (path sandboxing is the CALLER's responsibility, exercised
// in the domain/web layers), so the pure engine's tests only need target → fileId resolution.
const resolveInclude = (files: Record<string, string>) => (from: string, target: string) => {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
  return files[resolved] === undefined ? null : resolved;
};

describe('buildIncludeGraph attribute substitution', () => {
  test('resolves an include whose target uses an attribute reference', () => {
    const files: Record<string, string> = {
      'main.adoc': ':partsdir: parts\n\ninclude::{partsdir}/intro.adoc[]\n',
      'parts/intro.adoc': '== Intro\n',
    };
    const tree = buildIncludeGraph('main.adoc', (id) => files[id] ?? null, resolveInclude(files));
    expect(tree.nodes).toContain('parts/intro.adoc');
    expect(tree.unresolved).toHaveLength(0);
  });

  test('reports the raw (unsubstituted) target when an attribute is undefined', () => {
    const files: Record<string, string> = { 'main.adoc': 'include::{missing}/intro.adoc[]\n' };
    const tree = buildIncludeGraph('main.adoc', (id) => files[id] ?? null, resolveInclude(files));
    expect(tree.unresolved).toEqual([
      expect.objectContaining({ fromFile: 'main.adoc', target: '{missing}/intro.adoc' }),
    ]);
  });

  test('resolves an include whose target uses a nested attribute reference', () => {
    const files: Record<string, string> = {
      'main.adoc': ':root: parts\n:dir: {root}/sub\n\ninclude::{dir}/intro.adoc[]\n',
      'parts/sub/intro.adoc': '== Intro\n',
    };
    const tree = buildIncludeGraph('main.adoc', (id) => files[id] ?? null, resolveInclude(files));
    expect(tree.nodes).toContain('parts/sub/intro.adoc');
    expect(tree.unresolved).toHaveLength(0);
  });

  test('does not substitute an attribute defined after the include (document order)', () => {
    const files: Record<string, string> = {
      'main.adoc': 'include::{partsdir}/intro.adoc[]\n\n:partsdir: parts\n',
      'parts/intro.adoc': '== Intro\n',
    };
    const tree = buildIncludeGraph('main.adoc', (id) => files[id] ?? null, resolveInclude(files));
    expect(tree.nodes).not.toContain('parts/intro.adoc');
    expect(tree.unresolved.some((u) => u.target === '{partsdir}/intro.adoc')).toBe(true);
  });
});

describe('headingToId / parseIncludeLevelOffset', () => {
  test('auto-id mirrors Asciidoctor', () => {
    expect(headingToId('Getting Started!')).toBe('_getting_started');
  });

  test('honours a custom idprefix/idseparator', () => {
    expect(headingToId('Getting Started!', { idprefix: 'id_', idseparator: '-' })).toBe('id_getting-started');
    expect(headingToId('Getting Started!', { idprefix: '', idseparator: '' })).toBe('gettingstarted');
  });

  test('extractSymbols honours idprefix/idseparator, sectids, an inherited seed, and line order', () => {
    const withCustom = extractSymbols('f', ':idprefix: sect_\n:idseparator: -\n\n== My Section\n')
      .filter((s) => s.kind === 'section')
      .map((s) => s.name);
    expect(withCustom).toEqual(['sect_my-section']);
    const sectidsOff = extractSymbols('f', ':sectids!:\n\n== No Id\n\n[[keep]]\n== Explicit\n')
      .filter((s) => s.kind === 'section')
      .map((s) => s.name);
    expect(sectidsOff).toEqual(['keep']);
    // An inherited seed (from an including document) applies; the file's own entry wins over it.
    const inherited = extractSymbols('f', '== My Section\n', new Map([['idprefix', 'inh_'], ['idseparator', '-']]))
      .filter((s) => s.kind === 'section')
      .map((s) => s.name);
    expect(inherited).toEqual(['inh_my-section']);
    // Line-aware: a mid-file `:idprefix:` only affects headings BELOW it, not the ones above.
    const lineAware = extractSymbols('f', '== Before\n\n:idprefix: late_\n\n== After\n')
      .filter((s) => s.kind === 'section')
      .map((s) => s.name);
    expect(lineAware).toEqual(['_before', 'late_after']);
  });

  test('parses include leveloffset', () => {
    expect(parseIncludeLevelOffset('leveloffset=+2')).toBe(2);
    expect(parseIncludeLevelOffset('leveloffset=-1')).toBe(-1);
    expect(parseIncludeLevelOffset('')).toBe(0);
  });
});

describe('resolveReference', () => {
  const symbols = extractSymbols('f1', '[[intro]]\n:ver: 1\n');
  test('resolves a known xref / attributeRef', () => {
    expect(resolveReference({ kind: 'xref', target: 'intro', fileId: 'f1', range: { from: 0, to: 0 } }, symbols)).not.toBe('unresolved');
    expect(resolveReference({ kind: 'attributeRef', target: 'ver', fileId: 'f1', range: { from: 0, to: 0 } }, symbols)).not.toBe('unresolved');
  });
  test('reports unknown targets as unresolved', () => {
    expect(resolveReference({ kind: 'xref', target: 'missing', fileId: 'f1', range: { from: 0, to: 0 } }, symbols)).toBe('unresolved');
  });

  test('resolves an attributeRef case-insensitively (AsciiDoc attribute names are case-insensitive)', () => {
    const caseSymbols = extractSymbols('f1', ':Foo: bar\n');
    expect(resolveReference({ kind: 'attributeRef', target: 'foo', fileId: 'f1', range: { from: 0, to: 0 } }, caseSymbols)).not.toBe('unresolved');
    expect(resolveReference({ kind: 'attributeRef', target: 'FOO', fileId: 'f1', range: { from: 0, to: 0 } }, caseSymbols)).not.toBe('unresolved');
  });

  test('resolves a cross-file xref by its fragment (file.adoc#frag) — review fix', () => {
    expect(resolveReference({ kind: 'xref', target: 'chap.adoc#intro', fileId: 'f1', range: { from: 0, to: 0 } }, symbols)).not.toBe('unresolved');
    expect(resolveReference({ kind: 'xref', target: '#intro', fileId: 'f1', range: { from: 0, to: 0 } }, symbols)).not.toBe('unresolved');
  });
});

describe('buildIncludeGraph', () => {
  const files: Record<string, string> = {
    main: 'include::a.adoc[]\ninclude::b.adoc[leveloffset=+1]\n',
    a: 'include::missing.adoc[]\n',
    b: 'include::a.adoc[]\n', // a already visited → no infinite loop
  };
  const read = (id: string) => files[id] ?? null;
  const resolve = (_from: string, target: string) => {
    const id = target.replace('.adoc', '');
    return id in files ? id : null;
  };

  test('builds transitive nodes/edges, cycle-guarded', () => {
    const tree = buildIncludeGraph('main', read, resolve);
    expect(tree.nodes.toSorted()).toEqual(['a', 'b', 'main']);
    expect(tree.edges).toHaveLength(3); // main→a, main→b, b→a
  });

  test('records unresolved includes', () => {
    const tree = buildIncludeGraph('main', read, resolve);
    expect(tree.unresolved).toContainEqual(expect.objectContaining({ fromFile: 'a', target: 'missing.adoc' }));
  });

  test('edges carry the include leveloffset', () => {
    const tree = buildIncludeGraph('main', read, resolve);
    const edgeToB = tree.edges.find((edge) => edge.to === 'b');
    expect(edgeToB?.leveloffset).toBe(1);
  });
});

describe('inheritedLevelOffset', () => {
  const files: Record<string, string> = {
    main: 'include::a.adoc[leveloffset=+1]\n',
    a: 'include::b.adoc[leveloffset=+1]\n',
    b: '',
  };
  const tree = buildIncludeGraph(
    'main',
    (id) => files[id] ?? null,
    (_f, t) => t.replace('.adoc', ''),
  );

  test('root has offset 0', () => {
    expect(inheritedLevelOffset(tree, 'main')).toBe(0);
  });
  test('accumulates offsets along the include path', () => {
    expect(inheritedLevelOffset(tree, 'a')).toBe(1);
    expect(inheritedLevelOffset(tree, 'b')).toBe(2);
  });
  test('unreachable file → 0', () => {
    expect(inheritedLevelOffset(tree, 'orphan')).toBe(0);
  });
});

describe('effectiveLevelOffset (continuation-join parity with the web copy)', () => {
  test('a `\\`-continued attribute value whose continuation line looks like an include is NOT walked', () => {
    // The continuation line is value TEXT of `:caption:`, not a directive — joining it (as
    // documentOrderEvents and the assembler do) keeps child.adoc unreachable instead of synthesizing
    // a phantom include/offset (#3).
    const files = {
      'main.adoc': ':caption: see \\\ninclude::child.adoc[leveloffset=+3]\n',
      'child.adoc': '== Heading\n',
    };
    expect(
      effectiveLevelOffset({
        rootFileId: 'main.adoc',
        fileId: 'child.adoc',
        readContent: read(files),
        resolveInclude: resolveInclude(files),
      }),
    ).toBe(0);
  });
});

describe('extractReferences (xref/include/image/attributeRef parity)', () => {
  test('extracts both <<>> and xref: forms, include, image, and attribute refs', () => {
    const content = [
      'See <<intro>> and <<sec,label>>.',
      'Also xref:other.adoc#part[Part].',
      'include::chapter.adoc[leveloffset=+1]',
      'image::diagram.png[Diagram]',
      'Version {version} here.',
    ].join('\n');
    const references = extractReferences('f1', content);
    const kinds = references.map((reference) => `${reference.kind}:${reference.target}`);
    expect(kinds).toContain('xref:intro');
    expect(kinds).toContain('xref:sec');
    expect(kinds).toContain('xref:other.adoc#part');
    expect(kinds).toContain('include:chapter.adoc');
    expect(kinds).toContain('image:diagram.png');
    expect(kinds).toContain('attributeRef:version');
    expect(references.every((reference) => reference.fileId === 'f1')).toBe(true);
  });

  test('an empty xref target is skipped', () => {
    expect(extractReferences('f', 'a <<>> b\n').filter((reference) => reference.kind === 'xref')).toHaveLength(0);
  });

  test('a reference range spans the matched text', () => {
    const [reference] = extractReferences('f', '<<intro>>');
    expect(reference.range).toEqual({ from: 0, to: '<<intro>>'.length });
  });

  test('references inside literal/passthrough blocks are not extracted', () => {
    const content = [
      'Real <<intro>> here.',
      '',
      '....',
      'literal <<alsonotreal>>',
      '....',
      '',
      '++++',
      'passthrough {ptattr}',
      '++++',
    ].join('\n');
    const targets = extractReferences('f', content).map((reference) => reference.target);
    expect(targets).toContain('intro');
    expect(targets).not.toContain('alsonotreal');
    expect(targets).not.toContain('ptattr');
  });

  test('references inside non-verbatim delimited blocks (example/sidebar/quote) are still extracted', () => {
    const content = '====\nSee <<inExample>>\n====\n\n****\n<<inSidebar>>\n****';
    const targets = extractReferences('f', content).map((reference) => reference.target);
    expect(targets).toContain('inExample');
    expect(targets).toContain('inSidebar');
  });
});

describe('extractSymbols (anchor forms + auto-id parity)', () => {
  test('extracts section, anchor (all three forms), and attribute definitions', () => {
    const content = [
      '== A Section',
      '[[anchor-one]]',
      '[#anchor-two]',
      'anchor:anchor-three[]',
      ':myattr: value',
    ].join('\n');
    const named = extractSymbols('f', content).map((symbol) => `${symbol.kind}:${symbol.name}`);
    expect(named).toContain('section:_a_section');
    expect(named).toContain('anchor:anchor-one');
    expect(named).toContain('anchor:anchor-two');
    expect(named).toContain('anchor:anchor-three');
    expect(named).toContain('attribute:myattr');
  });

  test('an explicit id above a heading suppresses the auto-id but keeps the anchor (both forms)', () => {
    for (const anchor of ['[#install-guide]', '[[install-guide]]']) {
      const named = extractSymbols('f', `${anchor}\n====== Install\n`).map((s) => `${s.kind}:${s.name}`);
      expect(named).toContain('section:install-guide');
      expect(named).not.toContain('section:_install');
      expect(named).toContain('anchor:install-guide');
    }
  });

  test('an inline `{set:}` on a prose line is still a first-class attribute symbol', () => {
    const named = extractSymbols('f', 'body {set:flag:on}\n').map((s) => `${s.kind}:${s.name}`);
    expect(named).toContain('attribute:flag');
  });
});

describe('extractOwnAttributes (set/unset/override/expansion parity)', () => {
  test('captures `:name: value` entries downcased, skipping unset definitions', () => {
    const own = extractOwnAttributes(':PartsDir: shared/parts\n:empty:\n:draft!:\nbody\n');
    expect(Object.fromEntries(own)).toEqual({ partsdir: 'shared/parts', empty: '' });
  });

  test('includes an inline `{set:name:value}` assignment as a first-class own definition', () => {
    const own = extractOwnAttributes('{set:basedir:src/main}\nbody\n');
    expect(own.get('basedir')).toBe('src/main');
  });

  test('a later definition overrides an earlier one (document order)', () => {
    const own = extractOwnAttributes(':v: one\n{set:v:two}\n');
    expect(own.get('v')).toBe('two');
  });

  test('expands a nested `{ref}` in a set value against the attributes defined so far', () => {
    const own = extractOwnAttributes(':first: Jane\n:full: {first} Doe\n');
    expect(own.get('full')).toBe('Jane Doe');
  });

  test('does NOT treat attribute entries / inline {set:} inside a verbatim block as real definitions', () => {
    const content = [':real: yes', '', '----', ':fake: nope', '{set:alsofake:nope}', '----', ''].join('\n');
    const own = extractOwnAttributes(content);
    expect(own.get('real')).toBe('yes');
    expect(own.has('fake')).toBe(false);
    expect(own.has('alsofake')).toBe(false);
  });
});

describe('parseIncludeTags', () => {
  test('returns null when no tag selector is present', () => {
    expect(parseIncludeTags('lines=1..5')).toBeNull();
    expect(parseIncludeTags('')).toBeNull();
  });

  test('splits a single-tag selector', () => {
    expect(parseIncludeTags('tag=foo')).toEqual(['foo']);
  });

  test('splits an unquoted selector on `;`, trimming and dropping empties', () => {
    expect(parseIncludeTags('tags=a;!b;**')).toEqual(['a', '!b', '**']);
    expect(parseIncludeTags('tags=a; b ;')).toEqual(['a', 'b']);
  });

  test('splits a quoted selector on `;` or `,` (comma only separates inside quotes)', () => {
    expect(parseIncludeTags('tags="a, b ,"')).toEqual(['a', 'b']);
  });

  test('accepts a quoted selector value', () => {
    expect(parseIncludeTags('tags="a;b"')).toEqual(['a', 'b']);
  });
});

describe('parseIncludeLines', () => {
  test('returns null when no line selector is present', () => {
    expect(parseIncludeLines('tags=foo')).toBeNull();
    expect(parseIncludeLines('')).toBeNull();
  });

  test('a single line becomes a [n, n] range', () => {
    expect(parseIncludeLines('lines=2')).toEqual([[2, 2]]);
  });

  test('a closed range parses both endpoints', () => {
    expect(parseIncludeLines('lines=2..4')).toEqual([[2, 4]]);
  });

  test('multiple ranges separated by `;` or `,`', () => {
    expect(parseIncludeLines('lines=1;3..4')).toEqual([
      [1, 1],
      [3, 4],
    ]);
    expect(parseIncludeLines('lines="1,3..4"')).toEqual([
      [1, 1],
      [3, 4],
    ]);
  });

  test('an open-ended range (`5..`, `5..-1`) reaches end of file (null end)', () => {
    expect(parseIncludeLines('lines=5..')).toEqual([[5, null]]);
    expect(parseIncludeLines('lines=5..-1')).toEqual([[5, null]]);
  });

  test('skips tokens with a non-numeric start and ignores blanks', () => {
    expect(parseIncludeLines('lines=x..4; ;6')).toEqual([[6, 6]]);
  });
});

describe('resolveReference (cross-file / case-insensitive parity)', () => {
  const symbols: ProjectSymbol[] = [
    { kind: 'anchor', name: 'intro', fileId: 'f', range: { from: 0, to: 1 } },
    { kind: 'section', name: '_part', fileId: 'f', range: { from: 0, to: 1 } },
    { kind: 'attribute', name: 'Version', fileId: 'f', range: { from: 0, to: 1 } },
  ];

  test('resolves a cross-file xref by its #fragment', () => {
    const reference: Reference = { kind: 'xref', target: 'other.adoc#_part', fileId: 'f', range: { from: 0, to: 1 } };
    expect(resolveReference(reference, symbols)).toMatchObject({ name: '_part' });
  });

  test('resolves an attribute reference case-insensitively', () => {
    const reference: Reference = { kind: 'attributeRef', target: 'version', fileId: 'f', range: { from: 0, to: 1 } };
    expect(resolveReference(reference, symbols)).toMatchObject({ name: 'Version' });
  });

  test('returns "unresolved" for a non-resolvable kind (include)', () => {
    const include: Reference = { kind: 'include', target: 'x.adoc', fileId: 'f', range: { from: 0, to: 1 } };
    expect(resolveReference(include, symbols)).toBe('unresolved');
  });
});

describe('buildIncludeGraph attribute substitution', () => {
  test('resolves an include whose target uses an attribute reference', () => {
    const files: Record<string, string> = {
      'main.adoc': ':partsdir: parts\n\ninclude::{partsdir}/intro.adoc[]\n',
      'parts/intro.adoc': '== Intro\n',
    };
    const tree = buildIncludeGraph('main.adoc', read(files), resolveInclude(files));
    expect(tree.nodes).toContain('parts/intro.adoc');
    expect(tree.unresolved).toHaveLength(0);
  });

  test('reports the raw target when the attribute is undefined', () => {
    const files: Record<string, string> = { 'main.adoc': 'include::{missing}/intro.adoc[]\n' };
    const tree = buildIncludeGraph('main.adoc', read(files), resolveInclude(files));
    expect(tree.unresolved).toEqual([expect.objectContaining({ fromFile: 'main.adoc', target: '{missing}/intro.adoc' })]);
  });

  test('an include is not resolved by an attribute defined after it (document order)', () => {
    const files = {
      'main.adoc': 'include::{dir}/x.adoc[]\n\n:dir: parts\n',
      'parts/x.adoc': '= X\n',
    };
    const tree = buildIncludeGraph('main.adoc', read(files), resolveInclude(files));
    expect(tree.unresolved.some((u) => u.target === '{dir}/x.adoc')).toBe(true);
    expect(tree.nodes).not.toContain('parts/x.adoc');
  });
});

describe('buildIncludeGraphWithInheritance (parent → child attribute scope)', () => {
  test('a child inherits parent attributes defined above its include, not below', () => {
    const files = {
      'main.adoc': ':before: B\n\ninclude::child.adoc[]\n\n:after: A\n',
      'child.adoc': '= Child\n',
    };
    const { inheritedAttributes } = buildIncludeGraphWithInheritance('main.adoc', read(files), resolveInclude(files));
    const inherited = inheritedAttributes.get('child.adoc');
    expect(inherited?.get('before')).toBe('B');
    expect(inherited?.has('after')).toBe(false);
    expect(inheritedAttributes.get('main.adoc')?.size).toBe(0);
  });

  test('a `\\`-continued attribute value containing an include:: line creates NO spurious include edge', () => {
    const files = {
      'main.adoc': ':k: a \\\ninclude::child.adoc[]\nBody {k}.\n',
      'child.adoc': '= Child\n',
    };
    const { tree } = buildIncludeGraphWithInheritance('main.adoc', read(files), resolveInclude(files));
    expect(tree.edges.some((edge) => edge.to === 'child.adoc')).toBe(false);
  });

  test('resolves nested attribute references in inherited values (document order)', () => {
    const files = {
      'main.adoc': ':first: Jane\n:full: {first} Doe\n\ninclude::child.adoc[]\n',
      'child.adoc': '= Child\n',
    };
    const { inheritedAttributes } = buildIncludeGraphWithInheritance('main.adoc', read(files), resolveInclude(files));
    expect(inheritedAttributes.get('child.adoc')?.get('full')).toBe('Jane Doe');
  });

  test('leaves a forward reference in an inherited value unresolved (document order)', () => {
    const files = {
      'main.adoc': ':full: {first} Doe\n:first: Jane\n\ninclude::child.adoc[]\n',
      'child.adoc': '= Child\n',
    };
    const { inheritedAttributes } = buildIncludeGraphWithInheritance('main.adoc', read(files), resolveInclude(files));
    expect(inheritedAttributes.get('child.adoc')?.get('full')).toBe('{first} Doe');
  });

  test('a child inherits the parent :imagesdir: defined above the include', () => {
    const files = {
      'main.adoc': ':imagesdir: assets\n\ninclude::child.adoc[]\n',
      'child.adoc': 'image::logo.png[]\n',
    };
    const { inheritedAttributes } = buildIncludeGraphWithInheritance('main.adoc', read(files), resolveInclude(files));
    expect(inheritedAttributes.get('child.adoc')?.get('imagesdir')).toBe('assets');
  });

  test('a recursive include (a → b → a) terminates and records first-visit inheritance', () => {
    const files = {
      'a.adoc': ':froma: 1\n\ninclude::b.adoc[]\n',
      'b.adoc': ':fromb: 2\n\ninclude::a.adoc[]\n',
    };
    const { tree, inheritedAttributes } = buildIncludeGraphWithInheritance('a.adoc', read(files), resolveInclude(files));
    expect(tree.nodes).toEqual(['a.adoc', 'b.adoc']);
    expect(inheritedAttributes.get('a.adoc')?.size).toBe(0);
    expect(inheritedAttributes.get('b.adoc')?.get('froma')).toBe('1');
  });

  test('does NOT walk an include gated off by an inactive conditional region', () => {
    const files = {
      'main.adoc': 'ifdef::pdf[]\ninclude::child.adoc[]\nendif::[]\n',
      'child.adoc': ':childattr: x\n= Child\n',
    };
    const { tree, inheritedAttributes } = buildIncludeGraphWithInheritance('main.adoc', read(files), resolveInclude(files));
    expect(tree.nodes).not.toContain('child.adoc');
    expect(tree.edges).toHaveLength(0);
    expect(inheritedAttributes.has('child.adoc')).toBe(false);
  });

  test('DOES walk an include gated ON by an active conditional region', () => {
    const files = {
      'main.adoc': ':pdf:\n\nifdef::pdf[]\ninclude::child.adoc[]\nendif::[]\n',
      'child.adoc': '= Child\n',
    };
    const { tree } = buildIncludeGraphWithInheritance('main.adoc', read(files), resolveInclude(files));
    expect(tree.nodes).toContain('child.adoc');
  });

  test('gates includes against the render-intrinsic seed so an ifdef::backend-html5[] include is walked', () => {
    const files = {
      'main.adoc': 'ifdef::backend-html5[]\ninclude::child.adoc[]\nendif::[]\n',
      'child.adoc': '= Child\n',
    };
    const seed = new Map([['backend-html5', '']]);
    const gated = buildIncludeGraphWithInheritance('main.adoc', read(files), resolveInclude(files));
    const seeded = buildIncludeGraphWithInheritance('main.adoc', read(files), resolveInclude(files), seed);
    expect(gated.tree.nodes).not.toContain('child.adoc');
    expect(seeded.tree.nodes).toContain('child.adoc');
  });

  test('an include:: inside a verbatim block is literal text, creating NO edge', () => {
    const files = {
      'main.adoc': '----\ninclude::child.adoc[]\n----\n',
      'child.adoc': '= Child\n',
    };
    const { tree } = buildIncludeGraphWithInheritance('main.adoc', read(files), resolveInclude(files));
    expect(tree.edges).toHaveLength(0);
    expect(tree.nodes).not.toContain('child.adoc');
  });

  test('buildIncludeGraph returns just the tree of the inheritance-aware walk', () => {
    const files = { 'main.adoc': ':x: 1\ninclude::child.adoc[]\n', 'child.adoc': '= Child\n' };
    const tree = buildIncludeGraph('main.adoc', read(files), resolveInclude(files));
    const result = buildIncludeGraphWithInheritance('main.adoc', read(files), resolveInclude(files));
    expect(tree).toEqual(result.tree);
  });
});

describe('resolveAttributeScope', () => {
  test("standalone (rootFileId=null) resolves only the file's own attributes", () => {
    const files = { 'lone.adoc': ':own: yes\n:another: 2\nbody {own}\n' };
    const scope = resolveAttributeScope({
      rootFileId: null,
      fileId: 'lone.adoc',
      readContent: read(files),
      resolveInclude: resolveInclude(files),
    });
    expect(scope.origin).toBe('standalone');
    expect(scope.values.get('own')).toBe('yes');
    expect(scope.values.get('another')).toBe('2');
  });

  test('root scope (fileId === rootFileId) has origin "root" and its own attrs', () => {
    const files = { 'main.adoc': ':title: Manual\n\ninclude::child.adoc[]\n', 'child.adoc': '= Child\n' };
    const scope = resolveAttributeScope({
      rootFileId: 'main.adoc',
      fileId: 'main.adoc',
      readContent: read(files),
      resolveInclude: resolveInclude(files),
    });
    expect(scope.origin).toBe('root');
    expect(scope.values.get('title')).toBe('Manual');
  });

  test('a child inherits the parent attributes defined above its include, plus its own', () => {
    const files = {
      'main.adoc': ':env: prod\n\ninclude::child.adoc[]\n\n:after: late\n',
      'child.adoc': '= Child\n:local: x\n',
    };
    const scope = resolveAttributeScope({
      rootFileId: 'main.adoc',
      fileId: 'child.adoc',
      readContent: read(files),
      resolveInclude: resolveInclude(files),
    });
    expect(scope.origin).toBe('inherited');
    expect(scope.values.get('env')).toBe('prod');
    expect(scope.values.has('after')).toBe(false);
    expect(scope.values.get('local')).toBe('x');
  });

  test('a `{set:}` that is value text of an attribute definition does not leak into the scope', () => {
    const files = {
      'main.adoc': ':greeting: hi {set:secret:x}\n\ninclude::child.adoc[]\n',
      'child.adoc': '= Child\n',
    };
    const scope = resolveAttributeScope({
      rootFileId: 'main.adoc',
      fileId: 'child.adoc',
      readContent: read(files),
      resolveInclude: resolveInclude(files),
    });
    expect(scope.values.get('greeting')).toBe('hi {set:secret:x}');
    expect(scope.values.has('secret')).toBe(false);
  });

  test('first-include inheritance: a child reached via two paths keeps its FIRST-visit scope', () => {
    const files = {
      'main.adoc': ':flag: one\n\ninclude::child.adoc[]\n\n:flag: two\n\ninclude::child.adoc[]\n',
      'child.adoc': 'uses {flag}\n',
    };
    const scope = resolveAttributeScope({
      rootFileId: 'main.adoc',
      fileId: 'child.adoc',
      readContent: read(files),
      resolveInclude: resolveInclude(files),
    });
    expect(scope.values.get('flag')).toBe('one');
  });

  test('unset (:!name:) before an include removes the attribute for the child', () => {
    const files = {
      'main.adoc': ':env: prod\n:!env:\n\ninclude::child.adoc[]\n',
      'child.adoc': '= Child\n',
    };
    const scope = resolveAttributeScope({
      rootFileId: 'main.adoc',
      fileId: 'child.adoc',
      readContent: read(files),
      resolveInclude: resolveInclude(files),
    });
    expect(scope.values.has('env')).toBe(false);
  });

  test('inline {set:name:value} sets, and {set:name!} unsets, in reading order', () => {
    const files = {
      'main.adoc': '{set:dyn:on}\n\ninclude::child.adoc[]\n',
      'child.adoc': '= Child\n',
    };
    const scope = resolveAttributeScope({
      rootFileId: 'main.adoc',
      fileId: 'child.adoc',
      readContent: read(files),
      resolveInclude: resolveInclude(files),
    });
    expect(scope.values.get('dyn')).toBe('on');

    const unsetFiles = {
      'main.adoc': ':dyn: on\n{set:dyn!}\n\ninclude::child.adoc[]\n',
      'child.adoc': '= Child\n',
    };
    const unsetScope = resolveAttributeScope({
      rootFileId: 'main.adoc',
      fileId: 'child.adoc',
      readContent: read(unsetFiles),
      resolveInclude: resolveInclude(unsetFiles),
    });
    expect(unsetScope.values.has('dyn')).toBe(false);
  });

  test(String.raw`wrapping (trailing \) joins a multi-line attribute value`, () => {
    const files = { 'lone.adoc': ':msg: first line \\\nsecond line\n' };
    const scope = resolveAttributeScope({
      rootFileId: null,
      fileId: 'lone.adoc',
      readContent: read(files),
      resolveInclude: resolveInclude(files),
    });
    expect(scope.values.get('msg')).toBe('first line second line');
  });

  test('a soft-set (value@) does not override an attribute already in scope; a later hard set does', () => {
    const files = { 'lone.adoc': ':theme: dark\n:theme: light@\n:other: a@\n' };
    const scope = resolveAttributeScope({
      rootFileId: null,
      fileId: 'lone.adoc',
      readContent: read(files),
      resolveInclude: resolveInclude(files),
    });
    expect(scope.values.get('theme')).toBe('dark');
    expect(scope.values.get('other')).toBe('a');
  });

  test('a later in-document definition is NOT applied over a soft default for the same name', () => {
    const files = { 'lone.adoc': ':v: locked\n:v: open@\n' };
    const scope = resolveAttributeScope({
      rootFileId: null,
      fileId: 'lone.adoc',
      readContent: read(files),
      resolveInclude: resolveInclude(files),
    });
    expect(scope.values.get('v')).toBe('locked');
  });

  test('a recursive include (a -> b -> a) terminates safely', () => {
    const files = {
      'a.adoc': ':x: 1\n\ninclude::b.adoc[]\n',
      'b.adoc': ':y: 2\n\ninclude::a.adoc[]\n',
    };
    const scope = resolveAttributeScope({
      rootFileId: 'a.adoc',
      fileId: 'b.adoc',
      readContent: read(files),
      resolveInclude: resolveInclude(files),
    });
    expect(scope.values.get('x')).toBe('1');
  });

  test('a file unreachable from the root inherits nothing but keeps its own attributes', () => {
    const files = { 'main.adoc': '= Main\n', 'orphan.adoc': ':o: 1\n' };
    const scope = resolveAttributeScope({
      rootFileId: 'main.adoc',
      fileId: 'orphan.adoc',
      readContent: read(files),
      resolveInclude: resolveInclude(files),
    });
    expect(scope.origin).toBe('inherited');
    expect(scope.values.get('o')).toBe('1');
    expect(scope.values.size).toBe(1);
  });
});

describe('effectiveLevelOffset (attribute-form :leveloffset: + include offsets, include-scoped)', () => {
  test('standalone (rootFileId=null) is 0 — the file has no inherited offset', () => {
    const files = { 'lone.adoc': ':leveloffset: +1\n\n== A\n' };
    expect(
      effectiveLevelOffset({ rootFileId: null, fileId: 'lone.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(0);
  });

  test('the root file itself has 0 inherited offset', () => {
    const files = { 'main.adoc': ':leveloffset: +2\n\ninclude::child.adoc[]\n', 'child.adoc': '== C\n' };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'main.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(0);
  });

  test('a child included with leveloffset=+1 inherits offset +1', () => {
    const files = { 'main.adoc': 'include::child.adoc[leveloffset=+1]\n', 'child.adoc': '= Child Title\n' };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'child.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(1);
  });

  test('a parent attribute-form :leveloffset: above the include is inherited by the child', () => {
    const files = { 'main.adoc': ':leveloffset: +2\n\ninclude::child.adoc[]\n', 'child.adoc': '== Heading\n' };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'child.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(2);
  });

  test('attribute-form and include-option offsets compose at the include point', () => {
    const files = { 'main.adoc': ':leveloffset: +1\n\ninclude::child.adoc[leveloffset=+2]\n', 'child.adoc': '== Heading\n' };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'child.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(3);
  });

  test('a parent attribute-form :leveloffset: AFTER the include does not reach the child', () => {
    const files = { 'main.adoc': 'include::child.adoc[]\n\n:leveloffset: +5\n', 'child.adoc': '== Heading\n' };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'child.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(0);
  });

  test('attribute-form :leveloffset: inside one child persists into a sibling (AsciiDoc semantics)', () => {
    // Asciidoctor semantics: `:leveloffset: +1` SET INSIDE an included file (attribute form) persists
    // after the include ends — only the `leveloffset=` OPTION on the include directive is scoped.
    const files = {
      'main.adoc': 'include::first.adoc[]\n\ninclude::second.adoc[]\n',
      'first.adoc': ':leveloffset: +1\n\n== In First\n',
      'second.adoc': '== In Second\n',
    };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'second.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(1);
  });

  test('first-include-point wins for a child reached via two paths', () => {
    const files = {
      'main.adoc': 'include::child.adoc[leveloffset=+1]\n\ninclude::child.adoc[leveloffset=+3]\n',
      'child.adoc': '== Heading\n',
    };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'child.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(1);
  });

  test('a recursive include (a -> b -> a) terminates safely', () => {
    const files = {
      'a.adoc': 'include::b.adoc[leveloffset=+1]\n',
      'b.adoc': 'include::a.adoc[leveloffset=+1]\n',
    };
    expect(
      effectiveLevelOffset({ rootFileId: 'a.adoc', fileId: 'b.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(1);
  });

  test('a file unreachable from the root has 0 inherited offset', () => {
    const files = { 'main.adoc': '= Main\n', 'orphan.adoc': ':leveloffset: +4\n\n== O\n' };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'orphan.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(0);
  });

  test('an include inside an INACTIVE conditional branch is not walked (no inherited offset)', () => {
    const files = {
      'main.adoc': 'ifdef::draft[]\ninclude::child.adoc[leveloffset=+2]\nendif::[]\n',
      'child.adoc': '== Heading\n',
    };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'child.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(0);
  });

  test('an include inside an ACTIVE conditional branch is walked normally', () => {
    const files = {
      'main.adoc': ':draft:\n\nifdef::draft[]\ninclude::child.adoc[leveloffset=+2]\nendif::[]\n',
      'child.adoc': '== Heading\n',
    };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'child.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(2);
  });

  test('seedAttributes make an intrinsic-guarded include active (matches the seeded preview)', () => {
    const files = {
      'main.adoc': 'ifdef::backend-html5[]\ninclude::child.adoc[leveloffset=+1]\nendif::[]\n',
      'child.adoc': '== Heading\n',
    };
    expect(
      effectiveLevelOffset({
        rootFileId: 'main.adoc',
        fileId: 'child.adoc',
        readContent: read(files),
        resolveInclude: resolveInclude(files),
        seedAttributes: new Map([['backend-html5', '']]),
      }),
    ).toBe(1);
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'child.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(0);
  });

  test('a persisting :leveloffset: from a file included via TWO sibling paths accumulates per occurrence', () => {
    // Ground truth (real Asciidoctor): main→a→shared AND main→b→shared, where shared sets a persisting
    // attribute-form `:leveloffset: +1`. Asciidoctor EXPANDS each include occurrence, so the shift is
    // applied twice (once per path) — it does NOT dedup a diamond. A later sibling therefore inherits
    // +2, not +1. The offset walk mirrors the assembler's per-occurrence expansion (path-stack guard,
    // not a permanent visited set), so it agrees with the render.
    const files = {
      'main.adoc': 'include::a.adoc[]\ninclude::b.adoc[]\ninclude::tail.adoc[]\n',
      'a.adoc': 'include::shared.adoc[]\n',
      'b.adoc': 'include::shared.adoc[]\n',
      'shared.adoc': ':leveloffset: +1\n',
      'tail.adoc': '== Tail\n',
    };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'tail.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(2);
  });

  test('a long run of NOT-FOUND includes does not deplete the budget and gate off a later valid include', () => {
    // Parity with the assembler, which charges its expansion budget only for a resolved+found include
    // (cycle/depth/not-found rejections precede `expansions += 1`). Here MANY includes RESOLVE to an id
    // but have no content (not-found); they must NOT consume the budget, or the trailing valid chapter
    // would be gated off (offset 0) while the preview still expands it — an R2 break. `ghostN` resolve
    // but read null; `chapter.adoc` is the real target at `leveloffset=+2`.
    const ghosts = Array.from({ length: 10_001 }, (_unused, index) => `include::ghost${index}.adoc[]`).join('\n');
    const files: Record<string, string> = {
      'main.adoc': `${ghosts}\ninclude::chapter.adoc[leveloffset=+2]\n`,
      'chapter.adoc': '== Chapter\n',
    };
    // Every target resolves to its own id; only chapter.adoc has content (ghosts are not-found).
    const readNullable = (id: string): string | null => files[id] ?? null;
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'chapter.adoc', readContent: readNullable, resolveInclude: resolveToSelfId }),
    ).toBe(2);
  });

  test('a doubling include fan-out terminates within the expansion budget (no hang)', () => {
    // Each level includes the next level TWICE, so without a global budget the walk is 2^depth — an
    // attacker-authored graph that would pin the worker. The expansion budget (mirroring the assembler's
    // `maxExpansions`) bounds total work, so the walk returns a finite value promptly instead of hanging.
    const files: Record<string, string> = { 'leaf.adoc': '== Leaf\n' };
    for (let level = 0; level < 40; level += 1) {
      const next = level === 39 ? 'leaf.adoc' : `l${level + 1}.adoc`;
      files[`l${level}.adoc`] = `include::${next}[]\ninclude::${next}[]\n`;
    }
    const result = effectiveLevelOffset({ rootFileId: 'l0.adoc', fileId: 'leaf.adoc', readContent: read(files), resolveInclude: resolveInclude(files) });
    expect(Number.isFinite(result)).toBe(true);
  });
});

describe('leveloffset is engine-reserved (never leaks into an attribute map)', () => {
  // `:leveloffset:` is position-dependent and cumulative — the raw last-written string held in an
  // attribute map is meaningless as a resolved offset. It must be resolved ONLY through
  // `effectiveLevelOffset`, so the shared engine strips it from every accumulated attribute map.
  test("resolveAttributeScope().values omits a file's own :leveloffset:", () => {
    const files = { 'main.adoc': ':leveloffset: +1\n\ninclude::child.adoc[]\n', 'child.adoc': '== A\n:leveloffset: +10\n' };
    const scope = resolveAttributeScope({
      rootFileId: 'main.adoc',
      fileId: 'child.adoc',
      readContent: read(files),
      resolveInclude: resolveInclude(files),
    });
    expect(scope.values.has('leveloffset')).toBe(false);
  });

  test('buildIncludeGraphWithInheritance().inheritedAttributes omits leveloffset', () => {
    const files = { 'main.adoc': ':leveloffset: +1\n\ninclude::child.adoc[]\n', 'child.adoc': '== A\n' };
    const { inheritedAttributes } = buildIncludeGraphWithInheritance('main.adoc', read(files), resolveInclude(files));
    expect(inheritedAttributes.get('child.adoc')?.has('leveloffset')).toBe(false);
  });

  test('extractOwnAttributes omits leveloffset', () => {
    expect(extractOwnAttributes(':leveloffset: +3\n:author: X\n').has('leveloffset')).toBe(false);
    expect(extractOwnAttributes(':leveloffset: +3\n:author: X\n').get('author')).toBe('X');
  });

  // leveloffset is stripped from the VALUE maps consumers read, but it is still a real Asciidoctor
  // document attribute for CONDITIONAL gating: `ifdef::leveloffset[]` is active when it is set. Ground
  // truth (real Asciidoctor S4): with `:leveloffset: +1` set, an `ifdef::leveloffset[]`-guarded
  // `include::child[leveloffset=+2]` IS expanded, so the child inherits 1 + 2 = 3.
  test('ifdef::leveloffset[] gating sees leveloffset when it is set (matches Asciidoctor)', () => {
    const files = {
      'main.adoc': ':leveloffset: +1\n\nifdef::leveloffset[]\ninclude::child.adoc[leveloffset=+2]\nendif::[]\n',
      'child.adoc': '== H\n',
    };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'child.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(3);
  });

  test('ifndef::leveloffset[] gates an include OFF when leveloffset is set', () => {
    const files = {
      'main.adoc': ':leveloffset: +1\n\nifndef::leveloffset[]\ninclude::child.adoc[leveloffset=+2]\nendif::[]\n',
      'child.adoc': '== H\n',
    };
    // leveloffset IS set, so ifndef is inactive → the include is gated off → child unreachable → 0.
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'child.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(0);
  });

  // The core invariant: the offset AUTHORITY (effectiveLevelOffset) is the include-point value, even
  // when the child's own trailing entry would poison a naive attribute-map read. This is the exact
  // repro (parent :leveloffset: +1 above the include; child ends with :leveloffset: +10).
  test('effectiveLevelOffset is the include-point offset, not the file end-state', () => {
    const files = {
      'main.adoc': ':leveloffset: +1\n\ninclude::child.adoc[]\n',
      'child.adoc': '== A\n\n== B\n\n:leveloffset: +10\n',
    };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'child.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(1);
  });

  // R1: relatives accumulate (would be `+1` last-wins if routed through an attribute map).
  test('R1 — two successive :leveloffset: +1 entries accumulate to +2 (persisted into a sibling)', () => {
    const files = {
      'main.adoc': 'include::a.adoc[]\n\ninclude::b.adoc[]\n',
      'a.adoc': ':leveloffset: +1\n:leveloffset: +1\n',
      'b.adoc': '== B\n',
    };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'b.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(2);
  });

  test('a pathologically deep include chain terminates (depth-capped, no stack overflow)', () => {
    // A long linear chain of DISTINCT files (the cycle guard does not bound recursion depth). The walk
    // must stop at the same nesting the include assembler caps at (64), so a file deeper than the cap is
    // treated as not expanded (offset 0) and the recursion cannot overflow the stack.
    const files: Record<string, string> = { 'c0.adoc': 'include::c1.adoc[leveloffset=+1]\n' };
    for (let index = 1; index < 200; index += 1) {
      files[`c${index}.adoc`] = `include::c${index + 1}.adoc[leveloffset=+1]\n`;
    }
    files['c200.adoc'] = '== Deep\n';
    // Reachable within the cap: c40 is at depth 40 → offset 40.
    expect(
      effectiveLevelOffset({ rootFileId: 'c0.adoc', fileId: 'c40.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(40);
    // Beyond the cap: c200 is never expanded → offset 0, and the call returns without throwing.
    expect(() =>
      effectiveLevelOffset({ rootFileId: 'c0.adoc', fileId: 'c200.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).not.toThrow();
    expect(
      effectiveLevelOffset({ rootFileId: 'c0.adoc', fileId: 'c200.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(0);
  });

  test('R1 — :leveloffset: +1 then -1 nets to 0', () => {
    const files = {
      'main.adoc': 'include::a.adoc[]\n\ninclude::b.adoc[]\n',
      'a.adoc': ':leveloffset: +1\n:leveloffset: -1\n',
      'b.adoc': '== B\n',
    };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'b.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(0);
  });

  // `:leveloffset:` may also be an EXACT (absolute) value, not just a relative `+N`/`-N`.
  test('an absolute :leveloffset: N above the include is inherited as N (not added to the base)', () => {
    const files = { 'main.adoc': ':leveloffset: +1\n\n:leveloffset: 3\n\ninclude::child.adoc[]\n', 'child.adoc': '== A\n' };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'child.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(3);
  });

  test('an absolute :leveloffset: overrides a preceding relative inside the same file (persisted)', () => {
    const files = {
      'main.adoc': 'include::a.adoc[]\n\ninclude::b.adoc[]\n',
      'a.adoc': ':leveloffset: +2\n:leveloffset: 1\n',
      'b.adoc': '== B\n',
    };
    expect(
      effectiveLevelOffset({ rootFileId: 'main.adoc', fileId: 'b.adoc', readContent: read(files), resolveInclude: resolveInclude(files) }),
    ).toBe(1);
  });
});
