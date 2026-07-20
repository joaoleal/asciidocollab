/**
 * @file Warm-VM extension isolation harness.
 *
 * `Module#prepend` cannot be undone and the wasm VM is never torn down between renders, so an
 * extension required into it is in the converter's ancestor chain for the rest of the session. Every
 * guarantee this feature makes about DISABLING an extension therefore has to hold in a VM that has
 * already loaded it — SC-015a (disabling returns the unextended document), FR-031b1 (preview the
 * sample without one extension), FR-032g/SC-012b (adding an extension never changes existing output).
 *
 * Nothing else measures that. The parity fixtures each enable exactly what they test, so an extension
 * that leaks into the NEXT render still matches its own reference; the leak only shows up as some
 * later fixture failing, which makes it look like a defect in whatever ran second and makes the whole
 * suite's result depend on the order the fixture directory happened to enumerate. That is how the
 * accumulation bug survived: three fixtures failed, each of them innocent.
 *
 * So this harness renders the SAME document several times through ONE warm VM, varying only the
 * enabled set, and prints the resulting byte hashes. The invariants live in the test beside it:
 * the run with nothing enabled must equal a render from a VM that never loaded an extension at all,
 * and a run must depend on what IT selected rather than on what ran before it.
 *
 * It renders through the same shipping seams `parity-render.mjs` uses (dist VM + registry), and
 * prints a single JSON summary on stdout so the ts-jest test can spawn it and assert.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..', '..');
const DIST = join(PACKAGE_ROOT, 'dist');
const WASM_PATH = join(PACKAGE_ROOT, 'ruby', 'asciidoctor-pdf.wasm');

const requirePkg = createRequire(join(PACKAGE_ROOT, 'package.json'));
const { createWasiBridge } = requirePkg(join(DIST, 'vm', 'wasi-bridge.js'));
const { createRubyPdfVm } = requirePkg(join(DIST, 'vm', 'ruby-pdf-vm.js'));
const { populateProject } = requirePkg(join(DIST, 'vfs', 'populate.js'));
const { invokeConvert } = requirePkg(join(DIST, 'convert', 'invoke.js'));
const { resolvePdfExtensions } = requirePkg(join(DIST, 'extensions', 'registry.js'));

const SHIPPED_EXTENSIONS_DIR = join(
  PACKAGE_ROOT,
  'ruby',
  'extensions',
  'asciidocollab-pdf-extensions',
  'lib',
);

/** Every shipped extension directory carrying both a manifest and a source. */
function shippedDirectories() {
  if (!existsSync(SHIPPED_EXTENSIONS_DIR)) return [];
  return readdirSync(SHIPPED_EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        existsSync(join(SHIPPED_EXTENSIONS_DIR, name, 'manifest.json')) &&
        existsSync(join(SHIPPED_EXTENSIONS_DIR, name, 'extension.rb')),
    );
}

const manifestOf = (name) =>
  JSON.parse(readFileSync(join(SHIPPED_EXTENSIONS_DIR, name, 'manifest.json'), 'utf8'));

/** The shipped catalogue, as the server would assemble it. */
const shippedCatalogue = () =>
  shippedDirectories().map((name) => ({
    manifest: manifestOf(name),
    origin: 'shipped',
    available: true,
  }));

/** Each shipped extension's Ruby source, as the composition root would inject it. */
const shippedSources = () =>
  shippedDirectories().map((name) => ({
    id: manifestOf(name).id,
    origin: 'shipped',
    source: readFileSync(join(SHIPPED_EXTENSIONS_DIR, name, 'extension.rb'), 'utf8'),
  }));

/**
 * A book that gives every extension under test something visible to do.
 *
 * A contents list (`narrow-contents` narrows it, `per-chapter-contents` adds one per chapter), body
 * prose in chapters (`paragraph-numbering` numbers it) and a licence attribute (`auto-license-page`
 * draws a page from it). An extension that changed nothing here would make the comparison vacuous —
 * a leak and a correct render would both come out identical.
 */
