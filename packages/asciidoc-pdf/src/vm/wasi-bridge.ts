/**
 * @file Typed adapter over the (ESM-only, loosely typed) `@ruby/wasm-wasi` +
 * `@bjorn3/browser_wasi_shim` interop libraries. It is the SINGLE place in the package where the
 * untyped/structurally-mismatched surface of those libraries is touched: every `any`/`as` needed to
 * bridge them is confined here, behind a narrow fully-typed {@link WasiBridge} interface. The warm-VM
 * lifecycle, the Ruby convert invocation, the VFS population layer, and the web worker all program
 * against this typed surface so no interop cast ever leaks into the rest of the codebase.
 *
 * The adapter is dependency-injected: {@link createWasiBridge} takes the low-level factories
 * (WASI shim, Ruby-VM instantiation, in-memory filesystem primitives) so unit tests can pass
 * in-memory fakes, while production omits them and the real libraries are lazily bound on
 * {@link WasiBridge.instantiate}.
 */

// ---------------------------------------------------------------------------
// Narrow typed surface the rest of the codebase programs against.
// ---------------------------------------------------------------------------

/** A Ruby value returned from an evaluation, projected to the two accessors callers need. */
export interface RubyValue {
  /**
   * The Ruby `to_s` representation.
   *
   * @returns The value rendered as its Ruby `to_s` string.
   */
  toString(): string;
  /**
   * The Ruby `to_js` projection, or a plain JS value; `unknown` — callers must narrow.
   *
   * @returns The value projected to JavaScript, which callers must narrow before use.
   */
  toJS(): unknown;
}

/** The subset of the Ruby VM the bridge relies on. */
export interface RubyVmInstance {
  /**
   * Evaluate a Ruby source string synchronously in the VM.
   *
   * @param code - The Ruby source to evaluate.
   * @returns The value the expression evaluates to.
   */
  eval(code: string): RubyValue;
  /**
   * Evaluate a Ruby source string, awaiting any JS promises it suspends on.
   *
   * @param code - The Ruby source to evaluate.
   * @returns A promise resolving to the value the expression evaluates to.
   */
  evalAsync(code: string): Promise<RubyValue>;
}

/** The subset of a WASI Preview 1 shim the Ruby VM instantiation requires. */
export interface WasiInstance {
  /** The WASI Preview 1 host functions to supply to the wasm module as its import object. */
  readonly wasiImport: WebAssembly.ModuleImports;
  /**
   * Bind the shim to a freshly instantiated wasm instance so later host calls act on its memory.
   *
   * @param instance - The instantiated wasm instance the shim should operate against.
   */
  initialize(instance: WebAssembly.Instance): void;
}

/** Options passed to the Ruby-VM module instantiation. */
export interface VmInstantiateOptions {
  /** The compiled Ruby-with-JS wasm module to instantiate. */
  module: WebAssembly.Module;
  /** The WASI Preview 1 shim supplying the module's host imports. */
  wasip1: WasiInstance;
  /** Optional ARGV for the VM; the first entry is the program name. */
  args?: string[];
}

/** An in-memory regular file node in the WASI VFS. */
export interface WasiFile {
  /** The raw file bytes held in memory. */
  data: Uint8Array;
}

/** An in-memory directory node in the WASI VFS. */
export interface WasiDirectory {
  /** The child nodes keyed by their entry name. */
  contents: Map<string, WasiNode>;
}

/** A VFS node: either a file or a directory. */
export type WasiNode = WasiFile | WasiDirectory;

/** An opaque preopened descriptor produced by {@link WasiBridgeDeps.createPreopen}. */
export interface WasiPreopen {
  /** Brand marking the value as an opaque preopened WASI descriptor. */
  readonly __brand: 'wasi-preopen';
}

