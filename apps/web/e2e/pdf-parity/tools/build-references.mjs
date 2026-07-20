/**
 * @file Builds the committed reference PDFs for the PDF-parity corpus using the EXTERNAL Asciidoctor-PDF
 * toolchain (the real gem plus its citation/diagram extensions), never the in-app wasm export. It runs
 * the pinned `adc-pdf-ref` Docker image (see Dockerfile.reference) over each fixture and writes the
 * reference PDF(s) back into the fixture directory.
 *
 * Reference fidelity by family:
 *   - code       : real asciidoctor-pdf with the rouge highlighter — a fully independent reference.
 *   - citations  : real asciidoctor-pdf + asciidoctor-bibtex over the shared .bib, one PDF per
 *                  (CSL style x ordering) variant — a fully independent reference.
 *   - math       : asciidoctor-mathematical will not build on this platform, so the reference is the
 *                  real gem embedding the SAME MathJax SVG assets the shim produces. The parity under
 *                  test is therefore the wasm engine's placement of the identical math asset vs the
 *                  reference gem's placement — a real engine-embedding check.
 *   - diagrams   : the real gem embedding the shim-produced SVG assets (engine-embedding parity).
 *
 *   - theme-fonts-woff2 : the real gem rendering the DECODED fonts, because Prawn embeds TTF/OTF only
 *                  and cannot read WOFF2 at all. See buildFromReferenceBuild's note below.
 *
 * The math + diagrams shim SVGs need a browser (mermaid/MathJax), so their rewritten project (root doc
 * + placed `.gen/*.svg`) is produced once by emit-reference-inputs.spec.ts and committed under the
 * fixture's `reference-build/`. This tool renders code + citations directly, and re-renders math +
 * diagrams + theme-fonts-woff2 from that committed `reference-build/` (no browser needed).
 *
 * All renders pass `-a reproducible` so the committed PDFs carry no wall-clock metadata, and all run
 * as the invoking user against the content-addressed image from `reference-image.mjs` — the same
 * pinned toolchain `generate-reference.mjs` uses. This tool used to ask for `adc-pdf-ref:latest`,
 * which nothing rebuilds and no definition pins.
 *
 * Usage:  node tools/build-references.mjs [code|citations|math|diagrams|theme-fonts-woff2 ...]
 *         (default: all)
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureReferenceImage, SOURCE_DATE_EPOCH } from './reference-image.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');
const IMAGE = ensureReferenceImage();

/** The (style, order) matrix the citations fixture is verified across: one numeric + one author-date CSL. */
const CITATION_VARIANTS = [
  { id: 'numeric-appearance', style: 'vancouver', order: 'appearance' },
  { id: 'numeric-alphabetical', style: 'vancouver', order: 'alphabetical' },
  { id: 'author-date-appearance', style: 'apa', order: 'appearance' },
  { id: 'author-date-alphabetical', style: 'apa', order: 'alphabetical' },
];

function run(args) {
  execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'inherit'] });
}

/** Render one adoc in a throwaway work dir mounted into the reference image; copy the PDF back out. */
function renderInDocker(workDir, adocName, outName, extraArgs) {
  run([
    'run', '--rm',
    '--network', 'none',
    // Never root: the render only reads the work dir and writes one PDF into it, and the PDF is
    // copied back into the developer's checkout. Verified not to affect output — root and host-UID
    // renders of the same fixture are byte-identical.
    '--user', `${process.getuid()}:${process.getgid()}`,
    '-e', `SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}`,
    '-v', `${workDir}:/work`, '-w', '/work', IMAGE,
    // Through bundler, so the render resolves the LOCKED gem closure rather than whatever happens to
    // be installed in the image.
    'bundle', 'exec', 'asciidoctor-pdf', '-a', 'reproducible', ...extraArgs, '-o', outName, adocName,
  ]);
}

function freshWorkDir() {
  return mkdtempSync(join(tmpdir(), 'pdfref-'));
}

