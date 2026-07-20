/**
 * @file Proves that no shipped converter extension's output depends on where it landed in the
 * converter's ancestor chain.
 *
 * == The defect this exists to catch
 *
 * Every extension customises the converter by `prepend`ing a module. Two extensions that override the
 * same hook therefore wrap each other, and which one is outermost is decided by which was `require`d
 * FIRST — not by the registry's id ordering, because `require` is a no-op the second time and the
 * wasm VM is warm and never torn down between renders. In a worker that has already served another
 * project, the chain reflects that project's selection.
 *
 * So the load order is not something the application chooses per render, and an extension whose
 * output depends on it renders one document for the first project through a worker and a different
 * one for the next. Nothing in the app can observe which it got, and both look plausible.
 *
 * It has happened twice. `narrow-contents` narrowed the contents list by wrapping `super` in
 * `indent`, and `additional-contents-entries` drew its extra lists around `super` too: one order
 * narrowed those lists with the contents list, the other left them at full page measure beside it.
 * And `additional-contents-entries` recorded the page a table starts on before `super`, which
 * `large-table-page-size` then moved — so the List of Tables cited the page BEFORE the table in one
 * order and the right one in the other.
 *
 * == Why this check, and not a fixture
 *
 * A parity fixture renders one order and compares against a reference rendered the same way, so it
 * agrees with itself whichever order that is — it cannot see this class of defect at all. The static
 * invariant in `packages/asciidoc-pdf/tests/extensions/shipped-extensions.test.ts` forces a recorded
 * reason for every hook two extensions share, which catches a NEW collision going in unexamined; this
 * is what catches a recorded reason that is WRONG.
 *
 * == How
 *
 * Render each fixture that enables two or more extensions twice — once in the app's id order, once
 * reversed — and require the two PDFs to be byte-identical. Reversing is enough: it inverts every
 * pairwise relationship at once, so any pair whose composition is order-sensitive changes sides.
 *
 * The comparison can be on raw bytes because the reference toolchain is already reproducible
 * (`-a reproducible` plus a pinned `SOURCE_DATE_EPOCH`), which is the same property that lets
 * `generate-reference.mjs` regenerate a reference and get the identical file back.
 *
 * Usage: node apps/web/e2e/pdf-parity/tools/check-extension-order.mjs
 * Requires Docker, like every other tool in this directory.
 */

import { readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../generate-reference.mjs';
import { ensureReferenceImage, referenceImageTag } from './reference-image.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', 'fixtures');

/** Where each order's render is written. Removed afterwards; never committed. */
const FORWARD_PDF = 'order-check-forward.pdf';
const REVERSED_PDF = 'order-check-reversed.pdf';

function log(message) {
  process.stderr.write(`${message}\n`);
}

/** Fixture directories enabling two or more extensions — the only ones that can compose at all. */
function fixturesWithMultipleExtensions() {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(FIXTURES_DIR, entry.name))
    .filter((dir) => {
      const manifestPath = join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) return false;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const enabled = manifest?.render?.enabledExtensions;
      return Array.isArray(enabled) && new Set(enabled.map(String)).size > 1;
    });
}

function main() {
  const fixtures = fixturesWithMultipleExtensions();
  if (fixtures.length === 0) {
    // Not a pass. A corpus with no multi-extension fixture cannot demonstrate composition at all, and
    // reporting success would say it had.
    throw new Error(
      'No fixture enables more than one extension, so extension composition is untested. ' +
        'Add one before relying on this check.',
    );
  }

  const tag = referenceImageTag();
  ensureReferenceImage(tag, log);

  const divergent = [];
  for (const fixtureDir of fixtures) {
    const name = basename(fixtureDir);
    log(`\n${name}: rendering both load orders`);
    try {
      generate(fixtureDir, tag, { outputName: FORWARD_PDF });
      generate(fixtureDir, tag, { outputName: REVERSED_PDF, order: (ids) => [...ids].reverse() });
      const forward = readFileSync(join(fixtureDir, FORWARD_PDF));
      const reversed = readFileSync(join(fixtureDir, REVERSED_PDF));
      if (!forward.equals(reversed)) {
        divergent.push(name);
        log(`  DIFFERS: ${name} renders differently when its extensions load in the opposite order.`);
      } else {
        log(`  ok (${forward.length} bytes, identical both ways)`);
      }
    } finally {
      // Always, including on a divergence: these are scratch renders, and one left behind would be
      // picked up as a stray artefact by the next person to look at the fixture.
      for (const scratch of [FORWARD_PDF, REVERSED_PDF]) {
        rmSync(join(fixtureDir, scratch), { force: true });
      }
    }
  }

  if (divergent.length > 0) {
    throw new Error(
      `Extension load order changes the output of: ${divergent.join(', ')}.\n` +
        'Some extension composes with another by wrapping `super`, so which one is outermost decides ' +
        'the document. The app cannot fix this by loading in a set order — `Module#prepend` is ' +
        'permanent and the VM is warm, so the chain reflects whichever project rendered first. The ' +
        'extension has to stop depending on its position: publish what it owns as a named, re-entrant ' +
        'method the other asks for (as `narrow-contents` does with `_asciidocollab_contents_measure`), ' +
        'or take its measurement at a point both orders agree on.',
    );
  }
  log(`\nAll ${fixtures.length} multi-extension fixture(s) render identically in either load order.`);
}

main();
