import { createHarperEngineProxy } from '@/lib/codemirror/harper/harper-engine-proxy';
import {
  HarperEngineInitError,
  type EngineLint,
  type HarperEngine,
} from '@/lib/codemirror/harper/harper-engine';
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

/** Starts `call` on a fresh proxy and answers it with an unrelated method's value. */
function crossed(call: (engine: HarperEngine) => Promise<unknown>): Promise<unknown> {
  const { engine, worker } = makeProxy();
  const pending = call(engine);
  worker().answer(1, { method: 'setup', result: null });
  return pending;
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

  it('carries the dictionary and ignored-lint calls that answer with nothing', async () => {
    // These are the writes: they change what the engine reports next, and the caller only needs to
    // know the worker got them. Each must still be awaited, or a `resetWords` could re-import before
    // the clear landed.
    const { engine, worker } = makeProxy();
    const calls = [
      engine.ignore('teh cat', LINT),
      engine.importWords(['asciidoc']),
      engine.clearWords(),
      engine.importIgnoredLints('[]'),
      engine.setLintConfig({ SpellCheck: false }),
    ];
    expect(worker().calls().slice(1)).toEqual([
      { method: 'ignore', segmentText: 'teh cat', lint: LINT },
      { method: 'importWords', words: ['asciidoc'] },
      { method: 'clearWords' },
      { method: 'importIgnoredLints', json: '[]' },
      { method: 'setLintConfig', config: { SpellCheck: false } },
    ]);

    worker().answer(1, { method: 'ignore', result: null });
    worker().answer(2, { method: 'importWords', result: null });
    worker().answer(3, { method: 'clearWords', result: null });
    worker().answer(4, { method: 'importIgnoredLints', result: null });
    worker().answer(5, { method: 'setLintConfig', result: null });
    await expect(Promise.all(calls)).resolves.toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('returns the rule configuration and the rule descriptions the worker holds', async () => {
    // The settings page renders one row per rule from these two answers together, so both have to
    // come back as the engine's own shapes rather than as the raw union the boundary carries.
    const { engine, worker } = makeProxy();
    const config = engine.getLintConfig();
    const descriptions = engine.getLintDescriptions();
    worker().answer(1, { method: 'getLintConfig', result: { SpellCheck: true, Spaces: null } });
    worker().answer(2, { method: 'getLintDescriptions', result: { SpellCheck: 'Checks spelling.' } });

    await expect(config).resolves.toEqual({ SpellCheck: true, Spaces: null });
    await expect(descriptions).resolves.toEqual({ SpellCheck: 'Checks spelling.' });
  });

  it('returns the organized lints the worker computed', async () => {
    const { engine, worker } = makeProxy();
    const pending = engine.organizedLints('teh cat');
    expect(worker().calls().at(-1)).toEqual({ method: 'organizedLints', segmentText: 'teh cat' });

    worker().answer(1, { method: 'organizedLints', result: { Spelling: [LINT] } });
    await expect(pending).resolves.toEqual({ Spelling: [LINT] });
  });

  it('rejects every value-returning call whose answer names a different method', async () => {
    // Correlation is by id, so a crossed answer means the worker is broken rather than that two
    // answers raced. Returning it anyway would hand a lint array back as a dictionary, and so on.
    await expect(crossed((engine) => engine.lint('teh cat'))).rejects.toThrow(/lint/);
    await expect(crossed((engine) => engine.organizedLints('teh cat'))).rejects.toThrow(/organizedLints/);
    await expect(crossed((engine) => engine.applySuggestion('teh cat', LINT, 0))).rejects.toThrow(
      /applySuggestion/,
    );
    await expect(crossed((engine) => engine.exportWords())).rejects.toThrow(/exportWords/);
    await expect(crossed((engine) => engine.exportIgnoredLints())).rejects.toThrow(/exportIgnoredLints/);
    await expect(crossed((engine) => engine.getLintConfig())).rejects.toThrow(/getLintConfig/);
  });

  it('ignores an answer to a call it is no longer waiting on', async () => {
    // A worker torn down mid-call can still deliver its last answer; matching it to nothing must not
    // throw, and must not resolve some unrelated later call that happens to reuse the id.
    const { engine, worker } = makeProxy();
    const pending = engine.exportWords();
    worker().answer(1, { method: 'exportWords', result: ['asciidoc'] });
    await expect(pending).resolves.toEqual(['asciidoc']);

    expect(() => worker().answer(1, { method: 'exportWords', result: ['stale'] })).not.toThrow();
  });

  it('survives the worker dying after it has already been disposed', async () => {
    // Disposal drops the worker reference but leaves its `error` listener attached: a script that
    // fails on the way out must not throw on a worker that is already gone.
    const { engine, worker } = makeProxy();
    const pending = engine.setup();
    const running = worker();
    running.answer(1, { method: 'setup', result: null });
    await pending;

    const disposed = engine.dispose();
    running.answer(2, { method: 'dispose', result: null });
    await disposed;

    expect(() => running.crash()).not.toThrow();
    expect(running.terminate).toHaveBeenCalledTimes(1);
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

  it('fails the calls still in flight when it disposes, rather than abandoning them', async () => {
    const { engine, worker } = makeProxy();

    // An editor unmounting, or grammar checking being switched off, disposes the engine with a lint
    // still running. Dropped rather than failed, that lint's `await` never resumes: whatever the
    // caller does after it — clearing a flag, releasing a queue — never runs, for the rest of the
    // session.
    const abandoned = engine.lint('teh cat');
    const disposed = engine.dispose();
    worker().answer(2, { method: 'dispose', result: null });

    await expect(disposed).resolves.toBeUndefined();
    await expect(abandoned).rejects.toThrow(/disposed/);
  });
});
