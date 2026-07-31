/**
 * The application's single AsciiDoc render worker, shared between consumers and supervised when it
 * dies.
 *
 * The engine behind the worker is expensive to start, and the preview panel that uses it is mounted
 * and unmounted constantly: opening another file, switching between the web-formatted and
 * page-formatted previews, collapsing the panel. A worker owned by the component paid that start-up
 * cost again on every one of those, which is the whole reason the worker is held here, outside React,
 * instead of by whichever component happens to want it.
 *
 * Ownership is by counted share rather than by component: a consumer acquires a share, posts renders
 * through it, and releases it when it goes away. The count reaching zero is deliberately NOT a signal
 * to shut the worker down — see {@link RENDER_WORKER_IDLE_RETENTION_MS} for why that reads backwards
 * and is not.
 */
import { MAX_ENGINE_REBUILDS, RENDER_WORKER_IDLE_RETENTION_MS } from '@/lib/editor-config';
import { spawnRenderWorker } from '@/lib/spawn-render-worker';
import type { RenderRequest, RenderResult } from '@/workers/render-protocol';

/** What a consumer wants to hear about while it holds a share of the render worker. */
export interface RenderWorkerHandlers {
  /**
   * Called for every reply the worker posts, a failed render included.
   *
   * Replies are broadcast to all current consumers, because the worker answers one queue and cannot
   * say which consumer asked. Deciding that a reply is not yours is the consumer's job, which it
   * already does by matching the request id it sent.
   *
   * @param event - The worker's reply, carrying one render result.
   */
  onMessage: (event: MessageEvent<RenderResult>) => void;
  /**
   * Called when the engine has died more times in a row than is worth rebuilding automatically, and
   * will not be rebuilt again until someone asks for it through {@link RenderWorkerHandle.retry}.
   */
  onEngineFailed: () => void;
}

/** One consumer's share of the shared render worker. */
export interface RenderWorkerHandle {
  /**
   * Send a render to the worker. The request is also remembered as the one to replay if the worker
   * has to be rebuilt, so a crash costs a restart rather than a stale preview.
   *
   * @param request - The render to run.
   */
  post: (request: RenderRequest) => void;
  /**
   * Give up this share. Safe to call more than once; only the first call counts, so a cleanup that
   * runs twice cannot evict a consumer that is still there.
   */
  release: () => void;
  /**
   * Rebuild the engine at the author's request, restoring the automatic-rebuild budget. This is the
   * way out of the state {@link RenderWorkerHandlers.onEngineFailed} reports.
   */
  retry: () => void;
}

/**
 * Where the shared worker stands.
 *
 * `retained` is the interesting one: nobody is holding the worker, but it is alive and waiting to be
 * picked up again. `failed` means the rebuild budget ran out and only a deliberate retry will start
 * another engine.
 */
type HolderState = 'idle' | 'alive' | 'retained' | 'rebuilding' | 'failed';

let worker: Worker | null = null;
let consumerCount = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let rebuildCount = 0;
let lastRequest: RenderRequest | null = null;
let holderState: HolderState = 'idle';
const consumers = new Set<RenderWorkerHandlers>();

/**
 * Start a worker and subscribe to both of the things it can tell us.
 *
 * @returns The newly started worker, already wired to the current consumers.
 */
function startSupervisedWorker(): Worker {
  const started = spawnRenderWorker();
  started.addEventListener('message', (event: MessageEvent<RenderResult>) => {
    // A reply saying the render failed is an ordinary reply: the document did not convert, and the
    // engine that read it is in perfect health. Only the error channel below means the engine is
    // gone. Treating the two alike would either tear down a working worker over a syntax error, or
    // leave a dead one in place for the rest of the session.
    //
    // Iterating the live set is safe: a consumer that releases while this runs is simply skipped,
    // which is the behaviour wanted anyway.
    for (const consumer of consumers) consumer.onMessage(event);
  });
  started.addEventListener('error', () => {
    superviseDeath(started);
  });
  return started;
}

/** Replace the worker with a fresh one and replay whatever render was outstanding. */
function rebuild(): void {
  holderState = 'rebuilding';
  worker?.terminate();
  const replacement = startSupervisedWorker();
  worker = replacement;
  holderState = consumerCount > 0 ? 'alive' : 'retained';
  // Replaying means the preview recovers on its own. Waiting for the next keystroke would leave the
  // author looking at a panel that is stuck for no visible reason.
  if (lastRequest !== null) replacement.postMessage(lastRequest);
}

/**
 * React to a worker reporting that it has died.
 *
 * @param dead - The worker the report came from.
 */
function superviseDeath(dead: Worker): void {
  const current = worker;
  // A worker we have already replaced or torn down can still deliver a queued error. Acting on it
  // would throw away the healthy successor that took its place.
  if (current === null || current !== dead) return;

  current.terminate();
  worker = null;

  if (rebuildCount >= MAX_ENGINE_REBUILDS) {
    holderState = 'failed';
    for (const consumer of consumers) consumer.onEngineFailed();
    return;
  }

  rebuildCount += 1;
  rebuild();
}

/** Terminate the retained worker and return the holder to its starting state. */
function releaseRetainedWorker(): void {
  idleTimer = null;
  worker?.terminate();
  worker = null;
  lastRequest = null;
  // The next consumer starts a genuinely new engine, so it deserves the full rebuild budget rather
  // than inheriting the tally of a document that is no longer open.
  rebuildCount = 0;
  holderState = 'idle';
}

/** Start the clock that ends the worker's life if nobody claims it again. */
function armIdleRelease(): void {
  // Nothing to retain, which here means the engine has already given up. Leaving that state alone is
  // the point: consumers coming and going is not the evidence that would justify trying again, so the
  // next one to arrive is told the engine is down and can ask for a retry, exactly as this one could.
  if (worker === null) return;
  holderState = 'retained';
  idleTimer = setTimeout(releaseRetainedWorker, RENDER_WORKER_IDLE_RETENTION_MS);
}

/**
 * Take a share of the shared render worker, starting it if it is not already running.
 *
 * @param handlers - What to call when the worker replies, and when the engine gives up.
 * @returns The consumer's share, which it must release when it goes away.
 */
export function acquireRenderWorker(handlers: RenderWorkerHandlers): RenderWorkerHandle {
  // Whatever the previous consumer's departure set in motion, someone wants the worker again.
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  consumerCount += 1;
  consumers.add(handlers);

  if (holderState === 'failed') {
    // The engine is down pending a deliberate retry, and this consumer was not around to hear it.
    // Telling it now is what puts the retry within the author's reach; staying quiet would leave a
    // reopened panel waiting on a render that is never coming.
    handlers.onEngineFailed();
  } else {
    if (worker === null) worker = startSupervisedWorker();
    holderState = 'alive';
  }

  let held = true;

  return {
    post: (request: RenderRequest) => {
      lastRequest = request;
      worker?.postMessage(request);
    },
    release: () => {
      if (!held) return;
      held = false;
      consumers.delete(handlers);
      consumerCount -= 1;
      // Zero consumers starts a clock, never a shutdown.
      if (consumerCount === 0) armIdleRelease();
    },
    retry: () => {
      // A share that has been given up must not start an engine: nothing would hold the result, and
      // no later release would ever clean it up.
      if (!held) return;
      rebuildCount = 0;
      rebuild();
    },
  };
}