function buildCode() {
  const dir = join(FIXTURES, 'code');
  const work = freshWorkDir();
  copyFileSync(join(dir, 'source', 'main.adoc'), join(work, 'main.adoc'));
  renderInDocker(work, 'main.adoc', 'reference.pdf', []);
  copyFileSync(join(work, 'reference.pdf'), join(dir, 'reference.pdf'));
  rmSync(work, { recursive: true, force: true });
  console.log('code: reference.pdf');
}

function buildCitations() {
  const dir = join(FIXTURES, 'citations');
  for (const variant of CITATION_VARIANTS) {
    const work = freshWorkDir();
    copyFileSync(join(dir, 'reference-src', 'main.adoc'), join(work, 'main.adoc'));
    copyFileSync(join(dir, 'source', 'refs.bib'), join(work, 'refs.bib'));
    renderInDocker(work, 'main.adoc', 'out.pdf', [
      '-r', 'asciidoctor-bibtex',
      '-a', `bibtex-style=${variant.style}`,
      '-a', `bibtex-order=${variant.order}`,
    ]);
    copyFileSync(join(work, 'out.pdf'), join(dir, `reference-${variant.id}.pdf`));
    rmSync(work, { recursive: true, force: true });
    console.log(`citations: reference-${variant.id}.pdf`);
  }
}

/**
 * Re-render a fixture's reference PDF from its committed `reference-build/` (rewritten doc + assets).
 *
 * A `reference-build/` is a SELF-CONTAINED project: every option the render needs is a document
 * attribute in its `main.adoc`, so the command below is the same for every fixture and carries no
 * per-fixture flags. That is what makes these reference builds auditable — the committed directory
 * IS the input, with nothing supplied out of band by whoever runs the tool.
 *
 * `theme-fonts-woff2` is the reason this matters beyond math/diagrams. Its `source/` theme registers
 * `.woff2` fonts, which Prawn cannot read ("is not a known font"), so the fixture had a committed
 * reference that no toolchain could regenerate. Its `reference-build/` holds the fonts decoded to TTF
 * — exactly the bytes the app's own WOFF2 decode path produces at export time — under `.ttf` names,
 * with the theme pointing at them. The extension is load-bearing: decoded TTF bytes stored at the
 * original `.woff2` filenames still fail, because Prawn keys the format on the FILE EXTENSION, not on
 * the sfnt signature. (Spec 040's research note claims the opposite; it is wrong, and following it
 * reproduces the "is not a known font" failure.)
 *
 * Verified byte-identical to the committed reference.
 */
function buildFromReferenceBuild(fixtureName) {
  const dir = join(FIXTURES, fixtureName);
  const buildDir = join(dir, 'reference-build');
  if (!existsSync(join(buildDir, 'main.adoc'))) {
    console.log(`${fixtureName}: SKIPPED (no reference-build/ — run emit-reference-inputs.spec.ts with PARITY_EMIT=1)`);
    return;
  }
  const work = freshWorkDir();
  cpSync(buildDir, work, { recursive: true });
  renderInDocker(work, 'main.adoc', 'reference.pdf', []);
  copyFileSync(join(work, 'reference.pdf'), join(dir, 'reference.pdf'));
  rmSync(work, { recursive: true, force: true });
  console.log(`${fixtureName}: reference.pdf (real gem rendering the committed reference-build/ project)`);
}

const targets = process.argv.slice(2);
const wanted = (name) => targets.length === 0 || targets.includes(name);

mkdirSync(FIXTURES, { recursive: true });
if (wanted('code')) buildCode();
if (wanted('citations')) buildCitations();
if (wanted('math')) buildFromReferenceBuild('math');
if (wanted('diagrams')) buildFromReferenceBuild('diagrams');
if (wanted('theme-fonts-woff2')) buildFromReferenceBuild('theme-fonts-woff2');
console.log('done.');
