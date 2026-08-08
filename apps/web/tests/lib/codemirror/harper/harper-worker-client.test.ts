import { createHarperWorkerClient, toGrammarEngineStatus } from '@/lib/codemirror/harper/harper-worker-client';
import { WORKER_GONE_MESSAGE } from '@/lib/codemirror/harper/harper-engine-proxy';
import {
  HarperEngineInitError,
  type HarperEngine,
  type EngineLint,
} from '@/lib/codemirror/harper/harper-engine';

/** A controllable fake engine: setup resolves/rejects on demand, lint returns one lint per word "bad". */
function makeFakeEngine(overrides: Partial<HarperEngine> = {}): HarperEngine & {
  setupCalls: number;
  lintCalls: string[];
} {
  const state = { setupCalls: 0, lintCalls: [] as string[] };
  const base: HarperEngine = {
    async setup() {
      state.setupCalls++;
    },
    async lint(text) {
      state.lintCalls.push(text);
      // Flag each occurrence of the token "bad" as a spelling lint.
      const lints: EngineLint[] = [];
      let index = text.indexOf('bad');
      while (index !== -1) {
        lints.push({
          span: { start: index, end: index + 3 },
          kind: 'Spelling',
          rule: 'SpellCheck',
          message: '“bad” may be misspelled',
          suggestions: [{ text: 'bar', kind: 'replace' }],
        });
        index = text.indexOf('bad', index + 3);
      }
      return lints;
    },
    async organizedLints() {
      return {};
    },
    async applySuggestion(text) {
      return text;
    },
    async ignore() {},
    async importWords() {},
    async clearWords() {},
    async exportWords() {
      return [];
    },
    async importIgnoredLints() {},
    async exportIgnoredLints() {
      return '';
    },
    async setDialect() {},
    async getLintConfig() {
      return {};
    },
    async setLintConfig() {},
    async getLintDescriptions() {
      return {};
    },
    async dispose() {},
  };
  const engine = Object.assign(base, overrides);
  return Object.defineProperties(engine, {
    setupCalls: { get: () => state.setupCalls, enumerable: true },
    lintCalls: { get: () => state.lintCalls, enumerable: true },
  }) as HarperEngine & { setupCalls: number; lintCalls: string[] };
}