/** Low-level factories the adapter delegates to (injected for testability). */
export interface WasiBridgeDeps {
  /**
   * Build a WASI Preview 1 shim over the given CLI args, env, and preopened descriptors.
   *
   * @param arguments_ - The ARGV strings to expose to the guest, program name first.
   * @param environment - The `KEY=value` environment strings to expose to the guest.
   * @param preopens - The preopened directory descriptors that form the guest's file table.
   * @returns A WASI shim wired to those arguments, environment, and mounts.
   */
  createWasi(arguments_: string[], environment: string[], preopens: WasiPreopen[]): WasiInstance;
  /**
   * Instantiate the Ruby VM against the wasm module + WASI shim.
   *
   * @param options - The wasm module, WASI shim, and optional ARGV to instantiate with.
   * @returns A promise resolving to the running VM handle.
   */
  instantiateVm(options: VmInstantiateOptions): Promise<{ vm: RubyVmInstance }>;
  /**
   * Allocate an in-memory file node.
   *
   * @param data - The initial file contents.
   * @returns The newly allocated file node.
   */
  createFile(data: Uint8Array): WasiFile;
  /**
   * Allocate an in-memory directory node from initial entries.
   *
   * @param entries - The initial `[name, node]` pairs to populate the directory with.
   * @returns The newly allocated directory node.
   */
  createDirectory(entries: [string, WasiNode][]): WasiDirectory;
  /**
   * Wrap a directory as a named preopened descriptor for the WASI shim.
   *
   * @param name - The mount path the directory is exposed at to the guest.
   * @param directory - The directory node to expose at that mount.
   * @returns The opaque preopened descriptor for the WASI fd table.
   */
  createPreopen(name: string, directory: WasiDirectory): WasiPreopen;
}

/** Static configuration for a bridge instance. */
export interface WasiBridgeConfig {
  /** The compiled Ruby-with-JS wasm module (reactor ABI, gems/stdlib baked under `/usr`). */
  module: WebAssembly.Module;
  /** ARGV for the Ruby VM; the first entry must be the program name. */
  args?: string[];
  /** Environment strings (`KEY=value`) for the VM. */
  env?: string[];
}

