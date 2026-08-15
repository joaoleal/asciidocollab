import { MAX_ENGINE_REBUILDS, RENDER_WORKER_IDLE_RETENTION_MS } from '@/lib/editor-config';
import type { RenderRequest, RenderResult } from '@/workers/render-protocol';

// The holder reads nothing off an error event, and only `data` off a message, so the stand-in's
// listeners take at most that much.
type MockWorkerListener = (event?: { data: RenderResult }) => void;

// A stand-in for the render worker. The real one is spawned by a single-line module that the
// commonjs test runtime cannot even parse (`import.meta.url`), so that module is replaced wholesale
// below and every lifetime decision the holder makes is observed on these fakes instead.
class MockRenderWorker {
  readonly posted: RenderRequest[] = [];
  terminated = false;
  private readonly messageListeners: MockWorkerListener[] = [];
  private readonly errorListeners: MockWorkerListener[] = [];

  addEventListener(type: string, listener: MockWorkerListener): void {
    const listeners = type === 'message' ? this.messageListeners : this.errorListeners;
    listeners.push(listener);
  }

  postMessage(request: RenderRequest): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Deliver a result to the holder, the way the real worker replies to a render. */
  deliver(result: RenderResult): void {
    for (const listener of this.messageListeners) listener({ data: result });
  }

  /** Report that the worker itself has gone — a crash or a reclaim, not a failed render. */
  die(): void {
    for (const listener of this.errorListeners) listener();
  }
}

const mockWorkers: MockRenderWorker[] = [];

jest.mock('@/lib/spawn-render-worker', () => ({
  spawnRenderWorker: jest.fn(() => {
    const created = new MockRenderWorker();
    mockWorkers.push(created);
    return created;
  }),
}));

/** The most recently spawned fake worker. */
function newestWorker(): MockRenderWorker {
  const newest = mockWorkers.at(-1);
  if (newest === undefined) throw new Error('no worker has been spawned');
  return newest;
}

function renderRequest(requestId: number): RenderRequest {
  return { requestId, content: `= Document ${requestId}` };
}

function successfulResult(renderId: number): RenderResult {
  return { requestId: 1, renderId, ok: true, html: '<p>rendered</p>', error: null };
}

function failedResult(renderId: number): RenderResult {
  return { requestId: 1, renderId, ok: false, html: null, error: 'unterminated block' };
}

function stubHandlers() {
  return { onMessage: jest.fn(), onEngineFailed: jest.fn() };
}

/**
 * What the worker was asked to render, ignoring the id it was addressed under.
 *
 * Every request also carries a routing token of the holder's own, because a consumer's ids restart at
 * 1 per consumer and so cannot say whose reply is whose on a worker they share. The document is the
 * part a test means when it asks what was posted; the token is read back with {@link renderIdOf}.
 */
function postedDocuments(worker: MockRenderWorker): string[] {
  return worker.posted.map((request) => request.content);
}

/**
 * The routing token the holder put on a posted render, which is what its reply must carry back.
 *
 * @param worker - The worker the render was handed to.
 * @param index - Which of that worker's posted renders, oldest first.
 */
function renderIdOf(worker: MockRenderWorker, index = 0): number {
  const posted = worker.posted[index];
  if (posted?.renderId === undefined) throw new Error(`no render was posted at index ${index}`);
  return posted.renderId;
}

