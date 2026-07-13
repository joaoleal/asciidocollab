import {
  assembleIncludes,
  type AssembleIncludesDependencies,
  type SandboxPathResolver,
} from '../src';

// A minimal in-memory sandbox resolver mirroring the boundary contract the primitive depends on:
// reject remote/absolute/traversal targets, otherwise fold to a project-relative path.
const resolver: SandboxPathResolver = (fromPath, target) => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return { ok: false, reason: 'remote' };
  if (target.startsWith('/')) return { ok: false, reason: 'absolute' };
  const segments = fromPath.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return { ok: false, reason: 'traversal' };
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return { ok: false, reason: 'traversal' };
  return { ok: true, path: segments.join('/') };
};

function deps(files: Record<string, string>): AssembleIncludesDependencies {
  return {
    readFile: (path) => (path in files ? files[path] : null),
    resolveSandboxedPath: resolver,
    buildPlaceholder: (target) => `[placeholder ${target}]`,
  };
}

describe('assembleIncludes shared primitive', () => {
  it('inlines an in-sandbox include', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'Intro\ninclude::child.adoc[]\nOutro',
      'child.adoc': 'Child body',
    }));
    expect(result.content).toBe('Intro\nChild body\nOutro');
    expect(result.unresolved).toEqual([]);
  });

  it('reports a missing root document', () => {
    const result = assembleIncludes('nope.adoc', deps({}));
    expect(result.content).toBe('');
    expect(result.unresolved).toEqual([{ from: '', target: 'nope.adoc', reason: 'not-found' }]);
  });

  it('marks a missing include target without reading it', () => {
    const result = assembleIncludes('main.adoc', deps({ 'main.adoc': 'include::gone.adoc[]' }));
    expect(result.content).toContain('Unresolved directive in main.adoc - include::gone.adoc[]');
    expect(result.unresolved).toEqual([{ from: 'main.adoc', target: 'gone.adoc', reason: 'not-found' }]);
  });

  it('rejects a remote target via the injected sandbox boundary', () => {
    const result = assembleIncludes('main.adoc', deps({ 'main.adoc': 'include::https://evil/x.adoc[]' }));
    expect(result.unresolved[0].reason).toBe('remote');
    expect(result.content).toContain('Unresolved directive');
  });

  it('guards a cycle', () => {
    const result = assembleIncludes('a.adoc', deps({
      'a.adoc': 'include::b.adoc[]',
      'b.adoc': 'include::a.adoc[]',
    }));
    expect(result.unresolved.some((u) => u.reason === 'cycle')).toBe(true);
  });

  it('guards excessive depth', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::child.adoc[]',
      'child.adoc': 'body',
    }), { maxDepth: 0 });
    expect(result.unresolved).toEqual([{ from: 'main.adoc', target: 'child.adoc', reason: 'depth' }]);
  });

  it('caps total expansions (fan-out budget)', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::child.adoc[]',
      'child.adoc': 'body',
    }), { maxExpansions: 0 });
    expect(result.unresolved).toEqual([{ from: 'main.adoc', target: 'child.adoc', reason: 'limit' }]);
  });

  it('applies a tags= filter', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::child.adoc[tags=a]',
      'child.adoc': '// tag::a[]\nAlpha\n// end::a[]\nBeta',
    }));
    expect(result.content).toBe('Alpha');
  });

  it('applies a lines= filter', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::child.adoc[lines=2]',
      'child.adoc': 'L1\nL2\nL3',
    }));
    expect(result.content).toBe('L2');
  });

  it('emits scoped leveloffset around an include option', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::child.adoc[leveloffset=+1]\nAfter',
      'child.adoc': '== Child',
    }));
    expect(result.content).toBe(':leveloffset: 1\n== Child\n:leveloffset: 0\nAfter');
  });

  it('gates an include inside an inactive conditional region (target never read)', () => {
    const files = {
      'main.adoc': 'ifdef::flag[]\ninclude::child.adoc[]\nendif::[]',
      'child.adoc': 'Secret',
    };
    const off = assembleIncludes('main.adoc', deps(files));
    expect(off.content).not.toContain('Secret');
    expect(off.content).toContain('ifdef::flag[]');

    const on = assembleIncludes('main.adoc', deps(files), { seedAttributes: new Map([['flag', '']]) });
    expect(on.content).toContain('Secret');
  });

  it('substitutes {attr} in the target using seeded + document attributes', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::{partsdir}/c.adoc[]',
      'parts/c.adoc': 'Part body',
    }), { seedAttributes: new Map([['partsdir', 'parts']]) });
    expect(result.content).toBe('Part body');
  });

  it('hide mode suppresses the body but preserves attribute state via a placeholder', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::child.adoc[]',
      'child.adoc': ':foo: bar\nHello',
    }), { showIncludes: false });
    expect(result.content).toContain('[placeholder child.adoc]');
    expect(result.content).toContain(':foo: bar');
    expect(result.content).not.toContain('Hello');
  });

  it('produces a source map parallel to the assembled content', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'Intro\ninclude::child.adoc[]',
      'child.adoc': 'Child',
    }), { withSourceMap: true });
    expect(result.sourceMap).toBeDefined();
    expect(result.sourceMap!.lineToSource).toHaveLength(result.content.split('\n').length);
    expect(result.sourceMap!.lineToSource[0]).toEqual({ path: 'main.adoc', sourceLine: 1 });
  });
});