function buildDocument() {
  return [
    '= A Warm VM Book',
    ':doctype: book',
    ':toc:',
    ':license: CC BY-SA 4.0',
    '',
    '== The First Chapter',
    '',
    'Opening prose for the first chapter, long enough to occupy a visible amount of the measure',
    'and to be numbered by the paragraph-numbering extension when it is switched on.',
    '',
    '=== Origins',
    '',
    'A subsection, so the contents list has more than one level to lay out.',
    '',
    '== The Second Chapter',
    '',
    'More prose, in a second chapter, so a per-chapter contents list has somewhere to appear.',
    '',
    '=== Method',
    '',
    'Another subsection.',
    '',
  ].join('\n');
}

/** The snapshot for one render, differing from the others ONLY in the extensions it enables. */
function snapshotFor(enabledExtensions) {
  return {
    files: { 'main.adoc': buildDocument(), 'theme.yml': 'extends: default\n' },
    binaryAssets: {},
    rootPath: 'main.adoc',
    openPath: 'main.adoc',
    fontPaths: [],
    attributes: {},
    themePath: 'theme.yml',
    enabledExtensions,
  };
}

/** Boot one warm VM, exactly as the worker and the parity harness do. */
async function bootVm() {
  const module = await WebAssembly.compile(readFileSync(WASM_PATH));
  const vm = createRubyPdfVm({ createBridge: () => createWasiBridge({ module }) });
  await vm.warmup();
  return vm;
}

/** Render one snapshot in `vm`, leaving the VM warm and whatever it loaded still prepended. */
async function renderIn(vm, snapshot, requestId) {
  populateProject(vm, snapshot);

  const resolution = resolvePdfExtensions(
    snapshot.enabledExtensions,
    shippedCatalogue(),
    shippedSources(),
  );
  if (resolution.rejected.length > 0) {
    throw new Error(`Extensions refused: ${JSON.stringify(resolution.rejected)}`);
  }
  for (const extension of resolution.loaded) {
    vm.writeFile(extension.vfsPath, new TextEncoder().encode(extension.source));
  }

  const result = await invokeConvert({
    vm,
    request: { requestId, mode: 'export', snapshot, optimize: false },
    loadedExtensions: resolution.loaded.map(({ id, vfsPath }) => ({ id, vfsPath })),
  });
  if (!result.ok) {
    throw new Error(
      `convert failed: ${result.error.phase}/${result.error.code}: ${result.error.message}`,
    );
  }
  return createHash('sha256').update(result.bytes).digest('hex');
}

async function main() {
  // The control: a VM that has NEVER required an extension, rendering the document unextended. Every
  // "disabled" claim below is measured against this, not against another warm-VM render — otherwise a
  // leak that affected both sides equally would cancel out and read as success.
  const coldVm = await bootVm();
  const pristine = await renderIn(coldVm, snapshotFor([]), 'pristine');
  coldVm.dispose();

  // One warm VM for the whole sequence, which is what production does. By the last render its
  // converter carries every module the earlier ones prepended, and none of them can be removed.
  const warmVm = await bootVm();
  const sequence = [];
  for (const [label, enabled] of [
    ['all', ['auto-license-page', 'narrow-contents', 'paragraph-numbering', 'per-chapter-contents']],
    // Held out one at a time — the theme editor's comparison control (FR-031b1) in miniature.
    ['without-narrow-contents', ['auto-license-page', 'paragraph-numbering', 'per-chapter-contents']],
    ['only-narrow-contents', ['narrow-contents']],
    // The one that matters most: back to nothing, in a VM that has now loaded four extensions.
    ['none', []],
    // Re-enabling must return the earlier output exactly, not merely something extension-shaped.
    ['all-again', ['auto-license-page', 'narrow-contents', 'paragraph-numbering', 'per-chapter-contents']],
  ]) {
    sequence.push({ label, enabled, hash: await renderIn(warmVm, snapshotFor(enabled), label) });
  }
  warmVm.dispose();

  // One line, and the LAST one: the VM writes `wasi:` progress to stdout throughout, so the test
  // parses the final line rather than the whole stream.
  process.stdout.write(`\n${JSON.stringify({ ran: true, pristine, sequence })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exit(1);
});
