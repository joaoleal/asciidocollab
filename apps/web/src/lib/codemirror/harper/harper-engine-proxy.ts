import type { GrammarDialect } from './dialect';
import { HarperEngineInitError, type HarperEngine } from './harper-engine';
import {
  isValueOf,
  type FromHarperWorker,
  type HarperCall,
  type HarperMethod,
  type HarperValue,
  type ToHarperWorker,
} from './harper-worker-protocol';

/**
 * @file The main-thread half of the Harper grammar engine: a {@link HarperEngine} that forwards every
 * call to the worker over {@link ToHarperWorker} and resolves it from the matching answer.
 *
 * It is deliberately a transport and nothing else — no engine state, no WASM, not one `harper.js`
 * import. That is the whole point: `harper.js`'s own `WorkerLinter` looks like it keeps the engine off
 * the main thread, but its RPC serializer rehydrates every `Lint` into main-thread WASM objects, so
 * constructing one loads and initialises the (~18 MB, plus its slim sibling) binary on the editor's
 * thread and blocks it for hundreds of milliseconds. Owning the worker ourselves and shipping plain
 * data across the boundary is what makes "checking never blocks typing" true rather than intended.
 *
 * The worker is spawned on the first call and torn down again whenever initialisation fails, so a
 * failure is never memoized and a later call re-attempts a clean init (spec degradation path).
 */

/** A call awaiting its answer. */
interface PendingCall {
  /**
   * Deliver the worker's answer.
   *
   * @param value - The answer the worker sent.
   */
  readonly resolve: (value: HarperValue) => void;
  /**
   * Fail the call.
   *
   * @param error - Why it failed.
   */
  readonly reject: (error: Error) => void;
}

/**
 * The failure raised when the worker answers a different call than the one that was made. Correlation
 * is by id, so this means the worker is broken rather than that two answers crossed.
 *
 * @param expected - The method that was called.
 * @param value - The answer that came back.
 * @returns The error to throw.
 */
function mismatch(expected: HarperMethod, value: HarperValue): Error {
  return new Error(`The Harper worker answered a “${expected}” call with “${value.method}”`);
}

/**
 * Build the main-thread {@link HarperEngine} that drives the grammar worker.
 *
 * @param dialect - The English dialect to enforce from the first lint; applied to each freshly spawned
 *   worker before any other call, so a worker restarted after a failed init comes back on the same one.
 * @param createWorker - Spawns the grammar worker (the real factory in the app, a fake in tests).
 * @returns An engine whose every method is a round trip to the worker.
 */