/** A promise plus its resolve/reject, so a test can hold the engine mid-setup. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveCallback, rejectCallback) => {
    resolve = resolveCallback;
    reject = rejectCallback;
  });
  return { promise, resolve, reject };
}

describe('createHarperWorkerClient', () => {
  // A lint rejection has two very different causes and they arrive identically, as a rejected promise.
  describe('when engine.lint rejects', () => {
    test('a disposal mid-pass is swallowed: no results, and the engine is not marked failed', async () => {
      const engine = makeFakeEngine({
        async lint() {
          throw new Error(WORKER_GONE_MESSAGE);
        },
      });
      const client = createHarperWorkerClient(engine);
      await client.warmUp();

      // Routine teardown — the editor unmounted with this pass in flight. Nothing to report.
      await expect(client.lint([{ id: 's1', text: 'a bad word' }])).resolves.toBeNull();
      expect(client.getStatus()).toBe('ready');
    });

    // Reporting the failure must not memoize it. `ensureReady` short-circuits on a resolved
    // `setupPromise` and then answers `readStatus() === 'ready'` — so a failure left memoized makes
    // every later pass return null for the rest of the session, on an engine the proxy would happily
    // have rebuilt. One transient trap would silently end grammar checking for good.
    test('recovers on the next pass after a transient engine failure', async () => {
      let failNext = true;
      const engine = makeFakeEngine({
        async lint() {
          if (failNext) {
            failNext = false;
            throw new Error('transient wasm trap');
          }
          return [];
        },
      });
      const client = createHarperWorkerClient(engine);
      await client.warmUp();

      await expect(client.lint([{ id: 's1', text: 'a bad word' }])).resolves.toBeNull();
      expect(client.getStatus()).toBe('failed');

      // The engine is healthy again; the next pass must actually run.
      await expect(client.lint([{ id: 's2', text: 'a bad word' }])).resolves.toEqual([
        { id: 's2', lints: [] },
      ]);
      expect(client.getStatus()).toBe('ready');
    });

    // Every other exit from the lint loop discards a pass that was superseded while it was awaiting.
    // The rejection path has to as well, or a trap belonging to a pass the reader has already typed
    // past puts "grammar checking failed" over the document the newer pass linted cleanly.
    test('a failure belonging to a superseded pass does not report over the pass that replaced it', async () => {
      const stalled = deferred<EngineLint[]>();
      const engine = makeFakeEngine({
        async lint(text: string) {
          return text === 'superseded' ? stalled.promise : [];
        },
      });
      const client = createHarperWorkerClient(engine);
      await client.warmUp();

      // Starts, reaches the engine, and stays there — the reader keeps typing meanwhile.
      const superseded = client.lint([{ id: 's1', text: 'superseded' }]);
      await expect(client.lint([{ id: 's2', text: 'current' }])).resolves.toEqual([
        { id: 's2', lints: [] },
      ]);

      stalled.reject(new Error('unreachable executed'));
      await expect(superseded).resolves.toBeNull();
      expect(client.getStatus()).toBe('ready');
    });

    test('a genuine engine failure is reported rather than read as a clean document', async () => {
      const engine = makeFakeEngine({
        async lint() {
          throw new Error('unreachable executed');
        },
      });
      const client = createHarperWorkerClient(engine);
      await client.warmUp();

      // Returning null and saying nothing would show the reader a document with no writing issues,
      // indefinitely and indistinguishably from one that really has none.
      await expect(client.lint([{ id: 's1', text: 'a bad word' }])).resolves.toBeNull();
      expect(client.getStatus()).toBe('failed');
    });
  });

  test('warmUp initialises the engine and reports ready', async () => {
    const engine = makeFakeEngine();
    const client = createHarperWorkerClient(engine);
    expect(client.getStatus()).toBe('idle');
    await client.warmUp();
    expect(engine.setupCalls).toBe(1);
    expect(client.getStatus()).toBe('ready');
    expect(client.isReady()).toBe(true);
  });

  test('reports no results, rather than rejecting, when the engine goes away mid-pass', async () => {
    // What disposing the engine with a lint in flight looks like from here: the call the pass is
    // awaiting rejects. Both callers — the CodeMirror lint source and the included-file pass — read
    // `null` as "no results this time" and stay usable; a rejection has nowhere to go in either, and
    // surfaces as an unhandled one in the console of an editor that is already being torn down.
    const engine = makeFakeEngine({
      async lint() {
        throw new Error('The Harper worker was disposed while this call was in flight');
      },
    });
    const client = createHarperWorkerClient(engine);
    await client.warmUp();

    await expect(client.lint([{ id: '0', text: 'a bad line' }])).resolves.toBeNull();
  });

  test('a failed init reports "failed" and is not memoized — a later warmUp retries a clean setup', async () => {
    let attempt = 0;
    const engine = makeFakeEngine({
      async setup() {
        attempt++;
        if (attempt === 1) throw new HarperEngineInitError('boom');
      },
    });
    const client = createHarperWorkerClient(engine);
    await client.warmUp();
    expect(client.getStatus()).toBe('failed');
    expect(client.isReady()).toBe(false);
    // Not memoized: retry re-attempts setup and can succeed.
    await client.warmUp();
    expect(attempt).toBe(2);
    expect(client.getStatus()).toBe('ready');
  });

  test('lint returns mapped lints per segment once the engine is ready', async () => {
    const engine = makeFakeEngine();
    const client = createHarperWorkerClient(engine);
    await client.warmUp();
    const result = await client.lint([
      { id: 's1', text: 'a bad line' },
      { id: 's2', text: 'all good here' },
    ]);
    expect(result).not.toBeNull();
    expect(result).toEqual([
      { id: 's1', lints: [expect.objectContaining({ kind: 'Spelling', span: { start: 2, end: 5 } })] },
      { id: 's2', lints: [] },
    ]);
  });

  test('lint warms the engine up on demand when it has not been set up yet', async () => {
    const engine = makeFakeEngine();
    const client = createHarperWorkerClient(engine);
    const result = await client.lint([{ id: 's1', text: 'a bad line' }]);
    expect(engine.setupCalls).toBe(1);
    expect(result?.[0].lints).toHaveLength(1);
  });

  test('lint returns [] (not a throw) when the engine fails to initialise — graceful degradation', async () => {
    const engine = makeFakeEngine({
      async setup() {
        throw new HarperEngineInitError('no wasm');
      },
    });
    const client = createHarperWorkerClient(engine);
    const result = await client.lint([{ id: 's1', text: 'a bad line' }]);
    expect(result).toBeNull();
    expect(client.getStatus()).toBe('failed');
  });

  test('a superseded lint resolves to null so stale results never overwrite fresh ones', async () => {
    const gate = deferred<void>();
    let call = 0;
    const engine = makeFakeEngine({
      async lint(text) {
        call++;
        if (call === 1) await gate.promise; // hold the first request open
        const lints: EngineLint[] = [];
        let index = text.indexOf('bad');
        while (index !== -1) {
          lints.push({
            span: { start: index, end: index + 3 },
            kind: 'Spelling',
            rule: 'SpellCheck',
            message: 'x',
            suggestions: [],
          });
          index = text.indexOf('bad', index + 3);
        }
        return lints;
      },
    });
    const client = createHarperWorkerClient(engine);
    await client.warmUp();
    const first = client.lint([{ id: 's1', text: 'a bad one' }]);
    const second = client.lint([{ id: 's1', text: 'a bad two' }]);
    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBeNull(); // superseded
    expect(secondResult).not.toBeNull(); // latest wins
  });

  test('caches per-segment results so an unchanged segment is not re-linted', async () => {
    const engine = makeFakeEngine();
    const client = createHarperWorkerClient(engine);
    await client.warmUp();
    await client.lint([{ id: 's1', text: 'a bad line' }]);
    await client.lint([{ id: 's1', text: 'a bad line' }]);
    // The engine linted the segment text only once despite two lint passes.
    expect(engine.lintCalls.filter((text) => text === 'a bad line')).toHaveLength(1);
  });

  test('a cache hit still carries the rule that fired, so the panel can name it', async () => {
    // The cache returns the engine's own lint objects, and the panel reads the rule off them. Caching a
    // reduced copy would leave the rule chip blank on every unchanged paragraph — the common case.
    const engine = makeFakeEngine();
    const client = createHarperWorkerClient(engine);
    await client.warmUp();
    const first = await client.lint([{ id: 's1', text: 'a bad line' }]);
    const second = await client.lint([{ id: 's1', text: 'a bad line' }]);
    expect(engine.lintCalls.filter((text) => text === 'a bad line')).toHaveLength(1); // a cache hit
    expect(second![0]!.lints[0]!.rule).toBe('SpellCheck');
    // The same object, so the identity `ignore` and `applySuggestion` are matched on survives caching.
    expect(second![0]!.lints[0]!).toBe(first![0]!.lints[0]!);
  });

  test('rule descriptions are read straight from the engine', async () => {
    const engine = makeFakeEngine({
      async getLintDescriptions() {
        return { SpellCheck: 'Looks for words that are misspelled.' };
      },
    });
    const client = createHarperWorkerClient(engine);
    await expect(client.getLintDescriptions()).resolves.toEqual({
      SpellCheck: 'Looks for words that are misspelled.',
    });
  });

  test('adding dictionary words invalidates the cache so segments re-lint', async () => {
    const engine = makeFakeEngine();
    const client = createHarperWorkerClient(engine);
    await client.warmUp();
    await client.lint([{ id: 's1', text: 'a bad line' }]);
    await client.importWords(['bad']);
    await client.lint([{ id: 's1', text: 'a bad line' }]);
    expect(engine.lintCalls.filter((text) => text === 'a bad line')).toHaveLength(2);
  });

  test('a warm-up that never settles times out as "failed" rather than loading forever', async () => {
    // harper.js does not reject its pending request when its worker errors, so a worker-side failure
    // can leave setup() hanging. Without the watchdog the panel would show "loading" indefinitely.
    jest.useFakeTimers();
    try {
      const engine = makeFakeEngine({
        setup() {
          return new Promise<void>(() => {}); // never settles
        },
      });
      const client = createHarperWorkerClient(engine);
      const warm = client.warmUp();
      expect(client.getStatus()).toBe('loading');
      await jest.advanceTimersByTimeAsync(60_000);
      await warm;
      expect(client.getStatus()).toBe('failed');
      expect(client.isReady()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('toGrammarEngineStatus collapses the raw engine status to the panel-facing status', () => {
    expect(toGrammarEngineStatus('idle')).toBe('loading');
    expect(toGrammarEngineStatus('loading')).toBe('loading');
    expect(toGrammarEngineStatus('ready')).toBe('ready');
    expect(toGrammarEngineStatus('failed')).toBe('failed');
  });

  test('resetWords replaces the user dictionary (clear then import) and invalidates the cache', async () => {
    const calls: string[] = [];
    const engine = makeFakeEngine({
      async clearWords() {
        calls.push('clear');
      },
      async importWords(words) {
        calls.push(`import:${words.join(',')}`);
      },
    });
    const client = createHarperWorkerClient(engine);
    await client.warmUp();
    await client.lint([{ id: 's1', text: 'a bad line' }]);
    await client.resetWords(['bad']);
    await client.lint([{ id: 's1', text: 'a bad line' }]);
    // Cache invalidated → the segment is re-linted after the accepted-terms set changed.
    expect(engine.lintCalls.filter((text) => text === 'a bad line')).toHaveLength(2);
    // The user dictionary is cleared BEFORE the replacement set is imported, so a removed term is
    // reconciled away rather than lingering (harper.js `importWords` is additive-only).
    expect(calls).toEqual(['clear', 'import:bad']);
  });

  test('status changes are observable', async () => {
    const engine = makeFakeEngine();
    const client = createHarperWorkerClient(engine);
    const seen: string[] = [];
    client.onStatusChange((status) => seen.push(status));
    await client.warmUp();
    expect(seen).toContain('loading');
    expect(seen).toContain('ready');
  });
});

describe('createHarperWorkerClient — cache invalidation and eviction', () => {
  test('ignoring a lint invalidates the cache, so the dismissed issue stops coming back', async () => {
    // Without this the very next lint pass replays the cached result, and the underline the reader just
    // dismissed reappears until something else happened to clear the cache.
    let flag = true;
    const engine = makeFakeEngine({
      async lint(text) {
        return flag && text.includes('bad')
          ? [{ span: { start: 0, end: 3 }, kind: 'Spelling', rule: 'SpellCheck', message: 'bad', suggestions: [] }]
          : [];
      },
      async ignore() {
        flag = false;
      },
    });
    const client = createHarperWorkerClient(engine);
    await client.warmUp();
    const first = await client.lint([{ id: '0', text: 'bad text' }]);
    expect(first?.[0]!.lints).toHaveLength(1);
    await client.ignore('bad text', first![0]!.lints[0]!);
    const second = await client.lint([{ id: '0', text: 'bad text' }]);
    expect(second?.[0]!.lints).toHaveLength(0);
  });

  test('a rule-config change invalidates the cache', async () => {
    let flag = true;
    const engine = makeFakeEngine({
      async lint(text) {
        return flag && text.includes('bad')
          ? [{ span: { start: 0, end: 3 }, kind: 'Spelling', rule: 'SpellCheck', message: 'bad', suggestions: [] }]
          : [];
      },
      async setLintConfig() {
        flag = false;
      },
    });
    const client = createHarperWorkerClient(engine);
    await client.warmUp();
    const before = await client.lint([{ id: '0', text: 'bad text' }]);
    expect(before?.[0]!.lints).toHaveLength(1);
    await client.setLintConfig({ SpellCheck: false });
    const after = await client.lint([{ id: '0', text: 'bad text' }]);
    expect(after?.[0]!.lints).toHaveLength(0);
  });

  test('a dialect change invalidates the cache', async () => {
    let flag = true;
    const engine = makeFakeEngine({
      async lint(text) {
        return flag && text.includes('bad')
          ? [{ span: { start: 0, end: 3 }, kind: 'Spelling', rule: 'SpellCheck', message: 'bad', suggestions: [] }]
          : [];
      },
      async setDialect() {
        flag = false;
      },
    });
    const client = createHarperWorkerClient(engine);
    await client.warmUp();
    const before = await client.lint([{ id: '0', text: 'bad text' }]);
    expect(before?.[0]!.lints).toHaveLength(1);
    await client.setDialect('en-US');
    const after = await client.lint([{ id: '0', text: 'bad text' }]);
    expect(after?.[0]!.lints).toHaveLength(0);
  });

  test('the segment cache is bounded, evicting the oldest entry', async () => {
    // An unbounded cache keyed on segment text grows with every edit of a long document.
    const engine = makeFakeEngine();
    const client = createHarperWorkerClient(engine);
    await client.warmUp();
    const before = engine.lintCalls.length;
    // One past the 1000-entry bound, then ask for the very first segment again.
    const beyondBound = 1001;
    for (let index = 0; index < beyondBound; index++) {
      await client.lint([{ id: '0', text: `segment ${index}` }]);
    }
    const afterFill = engine.lintCalls.length;
    expect(afterFill - before).toBe(beyondBound);
    await client.lint([{ id: '0', text: 'segment 0' }]);
    // Re-linted, so the earliest entry was evicted rather than kept forever.
    expect(engine.lintCalls.length).toBe(afterFill + 1);
  });

  test('re-exports what the engine holds after an ignore', async () => {
    const engine = makeFakeEngine({
      async exportIgnoredLints() {
        return '["hash-a"]';
      },
    });
    const client = createHarperWorkerClient(engine);
    await client.warmUp();
    await expect(client.exportIgnoredLints()).resolves.toBe('["hash-a"]');
  });

  test('a non-init failure from setup is not swallowed', async () => {
    // A HarperEngineInitError is an expected outcome the client reports as `failed`; anything else is a
    // programming fault and must surface rather than look like a clean unavailable engine.
    const engine = makeFakeEngine({
      async setup() {
        throw new TypeError('boom');
      },
    });
    const client = createHarperWorkerClient(engine);
    await expect(client.warmUp()).rejects.toBeInstanceOf(TypeError);
    expect(client.getStatus()).toBe('failed');
  });
});
