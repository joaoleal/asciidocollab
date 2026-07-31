/**
 * Per-render stage timings reported by asciidoc-render.worker.ts.
 *
 * The worker module is imported directly (not via `new Worker(url)`) so Jest can execute it: the
 * global `onmessage` setter and `postMessage` are shimmed to capture and drive the message handler
 * synchronously. Asciidoctor is mocked, and `performance.now` is replaced with a hand-advanced clock,
 * so each stage's cost is a value the test sets rather than a wall-clock reading — that is what makes
 * "this duration was attributed to the right stage" assertable at all.
 */

let onMessageHandler: ((event: MessageEvent) => Promise<void>) | null = null;
const postMessageMock = jest.fn();

Object.defineProperty(globalThis, 'onmessage', {
  set(handler: (event: MessageEvent) => Promise<void>) {
    onMessageHandler = handler;
  },
  get() {
    return onMessageHandler;
  },
  configurable: true,
});
Object.defineProperty(globalThis, 'postMessage', {
  value: postMessageMock,
  writable: true,
  configurable: true,
});

const mockConvert = jest.fn();
const mockFindBy = jest.fn();
const mockGetAttribute = jest.fn();
const mockLoad = jest.fn();

// The engine exposes `load` as a module function, not a processor factory, and it resolves a promise.
jest.mock('asciidoctor', () => ({ __esModule: true, load: mockLoad }));

/** The parsed-document double the engine's `load` resolves to. */
function mockDocument(): unknown {
  return { findBy: mockFindBy, convert: mockConvert, getAttribute: mockGetAttribute };
}

/** The hand-advanced clock backing `performance.now()`, in milliseconds. */
let clock = 0;

/** Advance the clock by `ms`, the way a stage that took `ms` to run would. */
function spend(ms: number): void {
  clock += ms;
}

/**
 * A callback that spends `ms` the FIRST time it is called and nothing afterwards, returning `result`
 * every time. Attributing a fixed cost to a stage that calls its double several times (the header
 * reads after conversion) would otherwise multiply that cost by a call count the test does not care
 * about and should not be pinned to.
 */
function spendsOnce<T>(ms: number, result: T): () => T {
  let spent = false;
  return () => {
    if (!spent) {
      spent = true;
      spend(ms);
    }
    return result;
  };
}

/**
 * Drive one render, and settle before returning. The handler is asynchronous, so the reply exists only
 * once the promise it returns has settled; asserting without awaiting would read the previous reply.
 */
async function sendMessage(data: { requestId: number; content: string }): Promise<void> {
  if (onMessageHandler) {
    await onMessageHandler({ data } as MessageEvent);
  } else {
    throw new Error('onmessage handler not registered');
  }
}

interface PostedResult {
  ok: boolean;
  timings?: { parseMs: number; convertMs: number; postProcessMs: number; totalMs: number };
}

function lastResult(): PostedResult {
  const call = postMessageMock.mock.calls.at(-1);
  if (call === undefined) throw new Error('worker posted no result');
  const posted: PostedResult = call[0];
  return posted;
}

describe('asciidoc-render.worker stage timings', () => {
  beforeEach(() => {
    jest.resetModules();
    postMessageMock.mockClear();
    mockConvert.mockClear();
    mockFindBy.mockClear();
    mockGetAttribute.mockClear();
    mockLoad.mockClear();
    onMessageHandler = null;
    clock = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);

    mockFindBy.mockReturnValue([]);
    mockGetAttribute.mockReturnValue(undefined);
    mockConvert.mockResolvedValue('<div class="paragraph"><p>text</p></div>');
    mockLoad.mockResolvedValue(mockDocument());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('attributes the cost of parsing and of conversion to their own stages', async () => {
    mockLoad.mockImplementation(() => {
      spend(7);
      return Promise.resolve(mockDocument());
    });
    mockConvert.mockImplementation(() => {
      spend(11);
      return Promise.resolve('<div class="paragraph"><p>text</p></div>');
    });
    require('@/workers/asciidoc-render.worker');

    await sendMessage({ requestId: 1, content: '= Doc\n\ntext' });

    expect(lastResult().timings).toEqual(
      expect.objectContaining({ parseMs: 7, convertMs: 11 }),
    );
  });

  it("attributes the worker's own post-conversion passes to their own stage, inside the reported total", async () => {
    mockLoad.mockImplementation(() => {
      spend(7);
      return Promise.resolve(mockDocument());
    });
    mockConvert.mockImplementation(() => {
      spend(11);
      return Promise.resolve('<div class="paragraph"><p>text</p></div>');
    });
    // Read only once conversion has finished, so its cost lands in the post-conversion window.
    mockGetAttribute.mockImplementation(spendsOnce(5, undefined));
    require('@/workers/asciidoc-render.worker');

    await sendMessage({ requestId: 2, content: '= Doc\n\ntext' });

    const timings = lastResult().timings!;
    expect(timings.postProcessMs).toBe(5);
    expect(timings.totalMs).toBeGreaterThanOrEqual(
      timings.parseMs + timings.convertMs + timings.postProcessMs,
    );
    expect(timings.totalMs).toBe(23);
  });

  it('reports no timings at all for a render that failed', async () => {
    mockLoad.mockImplementation(() => {
      throw new Error('parse exploded');
    });
    require('@/workers/asciidoc-render.worker');

    await sendMessage({ requestId: 3, content: '= Doc' });

    const result = lastResult();
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('timings');
  });
});
