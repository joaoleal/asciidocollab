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

function successfulResult(requestId: number): RenderResult {
  return { requestId, ok: true, html: '<p>rendered</p>', error: null };
}

function failedResult(requestId: number): RenderResult {
  return { requestId, ok: false, html: null, error: 'unterminated block' };
}

function stubHandlers() {
  return { onMessage: jest.fn(), onEngineFailed: jest.fn() };
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
    holder.acquireRenderWorker(second);

    expect(mockWorkers).toHaveLength(1);

    // Both consumers see every reply; telling them apart is the caller's request-id guard.
    newestWorker().deliver(successfulResult(1));
    expect(first.onMessage).toHaveBeenCalledTimes(1);
    expect(second.onMessage).toHaveBeenCalledTimes(1);

    // One consumer leaving is not "nobody is using this": the count still stands at one.
    firstHandle.release();
    jest.advanceTimersByTime(RENDER_WORKER_IDLE_RETENTION_MS * 2);
    expect(newestWorker().terminated).toBe(false);
    expect(mockWorkers).toHaveLength(1);
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
    holder.acquireRenderWorker(handlers);
    const spawned = newestWorker();

    spawned.deliver(failedResult(1));

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
    expect(first.posted).toEqual([renderRequest(7)]);

    first.die();

    expect(mockWorkers).toHaveLength(2);
    expect(newestWorker()).not.toBe(first);
    expect(newestWorker().posted).toEqual([renderRequest(7)]);
    expect(handlers.onEngineFailed).not.toHaveBeenCalled();

    // The replacement is wired up: its replies reach the consumer that never knew anything happened.
    newestWorker().deliver(successfulResult(7));
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
    expect(newestWorker().posted).toEqual([renderRequest(3)]);

    // The budget was restored, so a fresh crash is supervised again instead of failing immediately.
    newestWorker().die();
    expect(mockWorkers).toHaveLength(workersBeforeRetry + 2);
    expect(handlers.onEngineFailed).toHaveBeenCalledTimes(1);
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

    leavingHandle.release();
    newestWorker().deliver(successfulResult(1));

    expect(leaving.onMessage).not.toHaveBeenCalled();
    expect(staying.onMessage).toHaveBeenCalledTimes(1);
  });
});