export function createHarperEngineProxy(
  dialect: GrammarDialect,
  createWorker: () => Worker,
): HarperEngine {
  let currentDialect = dialect;
  let worker: Worker | null = null;
  let nextId = 0;
  const pending = new Map<number, PendingCall>();

  /**
   * Fail every in-flight call and drop the worker, so the next call starts a clean one.
   *
   * @param error - The failure to reject the in-flight calls with.
   */
  function reset(error: Error): void {
    const failed = [...pending.values()];
    pending.clear();
    worker?.terminate();
    worker = null;
    for (const call of failed) call.reject(error);
  }

  /**
   * The live worker, spawning it (and applying the current dialect) on first use.
   *
   * @returns The worker every subsequent call is posted to.
   */
  function ensureWorker(): Worker {
    if (worker) return worker;
    const spawned = createWorker();
    worker = spawned;
    spawned.addEventListener('message', (event: MessageEvent<FromHarperWorker>) => {
      const answer = event.data;
      const call = pending.get(answer.id);
      if (!call) return; // an answer to a call from a worker we have already torn down
      pending.delete(answer.id);
      if (answer.ok) {
        call.resolve(answer.value);
        return;
      }
      const error =
        answer.error.code === 'engine-init-failed'
          ? new HarperEngineInitError(answer.error.message)
          : new Error(answer.error.message);
      // A dead engine takes the worker with it, so every OTHER call in flight fails too and the next
      // one starts a clean init. A single failed call leaves the engine (and the worker) alone.
      if (error instanceof HarperEngineInitError) reset(error);
      call.reject(error);
    });
    // A worker that fails to load (or throws at the top level) never answers, so the pending calls
    // would hang forever. Treat it as the init failure it is and let the next call start a new worker.
    spawned.addEventListener('error', () => {
      reset(new HarperEngineInitError('The Harper grammar worker failed to start'));
    });
    // The worker answers strictly in order, so this lands before any lint the caller goes on to make.
    post(spawned, { method: 'setDialect', dialect: currentDialect }).catch(() => undefined);
    return spawned;
  }

  /**
   * Post one call to a specific worker and await its answer.
   *
   * @param target - The worker to post to.
   * @param call - The call to make.
   * @returns The worker's answer, whatever method it names.
   */
  function post(target: Worker, call: HarperCall): Promise<HarperValue> {
    const id = ++nextId;
    return new Promise<HarperValue>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      target.postMessage({ id, call } satisfies ToHarperWorker);
    });
  }

  /**
   * Make one engine call.
   *
   * The answer is returned as the whole {@link HarperValue} union: a call that wants a value narrows it
   * against its own method literal (which is what types the result with no assertion), and a call that
   * wants none simply ignores it. Correlation is by id, so a mismatch means a broken worker, not a race.
   *
   * @param call - The call to make.
   * @returns Whatever the worker answered.
   */
  function send(call: HarperCall): Promise<HarperValue> {
    return post(ensureWorker(), call);
  }

  return {
    async setup() {
      await send({ method: 'setup' });
    },
    async lint(segmentText) {
      const value = await send({ method: 'lint', segmentText });
      if (!isValueOf(value, 'lint')) throw mismatch('lint', value);
      return value.result;
    },
    async organizedLints(segmentText) {
      const value = await send({ method: 'organizedLints', segmentText });
      if (!isValueOf(value, 'organizedLints')) throw mismatch('organizedLints', value);
      return value.result;
    },
    async applySuggestion(segmentText, lint, suggestionIndex) {
      const value = await send({ method: 'applySuggestion', segmentText, lint, suggestionIndex });
      if (!isValueOf(value, 'applySuggestion')) throw mismatch('applySuggestion', value);
      return value.result;
    },
    async ignore(segmentText, lint) {
      await send({ method: 'ignore', segmentText, lint });
    },
    async importWords(words) {
      await send({ method: 'importWords', words });
    },
    async clearWords() {
      await send({ method: 'clearWords' });
    },
    async exportWords() {
      const value = await send({ method: 'exportWords' });
      if (!isValueOf(value, 'exportWords')) throw mismatch('exportWords', value);
      return value.result;
    },
    async importIgnoredLints(json) {
      await send({ method: 'importIgnoredLints', json });
    },
    async exportIgnoredLints() {
      const value = await send({ method: 'exportIgnoredLints' });
      if (!isValueOf(value, 'exportIgnoredLints')) throw mismatch('exportIgnoredLints', value);
      return value.result;
    },
    async setDialect(next) {
      currentDialect = next; // remembered so a worker respawned after a failure comes back on it
      await send({ method: 'setDialect', dialect: next });
    },
    async getLintConfig() {
      const value = await send({ method: 'getLintConfig' });
      if (!isValueOf(value, 'getLintConfig')) throw mismatch('getLintConfig', value);
      return value.result;
    },
    async setLintConfig(config) {
      await send({ method: 'setLintConfig', config });
    },
    async getLintDescriptions() {
      const value = await send({ method: 'getLintDescriptions' });
      if (!isValueOf(value, 'getLintDescriptions')) throw mismatch('getLintDescriptions', value);
      return value.result;
    },
    async dispose() {
      if (!worker) return; // never started — nothing to release
      const running = worker;
      try {
        await send({ method: 'dispose' });
      } finally {
        // Terminate whatever we were told: `dispose` may have failed, but the worker still has to go.
        //
        // Every call still in flight is failed on the way out, exactly as `reset` fails them. Merely
        // dropped, each one's `await` would never resume: the lint that was running when the editor
        // unmounted, or when grammar checking was switched off, would leave whatever follows it —
        // clearing a state flag, releasing a queue — permanently unrun.
        const abandoned = [...pending.values()];
        pending.clear();
        running.terminate();
        if (worker === running) worker = null;
        for (const call of abandoned) {
          call.reject(new Error('The Harper worker was disposed while this call was in flight'));
        }
      }
    },
  };
}