describe('shared render worker holder', () => {
  let holder: typeof import('@/lib/create-render-worker');

  beforeEach(async () => {
    // The holder keeps its worker in module scope, so every test needs a fresh module registry.
    jest.resetModules();
    mockWorkers.length = 0;
    holder = await import('@/lib/create-render-worker');
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('serves every consumer from one worker and keeps it while any consumer remains', () => {
    const first = stubHandlers();
    const second = stubHandlers();

    const firstHandle = holder.acquireRenderWorker(first);
    const secondHandle = holder.acquireRenderWorker(second);

    expect(mockWorkers).toHaveLength(1);

    // One worker, but each reply goes to whoever asked for it. Both of these renders are numbered 1 —
    // the ids are each consumer's own — so the holder addresses them apart on the wire.
    firstHandle.post(renderRequest(1));
    secondHandle.post(renderRequest(1));

    newestWorker().deliver(successfulResult(renderIdOf(newestWorker(), 0)));
    expect(first.onMessage).toHaveBeenCalledTimes(1);
    expect(second.onMessage).not.toHaveBeenCalled();

    newestWorker().deliver(successfulResult(renderIdOf(newestWorker(), 1)));
    expect(second.onMessage).toHaveBeenCalledTimes(1);
    expect(first.onMessage).toHaveBeenCalledTimes(1);

    // Both renders still went out under the id their consumer gave them — the routing token is added
    // beside it, not in place of it, so the staleness guard each consumer runs on the reply is
    // comparing the ids it has always compared.
    expect(newestWorker().posted.map((request) => request.requestId)).toEqual([1, 1]);

    // And each says WHOSE it is, which the routing token above cannot: that names one render, while
    // the worker also has to know which renders belong to one stream, so that a preview's own newer
    // keystroke is the only thing that supersedes it. Counted across the page instead, either
    // panel's render silenced the other's on-demand grammar fetches, and the silenced consumer
    // accepted the reply because its own `requestId` still matched.
    const [firstConsumer, secondConsumer] = newestWorker().posted.map((request) => request.consumerId);
    expect(firstConsumer).toBeDefined();
    expect(secondConsumer).toBeDefined();
    expect(firstConsumer).not.toBe(secondConsumer);
    // A consumer's renders all name the same stream, whatever their own numbering does.
    firstHandle.post(renderRequest(2));
    expect(newestWorker().posted.at(-1)?.consumerId).toBe(firstConsumer);

    // One consumer leaving is not "nobody is using this": the count still stands at one.
    firstHandle.release();
    jest.advanceTimersByTime(RENDER_WORKER_IDLE_RETENTION_MS * 2);
    expect(newestWorker().terminated).toBe(false);
    expect(mockWorkers).toHaveLength(1);
  });

  it('answers the right consumer when the worker replies out of the order it was asked', () => {
    const first = stubHandlers();
    const second = stubHandlers();
    const firstHandle = holder.acquireRenderWorker(first);
    const secondHandle = holder.acquireRenderWorker(second);

    // Both renders are numbered 1, as two consumers' renders routinely are.
    firstHandle.post(renderRequest(1));
    secondHandle.post(renderRequest(1));

    // The worker's handler is asynchronous, so a render posted second can finish first — a short
    // document overtaking a long one is the ordinary way this happens. Identified by posted order,
    // this reply would go to the consumer that asked FIRST, carrying an id that consumer recognises
    // as its own: another file's document on screen, past the only guard it has.
    newestWorker().deliver(successfulResult(renderIdOf(newestWorker(), 1)));

    expect(second.onMessage).toHaveBeenCalledTimes(1);
    expect(first.onMessage).not.toHaveBeenCalled();

    newestWorker().deliver(successfulResult(renderIdOf(newestWorker(), 0)));
    expect(first.onMessage).toHaveBeenCalledTimes(1);
  });

  it('retains the worker when the last consumer leaves and hands the same one back inside the window', () => {
    const handle = holder.acquireRenderWorker(stubHandlers());
    const spawned = newestWorker();

    handle.release();
    expect(spawned.terminated).toBe(false);

    // Nearly the whole window passes with nobody holding it — still alive, still the same worker.
    jest.advanceTimersByTime(RENDER_WORKER_IDLE_RETENTION_MS - 1);
    holder.acquireRenderWorker(stubHandlers());
    expect(mockWorkers).toHaveLength(1);
    expect(spawned.terminated).toBe(false);

    // Acquiring cancelled the pending release rather than merely postponing the observation: long
    // past the original deadline, the worker the second consumer holds is untouched.
    jest.advanceTimersByTime(RENDER_WORKER_IDLE_RETENTION_MS * 2);
    expect(spawned.terminated).toBe(false);
  });

  it('terminates the retained worker when nobody re-acquires before the window elapses', () => {
    const handle = holder.acquireRenderWorker(stubHandlers());
    const spawned = newestWorker();

    handle.release();
    jest.advanceTimersByTime(RENDER_WORKER_IDLE_RETENTION_MS - 1);
    expect(spawned.terminated).toBe(false);

    jest.advanceTimersByTime(1);
    expect(spawned.terminated).toBe(true);

    // The next consumer pays for a fresh engine, because there is nothing left to reuse.
    holder.acquireRenderWorker(stubHandlers());
    expect(mockWorkers).toHaveLength(2);
  });

  it('rebuilds a retained worker that dies before anyone claims it again', () => {
    const handle = holder.acquireRenderWorker(stubHandlers());
    handle.post(renderRequest(2));
    handle.release();

    newestWorker().die();

    // The promise the retention window makes is a warm engine on the way back, so a crash inside the
    // window is repaired rather than left for the returning consumer to discover.
    expect(mockWorkers).toHaveLength(2);
    holder.acquireRenderWorker(stubHandlers());
    expect(mockWorkers).toHaveLength(2);
    expect(newestWorker().terminated).toBe(false);
  });

  it('leaves the worker in place when a render fails', () => {
    const handlers = stubHandlers();
    const handle = holder.acquireRenderWorker(handlers);
    const spawned = newestWorker();
    handle.post(renderRequest(1));

    spawned.deliver(failedResult(renderIdOf(spawned)));

    // A document that does not convert says nothing about the health of the engine that read it.
    expect(handlers.onMessage).toHaveBeenCalledTimes(1);
    expect(handlers.onEngineFailed).not.toHaveBeenCalled();
    expect(spawned.terminated).toBe(false);
    expect(mockWorkers).toHaveLength(1);
  });

  it('rebuilds a worker that dies and re-issues the render it was carrying', () => {
    const handlers = stubHandlers();
    const handle = holder.acquireRenderWorker(handlers);
    const first = newestWorker();

    handle.post(renderRequest(7));
    expect(postedDocuments(first)).toEqual([renderRequest(7).content]);

    first.die();

    expect(mockWorkers).toHaveLength(2);
    expect(newestWorker()).not.toBe(first);
    expect(postedDocuments(newestWorker())).toEqual([renderRequest(7).content]);
    expect(handlers.onEngineFailed).not.toHaveBeenCalled();

    // The replacement is wired up: its replies reach the consumer that never knew anything happened.
    newestWorker().deliver(successfulResult(renderIdOf(newestWorker())));
    expect(handlers.onMessage).toHaveBeenCalledTimes(1);

    // A second report from the worker already replaced — an error queued before it was torn down —
    // must not throw the healthy successor away with it.
    first.die();
    expect(mockWorkers).toHaveLength(2);
  });

  it('stops rebuilding and reports the engine failed once the rebuild bound is exhausted', () => {
    const handlers = stubHandlers();
    holder.acquireRenderWorker(handlers);

    for (let death = 0; death < MAX_ENGINE_REBUILDS; death += 1) {
      newestWorker().die();
    }
    // Every death so far was answered with a replacement, and nobody has been told anything is wrong.
    expect(mockWorkers).toHaveLength(MAX_ENGINE_REBUILDS + 1);
    expect(handlers.onEngineFailed).not.toHaveBeenCalled();

    newestWorker().die();

    // A document that kills the engine every time must not spin in a rebuild loop.
    expect(mockWorkers).toHaveLength(MAX_ENGINE_REBUILDS + 1);
    expect(handlers.onEngineFailed).toHaveBeenCalledTimes(1);

    // A late report from the worker already given up on says nothing new.
    newestWorker().die();
    expect(mockWorkers).toHaveLength(MAX_ENGINE_REBUILDS + 1);
    expect(handlers.onEngineFailed).toHaveBeenCalledTimes(1);
  });

  it('keeps rebuilding after unrelated one-off losses, because the budget counts deaths in a row', () => {
    const handlers = stubHandlers();
    const handle = holder.acquireRenderWorker(handlers);
    handle.post(renderRequest(5));

    // Losses spread across a long session — the browser reclaiming a worker under memory pressure,
    // say — each followed by an engine that then rendered perfectly well. There are more of them than
    // the budget allows, and that must not matter: the budget exists to stop a document that kills
    // the engine EVERY time from spinning in a rebuild loop, and a reply is the engine saying it is
    // alive. Counted cumulatively, a session long enough would eventually disable the preview over
    // deaths that had nothing to do with each other.
    for (let loss = 0; loss < MAX_ENGINE_REBUILDS + 2; loss += 1) {
      newestWorker().die();
      newestWorker().deliver(successfulResult(renderIdOf(newestWorker())));
    }

    expect(handlers.onEngineFailed).not.toHaveBeenCalled();
    expect(mockWorkers).toHaveLength(MAX_ENGINE_REBUILDS + 3);
  });

  it('counts a failed render as the engine speaking, so it too clears the rebuild tally', () => {
    const handlers = stubHandlers();
    const handle = holder.acquireRenderWorker(handlers);
    handle.post(renderRequest(6));

    // A document that does not convert is answered by an engine that read it and survived — the same
    // evidence of health a successful conversion gives, as the holder already says everywhere else.
    for (let loss = 0; loss < MAX_ENGINE_REBUILDS + 2; loss += 1) {
      newestWorker().die();
      newestWorker().deliver(failedResult(renderIdOf(newestWorker())));
    }

    expect(handlers.onEngineFailed).not.toHaveBeenCalled();
  });

  it('still gives up on a document that kills every engine it is handed to', () => {
    const handlers = stubHandlers();
    const handle = holder.acquireRenderWorker(handlers);
    handle.post(renderRequest(9));

    // Nothing ever replies here: every replacement dies on the replayed render. Deaths in a row are
    // exactly what the budget is for, and making it consecutive must not blunt that.
    for (let death = 0; death <= MAX_ENGINE_REBUILDS; death += 1) {
      newestWorker().die();
    }

    expect(handlers.onEngineFailed).toHaveBeenCalledTimes(1);
  });

  it('ignores a late reply from a replaced worker when clearing the rebuild tally', () => {
    const handlers = stubHandlers();
    const handle = holder.acquireRenderWorker(handlers);
    handle.post(renderRequest(4));
    const first = newestWorker();

    // The engine that has already been replaced delivers a reply queued before it was torn down. It
    // says nothing about the health of the successor, so it must not hand the successor a fresh
    // budget — the run of deaths the budget is counting is still unbroken.
    for (let death = 0; death < MAX_ENGINE_REBUILDS; death += 1) {
      newestWorker().die();
    }
    first.deliver(successfulResult(renderIdOf(first)));
    newestWorker().die();

    expect(handlers.onEngineFailed).toHaveBeenCalledTimes(1);
  });

  it('tells a consumer arriving after the failure that the engine is down', () => {
    holder.acquireRenderWorker(stubHandlers());
    for (let death = 0; death <= MAX_ENGINE_REBUILDS; death += 1) {
      newestWorker().die();
    }

    const latecomer = stubHandlers();
    holder.acquireRenderWorker(latecomer);

    // Without this the reopened panel would wait forever with no way to ask for another attempt.
    expect(latecomer.onEngineFailed).toHaveBeenCalledTimes(1);
    expect(mockWorkers).toHaveLength(MAX_ENGINE_REBUILDS + 1);
  });

  it('keeps the engine down across a consumer leaving and another arriving', () => {
    const handle = holder.acquireRenderWorker(stubHandlers());
    for (let death = 0; death <= MAX_ENGINE_REBUILDS; death += 1) {
      newestWorker().die();
    }

    handle.release();
    jest.advanceTimersByTime(RENDER_WORKER_IDLE_RETENTION_MS * 2);

    // Consumers coming and going is not evidence that the engine would start this time.
    const returning = stubHandlers();
    holder.acquireRenderWorker(returning);
    expect(returning.onEngineFailed).toHaveBeenCalledTimes(1);
    expect(mockWorkers).toHaveLength(MAX_ENGINE_REBUILDS + 1);
  });

  it('rebuilds on retry after a failure, with the automatic budget restored', () => {
    const handlers = stubHandlers();
    const handle = holder.acquireRenderWorker(handlers);
    handle.post(renderRequest(3));
    for (let death = 0; death <= MAX_ENGINE_REBUILDS; death += 1) {
      newestWorker().die();
    }
    const workersBeforeRetry = mockWorkers.length;

    handle.retry();

    expect(mockWorkers).toHaveLength(workersBeforeRetry + 1);
    expect(postedDocuments(newestWorker())).toEqual([renderRequest(3).content]);

    // The budget was restored, so a fresh crash is supervised again instead of failing immediately.
    newestWorker().die();
    expect(mockWorkers).toHaveLength(workersBeforeRetry + 2);
    expect(handlers.onEngineFailed).toHaveBeenCalledTimes(1);
  });

  it('ignores a retry while the engine is healthy, so a render in flight is not thrown away', () => {
    const handlers = stubHandlers();
    const handle = holder.acquireRenderWorker(handlers);
    const alive = newestWorker();
    handle.post(renderRequest(3));

    // A retry belongs to the failure notice, but nothing stops it arriving twice, or arriving from a
    // notice still on screen after another consumer's retry already brought the engine back. Acting
    // on it here would terminate a worker that is mid-render: the reply nobody is now going to send
    // is one every consumer is still waiting for, and the render they think is in flight never ends.
    handle.retry();

    expect(mockWorkers).toHaveLength(1);
    expect(alive.terminated).toBe(false);

    // And the render it was already running still reports back, to the consumer that asked for it.
    alive.deliver(successfulResult(renderIdOf(alive)));
    expect(handlers.onMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores a retry from a handle that has already been released', () => {
    const handle = holder.acquireRenderWorker(stubHandlers());
    handle.release();
    jest.advanceTimersByTime(RENDER_WORKER_IDLE_RETENTION_MS);

    handle.retry();

    // Nothing holds the worker, so nothing may spawn one that no release would ever clean up.
    expect(mockWorkers).toHaveLength(1);
  });

  it('counts a repeated release once, so a re-run cleanup cannot evict a live consumer', () => {
    const first = holder.acquireRenderWorker(stubHandlers());
    holder.acquireRenderWorker(stubHandlers());

    first.release();
    first.release();

    jest.advanceTimersByTime(RENDER_WORKER_IDLE_RETENTION_MS * 2);
    expect(newestWorker().terminated).toBe(false);
  });

  it('stops delivering results to a consumer that has released its share', () => {
    const leaving = stubHandlers();
    const staying = stubHandlers();
    const leavingHandle = holder.acquireRenderWorker(leaving);
    holder.acquireRenderWorker(staying);

    leavingHandle.post(renderRequest(1));
    leavingHandle.release();
    newestWorker().deliver(successfulResult(renderIdOf(newestWorker())));

    expect(leaving.onMessage).not.toHaveBeenCalled();
    // Nor is it passed on to whoever is still here. That render was never theirs to receive, and the
    // consumer it belonged to is gone: the right thing to do with the reply is nothing.
    expect(staying.onMessage).not.toHaveBeenCalled();
  });

  it('does not hand a departed consumer’s reply to the consumer that replaced it', () => {
    // The panel is not torn down and rebuilt around the engine any more, so this is the ordinary
    // sequence of opening a large document and clicking away from it before it has finished: the
    // first consumer leaves with a render still running, and the engine — retained, not shut down —
    // is handed to the next one, whose own numbering starts again at 1 just as the departed one's did.
    const departing = stubHandlers();
    const departingHandle = holder.acquireRenderWorker(departing);
    departingHandle.post(renderRequest(1));
    departingHandle.release();

    const arriving = stubHandlers();
    const arrivingHandle = holder.acquireRenderWorker(arriving);
    arrivingHandle.post(renderRequest(1));

    // The slow render the first consumer asked for finally reports. Given to the second, it would put
    // a document from a file nobody has open on screen, and — translated into an id that consumer
    // does recognise as its own — pass every staleness guard on the way.
    newestWorker().deliver(successfulResult(renderIdOf(newestWorker(), 0)));
    expect(arriving.onMessage).not.toHaveBeenCalled();

    // Its own render still arrives.
    newestWorker().deliver(successfulResult(renderIdOf(newestWorker(), 1)));
    expect(arriving.onMessage).toHaveBeenCalledTimes(1);
  });

  it('does not replay the render of a consumer that has left', () => {
    const departingHandle = holder.acquireRenderWorker(stubHandlers());
    departingHandle.post(renderRequest(1));
    departingHandle.release();

    newestWorker().die();

    // The engine comes back for whoever holds it next, but with nothing to catch up on: re-posting a
    // departed panel's document would render a file nobody has open, and hand the reply to whoever is
    // holding the engine by then.
    expect(mockWorkers).toHaveLength(2);
    expect(newestWorker().posted).toEqual([]);
  });

  it('reports a retry that put one of the caller’s own renders back in flight', () => {
    const handle = holder.acquireRenderWorker(stubHandlers());
    handle.post(renderRequest(3));
    for (let death = 0; death <= MAX_ENGINE_REBUILDS; death += 1) {
      newestWorker().die();
    }

    expect(handle.retry()).toEqual({ rebuilt: true, replayed: true });
    expect(postedDocuments(newestWorker())).toEqual([renderRequest(3).content]);
  });

  it('reports no render of the caller’s when the retry replays somebody else’s', () => {
    const mine = holder.acquireRenderWorker(stubHandlers());
    const theirs = holder.acquireRenderWorker(stubHandlers());
    theirs.post(renderRequest(4));
    for (let death = 0; death <= MAX_ENGINE_REBUILDS; death += 1) {
      newestWorker().die();
    }

    // The engine is back and a render is running, but not one this caller will ever hear about. A
    // caller told otherwise waits on a reply that is not coming — and a caller that paces itself by
    // what it believes is in flight would hold every later refresh back behind it.
    // Rebuilt all the same: the engine is back for everyone, and only the replay is somebody else's.
    expect(mine.retry()).toEqual({ rebuilt: true, replayed: false });
    expect(postedDocuments(newestWorker())).toEqual([renderRequest(4).content]);
  });

  it('reports nothing in flight for a retry it refuses', () => {
    const handle = holder.acquireRenderWorker(stubHandlers());
    handle.post(renderRequest(2));

    // The engine is healthy, so the retry is refused outright — and nothing new is running because of
    // it. The render already in flight is the one that was in flight before.
    expect(handle.retry()).toEqual({ rebuilt: false, replayed: false });
  });
});
