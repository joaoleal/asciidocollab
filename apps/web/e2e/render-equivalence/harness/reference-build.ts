/**
 * @file Drives the pinned external Asciidoctor toolchain over the corpus and holds the rules that
 * reconcile its output with the app's.
 *
 * This is the web-formatted preview's only external fidelity oracle. Everything the app's render path
 * does BEFORE conversion is reproduced here so that the two sides are converting the same document —
 * the include assembly and the API attributes the worker seeds — and everything it does AFTER
 * conversion is either undone or matched by an equivalent reduction of the reference, one named pass
 * per difference.
 *
 * The distinction matters more than it looks. A pass that reproduces an input (same assembled source,
 * same attributes) removes a difference that was never real. A pass that reduces both sides (code
 * blocks to their text, diagram blocks to a canonical node) gives up the ability to see a class of
 * change, and each one is therefore written to give up as little as it can: the code-block pass keeps
 * the code's exact characters and drops only the tokenisation, the diagram pass keeps the declared
 * type and the exact source and drops only the markup each toolchain wraps them in.
 *
 * The reference toolchain is a Docker image whose tag is a hash of its definition files, so an
 * existing image was built from exactly these bytes rather than merely sharing a name. Its definition
 * set is its own — see the Gemfile beside this file for why it must not be merged with the
 * page-format one.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assembleIncludes } from '../../../src/workers/assemble-includes';
import { RENDER_INTRINSIC_ATTRIBUTES } from '../../../src/lib/asciidoc/render-intrinsics';
import { APP_RENDER_DEFAULT_ATTRIBUTES } from '../../../src/lib/asciidoc/render-app-defaults';
import { captureRequestFor, corpusFiles, type CorpusDocument } from './capture';

/** Where the reference toolchain's output is kept, so the oracle's answer is readable and reviewable. */
export const REFERENCE_TOOLCHAIN_DIR = path.join(__dirname, '..', 'fixtures', 'reference-toolchain');

/** The mount point of the work directory inside the container. */
const WORK = '/work';

/** The conversion script's path inside the image, as the Dockerfile places it. */
const RENDER_SCRIPT = '/toolchain/reference-render.rb';

/** The page-format tooling's module, which owns the image-tagging and image-building mechanism. */
const REFERENCE_IMAGE_MODULE = path.join(
  __dirname,
  '..',
  '..',
  'pdf-parity',
  'tools',
  'reference-image.mjs',
);

/**
 * A reference toolchain's identity: its build context, the files whose bytes decide its output, and
 * the name of the image they produce.
 */
interface ReferenceDefinition {
  readonly name: string;
  readonly directory: string;
  readonly files: readonly string[];
}

/**
 * The HTML oracle's definition set.
 *
 * `reference-render.rb` is in the list because it chooses the load options — safe mode, embedded
 * output, sourcemap — and those decide the output bytes every bit as much as the gem version does. A
 * definition file left out of the hash is a change that silently reuses the previous image.
 */
export const HTML_REFERENCE_DEFINITION: ReferenceDefinition = {
  name: 'asciidoc-html-reference',
  directory: __dirname,
  files: ['Dockerfile.reference', 'Gemfile', 'Gemfile.lock', 'reference-render.rb'],
};

/** The subset of the page-format tooling's module this harness uses. */
interface ReferenceImageModule {
  readonly referenceImageTag: (definition: ReferenceDefinition) => string;
  readonly ensureReferenceImage: (
    tag: string,
    log: (message: string) => void,
    definition: ReferenceDefinition,
  ) => string;
  readonly SOURCE_DATE_EPOCH: string;
}

/** Whether a loaded module really is the image tooling, checked rather than asserted. */
function isReferenceImageModule(value: unknown): value is ReferenceImageModule {
  if (typeof value !== 'object' || value === null) return false;
  const candidate: Record<string, unknown> = { ...value };
  return (
    typeof candidate.referenceImageTag === 'function' &&
    typeof candidate.ensureReferenceImage === 'function' &&
    typeof candidate.SOURCE_DATE_EPOCH === 'string'
  );
}

/**
 * Load the shared image tooling.
 *
 * Through a dynamic `import()` of a file URL, not a static import: the Playwright runner transpiles
 * every statically-imported module to CommonJS, and a `.mjs` loaded that way fails with
 * `exports is not defined in ES module scope` at import time — taking the whole config down with it,
 * including the gates that never touch Docker.
 */
