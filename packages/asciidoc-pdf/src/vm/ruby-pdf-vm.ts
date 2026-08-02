/**
 * @file The VM lifecycle facade layered over the typed {@link WasiBridge}. It owns one Ruby VM
 * instance at a time, hands it to the convert path, and decides when that instance has to be replaced.
 * The convert invocation and the web worker program against this small facade rather than touching the
 * bridge (or the raw interop libraries) directly.
 *
 * The instance is instantiated lazily and can be pre-warmed, but it is NOT kept for the session: an
 * instance serves {@link RENDERS_PER_VM_INSTANCE} render and is then retired at the next warmup. That
 * is a measured decision, not a cautious one — see the constant, which records what reuse actually
 * cost. The expensive part of a cold start is compiling the wasm module, and that is not repeated: the
 * compiled `WebAssembly.Module` is supplied by the composition root and shared by every instance, so a
 * replacement costs an instantiation (~120 ms), not a compile.
 *
 * The bridge is dependency-injected via a factory ({@link RubyPdfVmDeps.createBridge}) so unit tests
 * pass an in-memory fake bridge and production supplies `() => createWasiBridge({ module })` at the
 * composition root. No real interop library is bound here.
 */

import type { RubyValue, WasiBridge } from './wasi-bridge';

// ---------------------------------------------------------------------------
// Errors (no magic strings).
// ---------------------------------------------------------------------------

/**
 * How many renders one VM instance may serve before it is retired and the next warmup boots a fresh
 * one.
 *
 * It is `1` because that is what measurement against the real engine supports, and the margin is not
 * close. Rendering the same 1,500-line document eight times in a row through one instance: the first
 * render took 6.7 s, the second 21.9 s, the third 22.3 s, and the fourth failed outright — the
 * instance's memory climbed monotonically (1.1 GiB, 2.0 GiB, 3.0 GiB, …) until it exhausted the 4 GiB
 * a 32-bit runtime can address, after which nothing rendered in it again. The same eight renders each
 * in their own instance took 6.5–6.7 s, every one of them, and all eight succeeded. The instance never
 * gives the memory back, so the SECOND render is already the expensive one; there is no budget above
 * one that buys anything.
 *
 * The boot this costs is small and measured: ~120 ms to instantiate against an already-compiled
 * module, against a render of several seconds. Reuse was saving that 120 ms and paying 15 s for it.
 */
export const RENDERS_PER_VM_INSTANCE = 1;

/** Structured error codes surfaced by the VM facade. */
export const RUBY_PDF_VM_ERROR = {
  /** An operation that needs a running VM was called before {@link RubyPdfVm.warmup}. */
  NOT_WARMED: 'not-warmed',
} as const;

/** The union of structured error codes the VM facade can raise. */
export type RubyPdfVmErrorCode = (typeof RUBY_PDF_VM_ERROR)[keyof typeof RUBY_PDF_VM_ERROR];

/** A typed error raised by the VM facade. */
export class RubyPdfVmError extends Error {
  /**
   * Carry the structured code alongside the human-readable message.
   *
   * @param code - The structured error code identifying the failure.
   * @param message - The human-readable explanation forwarded to `Error`.
   */
  constructor(
    readonly code: RubyPdfVmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RubyPdfVmError';
  }
}

// ---------------------------------------------------------------------------
// Facade surface.
// ---------------------------------------------------------------------------

/** The outcome of a {@link RubyPdfVm.warmup} call. */
export interface WarmupOutcome {
  /**
   * `true` when this call actually instantiated a VM — the session's first, or a replacement for an
   * instance that had spent its render budget; `false` when it reused the existing instance.
   *
   * This is the flag a boot COST is attributed to. Because an instance serves
   * {@link RENDERS_PER_VM_INSTANCE} render, booting is the normal case rather than the exception, and
   * the ~120 ms it takes is a per-render cost that has to stay visible in the timing breakdown.
   */
  readonly booted: boolean;
  /**
   * `true` only on the boot that started the engine for this session: the first successful
   * instantiation, and the first one after an explicit {@link RubyPdfVm.dispose} tore the engine down.
   *
   * Reported separately from {@link WarmupOutcome.booted} because the two answer different questions.
   * "Did this call boot an instance?" is a measurement. "Is the engine starting up?" is something an
   * author is TOLD, and the replacement instance each render gets is not that: announcing it would put
   * a start-up notice on screen on every edit, describing something the author experienced once.
   */
  readonly firstBoot: boolean;
}