/** The typed adapter surface downstream code programs against. */
export interface WasiBridge {
  /** Whether the VM has been instantiated and is ready to evaluate / serve VFS access. */
  readonly ready: boolean;
  /**
   * Instantiate the wasm module + WASI + Ruby VM. Idempotent while ready.
   *
   * @returns A promise that resolves once the VM is ready.
   */
  instantiate(): Promise<void>;
  /**
   * Evaluate Ruby synchronously.
   *
   * @param code - The Ruby source to evaluate.
   * @returns The value the expression evaluates to.
   */
  eval(code: string): RubyValue;
  /**
   * Evaluate Ruby that may `await` JS promises.
   *
   * @param code - The Ruby source to evaluate.
   * @returns A promise resolving to the value the expression evaluates to.
   */
  evalAsync(code: string): Promise<RubyValue>;
  /**
   * Write bytes to an absolute path under a writable mount, creating parent dirs.
   *
   * @param path - The absolute destination path under a writable mount.
   * @param data - The bytes to write.
   */
  writeFile(path: string, data: Uint8Array): void;
  /**
   * Read bytes from an absolute path under a writable mount.
   *
   * @param path - The absolute source path under a writable mount.
   * @returns The bytes stored at that path.
   */
  readFile(path: string): Uint8Array;
  /**
   * Remove a file if present (no-op when absent).
   *
   * @param path - The absolute path of the file to remove.
   */
  removeFile(path: string): void;
  /**
   * List the immediate entry names of a directory under a writable mount.
   *
   * @param path - The absolute directory path under a writable mount.
   * @returns The immediate child entry names.
   */
  readdir(path: string): string[];
  /**
   * Whether a file or directory exists at the given absolute path.
   *
   * @param path - The absolute path to test.
   * @returns Whether a file or directory exists there.
   */
  exists(path: string): boolean;
  /** Release the VM so it can be garbage-collected; the bridge becomes not-ready. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Mount layout & errors (no magic strings).
// ---------------------------------------------------------------------------

/**
 * The writable in-memory mounts preopened for the VM. `/usr` (Ruby stdlib + pinned gems) is baked
 * read-only into the wasm image via wasi-vfs and therefore needs no manual preopen.
 *
 * `/extensions` holds converter-extension source, written by the composition root before a convert
 * and `require`d by it. It is deliberately SEPARATE from `/project`: project files are member-
 * writable and must never be loadable as code, so the two live under different mounts and the
 * extension registry refuses any candidate path under the project one. Splitting the mounts is what
 * makes that refusal structural rather than a string check nobody notices being relaxed.
 */
export const WRITABLE_MOUNT_PATHS = ['/project', '/out', '/tmp', '/extensions'] as const;

const DEFAULT_ARGS: readonly string[] = ['ruby.wasm', '-EUTF-8', '-e_=0'];

/** Structured error codes surfaced by the bridge. */
export const WASI_BRIDGE_ERROR = {
  NOT_READY: 'not-ready',
  INVALID_PATH: 'invalid-path',
  NOT_FOUND: 'not-found',
} as const;

/** One of the structured error codes the bridge raises via {@link WasiBridgeError}. */
export type WasiBridgeErrorCode = (typeof WASI_BRIDGE_ERROR)[keyof typeof WASI_BRIDGE_ERROR];

/** A typed error raised by the adapter. */
export class WasiBridgeError extends Error {
  /**
   * Construct a bridge error tagging a human-readable message with a structured code.
   *
   * @param code - The structured code identifying the failure category.
   * @param message - The human-readable detail describing what went wrong.
   */
  constructor(
    readonly code: WasiBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WasiBridgeError';
  }
}

// ---------------------------------------------------------------------------
// Path helpers.
// ---------------------------------------------------------------------------

const PATH_SEPARATOR = '/';
const TRAVERSAL_SEGMENT = '..';
const CURRENT_SEGMENT = '.';

interface ParsedPath {
  /** The writable mount (e.g. `/project`). */
  mount: string;
  /** Path segments relative to the mount root. */
  segments: string[];
}

function isDirectory(node: WasiNode): node is WasiDirectory {
  return 'contents' in node;
}

function parseWritablePath(path: string): ParsedPath {
  if (!path.startsWith(PATH_SEPARATOR)) {
    throw new WasiBridgeError(WASI_BRIDGE_ERROR.INVALID_PATH, `Path must be absolute: ${path}`);
  }
  const rawSegments = path.split(PATH_SEPARATOR).filter((segment) => segment.length > 0);
  for (const segment of rawSegments) {
    if (segment === TRAVERSAL_SEGMENT || segment === CURRENT_SEGMENT) {
      throw new WasiBridgeError(
        WASI_BRIDGE_ERROR.INVALID_PATH,
        `Path must not contain relative segments: ${path}`,
      );
    }
  }
  if (rawSegments.length === 0) {
    throw new WasiBridgeError(WASI_BRIDGE_ERROR.INVALID_PATH, 'Path must not be a bare root');
  }
  const mount = PATH_SEPARATOR + rawSegments[0];
  if (!(WRITABLE_MOUNT_PATHS as readonly string[]).includes(mount)) {
    throw new WasiBridgeError(
      WASI_BRIDGE_ERROR.INVALID_PATH,
      `Path is not under a writable mount: ${path}`,
    );
  }
  return { mount, segments: rawSegments.slice(1) };
}

// ---------------------------------------------------------------------------
// Bridge implementation.
// ---------------------------------------------------------------------------

class WasiBridgeImpl implements WasiBridge {
  private vm: RubyVmInstance | null = null;
  private resolvedDeps: WasiBridgeDeps | null = null;
  private readonly roots = new Map<string, WasiDirectory>();

  constructor(
    private readonly config: WasiBridgeConfig,
    private readonly injectedDeps: WasiBridgeDeps | undefined,
  ) {}

  get ready(): boolean {
    return this.vm !== null;
  }

  async instantiate(): Promise<void> {
    if (this.vm !== null) {
      return;
    }
    const deps = this.injectedDeps ?? (await loadDefaultDeps());
    const arguments_ = [...(this.config.args ?? DEFAULT_ARGS)];
    const environment = [...(this.config.env ?? [])];

    this.roots.clear();
    const preopens: WasiPreopen[] = [];
    for (const mount of WRITABLE_MOUNT_PATHS) {
      const root = deps.createDirectory([]);
      this.roots.set(mount, root);
      preopens.push(deps.createPreopen(mount, root));
    }

    const wasi = deps.createWasi(arguments_, environment, preopens);
    const { vm } = await deps.instantiateVm({
      module: this.config.module,
      wasip1: wasi,
      args: arguments_,
    });
    this.vm = vm;
    this.resolvedDeps = deps;
  }

