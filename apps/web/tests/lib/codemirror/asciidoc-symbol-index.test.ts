import {
  buildProjectSymbolIndex,
  makeIncludeResolver,
} from '@/lib/codemirror/asciidoc-symbol-index';

// projection over the shared asciidoc-model (does NOT re-test extraction).

const FILES: Record<string, { path: string; content: string }> = {
  main: {
    path: 'main.adoc',
    content: '= Book\n:author: Ada\n\n[[overview]]\n== Overview\n\ninclude::chapter1.adoc[]\n',
  },
  chapter1: {
    path: 'chapter1.adoc',
    content: '[[intro]]\n== Chapter One\n\nSee <<overview>>.\n\ninclude::../escape.adoc[]\n',
  },
};
const PATH_TO_ID: Record<string, string> = { 'main.adoc': 'main', 'chapter1.adoc': 'chapter1' };

const getContent = (id: string) => FILES[id]?.content ?? null;
const getMainContentOnly = (id: string) => (id === 'main' ? FILES.main.content : null);
const pathOf = (id: string) => FILES[id]?.path ?? null;
const resolveInclude = makeIncludeResolver(
  (id) => FILES[id]?.path ?? null,
  (path) => PATH_TO_ID[path] ?? null,
);

describe('buildProjectSymbolIndex', () => {
  test('aggregates symbols and references across the include tree', () => {
    const index = buildProjectSymbolIndex('main', getContent, resolveInclude);
    expect(index.tree.nodes.toSorted()).toEqual(['chapter1', 'main']);
    expect(index.symbols.some((s) => s.name === 'overview')).toBe(true);
    expect(index.symbols.some((s) => s.name === 'intro')).toBe(true);
    expect(index.references.some((r) => r.kind === 'xref' && r.target === 'overview')).toBe(true);
  });

  test('resolves a cross-file xref through the index', () => {
    const index = buildProjectSymbolIndex('main', getContent, resolveInclude);
    // chapter1 references <<overview>> which is defined in main.
    expect(index.resolveXref('overview')).not.toBe('unresolved');
    expect(index.resolveXref('does-not-exist')).toBe('unresolved');
  });

  test('resolves an attribute reference to its definition; unknown ⇒ unresolved', () => {
    const index = buildProjectSymbolIndex('main', getContent, resolveInclude);
    // main defines `:author: Ada`.
    expect(index.resolveAttribute('author')).not.toBe('unresolved');
    expect(index.resolveAttribute('nope')).toBe('unresolved');
  });

  test('inheritedOffset returns the accumulated level offset for a file', () => {
    const index = buildProjectSymbolIndex('main', getContent, resolveInclude);
    expect(typeof index.inheritedOffset('chapter1')).toBe('number');
  });

  test('memoizes inheritedOffset so a repeated call does not re-walk the include tree (hot-path perf)', () => {
    let reads = 0;
    const countingGetContent = (id: string) => {
      reads += 1;
      return FILES[id]?.content ?? null;
    };
    const index = buildProjectSymbolIndex('main', countingGetContent, resolveInclude);
    const first = index.inheritedOffset('chapter1');
    const readsAfterFirst = reads;
    const second = index.inheritedOffset('chapter1');
    expect(second).toBe(first);
    // The second call is served from the per-index cache — it re-reads no file content. Called on
    // every editor render, an unmemoized full-tree walk here is O(files × bytes) of main-thread work.
    expect(reads).toBe(readsAfterFirst);
  });

  test('a child inherits the attributes the parent defines above its include; the root none', () => {
    const index = buildProjectSymbolIndex('main', getContent, resolveInclude);
    // main defines `:author: Ada` before `include::chapter1.adoc[]`.
    expect(index.inheritedAttributes('chapter1').get('author')).toBe('Ada');
    expect(index.inheritedAttributes('main').size).toBe(0);
    expect(index.inheritedAttributes('unknown').size).toBe(0);
  });

  test('inheritedAttributes resolves nested references in inherited values (document order)', () => {
    const files: Record<string, string> = {
      m: ':first: Jane\n:full: {first} Doe\ninclude::c.adoc[]\n',
      c: '= C\n',
    };
    const resolve = makeIncludeResolver(
      (id) => ({ m: 'm.adoc', c: 'c.adoc' })[id] ?? null,
      (path) => ({ 'm.adoc': 'm', 'c.adoc': 'c' })[path] ?? null,
    );
    const index = buildProjectSymbolIndex('m', (id) => files[id] ?? null, resolve);
    expect(index.inheritedAttributes('c').get('full')).toBe('Jane Doe');
    expect(index.effectiveAttributes('c').get('full')).toBe('Jane Doe');
  });

  test('effectiveAttributes merges inherited parent attributes with the file own definitions (own wins)', () => {
    const files: Record<string, string> = { m: ':v: parent\ninclude::c.adoc[]\n', c: ':v: child\n' };
    const resolve = makeIncludeResolver(
      (id) => ({ m: 'm.adoc', c: 'c.adoc' })[id] ?? null,
      (path) => ({ 'm.adoc': 'm', 'c.adoc': 'c' })[path] ?? null,
    );
    const index = buildProjectSymbolIndex('m', (id) => files[id] ?? null, resolve);
    expect(index.inheritedAttributes('c').get('v')).toBe('parent');
    expect(index.effectiveAttributes('c').get('v')).toBe('child');
  });

  test('an inline `{set:}` own definition is recognized in `attributes` and `effectiveAttributes`', () => {
    // Regression: a `{set:basedir:src/main}`-defined attribute was only honored for cross-file
    // INHERITANCE, never for the file's OWN project-wide/effective view, so the editor did not
    // recognize `{basedir}` as known nor fold it to its value. It must be first-class, like `:name:`.
    const files: Record<string, string> = { m: '{set:basedir:src/main}\nBuilt in {basedir}.\n' };
    const resolve = makeIncludeResolver(
      (id) => ({ m: 'm.adoc' })[id] ?? null,
      (path) => ({ 'm.adoc': 'm' })[path] ?? null,
    );
    const index = buildProjectSymbolIndex('m', (id) => files[id] ?? null, resolve);
    expect(index.attributes.get('basedir')).toBe('src/main');
    expect(index.effectiveAttributes('m').get('basedir')).toBe('src/main');
    expect(index.resolveAttribute('basedir')).not.toBe('unresolved');
  });

  test('a child inherits a parent `{set:}` attribute and the child folds/uses its value (consistency)', () => {
    // A `{set:}` defined in a parent ABOVE the include must reach the child exactly like a `:name:`
    // entry: present in the child's inherited + effective scope (so it folds in the child editor).
    const files: Record<string, string> = { m: '{set:env:prod}\ninclude::c.adoc[]\n', c: '= C\nMode {env}.\n' };
    const resolve = makeIncludeResolver(
      (id) => ({ m: 'm.adoc', c: 'c.adoc' })[id] ?? null,
      (path) => ({ 'm.adoc': 'm', 'c.adoc': 'c' })[path] ?? null,
    );
    const index = buildProjectSymbolIndex('m', (id) => files[id] ?? null, resolve);
    expect(index.inheritedAttributes('c').get('env')).toBe('prod');
    expect(index.effectiveAttributes('c').get('env')).toBe('prod');
  });

  test('project-wide `attributes` include definitions from INCLUDED files (known anywhere in the tree)', () => {
    // The root references {edition}, defined only in the file it includes. For known-vs-unknown
    // highlighting an attribute defined ANYWHERE in the include tree counts as known, so the
    // project-wide `attributes` view must surface the included file's definition to the parent.
    const files: Record<string, string> = { m: 'include::c.adoc[]\nRunning {edition} edition.\n', c: ':edition: Pro\n' };
    const resolve = makeIncludeResolver(
      (id) => ({ m: 'm.adoc', c: 'c.adoc' })[id] ?? null,
      (path) => ({ 'm.adoc': 'm', 'c.adoc': 'c' })[path] ?? null,
    );
    const index = buildProjectSymbolIndex('m', (id) => files[id] ?? null, resolve);
    expect(index.attributes.get('edition')).toBe('Pro');
    // ...but the position-aware effectiveAttributes for the ROOT does NOT (it has no ancestors and the
    // definition lives in a descendant), which is why highlighting must use the project-wide view.
    expect(index.effectiveAttributes('m').has('edition')).toBe(false);
  });

  test('skips files whose content is unavailable when aggregating', () => {
    // The include graph lists chapter1 as a node, but getContent only returns
    // content for main, exercising the `content === null` continue branch.
    const index = buildProjectSymbolIndex('main', getMainContentOnly, resolveInclude);
    expect(index.tree.nodes).toContain('chapter1');
    expect(index.symbols.every((s) => s.fileId === 'main')).toBe(true);
  });

  test('records an out-of-sandbox include as unresolved (Constitution IX)', () => {
    const index = buildProjectSymbolIndex('main', getContent, resolveInclude);
    // chapter1 includes ../escape.adoc which escapes the project root.
    expect(index.tree.unresolved.some((u) => u.target === '../escape.adoc')).toBe(true);
  });

  test('falls back to the open file when no main file (current-file scope)', () => {
    const index = buildProjectSymbolIndex('chapter1', getContent, resolveInclude);
    expect(index.tree.rootFileId).toBe('chapter1');
    expect(index.symbols.some((s) => s.name === 'intro')).toBe(true);
  });
});