/** Low-level dependency: how to construct a fresh {@link WasiBridge} for a cold start. */
export interface RubyPdfVmDeps {
  /**
   * Build a not-yet-instantiated bridge. Invoked once per boot — the first warmup, a warmup after
   * {@link RubyPdfVm.dispose}, and a warmup that replaces an instance which has served its render
   * budget. Production passes `() => createWasiBridge({ module })`; tests inject an in-memory fake.
   */
  createBridge: () => WasiBridge;
}

/**
 * The VM facade the convert path and the worker program against: the current Ruby VM instance, with
 * accessors to run Ruby ({@link RubyPdfVm.eval}/{@link RubyPdfVm.evalAsync}) and pass-through VFS
 * access, all delegating to the underlying {@link WasiBridge}.
 */
export interface RubyPdfVm {
  /** Whether a VM instance is currently live and ready to serve evals / VFS access. */
  readonly ready: boolean;
  /**
   * Instantiate the VM if there is no usable instance, and reuse the existing one otherwise.
   * Idempotent for pre-warming: repeated calls (and concurrent ones) against an instance that has not
   * yet served its render budget resolve to that same instance, and only a genuine boot reports
   * `booted: true`.
   *
   * An instance that has spent its {@link RENDERS_PER_VM_INSTANCE} budget is NOT reused: this call
   * disposes it and boots a replacement, reporting `booted: true` — but `firstBoot: false`, because the
   * engine has been running all along.
   *
   * @returns The warmup outcome: whether this call booted, and whether that boot started the engine.
   */
  warmup(): Promise<WarmupOutcome>;
  /**
   * Record that the current instance has just served a render.
   *
   * Called by the convert path once a render has finished, whether it succeeded or failed — a failed
   * render has already allocated, and a failure is very often the memory exhaustion this budget exists
   * to prevent, so the instance that produced it is the last one that should serve the retry.
   *
   * The instance is retired lazily, at the next {@link RubyPdfVm.warmup}, rather than being torn down
   * here. Tearing it down at the end of a render would free its memory a little sooner, but it would
   * also invalidate every VFS accessor between renders — and callers legitimately read the VM's
   * filesystem after a convert returns. Deferring the disposal to the next warmup keeps that surface
   * working while still guaranteeing that no render ever runs on an instance that has already served
   * one, which is where the whole cost was. It also costs nothing in peak memory: the outgoing
   * instance is disposed BEFORE its replacement is instantiated.
   */
  renderCompleted(): void;
  /**
   * Evaluate Ruby synchronously against the current VM instance.
   *
   * @param code - The Ruby source run against the VM.
   * @returns The value the evaluated Ruby produced.
   */
  eval(code: string): RubyValue;
  /**
   * Evaluate Ruby that may `await` JS promises against the current VM instance.
   *
   * @param code - The Ruby source run against the VM.
   * @returns The value the evaluated Ruby resolves to.
   */
  evalAsync(code: string): Promise<RubyValue>;
  /**
   * Write bytes into the in-memory VFS.
   *
   * @param path - The VFS path the bytes are written to.
   * @param data - The raw content stored at that path.
   */
  writeFile(path: string, data: Uint8Array): void;
  /**
   * Read bytes back from the in-memory VFS.
   *
   * @param path - The VFS path to read.
   * @returns The bytes stored at that path.
   */
  readFile(path: string): Uint8Array;
  /**
   * Remove a file from the in-memory VFS (no-op when absent).
   *
   * @param path - The VFS path whose file is deleted.
   */
  removeFile(path: string): void;
  /**
   * List the immediate entry names of a VFS directory.
   *
   * @param path - The VFS directory whose entries are enumerated.
   * @returns The immediate entry names within that directory.
   */
  readdir(path: string): string[];
  /**
   * Whether a VFS path exists.
   *
   * @param path - The VFS path to probe for occupancy.
   * @returns `true` when the path exists in the VFS.
   */
  exists(path: string): boolean;
  /** Tear the VM down; the facade becomes not-ready and the next warmup performs a fresh cold start. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Implementation.
// ---------------------------------------------------------------------------

class RubyPdfVmImpl implements RubyPdfVm {
  private bridge: WasiBridge | null = null;
  private warmupInFlight: Promise<void> | null = null;
  /** Renders the CURRENT instance has served; reset every time a fresh instance is booted. */
  private rendersServed = 0;
  /**
   * Whether an instance has EVER booted since this facade was last torn down. Survives the retirement
   * of a spent instance — retiring one and booting its replacement is this facade doing its job, not
   * the engine starting up — and is cleared only by {@link RubyPdfVmImpl.dispose}, after which nothing
   * is holding an engine and the next boot genuinely starts one again.
   */
  private engineStarted = false;