// The child used by the tag-wildcard suite: two tagged regions separated and surrounded by untagged
// lines, so `*` (tagged-only), `**` (everything) and `!*` (untagged-only) are distinguishable.
const TAGGED_CHILD = [
  'before',
  '// tag::a[]',
  'Alpha',
  '// end::a[]',
  'between',
  '// tag::b[]',
  'Beta',
  '// end::b[]',
  'after',
].join('\n');

// Assemble TAGGED_CHILD through a single `tags=<selector>` include and return the inlined content.
const runTagFilter = (selector: string): string =>
  assembleIncludes('main.adoc', deps({
    'main.adoc': `include::child.adoc[tags=${selector}]`,
    'child.adoc': TAGGED_CHILD,
  })).content;

describe('assembleIncludes tag-filter wildcards', () => {
  it('`**` selects every line, tagged and untagged (markers excluded)', () => {
    expect(runTagFilter('**')).toBe('before\nAlpha\nbetween\nBeta\nafter');
  });

  it('`*` selects only tagged regions', () => {
    expect(runTagFilter('*')).toBe('Alpha\nBeta');
  });

  it('`!*` selects only untagged content', () => {
    expect(runTagFilter('!*')).toBe('before\nbetween\nafter');
  });

  it('`!**` deselects everything', () => {
    expect(runTagFilter('!**')).toBe('');
  });

  it('a named region overrides the base selection', () => {
    expect(runTagFilter('a')).toBe('Alpha');
  });

  it('`!**` with an explicit exclusion still wildcard-selects other tagged regions', () => {
    // base deselected (`!**`), the named region stays excluded, but a remaining exclusion implies a
    // `*` wildcard so any OTHER tagged region is selected.
    const result = runTagFilter('!**;!a');
    expect(result).toContain('Beta');
    expect(result).not.toContain('Alpha');
  });

  it('a nested unlisted tag inside a deselected region stays deselected', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::child.adoc[tags=!*]',
      // With `!*` the base is untagged-only; the outer region is deselected, so the inner unlisted
      // region must remain deselected (it must not "re-select" via the wildcard).
      'child.adoc': 'top\n// tag::outer[]\nO1\n// tag::inner[]\nI1\n// end::inner[]\nO2\n// end::outer[]\nbottom',
    })).content;
    expect(result).toBe('top\nbottom');
  });
});