async function loadReferenceImageModule(): Promise<ReferenceImageModule> {
  const loaded: unknown = await import(pathToFileURL(REFERENCE_IMAGE_MODULE).href);
  if (!isReferenceImageModule(loaded)) {
    throw new Error(`${REFERENCE_IMAGE_MODULE} does not export the reference-image tooling.`);
  }
  return loaded;
}

/** Whether a usable Docker daemon is reachable, so the gate can skip cleanly instead of failing. */
export function dockerAvailable(): boolean {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return probe.error === undefined && probe.status === 0;
}

// The Asciidoctor convention for an overridable ("soft") default: an in-document attribute entry of
// the same name still wins. The worker marks its seeded values this way, and the include assembler
// wants the raw value, so the marker is stripped when the seed map is built.
const SOFT_DEFAULT_SUFFIX = '@';

/**
 * The API attributes the app renders a corpus document with.
 *
 * Mirrors `asciidoc-render.worker.ts`'s own attribute layering for the requests `capture.ts` builds:
 * the app's render defaults at the base, then the STEM soft-default, then `showtitle`. The worker's
 * inherited-scope seeding contributes nothing here — it is keyed on a project root, and the capture
 * requests deliberately carry none — which {@link assertNoInheritedScope} checks rather than assumes.
 */
export function appRenderAttributes(): Record<string, string> {
  return {
    ...APP_RENDER_DEFAULT_ATTRIBUTES,
    stem: SOFT_DEFAULT_SUFFIX,
    showtitle: '',
  };
}

/**
 * The attribute state in effect at the start of the assembled document, as the worker seeds the
 * include assembler with it: Asciidoctor's own intrinsics plus the API attributes, soft-default
 * markers removed.
 */
function assemblerSeed(attributes: Record<string, string>): Map<string, string> {
  const seed = new Map(RENDER_INTRINSIC_ATTRIBUTES);
  for (const [name, value] of Object.entries(attributes)) {
    seed.set(name, value.endsWith(SOFT_DEFAULT_SUFFIX) ? value.slice(0, -SOFT_DEFAULT_SUFFIX.length) : value);
  }
  return seed;
}

/**
 * Fail unless a corpus render really does seed no inherited attribute scope.
 *
 * The worker layers a THIRD group of attributes between the app defaults and `showtitle`: the scope a
 * file inherits at its include point under a project main file. It is keyed on a project root, and the
 * capture requests deliberately carry none, so it contributes nothing — but "contributes nothing" is
 * an assumption about another module, and if a request ever grows a root the reference would silently
 * be converting with fewer attributes than the app.
 *
 * @param document - The corpus document about to be assembled.
 * @throws {Error} When the app's request for this document names a project root.
 */
function assertNoInheritedScope(document: CorpusDocument): void {
  const { rootFileId } = captureRequestFor(document, 0);
  if (rootFileId !== undefined && rootFileId !== null) {
    throw new Error(
      `the app's request for ${document.relativePath} names the project root "${rootFileId}", so its ` +
        'render seeds an inherited attribute scope that this harness does not reproduce. The reference ' +
        'would be converted with different attributes than the app.',
    );
  }
}

/**
 * The source the app actually converts: the corpus document with its include tree inlined.
 *
 * Not a divergence to normalise but an input to reproduce. The reference converts this same text, so
 * the assembler's output — inlined bodies, and the absolute `:leveloffset:` set/restore entries it
 * writes around them — is compared rather than excused.
 */
export function assembledSourceFor(document: CorpusDocument): string {
  assertNoInheritedScope(document);
  const files = corpusFiles();
  const readFile = (filePath: string): string | null =>
    filePath === document.relativePath ? document.source : (files[filePath] ?? null);
  return assembleIncludes(document.relativePath, readFile, {
    showIncludes: true,
    seedAttributes: assemblerSeed(appRenderAttributes()),
    baseOffset: 0,
    withSourceMap: true,
  }).content;
}

/**
 * A verbatim block as the reference toolchain parsed it: the style the author declared, which does
 * not survive conversion, and the block's source text.
 */
export interface ReferenceVerbatimBlock {
  readonly context: string;
  readonly style: string;
  readonly source: string;
}

/** One corpus document as the reference toolchain rendered it. */
export interface ReferenceRender {
  readonly name: string;
  readonly html: string;
  readonly verbatimBlocks: readonly ReferenceVerbatimBlock[];
}

