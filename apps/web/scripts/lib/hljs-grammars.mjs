/**
 * @file One reading of the shipped highlight.js, for everything that has to know what the highlighter
 * can do: `build-hljs-language-map.mjs` (which languages the preview can colour at all) and
 * `build-print-highlight-css.mjs` (the Print rules, which must cover every class those grammars emit).
 *
 * Both come from the same walk of the same installed package because they must not be able to
 * disagree: a vocabulary derived from fewer grammars than the map can load is a stylesheet with no
 * rule for a class the preview really produces, and the reverse is the same fault written backwards.
 *
 * ## Why the definitions are LOADED rather than scanned
 *
 * A grammar is a function of the core API returning a tree of modes, and its scopes are strings inside
 * that tree. Reading them out of the source TEXT — which this used to do — was wrong in three ways at
 * once, and each is why a text scan cannot be reinstated:
 *
 *   - it read commented-out code: `gauss.js` carries `// className: "fn_ref"` from a withdrawn scope,
 *     so the scan reported two classes the highlighter cannot emit;
 *   - it could not see `classNameAliases`, the per-grammar table `core.js` applies to every scope on
 *     its way out (`language.classNameAliases[scope] || scope`). `cpp` DECLARES `function.dispatch`
 *     and EMITS `built_in`; `vbnet` declares `label` and emits `symbol`. Rules written for the names
 *     in the source match nothing on the page;
 *   - and it missed keyword GROUP names, which `core.js` emits as classes just like a mode's scope
 *     (`css` has a `keyframePosition` group, aliased to `selector-tag`).
 *
 * Loading each grammar and walking what it returns answers all three: it is the same object the
 * highlighter itself walks. The one thing it still cannot see is a scope invented at highlight time
 * inside a mode callback; nothing shipped does that, and the fidelity oracle in
 * `e2e/pdf-parity/print-fidelity/` compares what is actually drawn, so such a scope would surface
 * there rather than pass unnoticed.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const loadModule = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));

/** The web app's root, which the installed highlight.js is resolved from. */
export const WEB_ROOT = resolve(HERE, '../..');

/** The commonjs build's root. The es build beside it is the same grammars, exported differently. */
const HLJS_ROOT = resolve(WEB_ROOT, 'node_modules/highlight.js/lib');

/**
 * The deprecation shims the package ships beside each grammar.
 *
 * `lib/languages/ruby.js.js` re-exports `ruby.js` and prints a warning about the extension in the
 * specifier. They are not grammars, and counted as such they double every figure taken here.
 */
const SHIM_SUFFIX = '.js.js';

/**
 * Whether a keyword group is one `core.js` gives a class to.
 *
 * A group whose name begins with an underscore is, in the emitter's own words, "implied for relevance
 * only, do not highlight": it adds the word's text and no markup. `$pattern` is not a group at all; it
 * is the matcher the groups are found with.
 *
 * @param {string} name - A keyword group's name.
 * @returns Whether the group is emitted as a class.
 */
function emitsAClass(name) {
  return name !== '$pattern' && !name.startsWith('_');
}

/**
 * Every class one grammar can emit, as the highlighter would emit it.
 *
 * Walks the definition the grammar returned — every mode, every variant, every `starts` chain, the
 * core modes it reached for — collecting a mode's `scope`/`className` (either a name or a map from
 * capture group to name), its `beginScope`/`endScope`, and the names of its keyword groups. Each is
 * then put through the grammar's own `classNameAliases`, because that is the last thing `core.js`
 * does before the class reaches the page.
 *
 * @param {object} definition - What the grammar's factory returned.
 * @returns {string[]} The classes, unsorted and deduplicated.
 */
