// The two low-level libraries the adapter binds lazily are ESM-only and pull in a wasm engine, so the
// real-library binding is exercised against in-memory stand-ins that keep the same construction shapes.
jest.mock('@bjorn3/browser_wasi_shim', () => {
  class MockFile {
    constructor(public data: Uint8Array) {}
  }
  class MockOpenFile {
    constructor(public file: MockFile) {}
  }
  class MockDirectory {
    contents: Map<string, unknown>;
    constructor(entries: Iterable<[string, unknown]> = []) {
      this.contents = new Map(entries);
    }
  }
  class MockPreopenDirectory {
    constructor(
      public prestatName: string,
      public contents: Map<string, unknown>,
    ) {}
  }
  class MockWasi {
    readonly wasiImport: Record<string, unknown> = { fd_write: () => 0 };
    constructor(
      public arguments_: string[],
      public environment: string[],
      public fds: unknown[],
    ) {}
    initialize(): void {}
  }
  return {
    WASI: MockWasi,
    File: MockFile,
    OpenFile: MockOpenFile,
    Directory: MockDirectory,
    PreopenDirectory: MockPreopenDirectory,
  };
});

jest.mock('@ruby/wasm-wasi', () => ({
  RubyVM: {
    instantiateModule: async (): Promise<{ vm: { eval: (code: string) => unknown } }> => ({
      vm: {
        eval: (code: string) => ({ toString: () => code, toJS: () => code }),
      },
    }),
  },
}));

import {
  createWasiBridge,
  loadDefaultDeps,
  WasiBridgeError,
  WASI_BRIDGE_ERROR,
  WRITABLE_MOUNT_PATHS,
  type RubyValue,
  type RubyVmInstance,
  type VmInstantiateOptions,
  type WasiBridgeDeps,
  type WasiDirectory,
  type WasiFile,
  type WasiInstance,
  type WasiNode,
  type WasiPreopen,
} from '../../src/vm/wasi-bridge';

// ---------------------------------------------------------------------------
// In-memory fakes for the (otherwise ESM-only / loosely typed) low-level libs.
// Casts here live in TEST code, not production — the adapter surface is typed.
// ---------------------------------------------------------------------------

class FakeFile implements WasiFile {
  constructor(public data: Uint8Array) {}
}

class FakeDirectory implements WasiDirectory {
  contents: Map<string, WasiNode>;
  constructor(entries: [string, WasiNode][]) {
    this.contents = new Map(entries);
  }
}

interface FakePreopen {
  name: string;
  dir: WasiDirectory;
}

class FakeRubyValue implements RubyValue {
  constructor(
    private readonly text: string,
    private readonly js: unknown,
  ) {}
  toString(): string {
    return this.text;
  }
  toJS(): unknown {
    return this.js;
  }
}

interface Recorder {
  createWasi: Array<{ args: string[]; env: string[]; preopens: WasiPreopen[] }>;
  instantiateVm: VmInstantiateOptions[];
  preopens: Array<{ name: string; dir: WasiDirectory }>;
  evals: string[];
  evalAsyncs: string[];
}

function makeDeps(overrides: Partial<WasiBridgeDeps> = {}): {
  deps: WasiBridgeDeps;
  rec: Recorder;
  vm: RubyVmInstance;
} {
  const rec: Recorder = {
    createWasi: [],
    instantiateVm: [],
    preopens: [],
    evals: [],
    evalAsyncs: [],
  };

  const wasi: WasiInstance = {
    wasiImport: {},
    initialize: () => undefined,
  };

  const vm: RubyVmInstance = {
    eval: (code: string): RubyValue => {
      rec.evals.push(code);
      return new FakeRubyValue(`sync:${code}`, { code });
    },
    evalAsync: async (code: string): Promise<RubyValue> => {
      rec.evalAsyncs.push(code);
      return new FakeRubyValue(`async:${code}`, { code });
    },
  };

  const deps: WasiBridgeDeps = {
    createWasi: (arguments_, environment, preopens) => {
      rec.createWasi.push({ args: arguments_, env: environment, preopens });
      return wasi;
    },
    instantiateVm: async (options) => {
      rec.instantiateVm.push(options);
      return { vm };
    },
    createFile: (data) => new FakeFile(data),
    createDirectory: (entries) => new FakeDirectory(entries),
    createPreopen: (name, directory) => {
      rec.preopens.push({ name, dir: directory });
      const preopen: FakePreopen = { name, dir: directory };
      return preopen as unknown as WasiPreopen;
    },
    ...overrides,
  };

  return { deps, rec, vm };
}

