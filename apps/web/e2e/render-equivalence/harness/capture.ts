/**
 * @file Renders the render-equivalence corpus through the app's OWN render path and captures the
 * result, one HTML fixture per corpus document.
 *
 * These fixtures are the reference the regression gate compares against, and they can only be taken
 * once: they must come from the engine as it is BEFORE this feature changes anything, and there is
 * exactly one moment when that is available. Everything here is arranged around that — most visibly
 * {@link writeFixture}, which refuses to overwrite a fixture that already exists, so a later run
 * cannot quietly re-baseline the gate against the very change it exists to catch.
 *
 * It drives the real worker module rather than calling Asciidoctor directly. The gate compares what
 * the app displays, and the app's output is conversion PLUS the worker's own passes — diagram
 * placeholders, image-source rewriting, syntax highlighting, source-line provenance. A capture taken
 * from raw conversion would be a reference for something the product does not render.
 *
 * It runs in Node under the Playwright runner, not under jest: the real Asciidoctor (an Opal runtime)
 * does not load under ts-jest, so a jest-hosted capture could only ever exercise a mock.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { RenderRequest, RenderResult } from '../../../src/workers/render-protocol';
import { APP_RENDER_DEFAULT_ATTRIBUTES } from '../../../src/lib/asciidoc/render-app-defaults';

/** The corpus root: every top-level `.adoc` here is one document the gates run over. */
export const CORPUS_DIR = path.join(__dirname, '..', 'corpus');

/** Where the captured previous-engine fixtures live. */
export const PREVIOUS_ENGINE_DIR = path.join(__dirname, '..', 'fixtures', 'previous-engine');

/**
 * The image endpoint base the capture renders against.
 *
 * Fixed and fictional on purpose. The real base carries a project id, so capturing with a live one
 * would bake a value that changes between environments into a committed fixture, and the image-source
 * rewrite would then "differ" on every machine but the one that captured it.
 */
export const CAPTURE_IMAGES_DIR = 'https://render-equivalence.invalid/projects/corpus/images';

/**
 * Included bodies are captured EXPANDED.
 *
 * The alternative — the preview's placeholder mode — would render the include-tree document as a
 * couple of placeholder blocks, and the coverage that document exists for (offset composition across
 * a nested include) would not appear in the fixture at all.
 */
const CAPTURE_SHOW_INCLUDES = true;

/** One corpus document: the file the gates render, named by its path relative to the corpus root. */
export interface CorpusDocument {
  /** The document's file name without its extension, used as the fixture's name. */
  readonly name: string;
  /** The path relative to the corpus root, which is also its key in the files map. */
  readonly relativePath: string;
  /** The document's source text. */
  readonly source: string;
}

/** Every `.adoc` under the corpus root, recursively, keyed by corpus-relative path. */
export function corpusFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.name.endsWith('.adoc')) {
        files[path.relative(CORPUS_DIR, absolute)] = readFileSync(absolute, 'utf8');
      }
    }
  };
  walk(CORPUS_DIR);
  return files;
}

/**
 * The corpus documents the gates run over: the top-level `.adoc` files only.
 *
 * A file under `includes/` is part of a document, not one of its own — rendering it standalone would
 * produce a fixture for something the app never displays on its own in this corpus.
 */
export function corpusDocuments(): readonly CorpusDocument[] {
  return readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith('.adoc'))
    .toSorted()
    .map((name) => ({
      name: name.slice(0, -'.adoc'.length),
      relativePath: name,
      source: readFileSync(path.join(CORPUS_DIR, name), 'utf8'),
    }));
}

/** The fixture path for a corpus document. */
export function fixturePath(documentName: string, directory: string = PREVIOUS_ENGINE_DIR): string {
  return path.join(directory, `${documentName}.html`);
}

/**
 * The render request the app would post for this document.
 *
 * Kept deliberately close to `use-asciidoc-preview`'s own request: same source-line hints, same
 * project-attribute layering, same files map for include assembly. A capture rendered under different
 * inputs is a reference for a render the product never performs.
 */
export function captureRequestFor(document: CorpusDocument, requestId: number): RenderRequest {
  return {
    requestId,
    content: document.source,
    imagesDir: CAPTURE_IMAGES_DIR,
    showIncludes: CAPTURE_SHOW_INCLUDES,
    sourceLineHints: true,
    projectAttributes: { ...APP_RENDER_DEFAULT_ATTRIBUTES },
    files: corpusFiles(),
    openFileId: document.relativePath,
  };
}

/**
 * A render driven through the worker module, exactly as the main thread drives it.
 *
 * The worker's handler is asynchronous, so posting a request only STARTS a render. The promise this
 * returns is the one the handler itself returns, which settles after the handler has called
 * `postMessage` — so awaiting it is what makes the reply readable, and reading without awaiting would
 * see the previous render's reply or none at all.
 */
type PostMessage = (request: RenderRequest) => Promise<void>;

let post: PostMessage | null = null;
let lastResult: RenderResult | null = null;