function scopesOf(definition) {
  const found = new Set();
  const aliases = definition.classNameAliases ?? {};
  // Modes are shared and referenced from several places, and a few grammars close the graph into a
  // cycle by pushing a mode into its own `contains`.
  const seen = new WeakSet();
  const note = (value) => {
    if (typeof value === 'string') found.add(aliases[value] ?? value);
  };
  const walk = (node) => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const key of ['scope', 'className', 'beginScope', 'endScope']) {
      const value = node[key];
      if (typeof value === 'string') note(value);
      else if (value !== null && typeof value === 'object') for (const name of Object.values(value)) note(name);
    }
    const { keywords } = node;
    if (keywords !== null && typeof keywords === 'object' && !Array.isArray(keywords)) {
      for (const group of Object.keys(keywords)) if (emitsAClass(group)) note(group);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'scope' || key === 'className' || key === 'beginScope' || key === 'endScope') continue;
      if (key === 'keywords') continue;
      walk(value);
    }
  };
  walk(definition);
  return (
    [...found]
      // The empty scope is how a mode says it wants no markup at all — `emitsWrappingTags` in
      // `core.js` is `!!node.scope`, so nothing is wrapped. Python's parameter list uses it for the
      // empty `()` case. It is a class name in the source and never one on the page.
      .filter((scope) => scope !== '')
      // `language:xyz` marks a sub-language region and becomes a `language-xyz` class, not an `hljs-` one.
      .filter((scope) => !scope.startsWith('language:'))
  );
}

/**
 * The grammars `highlight.js/lib/common` registers at import — the ones the preview already carries.
 *
 * Read from the entry point rather than listed, because which languages are "common" is the package's
 * decision and it has changed between releases. A bump that moves a language in or out of it changes
 * what the worker must fetch, and this is where that is noticed.
 *
 * @returns {Set<string>} The registration names, as `common.js` requires them.
 */
function readBundled() {
  const source = readFileSync(join(HLJS_ROOT, 'common.js'), 'utf8');
  const names = new Set([...source.matchAll(/require\('\.\/languages\/([\w-]+)'\)/g)].map((match) => match[1]));
  if (names.size === 0) throw new Error('highlight.js/lib/common.js registered no languages.');
  return names;
}

/**
 * One installed grammar.
 *
 * @typedef {object} Grammar
 * @property {string} name - The name `lib/index.js` registers it under, which is its file's base name.
 * @property {boolean} bundled - Whether `lib/common` already carries it, so the preview never fetches it.
 * @property {string[]} aliases - The other spellings the grammar itself answers to, lower-cased.
 * @property {string[]} scopes - Every class it can emit, sorted.
 */

/**
 * Read every installed grammar.
 *
 * @returns {Grammar[]} The grammars, in the order `lib/index.js` registers them (its own, alphabetical).
 */
export function readGrammars() {
  // The core alone: loading a grammar is calling its factory with this, which is exactly what
  // `registerLanguage` does. Nothing is registered here — the definitions are only read.
  const hljs = loadModule(join(HLJS_ROOT, 'core.js'));
  const bundled = readBundled();
  const files = readdirSync(join(HLJS_ROOT, 'languages'))
    .filter((file) => file.endsWith('.js') && !file.endsWith(SHIM_SUFFIX))
    .toSorted();
  if (files.length === 0) throw new Error(`No grammars under ${join(HLJS_ROOT, 'languages')}.`);

  return files.map((file) => {
    const name = file.slice(0, -'.js'.length);
    const definition = loadModule(join(HLJS_ROOT, 'languages', file))(hljs);
    return {
      name,
      bundled: bundled.has(name),
      aliases: (definition.aliases ?? []).map((alias) => String(alias).toLowerCase()),
      scopes: scopesOf(definition).toSorted(),
    };
  });
}

/**
 * Which grammar each spelling a document may write resolves to, resolved the way the highlighter
 * resolves it.
 *
 * `getLanguage` is `languages[name] || languages[aliases[name]]`: a registration name always beats an
 * alias, whoever registered it, and an alias claimed by two grammars belongs to whichever registered
 * LAST, because `registerAliases` overwrites. Both matter here — `ls` is an alias of both `lasso` and
 * `livescript`, and `ml` of both `ocaml` and `sml` — and getting either backwards would hand a
 * document a different language from the one the highlighter would have chosen.
 *
 * @param {Grammar[]} grammars - The installed grammars, in registration order.
 * @returns {Map<string, string>} Spelling → the grammar name it resolves to.
 */
export function resolveSpellings(grammars) {
  const resolved = new Map();
  // Aliases first, so a later registration overwrites an earlier one …
  for (const grammar of grammars) {
    for (const alias of grammar.aliases) resolved.set(alias, grammar.name);
  }
  // … and registration names last, because no alias can displace one.
  for (const grammar of grammars) resolved.set(grammar.name, grammar.name);
  return resolved;
}
