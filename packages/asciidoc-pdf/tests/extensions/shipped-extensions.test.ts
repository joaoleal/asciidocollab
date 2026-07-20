import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parsePdfExtensionManifest } from '@asciidocollab/shared';

/**
 * @file The constraints every shipped extension must hold, checked without a Ruby runtime.
 *
 * The behavioural proof that an extension does what it claims is its parity fixture, compared against
 * a PDF the canonical toolchain produced. That needs Docker and a built wasm engine, so it runs in
 * the parity suite. What runs HERE is everything that can be established by reading the source — and
 * these are exactly the properties whose violation is silent:
 *
 *   A non-idempotent `prepend` corrupts every later render in a warm VM, and the first render is
 *     fine, so nothing fails at the point the mistake is made.
 *   A native `require` fails the wasm build, far from the file that caused it.
 *   A manifest that drifts from its Ruby ships an accurate-looking description of the wrong thing.
 */

const EXTENSIONS_DIR = path.resolve(
  __dirname,
  '../../ruby/extensions/asciidocollab-pdf-extensions/lib',
);

/** Every shipped extension directory (one per extension, each with a manifest and a source). */
function shippedExtensions(): { id: string; manifest: string; source: string }[] {
  if (!existsSync(EXTENSIONS_DIR)) return [];
  return readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      id: entry.name,
      manifest: path.join(EXTENSIONS_DIR, entry.name, 'manifest.json'),
      source: path.join(EXTENSIONS_DIR, entry.name, 'extension.rb'),
    }))
    .filter((entry) => existsSync(entry.manifest) && existsSync(entry.source));
}

const EXTENSIONS = shippedExtensions();

describe('shipped extensions', () => {
  it('ships at least one extension', () => {
    // An empty set would make every test below pass vacuously.
    expect(EXTENSIONS.length).toBeGreaterThan(0);
  });
});

