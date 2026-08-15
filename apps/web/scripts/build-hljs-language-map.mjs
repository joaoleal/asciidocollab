#!/usr/bin/env node
/**
 * Write the map the render worker fetches syntax grammars through.
 *
 * The worker used to import `highlight.js/lib/common` — 36 of the 192 grammars the package ships — so
 * a source block naming any of the other 156 came back with no colour at all, and the PDF painted a
 * Dockerfile the Print preview did not. The worker's rule (a language it has no grammar for is left
 * plain, never guessed at) is right and stays; what was wrong is that "no grammar" quietly meant "not
 * in the 36 we happened to import". This map makes the two the same thing. Importing the whole package
 * instead would put ~1 MB of grammars into every preview, paid on the first keystroke whether the
 * author writes a code block or not.
 *
 * ## Why it is GENERATED, and why that is a security property
 *
 * The language name comes out of the document — `[source,dockerfile]` — so it is author-controlled
 * text, and a dynamic `import()` built from it would let that text choose a module path. So no
 * specifier is ever built from it: every `import()` in the generated file is a LITERAL written here,
 * and the document's name can only be looked UP in the map. A name that is not a key misses, and a
 * miss is the plain-text path the worker already had. That is a property of the SHAPE of the generated
 * file, not of a check someone has to remember to write.
 *
 * Deriving it from the installed package rather than typing 192 names keeps it true across a bump:
 * `--check` re-derives and compares, so a release that adds, removes or renames a grammar — or moves
 * one in or out of `lib/common` — fails instead of silently changing what the preview can colour.
 *
 * ## What is deliberately NOT in it
 *
 * The bundled grammars. One is registered before the first render and `hljs.getLanguage` answers for
 * it, so the worker never reaches the map; an entry would be a chunk that can never be fetched. A
 * spelling a bundled grammar already answers to is left out for the same reason. The rest carry every
 * spelling a document may name them by, resolved the way `getLanguage` resolves them (see
 * {@link resolveSpellings}).
 *
 * ## Usage
 *
 *   node scripts/build-hljs-language-map.mjs            # rewrite the generated module
 *   node scripts/build-hljs-language-map.mjs --check     # verify it, change nothing
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readGrammars, resolveSpellings, WEB_ROOT } from './lib/hljs-grammars.mjs';

/** The module the render worker imports. */
const OUTPUT = resolve(WEB_ROOT, 'src/workers/hljs-languages.generated.ts');

/**
 * The grammars the worker can fetch, each with every spelling that resolves to it.
 *
 * @returns {{ name: string, spellings: string[] }[]} The fetchable grammars, in registration order.
 */
function fetchableGrammars() {
  const grammars = readGrammars();
  const owner = resolveSpellings(grammars);
  const bundled = new Set(grammars.filter((grammar) => grammar.bundled).map((grammar) => grammar.name));

  const fetchable = [];
  for (const grammar of grammars) {
    if (grammar.bundled) continue;
    // Only the spellings this grammar actually WINS. `ls` names both `lasso` and `livescript`, and
    // the highlighter would give it to `livescript`; a map that gave it to whichever grammar was
    // written out first would colour a block with a language the highlighter would not have chosen.
    const spellings = [grammar.name, ...grammar.aliases]
      .filter((spelling) => owner.get(spelling) === grammar.name)
      // A spelling a bundled grammar answers to can never reach the map — `getLanguage` finds the
      // registered language first — so an entry for it would be unreachable rather than wrong.
      .filter((spelling) => !bundled.has(spelling))
      .toSorted();
    if (spellings.length === 0) continue;
    fetchable.push({ name: grammar.name, spellings });
  }
  if (fetchable.length === 0) throw new Error('Every installed grammar is bundled, which cannot be right.');
  return fetchable;
}

/**
 * One name on its way into the generated module, checked for what it must not be able to do.
 *
 * Every string emitted below is written into TypeScript source, and one of them ends up INSIDE an
 * `import()` specifier. These names come from a package's own metadata rather than from a document,
 * so this is not the boundary that protects the app — that is the map lookup itself — but a grammar
 * named with a quote or a path segment would still write a module that means something other than it
 * says. Refused rather than escaped: there is no legitimate grammar name that needs any of this.
 *
 * @param {string} value - The registration name or spelling.
 * @param {string} what - What it is, for the message.
 * @returns {string} The value, unchanged.
 */
function safeName(value, what) {
  if (!/^[\w+#.-]+$/.test(value)) {
    throw new Error(`${what} is not a plain name and will not be written into the map: ${value}`);
  }
  return value;
}

/**
 * Render the generated module.
 *
 * @param {{ name: string, spellings: string[] }[]} grammars - The fetchable grammars.
 * @returns {string} The module's whole text.
 */
function renderModule(grammars) {
  const entries = grammars.map((grammar) => {
    const name = safeName(grammar.name, 'a grammar name');
    const spellings = grammar.spellings.map((spelling) => `'${safeName(spelling, `a spelling of ${name}`)}'`);
    return (
      `  { name: '${name}', spellings: [${spellings.join(', ')}], ` +
      `load: () => import('highlight.js/lib/languages/${name}') },`
    );
  });

  return `/**
 * @file Generated by scripts/build-hljs-language-map.mjs — do not edit by hand.
 *
 * The ${grammars.length} grammars \`highlight.js/lib/common\` does not carry, each with the spellings a document
 * may name it by, and a thunk that fetches it. Run:
 *
 *   pnpm --filter @asciidocollab/web run generate:hljs-language-map
 *
 * Every \`import()\` below is a literal. The language name a document declares is only ever a KEY into
 * {@link ON_DEMAND_GRAMMARS}, never any part of a specifier — see the generator's header for why that
 * is the whole point of generating this rather than composing a path at run time.
 */

import type { LanguageFn } from 'highlight.js';

/** One grammar the preview can fetch, and how. */
export interface OnDemandGrammar {
  /** The name to register it under, which is the one the highlighter's own index uses. */
  readonly name: string;
  /** Every spelling that resolves to it, registration name included. Lower case, sorted. */
  readonly spellings: readonly string[];
  /** Fetch it. Resolves to the grammar's factory as the module's default export. */
  readonly load: () => Promise<{ default: LanguageFn }>;
}

const GRAMMARS: readonly OnDemandGrammar[] = [
${entries.join('\n')}
];

/**
 * Spelling → the grammar it names.
 *
 * A Map rather than an object literal, so a lookup of a name a document invented cannot reach
 * anything but an entry written above: no \`__proto__\`, no \`constructor\`, no inherited key.
 */
export const ON_DEMAND_GRAMMARS: ReadonlyMap<string, OnDemandGrammar> = new Map(
  GRAMMARS.flatMap((grammar) => grammar.spellings.map((spelling) => [spelling, grammar] as const)),
);
`;
}

function main() {
  const check = process.argv.includes('--check');
  const grammars = fetchableGrammars();
  const rendered = renderModule(grammars);

  if (check) {
    let existing = null;
    try {
      existing = readFileSync(OUTPUT, 'utf8');
    } catch {
      existing = null;
    }
    if (existing !== rendered) {
      console.error(
        'The on-demand grammar map does not match the installed highlight.js.\n\n' +
          'Run: pnpm --filter @asciidocollab/web run generate:hljs-language-map',
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `The on-demand grammar map carries the ${grammars.length} grammars highlight.js/lib/common does not.`,
    );
    return;
  }

  writeFileSync(OUTPUT, rendered);
  console.log(`Wrote ${grammars.length} fetchable grammars into ${OUTPUT}.`);
}

main();