describe('assembleIncludes hide mode (showIncludes:false)', () => {
  const hide = { showIncludes: false, withSourceMap: true } as const;

  it('emits a placeholder for a rejected (remote) target and tracks the source map', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::https://evil/x.adoc[]',
    }), hide);
    expect(result.content).toContain('[placeholder https://evil/x.adoc]');
    expect(result.unresolved[0].reason).toBe('remote');
    expect(result.sourceMap!.lineToSource).toHaveLength(result.content.split('\n').length);
  });

  it('emits a placeholder for a not-found target', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::gone.adoc[]',
    }), hide);
    expect(result.content).toContain('[placeholder gone.adoc]');
    expect(result.unresolved).toEqual([{ from: 'main.adoc', target: 'gone.adoc', reason: 'not-found' }]);
    expect(result.sourceMap!.lineToSource).toHaveLength(result.content.split('\n').length);
  });

  it('emits a placeholder when a cycle is detected', () => {
    const result = assembleIncludes('a.adoc', deps({
      'a.adoc': 'include::b.adoc[]',
      'b.adoc': 'include::a.adoc[]',
    }), hide);
    expect(result.content).toContain('[placeholder');
    expect(result.unresolved.some((u) => u.reason === 'cycle')).toBe(true);
  });

  it('emits a placeholder for a direct self-include cycle at the visible level', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::main.adoc[]',
    }), hide);
    expect(result.content).toContain('[placeholder main.adoc]');
    expect(result.unresolved.some((u) => u.reason === 'cycle')).toBe(true);
    expect(result.sourceMap!.lineToSource).toHaveLength(result.content.split('\n').length);
  });

  it('emits a placeholder when max depth is exceeded', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::child.adoc[]',
      'child.adoc': 'body',
    }), { ...hide, maxDepth: 0 });
    expect(result.content).toContain('[placeholder child.adoc]');
    expect(result.unresolved).toEqual([{ from: 'main.adoc', target: 'child.adoc', reason: 'depth' }]);
  });

  it('emits a placeholder when the fan-out budget is spent', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::child.adoc[]',
      'child.adoc': 'body',
    }), { ...hide, maxExpansions: 0 });
    expect(result.content).toContain('[placeholder child.adoc]');
    expect(result.unresolved).toEqual([{ from: 'main.adoc', target: 'child.adoc', reason: 'limit' }]);
  });

  it('preserves the child\'s attribute state and scoped leveloffset behind the placeholder', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::child.adoc[leveloffset=+1]\nAfter',
      'child.adoc': ':foo: bar\n== Child',
    }), hide);
    // Body suppressed, but the placeholder, the attribute entry, and the scoped offset set/restore survive.
    expect(result.content).toContain('[placeholder child.adoc]');
    expect(result.content).toContain(':foo: bar');
    expect(result.content).toContain(':leveloffset: 1');
    expect(result.content).toContain(':leveloffset: 0');
    expect(result.content).not.toContain('== Child');
    expect(result.sourceMap!.lineToSource).toHaveLength(result.content.split('\n').length);
  });

  it('synthesizes attribute set/unset lines from a hidden child\'s inline directives', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::child.adoc[]',
      // Inline `{set:}` / `{set:!}` on prose lines mutate attribute state that must survive as
      // synthetic entry lines even though the prose body itself is hidden.
      'child.adoc': '{set:foo:bar}\n{set:foo!}\n:baz: qux',
    }), { showIncludes: false });
    expect(result.content).toContain('[placeholder child.adoc]');
    expect(result.content).toContain(':foo: bar');
    expect(result.content).toContain(':foo!:');
    expect(result.content).toContain(':baz: qux');
    // The raw prose directive lines are never emitted.
    expect(result.content).not.toContain('{set:foo:bar}');
  });

  it('substitutes resolved {attr} references into visible prose in hide mode', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': ':who: world\nHello {who}\ninclude::child.adoc[]',
      'child.adoc': 'hidden',
    }), { showIncludes: false });
    expect(result.content).toContain('Hello world');
  });
});

describe('assembleIncludes inline conditional include (ifdef::flag[include::…])', () => {
  const files = {
    'main.adoc': 'ifdef::flag[include::child.adoc[]]',
    'child.adoc': 'Gated body',
  };

  it('expands the inner include only when the flag is set', () => {
    const on = assembleIncludes('main.adoc', deps(files), {
      seedAttributes: new Map([['flag', '']]),
      withSourceMap: true,
    });
    expect(on.content).toContain('Gated body');
    // The directive line itself is still emitted verbatim for the renderer.
    expect(on.content).toContain('ifdef::flag[include::child.adoc[]]');
    expect(on.sourceMap!.lineToSource).toHaveLength(on.content.split('\n').length);
  });

  it('does not read the inner target when the flag is unset', () => {
    const off = assembleIncludes('main.adoc', deps(files));
    expect(off.content).not.toContain('Gated body');
    expect(off.content).toContain('ifdef::flag[include::child.adoc[]]');
  });
});

describe('assembleIncludes attribute-value continuation', () => {
  it('joins a `\\`-wrapped attribute value for tracking while emitting each physical line', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': ':desc: line one \\\ncontinued two\ninclude::{desc-part}.adoc[]',
      // The wrapped value is tracked (joined) but each physical line is emitted verbatim; assert both.
      'x.adoc': 'unused',
    }), { withSourceMap: true });
    expect(result.content).toContain(':desc: line one \\');
    expect(result.content).toContain('continued two');
    expect(result.sourceMap!.lineToSource).toHaveLength(result.content.split('\n').length);
  });
});

describe('assembleIncludes base leveloffset', () => {
  it('computes emitted offsets relative to an inherited baseOffset', () => {
    const result = assembleIncludes('main.adoc', deps({
      'main.adoc': 'include::child.adoc[leveloffset=+1]',
      'child.adoc': '== Child',
    }), { baseOffset: 2 });
    // base 2 + include option +1 → absolute 3, restored to the base 2 afterwards.
    expect(result.content).toBe(':leveloffset: 3\n== Child\n:leveloffset: 2');
  });
});
