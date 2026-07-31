import {
  createRubyPdfVm,
  RubyPdfVmError,
  RUBY_PDF_VM_ERROR,
} from '../../src/vm/ruby-pdf-vm';
import type { RubyValue, WasiBridge } from '../../src/vm/wasi-bridge';

// ---------------------------------------------------------------------------
// In-memory fake WasiBridge. The bridge surface is already fully typed, so no
// casts are needed here — the fake simply records the facade's delegations.
// ---------------------------------------------------------------------------

function makeValue(text: string): RubyValue {
  return {
    toString: () => text,
    toJS: () => ({ text }),
  };
}

class FakeBridge implements WasiBridge {
  ready = false;
  instantiateCount = 0;
  disposeCount = 0;
  readonly evals: string[] = [];
  readonly evalAsyncs: string[] = [];
  readonly writes: Array<{ path: string; data: Uint8Array }> = [];
  readonly reads: string[] = [];
  readonly removes: string[] = [];
  readonly readdirs: string[] = [];
  readonly existsCalls: string[] = [];
  instantiateImpl: () => Promise<void> = async () => undefined;

  async instantiate(): Promise<void> {
    await this.instantiateImpl();
    this.instantiateCount += 1;
    this.ready = true;
  }

  eval(code: string): RubyValue {
    this.evals.push(code);
    return makeValue(`sync:${code}`);
  }

  async evalAsync(code: string): Promise<RubyValue> {
    this.evalAsyncs.push(code);
    return makeValue(`async:${code}`);
  }

  writeFile(path: string, data: Uint8Array): void {
    this.writes.push({ path, data });
  }

  readFile(path: string): Uint8Array {
    this.reads.push(path);
    return new Uint8Array([1, 2, 3]);
  }

  removeFile(path: string): void {
    this.removes.push(path);
  }

  readdir(path: string): string[] {
    this.readdirs.push(path);
    return ['entry'];
  }

  exists(path: string): boolean {
    this.existsCalls.push(path);
    return true;
  }

