/**
 * Per-render stage timings reported by asciidoc-render.worker.ts.
 *
 * The worker module is imported directly (not via `new Worker(url)`) so Jest can execute it: the
 * global `onmessage` setter and `postMessage` are shimmed to capture and drive the message handler
 * synchronously. Asciidoctor is mocked, and `performance.now` is replaced with a hand-advanced clock,
 * so each stage's cost is a value the test sets rather than a wall-clock reading — that is what makes
 * "this duration was attributed to the right stage" assertable at all.
 */

let onMessageHandler: ((event: MessageEvent) => void) | null = null;
const postMessageMock = jest.fn();

Object.defineProperty(globalThis, 'onmessage', {
  set(handler: (event: MessageEvent) => void) {
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

jest.mock('asciidoctor', () => {
  const MockAsciidoctor = jest.fn().mockReturnValue({ load: mockLoad });
  return MockAsciidoctor;
});

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

function sendMessage(data: { requestId: number; content: string }): void {
  if (onMessageHandler) {
    onMessageHandler({ data } as MessageEvent);
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
    mockConvert.mockReturnValue('<div class="paragraph"><p>text</p></div>');
    mockLoad.mockReturnValue({ findBy: mockFindBy, convert: mockConvert, getAttribute: mockGetAttribute });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('attributes the cost of parsing and of conversion to their own stages', () => {
    mockLoad.mockImplementation(() => {
      spend(7);
      return { findBy: mockFindBy, convert: mockConvert, getAttribute: mockGetAttribute };
    });
    mockConvert.mockImplementation(() => {
      spend(11);
      return '<div class="paragraph"><p>text</p></div>';
    });
    require('@/workers/asciidoc-render.worker');

    sendMessage({ requestId: 1, content: '= Doc\n\ntext' });

    expect(lastResult().timings).toEqual(
      expect.objectContaining({ parseMs: 7, convertMs: 11 }),
    );
  });

  it("attributes the worker's own post-conversion passes to their own stage, inside the reported total", () => {
    mockLoad.mockImplementation(() => {
      spend(7);
      return { findBy: mockFindBy, convert: mockConvert, getAttribute: mockGetAttribute };
    });
    mockConvert.mockImplementation(() => {
      spend(11);
      return '<div class="paragraph"><p>text</p></div>';
    });
    // Read only once conversion has finished, so its cost lands in the post-conversion window.
    mockGetAttribute.mockImplementation(spendsOnce(5, undefined));
    require('@/workers/asciidoc-render.worker');

    sendMessage({ requestId: 2, content: '= Doc\n\ntext' });

    const timings = lastResult().timings!;
    expect(timings.postProcessMs).toBe(5);
    expect(timings.totalMs).toBeGreaterThanOrEqual(
      timings.parseMs + timings.convertMs + timings.postProcessMs,
    );
    expect(timings.totalMs).toBe(23);
  });

  it('reports no timings at all for a render that failed', () => {
    mockLoad.mockImplementation(() => {
      throw new Error('parse exploded');
    });
    require('@/workers/asciidoc-render.worker');

    sendMessage({ requestId: 3, content: '= Doc' });

    const result = lastResult();
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('timings');
  });
});
