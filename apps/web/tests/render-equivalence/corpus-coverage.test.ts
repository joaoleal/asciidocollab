/**
 * The render-equivalence corpus is the fixed document set both the reference-build gate and the
 * previous-engine regression gate run over. Its value is entirely in what it covers: a category that
 * quietly leaves the corpus takes its gate coverage with it and nothing else fails.
 *
 * This checks the corpus against the coverage the equivalence contract enumerates, so dropping a
 * category is a failing test rather than a silent narrowing of what the gates prove.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const CORPUS_DIR = path.join(__dirname, '..', '..', 'e2e', 'render-equivalence', 'corpus');

/** Every top-level corpus document (an included file is part of a document, not one of its own). */
function corpusDocuments(): readonly string[] {
  return readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith('.adoc'))
    .toSorted();
}

/** The whole corpus as one string, for "is this covered anywhere?" questions. */
function corpusText(): string {
  return corpusDocuments()
    .map((name) => readFileSync(path.join(CORPUS_DIR, name), 'utf8'))
    .join('\n');
}

/**
 * The coverage the contract requires, as a probe per row. A probe is deliberately a marker of the
 * SYNTAX under test rather than a file name, so moving a category between documents is free and
 * losing it is not.
 */
const REQUIRED_COVERAGE: readonly (readonly [string, RegExp])[] = [
  ['headings at every level', /^====== |^===== |^==== |^=== |^== /m],
  ['section numbering', /^:sectnums:/m],
  ['explicit anchors', /^\[\[[\w-]+\]\]/m],
  ['internal cross-references', /xref:[\w-]+\[|<<[\w-]+[,>]/],
  ['source block with a declared language', /^\[source,\s*\w+/m],
  ['source block without a declared language', /^\[source\]$/m],
  ['tables', /^\|===/m],
  ['unordered lists', /^\* /m],
  ['ordered lists', /^\. /m],
  ['description lists', /^\w[^\n]*::\s*$/m],
  ['admonitions', /^(NOTE|TIP|WARNING|CAUTION|IMPORTANT):/m],
  ['footnotes', /footnote:/],
  ['callouts', /<1>/],
  ['attribute entries', /^:[\w-]+:\s+\S/m],
  ['ifdef conditionals', /^ifdef::/m],
  ['ifeval conditionals', /^ifeval::/m],
  ['include with leveloffset', /^include::[^[]+\[[^\]]*leveloffset=/m],
  ['diagram blocks', /^\[(mermaid|graphviz|vega|vegalite)/m],
  ['stem blocks', /^\[stem\]$/m],
  ['inline stem', /stem:\[|latexmath:\[|asciimath:\[/],
  ['imagesdir-relative images', /^image::(?!https?:|\/)[^[]+\[/m],
  ['absolute image targets', /^image::(https?:\/\/|\/)/m],
];

describe('render-equivalence corpus', () => {
  it('holds at least one document per category the gates are meant to cover', () => {
    const text = corpusText();
    const missing = REQUIRED_COVERAGE.filter(([, probe]) => !probe.test(text)).map(([label]) => label);

    expect(missing).toEqual([]);
  });

  it('resolves every include target it declares, so no document renders half-empty', () => {
    const unresolved: string[] = [];
    for (const name of corpusDocuments()) {
      const documentPath = path.join(CORPUS_DIR, name);
      const source = readFileSync(documentPath, 'utf8');
      for (const match of source.matchAll(/^include::([^[]+)\[/gm)) {
        const target = path.join(path.dirname(documentPath), match[1]!);
        if (!existsSync(target)) unresolved.push(`${name} → ${match[1]!}`);
      }
    }

    expect(unresolved).toEqual([]);
  });

  it('is a fixed set, not an empty directory the gates would pass over in silence', () => {
    expect(corpusDocuments().length).toBeGreaterThanOrEqual(8);
  });
});
