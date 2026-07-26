import { createHarperEngineProxy } from '@/lib/codemirror/harper/harper-engine-proxy';
import { HarperEngineInitError, type EngineLint } from '@/lib/codemirror/harper/harper-engine';
import type {
  FromHarperWorker,
  HarperValue,
  ToHarperWorker,
} from '@/lib/codemirror/harper/harper-worker-protocol';

/** A fake grammar worker: records what was posted and answers on demand. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: ToHarperWorker[] = [];
  terminate = jest.fn();
  private messageListeners: ((event: MessageEvent<FromHarperWorker>) => void)[] = [];
  private errorListeners: (() => void)[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: ToHarperWorker) {
    this.posted.push(message);
  }

  addEventListener(type: string, listener: (event: never) => void) {
    if (type === 'message') this.messageListeners.push(listener as (event: MessageEvent<FromHarperWorker>) => void);
    if (type === 'error') this.errorListeners.push(listener as () => void);
  }

  /** The calls posted so far, ignoring the dialect the proxy applies on spawn. */
  calls() {
    return this.posted.map((message) => message.call);
  }

  /** Answer the call at `index` (in post order) with a successful value. */
  answer(index: number, value: HarperValue) {
    this.emit({ id: this.posted[index].id, ok: true, value });
  }

  /** Answer the call at `index` with a failure. */
  fail(index: number, code: 'engine-init-failed' | 'call-failed', message = 'nope') {
    this.emit({ id: this.posted[index].id, ok: false, error: { code, message } });
  }

  /** Fire the worker's `error` event (the script itself failed to load or threw). */
  crash() {
    for (const listener of this.errorListeners) listener();
  }

  private emit(message: FromHarperWorker) {
    for (const listener of this.messageListeners) {
      listener({ data: message } as MessageEvent<FromHarperWorker>);
    }
  }
}

const LINT: EngineLint = {
  span: { start: 0, end: 3 },
  kind: 'Spelling',
  rule: 'SpellCheck',
  message: '“teh” may be misspelled',
  suggestions: [{ text: 'the', kind: 'replace' }],
};

function makeProxy(dialect: 'en-US' | 'en-GB' = 'en-US') {
  FakeWorker.instances = [];
  const createWorker = jest.fn(() => new FakeWorker() as unknown as Worker);
  const engine = createHarperEngineProxy(dialect, createWorker);
  return { engine, createWorker, worker: () => FakeWorker.instances.at(-1)! };
}

describe('createHarperEngineProxy', () => {
  it('spawns no worker until the first call', () => {
    const { createWorker } = makeProxy();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('applies the dialect before the first call it is asked to make', async () => {
    const { engine, worker } = makeProxy('en-GB');
    const pending = engine.lint('teh cat');
    expect(worker().calls()).toEqual([
      { method: 'setDialect', dialect: 'en-GB' },
      { method: 'lint', segmentText: 'teh cat' },
    ]);

    worker().answer(1, { method: 'lint', result: [LINT] });
    await expect(pending).resolves.toEqual([LINT]);
  });

  it('reuses the one worker across calls', async () => {
    const { engine, createWorker, worker } = makeProxy();
    const first = engine.exportWords();
    const second = engine.exportIgnoredLints();
    worker().answer(1, { method: 'exportWords', result: ['asciidoc'] });
    worker().answer(2, { method: 'exportIgnoredLints', result: '[]' });

    await expect(first).resolves.toEqual(['asciidoc']);
    await expect(second).resolves.toBe('[]');
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it('carries every engine call across the boundary as plain data', async () => {
    const { engine, worker } = makeProxy();
    const pending = engine.applySuggestion('teh cat', LINT, 0);
    expect(worker().calls().at(-1)).toEqual({
      method: 'applySuggestion',
      segmentText: 'teh cat',
      lint: LINT,
      suggestionIndex: 0,
    });

    worker().answer(1, { method: 'applySuggestion', result: 'the cat' });
    await expect(pending).resolves.toBe('the cat');
  });

  it('rejects an init failure as a HarperEngineInitError and never memoizes it', async () => {
    const { engine, createWorker, worker } = makeProxy();
    const pending = engine.setup();
    const first = worker();
    first.fail(1, 'engine-init-failed', 'WASM did not load');

    await expect(pending).rejects.toBeInstanceOf(HarperEngineInitError);
    expect(first.terminate).toHaveBeenCalledTimes(1);

    // A later call gets a clean worker rather than the failure again.
    const retried = engine.setup();
    expect(createWorker).toHaveBeenCalledTimes(2);
    worker().answer(1, { method: 'setup', result: null });
    await expect(retried).resolves.toBeUndefined();
  });

  it('keeps the engine alive when a single call fails', async () => {
    const { engine, createWorker, worker } = makeProxy();
    const pending = engine.lint('teh cat');
    worker().fail(1, 'call-failed', 'no suggestion at index 3');

    await expect(pending).rejects.toThrow('no suggestion at index 3');
    expect(worker().terminate).not.toHaveBeenCalled();

    const next = engine.lint('teh cat');
    expect(createWorker).toHaveBeenCalledTimes(1);
    worker().answer(2, { method: 'lint', result: [] });
    await expect(next).resolves.toEqual([]);
  });

  it('fails the in-flight calls when the worker itself dies', async () => {
    const { engine, worker } = makeProxy();
    const first = engine.lint('teh cat');
    const second = engine.getLintConfig();
    worker().crash();

    await expect(first).rejects.toBeInstanceOf(HarperEngineInitError);
    await expect(second).rejects.toBeInstanceOf(HarperEngineInitError);
  });

  it('rejects an answer that names a different call', async () => {
    const { engine, worker } = makeProxy();
    const pending = engine.getLintDescriptions();
    worker().answer(1, { method: 'getLintConfig', result: {} });

    await expect(pending).rejects.toThrow(/getLintDescriptions/);
  });

  it('remembers a dialect change for the worker spawned after a failure', async () => {
    const { engine, worker } = makeProxy('en-US');
    const switched = engine.setDialect('en-GB');
    worker().answer(1, { method: 'setDialect', result: null });
    await expect(switched).resolves.toBeUndefined();

    const pending = engine.setup();
    worker().fail(2, 'engine-init-failed');
    await expect(pending).rejects.toBeInstanceOf(HarperEngineInitError);

    void engine.setup();
    expect(worker().calls()[0]).toEqual({ method: 'setDialect', dialect: 'en-GB' });
  });

  it('terminates the worker on dispose, and does nothing when none was started', async () => {
    const { engine, createWorker, worker } = makeProxy();
    await expect(engine.dispose()).resolves.toBeUndefined();
    expect(createWorker).not.toHaveBeenCalled();

    const pending = engine.lint('teh cat');
    worker().answer(1, { method: 'lint', result: [] });
    await pending;

    const disposed = engine.dispose();
    const running = worker();
    running.answer(2, { method: 'dispose', result: null });
    await expect(disposed).resolves.toBeUndefined();
    expect(running.terminate).toHaveBeenCalledTimes(1);
  });
});