  eval(code: string): RubyValue {
    return this.requireVm().eval(code);
  }

  async evalAsync(code: string): Promise<RubyValue> {
    return this.requireVm().evalAsync(code);
  }

  writeFile(path: string, data: Uint8Array): void {
    const deps = this.requireDeps();
    const parentDirectory = this.resolveParentDir(path);
    const name = leafName(path);
    const existing = parentDirectory.contents.get(name);
    if (existing !== undefined && isDirectory(existing)) {
      throw new WasiBridgeError(WASI_BRIDGE_ERROR.INVALID_PATH, `Path is a directory: ${path}`);
    }
    if (existing !== undefined) {
      existing.data = data;
      return;
    }
    parentDirectory.contents.set(name, deps.createFile(data));
  }

  readFile(path: string): Uint8Array {
    const node = this.resolveNode(path);
    if (node === undefined || isDirectory(node)) {
      throw new WasiBridgeError(WASI_BRIDGE_ERROR.NOT_FOUND, `No file at path: ${path}`);
    }
    return node.data;
  }

  removeFile(path: string): void {
    this.requireDeps();
    const { mount, segments } = parseWritablePath(path);
    if (segments.length === 0) {
      throw new WasiBridgeError(WASI_BRIDGE_ERROR.INVALID_PATH, `Path has no file name: ${path}`);
    }
    const parent = this.walk(this.rootFor(mount), segments.slice(0, -1));
    if (parent === undefined || !isDirectory(parent)) {
      return;
    }
    parent.contents.delete(segments.at(-1) as string);
  }

  readdir(path: string): string[] {
    const node = this.resolveNode(path);
    if (node === undefined || !isDirectory(node)) {
      throw new WasiBridgeError(WASI_BRIDGE_ERROR.NOT_FOUND, `No directory at path: ${path}`);
    }
    return [...node.contents.keys()];
  }

  exists(path: string): boolean {
    this.requireDeps();
    const { mount, segments } = parseWritablePath(path);
    if (segments.length === 0) {
      return true;
    }
    return this.walk(this.rootFor(mount), segments) !== undefined;
  }

  dispose(): void {
    this.vm = null;
    this.resolvedDeps = null;
    this.roots.clear();
  }

  // --- internals ---------------------------------------------------------

  private requireVm(): RubyVmInstance {
    if (this.vm === null) {
      throw new WasiBridgeError(WASI_BRIDGE_ERROR.NOT_READY, 'Bridge has not been instantiated');
    }
    return this.vm;
  }

  private requireDeps(): WasiBridgeDeps {
    if (this.resolvedDeps === null) {
      throw new WasiBridgeError(WASI_BRIDGE_ERROR.NOT_READY, 'Bridge has not been instantiated');
    }
    return this.resolvedDeps;
  }

  private rootFor(mount: string): WasiDirectory {
    const root = this.roots.get(mount);
    if (root === undefined) {
      throw new WasiBridgeError(WASI_BRIDGE_ERROR.NOT_READY, 'Bridge has not been instantiated');
    }
    return root;
  }

  private resolveNode(path: string): WasiNode | undefined {
    this.requireDeps();
    const { mount, segments } = parseWritablePath(path);
    if (segments.length === 0) {
      return this.rootFor(mount);
    }
    return this.walk(this.rootFor(mount), segments);
  }

  private resolveParentDir(path: string): WasiDirectory {
    const deps = this.requireDeps();
    const { mount, segments } = parseWritablePath(path);
    if (segments.length === 0) {
      throw new WasiBridgeError(WASI_BRIDGE_ERROR.INVALID_PATH, `Path has no file name: ${path}`);
    }
    let directory = this.rootFor(mount);
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] as string;
      const next = directory.contents.get(segment);
      if (next === undefined) {
        const created = deps.createDirectory([]);
        directory.contents.set(segment, created);
        directory = created;
      } else if (isDirectory(next)) {
        directory = next;
      } else {
        throw new WasiBridgeError(
          WASI_BRIDGE_ERROR.INVALID_PATH,
          `Path segment is not a directory: ${segment} in ${path}`,
        );
      }
    }
    return directory;
  }

  private walk(root: WasiDirectory, segments: string[]): WasiNode | undefined {
    let node: WasiNode = root;
    for (const segment of segments) {
      if (!isDirectory(node)) {
        return undefined;
      }
      const next = node.contents.get(segment);
      if (next === undefined) {
        return undefined;
      }
      node = next;
    }
    return node;
  }
}