/**
 * Load the render worker with the globals it expects, once per copy of this module.
 *
 * The worker is a module that assigns `onmessage` and calls `postMessage` at global scope, so it is
 * loaded LATE, after those globals exist — a static import is hoisted above every statement here and
 * the module would find neither. It goes through `require` rather than `import()` because the runner
 * transpiles this file to CommonJS while leaving dynamic imports as real ESM, which cannot load a
 * TypeScript source file.
 */
function loadWorker(): PostMessage {
  if (post !== null) return post;

  let handler: ((event: { data: RenderRequest }) => Promise<void>) | null = null;
  Object.defineProperty(globalThis, 'onmessage', {
    set(next: (event: { data: RenderRequest }) => Promise<void>) {
      handler = next;
    },
    get() {
      return handler;
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'postMessage', {
    value: (result: RenderResult) => {
      lastResult = result;
    },
    writable: true,
    configurable: true,
  });

  // Evicted from the module cache before it is required, so the module BODY runs every time and
  // assigns `onmessage` through the accessor installed above.
  //
  // Without this the harness fails intermittently, and only ever on the first document of a file. The
  // runner gives each spec FILE a fresh registry for the files under its own test directory but not
  // for the rest of the tree, so a second render-equivalence file in the same worker process gets a
  // fresh copy of THIS module — `post` back to null — while the worker module is still cached from the
  // first file. Requiring it then re-executes nothing, no `onmessage` is assigned, and the registration
  // check below fires. Whether that happens depends on how the runner distributed the files, which is
  // why it looked like a flake. Re-executing is also what the harness wants on its own terms: the
  // worker keeps module-level state (its render ordinal, its registered grammars), and each file's
  // renders should start from the same place rather than from wherever the previous file left it.
  const requireWorker = createRequire(__filename);
  const workerModule = requireWorker.resolve('../../../src/workers/asciidoc-render.worker');
  delete requireWorker.cache[workerModule];
  requireWorker(workerModule);
  // Read through a call rather than the variable. Both `handler` and `lastResult` are written from
  // inside a property descriptor the worker triggers, which the compiler cannot see: reading them
  // directly, it narrows each to the `null` it was last assigned here and rejects every later use.
  const registered = readHandler();
  if (registered === null) {
    throw new Error('the render worker registered no message handler');
  }
  post = (request) => registered({ data: request });
  return post;

  function readHandler(): ((event: { data: RenderRequest }) => Promise<void>) | null {
    return handler;
  }
}

/** The worker's most recent reply, read through a call so the compiler does not narrow it away. */
function readLastResult(): RenderResult | null {
  return lastResult;
}

/**
 * Render one corpus document through the app's render path.
 *
 * @param document - The corpus document to render.
 * @param requestId - The request id to tag the render with. The worker echoes it, and the echo is
 *   checked: it is what says this reply answers this request rather than being the previous render's,
 *   which is the single-slot race the callers are ordered to avoid.
 * @returns The rendered (unsanitised) HTML, once the render has finished. One document at a time: the
 *   worker's reply is read from a single slot, so two renders started concurrently would race for it.
 *   Every gate awaits each document before starting the next.
 * @throws {Error} When the render fails — a corpus document that does not render is a broken corpus, and
 *   capturing a failure as though it were a reference would make the gate assert against nothing.
 */
export async function renderCorpusDocument(document: CorpusDocument, requestId = 1): Promise<string> {
  const send = loadWorker();
  lastResult = null;
  await send(captureRequestFor(document, requestId));
  const result = readLastResult();
  if (result === null) {
    throw new Error(`the render worker returned nothing for ${document.relativePath}`);
  }
  if (result.requestId !== requestId) {
    throw new Error(
      `the render worker answered request ${requestId} for ${document.relativePath} with a reply ` +
        `tagged ${result.requestId}, so this is not that render's output.`,
    );
  }
  if (!result.ok || result.html === null) {
    throw new Error(`${document.relativePath} failed to render: ${result.error ?? 'no reason given'}`);
  }
  return result.html;
}

/**
 * Write one captured fixture, refusing to overwrite an existing one.
 *
 * The refusal is the point. These fixtures record how the engine behaved BEFORE this feature touched
 * it; a re-run that silently rewrote them would replace the reference with the output it is supposed
 * to be judged against, and the gate would pass by definition. Deleting a fixture on purpose is a
 * visible act; overwriting one by accident is not.
 *
 * @param documentName - The corpus document's name.
 * @param html - The captured HTML.
 * @param directory - Where to write; defaults to the previous-engine fixture directory.
 * @returns The path written.
 */
export function writeFixture(
  documentName: string,
  html: string,
  directory: string = PREVIOUS_ENGINE_DIR,
): string {
  const target = fixturePath(documentName, directory);
  if (existsSync(target)) {
    throw new Error(
      `${target} already exists. Captured fixtures record the engine as it was before this feature ` +
        'changed it; overwriting one replaces the reference with the thing being tested. Delete it ' +
        'deliberately if you really mean to re-capture.',
    );
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(target, html.endsWith('\n') ? html : `${html}\n`, 'utf8');
  return target;
}

/** Read a previously captured fixture, or `null` when none exists. */
export function readFixture(documentName: string, directory: string = PREVIOUS_ENGINE_DIR): string | null {
  const target = fixturePath(documentName, directory);
  return existsSync(target) ? readFileSync(target, 'utf8') : null;
}