const MODULE = {} as unknown as WebAssembly.Module;

describe('createWasiBridge', () => {
  describe('instantiate', () => {
    it('creates a preopen for each writable mount and hands them to the WASI factory', async () => {
      const { deps, rec } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);

      expect(bridge.ready).toBe(false);
      await bridge.instantiate();

      expect(bridge.ready).toBe(true);
      expect(rec.preopens.map((p) => p.name)).toEqual([...WRITABLE_MOUNT_PATHS]);
      expect(rec.createWasi).toHaveLength(1);
      expect(rec.createWasi[0]?.preopens).toHaveLength(WRITABLE_MOUNT_PATHS.length);
    });

    it('passes the module through to the VM factory with the WASI shim', async () => {
      const { deps, rec } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      expect(rec.instantiateVm).toHaveLength(1);
      expect(rec.instantiateVm[0]?.module).toBe(MODULE);
      expect(rec.instantiateVm[0]?.wasip1).toBeDefined();
    });

    it('honors custom args and env', async () => {
      const { deps, rec } = makeDeps();
      const arguments_ = ['ruby.wasm', '-e_=0'];
      const environment = ['RUBYOPT=-EUTF-8'];
      const bridge = createWasiBridge({ module: MODULE, args: arguments_, env: environment }, deps);
      await bridge.instantiate();

      expect(rec.createWasi[0]?.args).toEqual(arguments_);
      expect(rec.createWasi[0]?.env).toEqual(environment);
      expect(rec.instantiateVm[0]?.args).toEqual(arguments_);
    });

    it('is idempotent — a second call does not re-instantiate', async () => {
      const { deps, rec } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();
      await bridge.instantiate();

      expect(rec.createWasi).toHaveLength(1);
      expect(rec.instantiateVm).toHaveLength(1);
    });

    it('leaves the bridge not-ready if the VM factory rejects', async () => {
      const boom = new Error('vm blew up');
      const { deps } = makeDeps({
        instantiateVm: async () => {
          throw boom;
        },
      });
      const bridge = createWasiBridge({ module: MODULE }, deps);

      await expect(bridge.instantiate()).rejects.toBe(boom);
      expect(bridge.ready).toBe(false);
    });
  });

  describe('eval / evalAsync', () => {
    it('delegates eval and maps the result to the typed RubyValue surface', async () => {
      const { deps, rec } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      const result = bridge.eval('1 + 2');
      expect(rec.evals).toEqual(['1 + 2']);
      expect(result.toString()).toBe('sync:1 + 2');
      expect(result.toJS()).toEqual({ code: '1 + 2' });
    });

    it('delegates evalAsync', async () => {
      const { deps, rec } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      const result = await bridge.evalAsync('sleep 0');
      expect(rec.evalAsyncs).toEqual(['sleep 0']);
      expect(result.toString()).toBe('async:sleep 0');
    });

    it('throws a NOT_READY bridge error when eval runs before instantiate', () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);

      expect.assertions(2);
      try {
        bridge.eval('1');
      } catch (error) {
        expect(error).toBeInstanceOf(WasiBridgeError);
        expect((error as WasiBridgeError).code).toBe(WASI_BRIDGE_ERROR.NOT_READY);
      }
    });

    it('rejects evalAsync before instantiate', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await expect(bridge.evalAsync('1')).rejects.toBeInstanceOf(WasiBridgeError);
    });
  });

  describe('read/write-through to the in-memory VFS', () => {
    it('round-trips bytes written under /project (creating nested dirs)', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      const bytes = new TextEncoder().encode('= Title\n');
      bridge.writeFile('/project/chapters/intro.adoc', bytes);

      const back = bridge.readFile('/project/chapters/intro.adoc');
      expect([...back]).toEqual([...bytes]);
    });

    it('overwrites an existing file in place', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      bridge.writeFile('/out/doc.pdf', new Uint8Array([1, 2, 3]));
      bridge.writeFile('/out/doc.pdf', new Uint8Array([9]));
      expect([...bridge.readFile('/out/doc.pdf')]).toEqual([9]);
    });

    it('reads back a produced artifact from /out', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      bridge.writeFile('/out/report.pdf', pdf);
      expect([...bridge.readFile('/out/report.pdf')]).toEqual([...pdf]);
    });

    it('lists directory entries and reports existence', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      bridge.writeFile('/project/a.adoc', new Uint8Array([1]));
      bridge.writeFile('/project/b.adoc', new Uint8Array([2]));

      expect(bridge.readdir('/project').toSorted()).toEqual(['a.adoc', 'b.adoc']);
      expect(bridge.exists('/project/a.adoc')).toBe(true);
      expect(bridge.exists('/project/missing.adoc')).toBe(false);
    });

    it('removes a file', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      bridge.writeFile('/tmp/scratch', new Uint8Array([1]));
      expect(bridge.exists('/tmp/scratch')).toBe(true);
      bridge.removeFile('/tmp/scratch');
      expect(bridge.exists('/tmp/scratch')).toBe(false);
    });

    it('creates intermediate directories via the injected directory factory', async () => {
      const { deps, rec } = makeDeps();
      const created: number = rec.preopens.length;
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      // The three mount roots are created during instantiate.
      expect(created).toBe(0);
      bridge.writeFile('/project/deep/nested/file.txt', new Uint8Array([7]));
      expect(bridge.exists('/project/deep/nested/file.txt')).toBe(true);
    });
  });

  describe('path validation (defense in depth)', () => {
    it('rejects a non-absolute path', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();
      expect(() => bridge.writeFile('project/x', new Uint8Array())).toThrow(WasiBridgeError);
    });

    it('rejects a path outside the writable mounts', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();
      try {
        bridge.writeFile('/usr/evil', new Uint8Array());
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as WasiBridgeError).code).toBe(WASI_BRIDGE_ERROR.INVALID_PATH);
      }
    });

    it('rejects a traversal segment', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();
      expect(() => bridge.writeFile('/project/../out/x', new Uint8Array())).toThrow(WasiBridgeError);
    });

    it('throws NOT_FOUND when reading a missing file', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();
      try {
        bridge.readFile('/project/nope.adoc');
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as WasiBridgeError).code).toBe(WASI_BRIDGE_ERROR.NOT_FOUND);
      }
    });

    it('rejects VFS access before instantiate', () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      expect(() => bridge.writeFile('/project/x', new Uint8Array())).toThrow(WasiBridgeError);
    });

    it('refuses to overwrite a directory with file bytes', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      // Writing a nested file makes /project/dir a directory node.
      bridge.writeFile('/project/dir/child', new Uint8Array([1]));
      try {
        bridge.writeFile('/project/dir', new Uint8Array([2]));
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as WasiBridgeError).code).toBe(WASI_BRIDGE_ERROR.INVALID_PATH);
      }
    });

    it('refuses to write through a path whose intermediate segment is a file', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      bridge.writeFile('/project/note', new Uint8Array([1]));
      try {
        bridge.writeFile('/project/note/child', new Uint8Array([2]));
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as WasiBridgeError).code).toBe(WASI_BRIDGE_ERROR.INVALID_PATH);
      }
    });

    it('rejects a mount-root path with no file name on write', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();
      expect(() => bridge.writeFile('/project', new Uint8Array())).toThrow(WasiBridgeError);
    });

    it('throws NOT_FOUND when listing a non-directory path', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      bridge.writeFile('/project/file.adoc', new Uint8Array([1]));
      try {
        bridge.readdir('/project/file.adoc');
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as WasiBridgeError).code).toBe(WASI_BRIDGE_ERROR.NOT_FOUND);
      }
    });

    it('reports a mount root as existing and treats descent into a file as absent', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      // A mount root itself has no path segments and is always present.
      expect(bridge.exists('/project')).toBe(true);

      // Descending past a leaf file returns "not found" rather than throwing.
      bridge.writeFile('/project/leaf', new Uint8Array([1]));
      expect(bridge.exists('/project/leaf/below')).toBe(false);
    });

    it('rejects removing a mount root (no file name)', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();
      expect(() => bridge.removeFile('/project')).toThrow(WasiBridgeError);
    });

    it('silently no-ops removeFile when the parent directory is absent', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();
      // Parent /project/ghost never existed — removal must be a no-op, not a throw.
      expect(() => bridge.removeFile('/project/ghost/child')).not.toThrow();
    });
  });

  describe('dispose', () => {
    it('tears the VM down so the bridge is no longer ready', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();
      expect(bridge.ready).toBe(true);

      bridge.dispose();
      expect(bridge.ready).toBe(false);
      expect(() => bridge.eval('1')).toThrow(WasiBridgeError);
    });

    it('can be re-instantiated after dispose', async () => {
      const { deps, rec } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();
      bridge.dispose();
      await bridge.instantiate();
      expect(rec.createWasi).toHaveLength(2);
      expect(bridge.ready).toBe(true);
    });
  });

  describe('writing under a path whose parent is a file', () => {
    it('reuses a directory it already created for a sibling file', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      bridge.writeFile('/project/chapters/one.adoc', new Uint8Array([1]));
      bridge.writeFile('/project/chapters/two.adoc', new Uint8Array([2]));

      expect(bridge.readdir('/project/chapters').toSorted()).toEqual(['one.adoc', 'two.adoc']);
      expect(bridge.readFile('/project/chapters/one.adoc')).toEqual(new Uint8Array([1]));
    });

    it('refuses to descend through a regular file to reach a parent directory', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();
      bridge.writeFile('/project/book.adoc', new Uint8Array([1]));

      expect(() => bridge.writeFile('/project/book.adoc/nested.txt', new Uint8Array([2]))).toThrow(
        WasiBridgeError,
      );
      try {
        bridge.writeFile('/project/book.adoc/nested.txt', new Uint8Array([2]));
      } catch (error) {
        expect((error as WasiBridgeError).code).toBe(WASI_BRIDGE_ERROR.INVALID_PATH);
        expect((error as WasiBridgeError).message).toContain('is not a directory');
      }
    });
  });

  describe('the bare root path', () => {
    it('refuses a path that names a mount root and nothing else', async () => {
      const { deps } = makeDeps();
      const bridge = createWasiBridge({ module: MODULE }, deps);
      await bridge.instantiate();

      expect(() => bridge.readFile('/')).toThrow(WasiBridgeError);
      try {
        bridge.readFile('/');
      } catch (error) {
        expect((error as WasiBridgeError).code).toBe(WASI_BRIDGE_ERROR.INVALID_PATH);
        expect((error as WasiBridgeError).message).toContain('bare root');
      }
    });
  });
});