describe.each(EXTENSIONS.map((entry) => [entry.id, entry] as const))(
  'shipped extension: %s',
  (id, entry) => {
    const source = readFileSync(entry.source, 'utf8');
    const manifest = JSON.parse(readFileSync(entry.manifest, 'utf8')) as Record<string, unknown>;

    it('has a manifest that validates against the shared contract', () => {
      const parsed = parsePdfExtensionManifest(manifest);
      expect(parsed.ok ? null : parsed.reason).toBeNull();
    });

    it('declares the id its directory is named for', () => {
      // The directory name is what the loader derives its VFS path from, so a mismatch would load
      // one extension's code under another's identity.
      expect(manifest.id).toBe(id);
    });

    it('guards its prepend, so a warm VM cannot wrap the converter twice', () => {
      // The VM is never torn down between renders. A second prepend corrupts every later render in
      // that worker, and the render where the mistake happens looks fine.
      expect(source).toMatch(/ancestors\.include\?/);
      expect(source).toMatch(/unless|if\s+!/);
    });

    it('is plain Ruby with no native dependency', () => {
      // The wasm build fails closed on a native extension, far from the file that introduced it.
      expect(source).not.toMatch(/require ['"](?:fiddle|ffi|io\/console)['"]/);
      expect(source).not.toMatch(/\bextconf\b/);
    });

    it('persists nothing', () => {
      // Extension output is a function of the document at render time. A file or environment write
      // would make one render's output depend on a previous one.
      expect(source).not.toMatch(/File\.(?:write|open)/);
      expect(source).not.toMatch(/ENV\[[^\]]+\]\s*=/);
    });

    it('does not reach the host page through the VM’s JS bridge', () => {
      // The Ruby VM exposes `JS.global`. Extension code has no reason to touch it, and this is the
      // check that keeps that true as extensions are added.
      expect(source).not.toMatch(/\bJS\.global\b/);
      expect(source).not.toMatch(/\brequire ['"]js['"]/);
    });

    it('describes every theme key it contributes', () => {
      // A key the Ruby reads but the manifest omits is invisible to the theme editor's completion,
      // so an author cannot discover the setting the extension added.
      const parsed = parsePdfExtensionManifest(manifest);
      if (!parsed.ok) throw new Error(parsed.reason);
      for (const key of parsed.manifest.themeKeys) {
        const flattened = key.key.replaceAll(/[.-]/g, '_');
        expect(source).toContain(flattened);
      }
    });

    it('has a parity fixture with a committed reference PDF', () => {
      // Principle XV: an extension without passing comparison coverage is not done.
      const fixture = path.resolve(
        __dirname,
        `../../../../apps/web/e2e/pdf-parity/fixtures/extension-${id}`,
      );
      expect(existsSync(path.join(fixture, 'manifest.json'))).toBe(true);
      expect(existsSync(path.join(fixture, 'reference.pdf'))).toBe(true);
    });
  },
);

/**
 * A private helper method definition, keyed by name, with its body normalised for comparison.
 *
 * Only the `_asciidocollab_`-prefixed methods are considered: those are the ones each extension
 * carries its own copy of, and so the ones that can collide.
 */
function privateHelpers(source: string): Map<string, string> {
  const helpers = new Map<string, string>();
  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    const match = /^(\s*)def (_asciidocollab_\S+)/.exec(line);
    if (match === null) continue;
    const [, indent, name] = match;
    const end = lines.findIndex(
      (candidate, at) => at > index && candidate === `${indent}end`,
    );
    helpers.set(name, lines.slice(index, end + 1).join('\n').trim());
  }
  return helpers;
}

describe('helpers duplicated across extensions', () => {
  /**
   * THE INVARIANT. Each extension carries its own copy of the helpers it needs, because the registry
   * mounts exactly one file per extension and nothing may be shared through a common library.
   *
   * That makes duplicate NAMES unavoidable — and dangerous. Every extension prepends a module to the
   * one converter in a warm VM that is never torn down, and `require` is a no-op the second time, so
   * a method's position in `Converter.ancestors` is fixed by the first render in the session that
   * loaded it. Whichever copy sits earliest wins for EVERY extension thereafter. The per-render
   * enable gate does not help: it guards the converter HOOKS, not the private helpers they call.
   *
   * So two copies of a name must be byte-identical, or output depends on the order projects
   * happened to be rendered in. This caught exactly that: `_asciidocollab_dot_leader` omitted the
   * `levels:` key in one copy, so whether `toc.dot-leader.levels` was honoured depended on which
   * extension had been loaded first in that worker.
   */
  it('are byte-identical wherever they are repeated', () => {
    const byName = new Map<string, Map<string, string>>();
    for (const extension of EXTENSIONS) {
      for (const [name, body] of privateHelpers(readFileSync(extension.source, 'utf8'))) {
        const bodies = byName.get(name) ?? new Map<string, string>();
        bodies.set(extension.id, body);
        byName.set(name, bodies);
      }
    }

    const divergent = [...byName]
      .filter(([, bodies]) => new Set(bodies.values()).size > 1)
      .map(([name, bodies]) => `${name} differs between ${[...bodies.keys()].join(', ')}`);
    expect(divergent).toEqual([]);
  });

  it('finds the shared helpers it is meant to be checking', () => {
    // Guards the guard: a parser that silently matched nothing would make the case above vacuous.
    const shared = new Map<string, number>();
    for (const extension of EXTENSIONS) {
      for (const name of privateHelpers(readFileSync(extension.source, 'utf8')).keys()) {
        shared.set(name, (shared.get(name) ?? 0) + 1);
      }
    }
    expect([...shared.values()].filter((count) => count > 1).length).toBeGreaterThan(2);
  });
});

/**
 * The converter hooks an extension overrides — the public `def`s above its `private`, excluding this
 * gem's own `_asciidocollab_`-prefixed methods.
 */
function converterHooks(source: string): string[] {
  const hooks: string[] = [];
  for (const line of source.split('\n')) {
    if (/^ {4}private\s*$/.test(line)) break;
    const match = /^ {4}def ([a-z]\w*[?!]?)/.exec(line);
    if (match !== null) hooks.push(match[1]);
  }
  return hooks;
}

/**
 * Hooks more than one extension overrides, each with the reason its composition does not depend on
 * the order the modules were prepended in.
 *
 * ADDING TO THIS LIST IS A DESIGN DECISION, NOT A FORMALITY. Two extensions overriding one hook both
 * wrap `super`, so one runs inside the other, and which is which is fixed by the first `require` in
 * the session — in a warm VM that is decided by whichever project rendered first in that worker, not
 * by what this render selected. If the two orders can draw different documents, the entry does not
 * belong here; the hook needs a composition that does not care, as `ink_toc` now has.
 */
const REVIEWED_SHARED_HOOKS: Readonly<Record<string, string>> = {
  // Each participant only initialises its OWN state before `super`, and the shared back-matter queue
  // is drained in rank order rather than insertion order, so enqueueing order cannot reach the page.
  convert_document: 'disjoint state; the shared queue is ordered by rank, not by arrival',
  // colophon-placement claims the colophon section and returns without `super`;
  // per-chapter-contents only post-processes sections that reserved a chapter contents list, which a
  // colophon never does. Neither order gives either extension a section the other wanted.
  convert_section: 'the claimed sections are disjoint, so neither order changes what each sees',
  // additional-contents-entries records the page a table lands on from `add_dest_for_block` rather
  // than before `super`, so large-table-page-size moving the table onto a fresh wide page is
  // reflected whichever wrapper runs first.
  convert_table: 'the entry page is taken at the anchor, after any page change either order makes',
  // Both bodies are byte-identical and drain the same queue, which nils itself before inking, so the
  // second call in either order is a no-op.
  ink_cover_page: 'identical bodies draining a queue that is idempotent after the first flush',
  // narrow-contents publishes the measure as a named, re-entrant protocol
  // (`_asciidocollab_contents_measure`) and additional-contents-entries asks for it by name. Ordinary
  // dispatch finds it wherever the module sits, so both orders narrow exactly once.
  ink_toc: 'the measure is asked for by name, not inherited from whichever wrapper is outermost',
};

describe('converter hooks shared by more than one extension', () => {
  /**
   * THE INVARIANT. Every hook two extensions both override has been looked at, and found to draw the
   * same document in either prepend order.
   *
   * This is the ordering half of the same defect the duplicated-helper check covers. `Module#prepend`
   * cannot be undone and the VM is never torn down, so a module's position in `Converter.ancestors`
   * is fixed by the first render in the session that loaded it — the registry's id ordering only
   * decides the requires, and `require` is a no-op the second time. Two extensions wrapping one hook
   * therefore compose in an order this render did not choose and cannot see.
   *
   * It found `ink_toc`: `narrow-contents` narrowed the contents list with `indent` around `super`,
   * and `additional-contents-entries` drew its extra lists around `super` too, so one order narrowed
   * the extra lists with it and the other left them at full page measure beside a narrowed list.
   */
  it('are all reviewed for order-independence', () => {
    const byHook = new Map<string, string[]>();
    for (const extension of EXTENSIONS) {
      for (const hook of converterHooks(readFileSync(extension.source, 'utf8'))) {
        byHook.set(hook, [...(byHook.get(hook) ?? []), extension.id]);
      }
    }

    const unreviewed = [...byHook]
      .filter(([hook, ids]) => ids.length > 1 && REVIEWED_SHARED_HOOKS[hook] === undefined)
      .map(([hook, ids]) => `${hook} is overridden by ${ids.join(', ')} with no recorded reason`);
    expect(unreviewed).toEqual([]);
  });

  it('lists no hook that has stopped being shared', () => {
    // Keeps the list honest in the other direction: a stale entry would silently pre-approve a future
    // collision on that hook.
    const counts = new Map<string, number>();
    for (const extension of EXTENSIONS) {
      for (const hook of converterHooks(readFileSync(extension.source, 'utf8'))) {
        counts.set(hook, (counts.get(hook) ?? 0) + 1);
      }
    }
    const stale = Object.keys(REVIEWED_SHARED_HOOKS).filter((hook) => (counts.get(hook) ?? 0) < 2);
    expect(stale).toEqual([]);
  });

  it('finds the hooks it is meant to be checking', () => {
    // Guards the guard twice over: a parser matching nothing would make both cases above vacuous,
    // and one that swept up the `_asciidocollab_` helpers would report collisions that are the OTHER
    // invariant's business and are handled by making the bodies identical.
    const hooks = EXTENSIONS.flatMap((extension) =>
      converterHooks(readFileSync(extension.source, 'utf8')),
    );
    expect(hooks).toContain('ink_toc');
    expect(hooks.filter((hook) => hook.startsWith('_asciidocollab_'))).toEqual([]);
    expect(Object.keys(REVIEWED_SHARED_HOOKS).length).toBeGreaterThan(0);
  });
});
