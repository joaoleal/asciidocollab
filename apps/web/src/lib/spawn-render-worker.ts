/**
 * Constructs the AsciiDoc render Web Worker, and nothing else.
 *
 * The `new Worker(new URL(path, import.meta.url))` form is what makes Next.js/webpack bundle the
 * worker entry together with its whole npm graph (Asciidoctor included) into a self-contained asset,
 * so it has to appear literally: a computed URL is not statically analysable and yields a worker that
 * fails to load at runtime.
 *
 * That one line is also why this module holds nothing else. `import.meta` cannot be parsed by the
 * commonjs test runtime, so any code sharing a file with it is untestable by construction. Isolating
 * it keeps the render-worker holder next door — where all the lifetime policy lives — loadable, and
 * lets a test replace this module wholesale to hand the holder a stand-in worker.
 */

/**
 * Start a fresh render worker.
 *
 * @returns A worker speaking the render protocol. The caller owns it and is responsible for
 * terminating it.
 */
export function spawnRenderWorker(): Worker {
  return new Worker(new URL('../workers/asciidoc-render.worker.ts', import.meta.url));
}