  dispose(): void {
    this.disposeCount += 1;
    this.ready = false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function setup(configureBridge?: (bridge: FakeBridge, index: number) => void): {
  vm: ReturnType<typeof createRubyPdfVm>;
  bridges: FakeBridge[];
  factoryCalls: () => number;
} {
  const bridges: FakeBridge[] = [];
  let factoryCalls = 0;
  const vm = createRubyPdfVm({
    createBridge: () => {
      const bridge = new FakeBridge();
      configureBridge?.(bridge, factoryCalls);
      factoryCalls += 1;
      bridges.push(bridge);
      return bridge;
    },
  });
  return { vm, bridges, factoryCalls: () => factoryCalls };
}

describe('createRubyPdfVm', () => {
  describe('warmup', () => {
    it('lazily instantiates the bridge on first warmup and reports a cold start', async () => {
      const { vm, bridges, factoryCalls } = setup();

      expect(vm.ready).toBe(false);
      const outcome = await vm.warmup();

      expect(outcome.coldStart).toBe(true);
      expect(vm.ready).toBe(true);
      expect(factoryCalls()).toBe(1);
      expect(bridges[0]?.instantiateCount).toBe(1);
    });

    it('reuses the single warm VM across repeated warmups (idempotent), cold start only once', async () => {
      const { vm, bridges, factoryCalls } = setup();

      const first = await vm.warmup();
      const second = await vm.warmup();
      const third = await vm.warmup();

      expect([first.coldStart, second.coldStart, third.coldStart]).toEqual([true, false, false]);
      expect(factoryCalls()).toBe(1);
      expect(bridges).toHaveLength(1);
      expect(bridges[0]?.instantiateCount).toBe(1);
    });

    it('reuses the single warm VM across warmup + many evals — one instantiation', async () => {
      const { vm, bridges, factoryCalls } = setup();

      await vm.warmup();
      vm.eval('a');
      await vm.evalAsync('b');
      await vm.warmup();
      vm.eval('c');

      expect(factoryCalls()).toBe(1);
      expect(bridges).toHaveLength(1);
      expect(bridges[0]?.instantiateCount).toBe(1);
    });

    it('coalesces concurrent warmups into a single instantiation', async () => {
      const { vm, bridges, factoryCalls } = setup((bridge) => {
        bridge.instantiateImpl = () => delay(5);
      });

      const outcomes = await Promise.all([vm.warmup(), vm.warmup(), vm.warmup()]);

      expect(factoryCalls()).toBe(1);
      expect(bridges[0]?.instantiateCount).toBe(1);
      expect(outcomes.filter((o) => o.coldStart)).toHaveLength(1);
    });

    it('leaves the VM not-ready if instantiation fails and allows a retry', async () => {
      const boom = new Error('vm blew up');
      const { vm, factoryCalls } = setup((bridge, index) => {
        bridge.instantiateImpl = async () => {
          if (index === 0) {
            throw boom;
          }
        };
      });

      await expect(vm.warmup()).rejects.toBe(boom);
      expect(vm.ready).toBe(false);

      const retry = await vm.warmup();
      expect(retry.coldStart).toBe(true);
      expect(vm.ready).toBe(true);
      expect(factoryCalls()).toBe(2);
    });
  });

  describe('running ruby', () => {
    it('delegates eval to the warm bridge and returns the typed value', async () => {
      const { vm, bridges } = setup();
      await vm.warmup();

      const value = vm.eval('1 + 2');
      expect(bridges[0]?.evals).toEqual(['1 + 2']);
      expect(value.toString()).toBe('sync:1 + 2');
    });

    it('delegates evalAsync to the warm bridge', async () => {
      const { vm, bridges } = setup();
      await vm.warmup();

      const value = await vm.evalAsync('sleep 0');
      expect(bridges[0]?.evalAsyncs).toEqual(['sleep 0']);
      expect(value.toString()).toBe('async:sleep 0');
    });

    it('throws NOT_WARMED when eval runs before warmup', () => {
      const { vm } = setup();
      expect.assertions(2);
      try {
        vm.eval('1');
      } catch (error) {
        expect(error).toBeInstanceOf(RubyPdfVmError);
        expect((error as RubyPdfVmError).code).toBe(RUBY_PDF_VM_ERROR.NOT_WARMED);
      }
    });

    it('rejects evalAsync before warmup', async () => {
      const { vm } = setup();
      await expect(vm.evalAsync('1')).rejects.toBeInstanceOf(RubyPdfVmError);
    });
  });

  describe('VFS access', () => {
    it('delegates write/read/remove/readdir/exists to the warm bridge', async () => {
      const { vm, bridges } = setup();
      await vm.warmup();
      const bridge = bridges[0];

      const bytes = new Uint8Array([9]);
      vm.writeFile('/project/a.adoc', bytes);
      const read = vm.readFile('/out/doc.pdf');
      vm.removeFile('/tmp/scratch');
      const listing = vm.readdir('/project');
      const present = vm.exists('/project/a.adoc');

      expect(bridge?.writes).toEqual([{ path: '/project/a.adoc', data: bytes }]);
      expect(bridge?.reads).toEqual(['/out/doc.pdf']);
      expect([...read]).toEqual([1, 2, 3]);
      expect(bridge?.removes).toEqual(['/tmp/scratch']);
      expect(bridge?.readdirs).toEqual(['/project']);
      expect(listing).toEqual(['entry']);
      expect(bridge?.existsCalls).toEqual(['/project/a.adoc']);
      expect(present).toBe(true);
    });

    it('throws NOT_WARMED for VFS access before warmup', () => {
      const { vm } = setup();
      expect(() => vm.writeFile('/project/x', new Uint8Array())).toThrow(RubyPdfVmError);
      expect(() => vm.readFile('/out/x')).toThrow(RubyPdfVmError);
      expect(() => vm.readdir('/project')).toThrow(RubyPdfVmError);
      expect(() => vm.exists('/project/x')).toThrow(RubyPdfVmError);
      expect(() => vm.removeFile('/tmp/x')).toThrow(RubyPdfVmError);
    });
  });

  describe('dispose', () => {
    it('tears the VM down so it is no longer ready', async () => {
      const { vm, bridges } = setup();
      await vm.warmup();
      expect(vm.ready).toBe(true);

      vm.dispose();
      expect(vm.ready).toBe(false);
      expect(bridges[0]?.disposeCount).toBe(1);
      expect(() => vm.eval('1')).toThrow(RubyPdfVmError);
    });

    it('allows a fresh cold-start re-instantiation after dispose', async () => {
      const { vm, bridges, factoryCalls } = setup();
      await vm.warmup();
      vm.dispose();

      const outcome = await vm.warmup();
      expect(outcome.coldStart).toBe(true);
      expect(vm.ready).toBe(true);
      expect(factoryCalls()).toBe(2);
      expect(bridges).toHaveLength(2);
      expect(bridges[1]?.instantiateCount).toBe(1);
    });

    it('is a no-op when disposing a VM that was never warmed', () => {
      const { vm, factoryCalls } = setup();
      expect(() => vm.dispose()).not.toThrow();
      expect(vm.ready).toBe(false);
      expect(factoryCalls()).toBe(0);
    });
  });

  describe('render budget', () => {
    it('never lets a second render run on the instance that served the first', async () => {
      const { vm, bridges, factoryCalls } = setup();

      await vm.warmup();
      vm.renderCompleted();
      const second = await vm.warmup();

      expect(second.coldStart).toBe(true);
      expect(factoryCalls()).toBe(2);
      expect(bridges[0]?.disposeCount).toBe(1);
      expect(bridges[1]?.instantiateCount).toBe(1);
    });

    it('disposes the spent instance BEFORE instantiating its replacement, so the two never coexist', async () => {
      const liveAtInstantiate: boolean[] = [];
      const { vm, bridges } = setup((bridge, index) => {
        bridge.instantiateImpl = async () => {
          liveAtInstantiate.push(bridges.slice(0, index).some((earlier) => earlier.ready));
        };
      });

      await vm.warmup();
      vm.renderCompleted();
      await vm.warmup();

      expect(liveAtInstantiate).toEqual([false, false]);
    });

    it('keeps a pre-warmed instance that has not rendered — pre-warming is not wasted', async () => {
      const { vm, bridges, factoryCalls } = setup();

      await vm.warmup();
      await vm.warmup();
      await vm.warmup();

      expect(factoryCalls()).toBe(1);
      expect(bridges[0]?.disposeCount).toBe(0);
    });

    it('serves the render that follows a boot, then retires that instance in turn', async () => {
      const { vm, factoryCalls } = setup();

      await vm.warmup();
      vm.renderCompleted();
      await vm.warmup();
      vm.renderCompleted();
      await vm.warmup();

      expect(factoryCalls()).toBe(3);
    });

    it('ignores a completed render reported with no instance to attribute it to', async () => {
      const { vm, factoryCalls } = setup();

      expect(() => vm.renderCompleted()).not.toThrow();
      const outcome = await vm.warmup();

      // The report landed on nothing, so the instance booted next is fresh and still owes a render.
      expect(outcome.coldStart).toBe(true);
      await vm.warmup();
      expect(factoryCalls()).toBe(1);
    });
  });
});
