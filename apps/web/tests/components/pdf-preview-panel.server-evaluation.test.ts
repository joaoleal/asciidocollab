/* @jest-environment node */
/*
 * Server evaluation of the client modules that reach the PDF preview.
 *
 * `"use client"` says where a component's INTERACTIVITY runs; it does not keep the module off the
 * server. Next.js still evaluates every client module in Node to server-render the page, so anything
 * a client module touches at module scope has to survive a context with no DOM. pdf.js does not:
 * `pdfjs-dist@6.2.108` builds `const SCALE_MATRIX = new DOMMatrix()` while `src/display/canvas.js`
 * is being evaluated, and `DOMMatrix` does not exist in Node. A top-level value import of it therefore
 * took down the whole project editor page — a full-screen `DOMMatrix is not defined` overlay in dev —
 * before a single line of it reached a browser.
 *
 * This suite is the SSR context itself rather than an assertion about import syntax: it runs under the
 * `node` environment (no `window`, no `document`, no `DOMMatrix`) and simply evaluates the modules. A
 * re-introduced top-level value import of any browser-only dependency anywhere in these graphs fails
 * here for exactly the reason it would fail a page load. Because it evaluates the whole graph rather
 * than one file's imports, it also covers the case a per-consumer fix cannot: a browser-only dependency
 * pulled in by some other module the page reaches.
 *
 * One caveat on the failure TEXT, so a future reader is not confused by it. Restoring the value import
 * was measured to fail all three cases below, but reported as
 * `SyntaxError: Cannot use 'import.meta' outside a module` from `pdfjs-dist/build/pdf.mjs`, not as
 * `DOMMatrix is not defined`: jest's commonjs runtime rejects the ESM browser build while parsing it
 * and never reaches the line that builds the matrix. Real Node — `node --input-type=module -e
 * "import('pdfjs-dist')"` — reports `DOMMatrix is not defined`, which is what Next's server shows. The
 * two are the same fact stated by different loaders (the browser build cannot be evaluated off the
 * browser), so the assertions below deliberately assert that the module LOADS rather than matching a
 * message that depends on which runtime is doing the loading.
 */

// The three worker-factory modules, and ONLY those three.
//
// Each is a one-line `new Worker(new URL('…', import.meta.url))`, which the bundler rewrites into a
// worker entry. `import.meta` is legal ESM and Next evaluates these modules on the server without
// complaint; it is jest's commonjs runtime that cannot parse it, which is why the jest config already
// excludes exactly this set from coverage as "unloadable under the commonjs transform". Stubbing them
// removes a runtime limitation from the graph without removing anything the server actually runs — and
// it is deliberately a NAMED list rather than a blanket `@/lib/*` stub, so a browser-only dependency
// added anywhere else still has to survive the evaluation below.
jest.mock('@/lib/create-pdf-worker', () => ({ createPdfWorker: jest.fn() }));
jest.mock('@/lib/create-harper-worker', () => ({ createHarperEngine: jest.fn() }));
jest.mock('@/lib/spawn-render-worker', () => ({ spawnRenderWorker: jest.fn() }));

// Guard the guard: if the environment this runs in HAS a DOM, the evaluations below prove nothing.
describe('the DOM-less server context these evaluations model', () => {
  it('has no DOMMatrix, window or document', () => {
    expect(typeof globalThis.DOMMatrix).toBe('undefined');
    expect((globalThis as { window?: unknown }).window).toBeUndefined();
    expect((globalThis as { document?: unknown }).document).toBeUndefined();
  });
});

describe('client modules reachable from a server-rendered page', () => {
  it('evaluates the PDF preview panel without a DOM', async () => {
    const module_ = await import('@/components/pdf-preview-panel');
    expect(typeof module_.PdfPreviewPanel).toBe('function');
  });

  it('evaluates the theme editor without a DOM', async () => {
    const module_ = await import('@/components/theme-editor/theme-editor');
    expect(typeof module_.ThemeEditor).toBe('function');
  });

  it('evaluates the project editor layout without a DOM', async () => {
    const module_ = await import(
      '@/app/(dashboard)/dashboard/projects/[id]/project-editor-layout'
    );
    expect(typeof module_.ProjectEditorLayout).toBe('function');
  });
});