/** Read one entry of the conversion script's block manifest, refusing anything malformed. */
function readVerbatimBlock(entry: unknown, source: string): ReferenceVerbatimBlock {
  if (typeof entry !== 'object' || entry === null) {
    throw new TypeError(`${source} contains a block entry that is not an object.`);
  }
  const record: Record<string, unknown> = { ...entry };
  const { context, style, source: blockSource } = record;
  if (typeof context !== 'string' || typeof style !== 'string' || typeof blockSource !== 'string') {
    throw new TypeError(`${source} contains a block entry with missing or non-string fields.`);
  }
  return { context, style, source: blockSource };
}

/** Read the whole manifest the conversion script wrote for one document. */
function readVerbatimBlocks(manifestPath: string): readonly ReferenceVerbatimBlock[] {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${manifestPath} is not a list of blocks.`);
  }
  return parsed.map((entry) => readVerbatimBlock(entry, manifestPath));
}

/**
 * Convert the whole corpus with the pinned toolchain, in one container run.
 *
 * The assembled sources go in, the conversions come back, and a copy is left in
 * `fixtures/reference-toolchain/` so the oracle's answer can be read and reviewed rather than only
 * asserted against. Unlike the previous-engine fixtures, that copy is an artefact and not a
 * reference: it is re-derivable at any time from the pinned image, which is exactly why the image
 * has to be pinned.
 *
 * @param documents - The corpus documents to convert.
 * @param log - Where progress goes.
 * @returns One render per document, keyed by document name.
 */
export async function buildReferenceRenders(
  documents: readonly CorpusDocument[],
  log: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): Promise<Map<string, ReferenceRender>> {
  const { referenceImageTag, ensureReferenceImage, SOURCE_DATE_EPOCH } = await loadReferenceImageModule();
  const tag = referenceImageTag(HTML_REFERENCE_DEFINITION);
  ensureReferenceImage(tag, log, HTML_REFERENCE_DEFINITION);

  const work = mkdtempSync(path.join(tmpdir(), 'render-equivalence-reference-'));
  try {
    writeFileSync(path.join(work, 'attributes.json'), JSON.stringify(appRenderAttributes(), null, 2));
    for (const document of documents) {
      writeFileSync(path.join(work, `${document.name}.adoc`), assembledSourceFor(document));
    }

    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        // Nothing here needs the network, and a reference that could reach one would not be pinned.
        '--network',
        'none',
        // Never root: the conversions are copied straight back into the developer's checkout.
        '--user',
        `${process.getuid()}:${process.getgid()}`,
        '-e',
        `SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}`,
        '-v',
        `${work}:${WORK}`,
        '-w',
        WORK,
        tag,
        // Through bundler, so the conversion resolves the LOCKED closure rather than whatever gems
        // happen to be installed in the image.
        'bundle',
        'exec',
        'ruby',
        RENDER_SCRIPT,
        WORK,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );

    const renders = new Map<string, ReferenceRender>();
    mkdirSync(REFERENCE_TOOLCHAIN_DIR, { recursive: true });
    for (const document of documents) {
      const htmlPath = path.join(work, `${document.name}.html`);
      const manifestPath = path.join(work, `${document.name}.json`);
      renders.set(document.name, {
        name: document.name,
        html: readFileSync(htmlPath, 'utf8'),
        verbatimBlocks: readVerbatimBlocks(manifestPath),
      });
      cpSync(htmlPath, path.join(REFERENCE_TOOLCHAIN_DIR, `${document.name}.html`));
      cpSync(manifestPath, path.join(REFERENCE_TOOLCHAIN_DIR, `${document.name}.json`));
    }
    return renders;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Block styles the preview draws as a diagram instead of showing as a listing.
 *
 * App policy, restated here because the reference toolchain has no opinion about it: with no diagram
 * extension loaded it renders every one of these as an ordinary listing block. `plantuml` and `ditaa`
 * are deliberately absent — the preview has no offline renderer for them and leaves them as listings,
 * so canonicalising them here would manufacture a difference where the two sides agree.
 *
 * Keyed by the declared style, valued by the type the preview reports. `vega-lite` maps to `vegalite`
 * because the preview normalises the name it dispatches on; without the mapping the canonical node
 * would carry a different type on each side and the comparison would fail on a rename that is not one.
 */
const DIAGRAM_TYPE_BY_STYLE: Readonly<Record<string, string>> = {
  mermaid: 'mermaid',
  graphviz: 'graphviz',
  vega: 'vega',
  vegalite: 'vegalite',
  'vega-lite': 'vegalite',
};

/**
 * The canonical diagram type for a declared block style, or `null` when the style is not one the
 * preview draws.
 */
export function canonicalDiagramType(style: string): string | null {
  return DIAGRAM_TYPE_BY_STYLE[style.toLowerCase()] ?? null;
}

/** The declared type and source of one diagram, in document order, as the reference parsed it. */
export interface ReferenceDiagram {
  /** The block's index among the reference document's verbatim blocks, which is how it is located. */
  readonly blockIndex: number;
  readonly type: string;
}

/** The diagrams in a reference render, in document order, with the index that locates each in the DOM. */
export function referenceDiagrams(render: ReferenceRender): readonly ReferenceDiagram[] {
  const diagrams: ReferenceDiagram[] = [];
  for (const [blockIndex, block] of render.verbatimBlocks.entries()) {
    const type = canonicalDiagramType(block.style);
    if (type !== null) diagrams.push({ blockIndex, type });
  }
  return diagrams;
}

/** What {@link normaliseForReferenceComparison} needs in order to reconcile the two sides. */
export interface ReferenceNormalisationInput {
  /** The HTML to normalise. */
  readonly html: string;
  /** The image endpoint base the app maps project-relative image targets onto. */
  readonly imageEndpointBase: string;
  /**
   * The reference toolchain's diagram blocks, when normalising the REFERENCE side. Empty for the app
   * side, whose diagrams are already marked in its own markup.
   */
  readonly diagrams: readonly ReferenceDiagram[];
  /**
   * Whether this side is expected to have mapped project-relative image targets onto the endpoint.
   *
   * True for the app side only. Without it the image pass would be unfalsifiable: it maps targets
   * back, so an app that stopped mapping them at all would produce output that already matches the
   * reference and the gate would report agreement. With it, an unmapped relative target is an error
   * rather than a match.
   */
  readonly mapsImagesToEndpoint: boolean;
}

/**
 * Reduce one side of the comparison to the form the two sides are compared in.
 *
 * Runs inside a real browser page (it is handed to `page.evaluate`), so it is written self-contained,
 * with no reference to anything outside its own body. A real HTML parser is the only honest way to
 * decide what markup means; hand-rolling one would make the gate's verdict a property of the parser.
 *
 * Every pass here corresponds to an enumerated divergence, and none of them is allowed to grow into
 * "ignore whatever differs". They are, in order:
 *
 *   - **strip source provenance** — `data-source-line`/`data-source-file` are the app's scroll-sync
 *     markers, added after conversion. The reference has none. They are asserted exactly by the
 *     previous-engine regression gate, which is where they belong; here they are noise.
 *   - **strip synthetic identifiers** — the app gives an id to blocks the author left unidentified so
 *     it has something to hang provenance on. Removed by their reserved prefix, so a REAL id — an
 *     author's anchor or an engine-derived one — is never touched and is compared exactly.
 *   - **unmap image endpoint targets** — the app rewrites project-relative image targets onto the
 *     authenticated image endpoint. Mapped back to project-relative, so what is compared is the
 *     target the engine resolved rather than the base the app serves it from. An app-side target that
 *     was never mapped is an ERROR rather than a match, or the pass would forgive the app dropping
 *     the rewrite entirely — it undoes the rewrite, so its absence looks like agreement.
 *   - **reduce highlighted source blocks to their code** — the app colours source blocks with
 *     highlight.js after conversion, and the two engines disagree about which highlighter is in
 *     effect at all (the corpus declares `rouge`, which the reference engine has an adapter for and
 *     the JS engine does not). Only the tokenisation and the name of the highlighter are dropped: the
 *     code's exact characters including indentation, its `data-lang`, and everything in the block
 *     that is not a token span — callout markers especially — are kept and compared.
 *   - **canonicalise diagram blocks** — the app replaces a diagram block with an inert placeholder for
 *     the main thread to draw; the reference, having no diagram extension, renders it as a listing.
 *     Both become `<adc-diagram type="TYPE">SOURCE</adc-diagram>`, so a changed type or changed source
 *     fails while the wrapper each toolchain chose does not enter the comparison.
 *
 * @param input - The HTML to normalise plus what is needed to reconcile it.
 * @returns The normalised HTML.
 */
export function normaliseForReferenceComparison(input: ReferenceNormalisationInput): string {
  const parsed = new DOMParser().parseFromString(input.html, 'text/html');
  const body = parsed.body;

  // Identifiers the app mints for blocks the author did not identify, so it has somewhere to record
  // where the block came from. Their prefixes are reserved, which is what makes stripping them safe.
  const syntheticIdPrefixes = ['__src_', '__adc_diagram_'];

  const canonicalDiagram = (type: string, source: string): Element => {
    const node = parsed.createElement('adc-diagram');
    node.setAttribute('type', type);
    // Trailing whitespace carries nothing in a diagram source and neither toolchain preserves it
    // identically, so both sides drop it per line. Leading whitespace is content and is kept.
    node.textContent = source
      .split('\n')
      .map((line) => line.replace(/[\t ]+$/, ''))
      .join('\n');
    return node;
  };

  // Pass: canonicalise diagram blocks — the reference side, whose declared styles are not in its
  // markup and arrive alongside it. Located by index among the verbatim blocks, which the conversion
  // script reports in document order and which `querySelectorAll` returns in document order too.
  if (input.diagrams.length > 0) {
    const verbatimBlocks = [...body.querySelectorAll('div.listingblock, div.literalblock')];
    for (const diagram of input.diagrams) {
      const block = verbatimBlocks[diagram.blockIndex];
      if (block === undefined) {
        throw new Error(
          `the reference toolchain reported a verbatim block at index ${diagram.blockIndex} that its ` +
            `own HTML does not contain (${verbatimBlocks.length} present)`,
        );
      }
      const source = block.querySelector('pre')?.textContent ?? '';
      block.replaceWith(canonicalDiagram(diagram.type, source));
    }
  }

  // Pass: canonicalise diagram blocks — the app side, whose placeholder already carries the type it
  // dispatches on and the block's source as text.
  for (const placeholder of body.querySelectorAll<HTMLDivElement>('div.adc-diagram')) {
    placeholder.replaceWith(
      canonicalDiagram(placeholder.dataset.diagramEngine ?? '', placeholder.textContent ?? ''),
    );
  }

  // Pass: reduce highlighted source blocks to their code.
  //
  // Deliberately narrow. It does NOT flatten the block to text: the code's exact characters and
  // indentation stay, and so does everything in it that is not a token — callout markers in
  // particular, which are elements inside the code and are numbered by the engine.
  for (const pre of body.querySelectorAll('pre.highlight')) {
    // Token spans: the app's, emitted by highlight.js after conversion. Unwrapped outermost-first,
    // which also handles the nested spans highlight.js emits.
    for (const span of pre.querySelectorAll('span')) span.replaceWith(...span.childNodes);
    // Which highlighter claimed the block. The document declares `rouge`; the reference engine has a
    // rouge adapter and says so in the class list, the JS engine has none and the app colours the
    // block itself and says `hljs`. The class the two agree on (`highlight`) stays, and any OTHER
    // difference in the class list still fails.
    pre.classList.remove('hljs', 'rouge');
    for (const code of pre.querySelectorAll('code')) {
      // Asciidoctor writes the language BOTH as a class and as `data-lang` when no highlighter
      // claimed the block, and as `data-lang` alone when one did. `data-lang` is on both sides and
      // is compared; the class is the same value again, so dropping it loses nothing.
      const languageClasses = code.className.split(/\s+/).filter((name) => name.startsWith('language-'));
      for (const name of languageClasses) code.classList.remove(name);
      if (code.classList.length === 0) code.removeAttribute('class');
    }
  }

  for (const element of body.querySelectorAll('*')) {
    // Pass: strip source provenance. Removed by name from the element's own attribute list rather
    // than by a literal, so the loop states the rule once: every source-provenance marker goes.
    for (const name of element.getAttributeNames()) {
      if (name === 'data-source-line' || name === 'data-source-file') element.removeAttribute(name);
    }

    // Pass: strip synthetic identifiers.
    const identifier = element.getAttribute('id');
    if (identifier !== null && syntheticIdPrefixes.some((prefix) => identifier.startsWith(prefix))) {
      element.removeAttribute('id');
    }

    // Pass: unmap image endpoint targets. `<img src>` for a normal image, `<object data>` for an
    // interactive SVG — the two targets the app rewrites.
    for (const attribute of ['src', 'data']) {
      const target = element.getAttribute(attribute);
      if (target === null) continue;
      if (target.startsWith(`${input.imageEndpointBase}/`)) {
        element.setAttribute(attribute, target.slice(input.imageEndpointBase.length + 1));
        continue;
      }
      // A target carrying a scheme, a protocol-relative `//`, a root-absolute `/` or a fragment is
      // already fully qualified and the app leaves it alone, so it is not expected to be mapped.
      const alreadyQualified = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(target);
      if (input.mapsImagesToEndpoint && target !== '' && !alreadyQualified) {
        throw new Error(
          `the app's render leaves the project-relative image target "${target}" unmapped; it should ` +
            `be served from ${input.imageEndpointBase}`,
        );
      }
    }
  }

  return body.innerHTML;
}
