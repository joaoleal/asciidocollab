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
   * Called for every reply to a render THIS consumer posted, a failed render included.
   *
   * Which consumer a reply belongs to is settled before it gets here, by the routing token the holder
   * puts on every request — see {@link nextRenderId}. A consumer still has to discard replies to its
   * OWN superseded renders, which is a different question and one only it can answer.
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

/** What a call to {@link RenderWorkerHandle.retry} actually did. */
export interface RetryOutcome {
  /**
   * Whether an engine was started because of this call.
   *
   * False whenever the call did nothing: the engine was never down, or this share has been released.
   * A caller showing a failure notice should leave it up in that case — nothing has changed.
   */
  readonly rebuilt: boolean;
  /**
   * Whether a render OF THIS CONSUMER'S went back out with the new engine, so a reply is coming here.
   *
   * False when there was nothing outstanding to replay, and false when the replayed render belongs to
   * another consumer. A caller that assumed a reply in either case would wait on one for the rest of
   * the session — and this is independent of {@link RetryOutcome.rebuilt}: an engine that came back
   * with nothing to catch up on is the ordinary case for a document nobody has rendered yet.
   */
  readonly replayed: boolean;
}

/** Nothing happened: no engine was started, and no render went out. */
const RETRY_DID_NOTHING: RetryOutcome = { rebuilt: false, replayed: false };

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
   *
   * @returns What the call did — see {@link RetryOutcome}. The two facts are reported separately
   *   because a caller needs both and they do not follow from each other: a retry can bring the engine
   *   back with nothing of this consumer's to replay.
   */
  retry: () => RetryOutcome;
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
/**
 * How many times the engine has died IN A ROW, with nothing to show for itself in between.
 *
 * Consecutive, not cumulative, and the distinction is the whole of what the budget means. What must
 * not be allowed is a document that kills every engine it is handed to spinning in a rebuild loop;
 * unrelated one-off losses spread across a long session are not that, and counting them together
 * would eventually disable the preview of a perfectly healthy editor that had simply been left open
 * long enough. A reply from the live worker is the engine saying it is alive, and clears this.
 */
let rebuildCount = 0;
let lastRequest: RenderRequest | null = null;
/**
 * Whose render {@link lastRequest} is, so that it is replayed only while that consumer is still there
 * to receive the reply, and so a reply to it is delivered to them rather than to whoever is around.
 */
let lastRequestOwner: RenderWorkerHandlers | null = null;
let holderState: HolderState = 'idle';
const consumers = new Set<RenderWorkerHandlers>();

/**
 * The routing token the next render goes out under, unique across every consumer for the life of the
 * page.
 *
 * A consumer's own request ids restart at 1 for each consumer, so two of them routinely have a render
 * numbered 1 outstanding at once and the id on a reply cannot say whose it is. Posted order used to
 * answer that — one worker, one queue, answered in the order it was asked — and it no longer does:
 * the worker's handler is asynchronous, so a short document posted second can be answered before a
 * long one posted first, as the worker's own comment says. An overtaking reply routed by order would
 * be handed to the consumer that asked first, whose staleness guard would see an id from its own
 * numbering and let another file's document onto the screen.
 *
 * A token of the holder's own settles it without either end giving up its numbering: the worker
 * echoes it back untouched, and the reply the consumer receives is the one the worker sent.
 */
let nextRenderId = 1;

/** A render the live worker has been handed and has not yet answered, and the consumer waiting on it. */
interface OutstandingRender {
  /** The consumer that posted it, which is the one its reply belongs to. */
  handlers: RenderWorkerHandlers;
}

/**
 * Renders handed to the live worker and not yet answered, by the token each went out under.
 *
 * Entries of a consumer that has since released are deliberately kept rather than purged. They are
 * what a reply to a departed consumer's render lands on, and dropping it there is the whole point of
 * keeping them.
 */
let outstanding = new Map<number, OutstandingRender>();

/**
 * Take the entry a reply answers off the queue.
 *
 * @param renderId - The routing token the reply carries, or undefined when it carries none.
 * @returns Who asked for it, or null when nothing outstanding matches — which happens for a reply from
 *   a worker already replaced, and in no other ordinary case.
 */