describe('loadDefaultDeps', () => {
  it('allocates files and directories the VFS layer can read back', async () => {
    const deps = await loadDefaultDeps();

    const bytes = new Uint8Array([1, 2, 3]);
    const file = deps.createFile(bytes);
    expect(file.data).toBe(bytes);

    const directory = deps.createDirectory([['a.txt', file]]);
    expect(directory.contents.get('a.txt')).toBe(file);

    const empty = deps.createDirectory([]);
    expect(empty.contents.size).toBe(0);
  });

  it('builds a WASI shim over the preopened mounts and instantiates the VM against it', async () => {
    const deps = await loadDefaultDeps();

    const root = deps.createDirectory([]);
    const preopen = deps.createPreopen('/project', root);
    expect(preopen).toBeDefined();

    const wasi = deps.createWasi(['ruby.wasm'], ['RUBYOPT=-EUTF-8'], [preopen]);
    expect(wasi.wasiImport).toBeDefined();
    expect(typeof wasi.initialize).toBe('function');

    const { vm } = await deps.instantiateVm({ module: MODULE, wasip1: wasi, args: ['ruby.wasm'] });
    expect(vm.eval('1 + 1').toString()).toBe('1 + 1');
  });
});

describe('createWasiBridge without injected dependencies', () => {
  it('binds the real libraries on instantiate and serves its mounts from them', async () => {
    const bridge = createWasiBridge({ module: MODULE });

    await bridge.instantiate();

    expect(bridge.ready).toBe(true);
    const payload = new TextEncoder().encode('= Title');
    bridge.writeFile('/project/book.adoc', payload);
    expect(bridge.readFile('/project/book.adoc')).toEqual(payload);
    expect(bridge.readdir('/project')).toEqual(['book.adoc']);
    expect(bridge.exists('/project/book.adoc')).toBe(true);
  });
});
