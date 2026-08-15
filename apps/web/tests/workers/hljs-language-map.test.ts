import { execFileSync } from 'node:child_process';
import path from 'node:path';
import hljs from 'highlight.js/lib/core';
import common from 'highlight.js/lib/common';
import { ON_DEMAND_GRAMMARS } from '@/workers/hljs-languages.generated';

/**
 * The map the render worker fetches syntax grammars through.
 *
 * Its whole reason for being generated is a security property: the language name comes out of the
 * document, so it is author-controlled, and a dynamic `import()` built from it would let that text
 * choose a module path. Every specifier in the map is a literal, and the document's name can only be
 * looked up. What is asserted here is that shape — a name that is not a key reaches nothing — and that
 * every key really names a grammar, since a map whose entries did not load would be a preview that
 * silently stopped colouring half the languages it claims to.
 */
const WEB_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(WEB_ROOT, 'scripts/build-hljs-language-map.mjs');

describe('the on-demand grammar map', () => {
  it('is what the installed highlight.js derives', () => {
    // The generator's own `--check`, not a second copy of its output: a bump that adds, removes or
    // renames a grammar — or moves one in or out of `lib/common` — has to fail somewhere, and a
    // restatement here would go stale in exactly the same way the map would.
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, '--check'], { cwd: WEB_ROOT, encoding: 'utf8' }),
    ).not.toThrow();
  });

  it('loads a grammar for every spelling it offers', async () => {
    // Every entry, not a sample. A thunk whose specifier no longer resolves is indistinguishable at
    // run time from a language nobody writes: the worker leaves the block plain and says nothing.
    for (const [spelling, grammar] of ON_DEMAND_GRAMMARS) {
      const grammarModule = await grammar.load();
      expect(typeof grammarModule.default).toBe('function');
      hljs.registerLanguage(grammar.name, grammarModule.default);
      // Registered under the name the highlighter's own index uses, so the spelling the document
      // wrote resolves through the registry exactly as it would for a bundled language.
      expect(hljs.getLanguage(spelling)).toBeDefined();
    }
  });

  it('offers nothing the preview already carries', () => {
    // A registry of its own. `lib/common` and `lib/core` are one instance — common IS core with 36
    // grammars registered into it — so the test above, which registers every fetchable grammar to
    // prove it loads, would otherwise have made this one vacuous by answering for all of them.
    let bundled: typeof common | null = null;
    jest.isolateModules(() => {
      bundled = require('highlight.js/lib/common') as typeof common;
    });

    // An entry for a bundled language could never be reached — `hljs.getLanguage` answers for those
    // before the first render — and its presence would mean the common path had learnt to fetch.
    for (const spelling of ON_DEMAND_GRAMMARS.keys()) {
      expect(bundled!.getLanguage(spelling)).toBeUndefined();
    }
  });

  it('answers nothing to a name a document invented', () => {
    // The traversal the generated map exists to make impossible, plus the two keys an object literal
    // would have answered to for free. A miss is the plain-text path, which is what a language with no
    // grammar has always got.
    for (const invented of [
      '../../../etc/passwd',
      './core',
      'highlight.js/lib/core',
      '__proto__',
      'constructor',
      'toString',
      'totally-unknown',
    ]) {
      expect(ON_DEMAND_GRAMMARS.get(invented)).toBeUndefined();
    }
  });
});