function claimOutstanding(renderId: number | undefined): OutstandingRender | null {
  if (renderId === undefined) return null;
  const claimed = outstanding.get(renderId);
  if (claimed === undefined) return null;
  outstanding.delete(renderId);
  return claimed;
}

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
    // That same reasoning is what ends the run of deaths the rebuild budget counts: this engine read
    // a document and answered, whatever it thought of it, so whatever killed its predecessors is not
    // killing it. Only a reply from the CURRENT worker counts — one queued by a worker already
    // replaced says nothing about the successor, and would hand it a budget it has not earned.
    if (worker === started) rebuildCount = 0;

    // Nothing outstanding claims this reply: it answers a render of a worker already replaced, whose
    // queue was emptied when it went. There is no consumer it can be said to belong to, so it is
    // dropped. Handed to everyone instead — as it was while posted order was what identified a render
    // — it would reach consumers who never asked for it, and a request id that happened to match one
    // of theirs would pass the only guard they have.
    const asked = claimOutstanding(event.data.renderId);
    if (asked === null) return;

    // Answer whoever asked, and only them. A consumer that has released hears nothing — its share is
    // gone, and handing its reply to whoever holds the engine now is how another file's document ends
    // up on screen.
    if (consumers.has(asked.handlers)) asked.handlers.onMessage(event);
  });
  started.addEventListener('error', () => {
    superviseDeath(started);
  });
  return started;
}

/**
 * Hand a render to a worker under a routing token of the holder's own, and record who is waiting on it.
 *
 * @param engine - The live engine this render is handed to, which may be one just rebuilt.
 * @param request - The render, in the consumer's own numbering.
 * @param handlers - The consumer waiting for the reply.
 */
function postToWorker(engine: Worker, request: RenderRequest, handlers: RenderWorkerHandlers): void {
  const renderId = nextRenderId;
  nextRenderId += 1;
  outstanding.set(renderId, { handlers });
  engine.postMessage({ ...request, renderId } satisfies RenderRequest);
}

/** Replace the worker with a fresh one and replay whatever render was outstanding. */
function rebuild(): void {
  holderState = 'rebuilding';
  worker?.terminate();
  const replacement = startSupervisedWorker();
  worker = replacement;
  holderState = consumerCount > 0 ? 'alive' : 'retained';
  // Every render the dead worker was carrying died with it, so nothing is waiting on the replacement
  // yet. Anything left in the queue would only be there to mis-claim a later reply.
  outstanding = new Map();
  // Replaying means the preview recovers on its own. Waiting for the next keystroke would leave the
  // author looking at a panel that is stuck for no visible reason.
  if (lastRequest !== null && lastRequestOwner !== null) {
    postToWorker(replacement, lastRequest, lastRequestOwner);
  }
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
  lastRequestOwner = null;
  outstanding = new Map();
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
      lastRequestOwner = handlers;
      const engine = worker;
      // With no engine there is nothing to wait on, so nothing goes on the queue — an entry no reply
      // will ever claim would sit there waiting to absorb a later reply that is not it. The request is
      // still remembered above, because a retry replays it.
      if (engine === null) return;
      postToWorker(engine, request, handlers);
    },
    release: () => {
      if (!held) return;
      held = false;
      consumers.delete(handlers);
      consumerCount -= 1;
      if (lastRequestOwner === handlers) {
        // A departing consumer's render is nobody's to replay. Left standing it would be re-posted
        // into an engine rebuild long after the panel that wanted it had gone, and the reply handed
        // to whoever holds the engine by then — another file's document, arriving unbidden.
        lastRequest = null;
        lastRequestOwner = null;
      }
      // Zero consumers starts a clock, never a shutdown.
      if (consumerCount === 0) armIdleRelease();
    },
    retry: () => {
      // A share that has been given up must not start an engine: nothing would hold the result, and
      // no later release would ever clean it up.
      if (!held) return RETRY_DID_NOTHING;
      // Nor may a retry disturb an engine that is working. The only state it answers is the one
      // `onEngineFailed` reports, and outside that state rebuilding is strictly destructive: the
      // worker is terminated mid-render, and the reply it would have sent is one EVERY consumer is
      // waiting on, so each of them is left holding a render that can never report back. The
      // openings are ordinary — a retry pressed twice, or pressed on a notice still on screen after
      // another consumer's retry already brought the engine back.
      if (holderState !== 'failed') return RETRY_DID_NOTHING;
      rebuildCount = 0;
      const replayed = lastRequest !== null && lastRequestOwner === handlers;
      rebuild();
      return { rebuilt: true, replayed };
    },
  };
}