  constructor(private readonly deps: RubyPdfVmDeps) {}

  get ready(): boolean {
    return this.bridge !== null && this.bridge.ready;
  }

  async warmup(): Promise<WarmupOutcome> {
    if (this.ready && this.rendersServed >= RENDERS_PER_VM_INSTANCE) {
      // Retire the spent instance before instantiating its replacement, so the two never coexist and
      // the peak is one VM's worth of memory rather than two.
      this.disposeBridge();
    }
    if (this.ready) {
      return { booted: false, firstBoot: false };
    }
    if (this.warmupInFlight !== null) {
      // Someone else's boot is what will serve this caller; only the call that performed it reports it.
      await this.warmupInFlight;
      return { booted: false, firstBoot: false };
    }

    const bridge = this.deps.createBridge();
    this.bridge = bridge;
    const inFlight = bridge.instantiate();
    this.warmupInFlight = inFlight;
    try {
      await inFlight;
    } catch (error) {
      // A failed cold start leaves no usable VM; drop the bridge so a retry starts clean.
      this.bridge = null;
      throw error;
    } finally {
      this.warmupInFlight = null;
    }
    this.rendersServed = 0;
    // Recorded only after a SUCCESSFUL instantiation: a boot that threw left no engine running, so the
    // retry after it is still the one that starts the session's engine.
    const firstBoot = !this.engineStarted;
    this.engineStarted = true;
    return { booted: true, firstBoot };
  }

  renderCompleted(): void {
    if (this.bridge === null) {
      return;
    }
    this.rendersServed += 1;
  }

  eval(code: string): RubyValue {
    return this.requireBridge().eval(code);
  }

  async evalAsync(code: string): Promise<RubyValue> {
    return this.requireBridge().evalAsync(code);
  }

  writeFile(path: string, data: Uint8Array): void {
    this.requireBridge().writeFile(path, data);
  }

  readFile(path: string): Uint8Array {
    return this.requireBridge().readFile(path);
  }

  removeFile(path: string): void {
    this.requireBridge().removeFile(path);
  }

  readdir(path: string): string[] {
    return this.requireBridge().readdir(path);
  }

  exists(path: string): boolean {
    return this.requireBridge().exists(path);
  }

  dispose(): void {
    this.disposeBridge();
    this.warmupInFlight = null;
    this.engineStarted = false;
  }

  /** Tear the current instance down and forget what it served, leaving the facade not-ready. */
  private disposeBridge(): void {
    if (this.bridge !== null) {
      this.bridge.dispose();
      this.bridge = null;
    }
    this.rendersServed = 0;
  }

  private requireBridge(): WasiBridge {
    if (this.bridge === null || !this.bridge.ready) {
      throw new RubyPdfVmError(
        RUBY_PDF_VM_ERROR.NOT_WARMED,
        'Ruby PDF VM has not been warmed up; call warmup() first',
      );
    }
    return this.bridge;
  }
}

/**
 * Create a VM facade over a dependency-injected {@link WasiBridge} factory. The VM is instantiated
 * lazily on the first {@link RubyPdfVm.warmup} and replaced once it has served
 * {@link RENDERS_PER_VM_INSTANCE} render.
 */
export function createRubyPdfVm(deps: RubyPdfVmDeps): RubyPdfVm {
  return new RubyPdfVmImpl(deps);
}