function leafName(path: string): string {
  const { segments } = parseWritablePath(path);
  const name = segments.at(-1);
  if (name === undefined) {
    throw new WasiBridgeError(WASI_BRIDGE_ERROR.INVALID_PATH, `Path has no file name: ${path}`);
  }
  return name;
}

/**
 * Create a typed WASI bridge. In production the low-level libraries are lazily bound on
 * {@link WasiBridge.instantiate} (see {@link loadDefaultDeps}); tests inject {@link WasiBridgeDeps}
 * fakes.
 */
export function createWasiBridge(config: WasiBridgeConfig, deps?: WasiBridgeDeps): WasiBridge {
  return new WasiBridgeImpl(config, deps);
}

// ---------------------------------------------------------------------------
// Real-library binding. This is the ONLY code that touches the untyped/ESM interop, so every
// interop cast lives here and nowhere else in the package.
// ---------------------------------------------------------------------------

/**
 * Bind the real, ESM-only interop libraries into the typed {@link WasiBridgeDeps} surface. Loaded
 * lazily (dynamic import) so the ESM-only modules never enter the graph until a bridge is actually
 * instantiated. This is the single confinement point for interop casts — the libraries ship
 * loose/structurally-mismatched types, so keeping the reconciliation here keeps `any`/`as` out of
 * every other module in the package.
 */
export async function loadDefaultDeps(): Promise<WasiBridgeDeps> {
  const wasiShim = await import('@bjorn3/browser_wasi_shim');
  const ruby = await import('@ruby/wasm-wasi');
  const { WASI, File, OpenFile, Directory, PreopenDirectory } = wasiShim;

  return {
    createWasi: (arguments_, environment, preopens) => {
      // WASI fd-table ABI: descriptors 0/1/2 are stdin/stdout/stderr, and wasi-libc's preopen scan
      // (`__wasilibc_populate_preopens`) only starts at fd 3. If the preopened directories are placed
      // at fds 0/1/2 they are never discovered, so every guest path op on /project, /out and /tmp
      // raises ENOENT and the convert silently reads/writes nothing. The three standard streams must
      // therefore precede the preopens so the mounts land at fd 3+. Empty in-memory files back the
      // streams — the engine performs no console I/O in the convert path.
      const stdio = [
        new OpenFile(new File([])),
        new OpenFile(new File([])),
        new OpenFile(new File([])),
      ];
      // Untyped interop: `browser_wasi_shim` types fds as `Fd[]`; the opaque `WasiPreopen` brand IS
      // such a descriptor, so the assembled `[...stdio, ...preopens]` list is a valid fd table and the
      // returned WASI structurally satisfies `WasiInstance`.
      const fds = [...stdio, ...preopens] as unknown as ConstructorParameters<typeof WASI>[2];
      return new WASI(arguments_, environment, fds);
    },
    instantiateVm: (options) => ruby.RubyVM.instantiateModule(options).then(({ vm }) => ({ vm })),
    createFile: (data) => new File(data),
    // Untyped interop: `Directory`/`PreopenDirectory` carry the library's `Inode` node type, which
    // is structurally wider than the narrow `WasiNode`; confine the reconciliation cast here.
    createDirectory: (entries) =>
      new Directory(
        entries as unknown as ConstructorParameters<typeof Directory>[0],
      ) as unknown as WasiDirectory,
    createPreopen: (name, directory) =>
      new PreopenDirectory(
        name,
        directory.contents as unknown as ConstructorParameters<typeof PreopenDirectory>[1],
      ) as unknown as WasiPreopen,
  } satisfies WasiBridgeDeps;
}