describe('go-to-definition locators', () => {
  test('pathOf maps a file id to its project-relative path; unknown ⇒ null', () => {
    const index = buildProjectSymbolIndex('main', getContent, resolveInclude, 'main', pathOf);
    expect(index.pathOf('chapter1')).toBe('chapter1.adoc');
    expect(index.pathOf('ghost')).toBeNull();
  });

  test('pathOf returns null when no path resolver is supplied', () => {
    const index = buildProjectSymbolIndex('main', getContent, resolveInclude);
    expect(index.pathOf('chapter1')).toBeNull();
  });

  test('lineOf converts a character offset to a 1-based line within the file', () => {
    const index = buildProjectSymbolIndex('main', getContent, resolveInclude, 'main', pathOf);
    // chapter1.adoc: '[[intro]]\n== Chapter One\n...': the '== Chapter One' heading starts on line 2.
    const heading = index.symbols.find((s) => s.kind === 'section' && s.fileId === 'chapter1');
    expect(heading).toBeDefined();
    expect(index.lineOf('chapter1', heading!.range.from)).toBe(2);
  });

  test('lineOf returns 1 when the file content is unavailable', () => {
    const index = buildProjectSymbolIndex('main', getContent, resolveInclude, 'main', pathOf);
    expect(index.lineOf('ghost', 0)).toBe(1);
  });

  test('hands back a file’s raw text, and null for a file it cannot read', () => {
    // Consumers that re-parse a file (heading levels, include tracing) read it through the index
    // rather than holding their own reader, so the two never disagree about what a file contains.
    const index = buildProjectSymbolIndex('main', getContent, resolveInclude, 'main', pathOf);
    expect(index.getContent('chapter1')).toBe(FILES.chapter1.content);
    expect(index.getContent('ghost')).toBeNull();
  });

  test('resolves an include target through the same sandboxed resolver the walk used', () => {
    const index = buildProjectSymbolIndex('main', getContent, resolveInclude, 'main', pathOf);
    expect(index.resolveInclude('main', 'chapter1.adoc')).toBe('chapter1');
    expect(index.resolveInclude('main', '../secret.adoc')).toBeNull();
  });
});

describe('makeIncludeResolver (Constitution IX sandbox)', () => {
  test('resolves a sibling include to its file id', () => {
    expect(resolveInclude('main', 'chapter1.adoc')).toBe('chapter1');
  });
  test('rejects traversal escaping the root', () => {
    expect(resolveInclude('main', '../secret.adoc')).toBeNull();
  });
  test('rejects remote targets', () => {
    expect(resolveInclude('main', 'https://evil.example/x.adoc')).toBeNull();
  });
  test('returns null when the referencing file has no known path', () => {
    expect(resolveInclude('ghost', 'chapter1.adoc')).toBeNull();
  });
});
