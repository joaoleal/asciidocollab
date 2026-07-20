import { mountPdfExtensions, requestedExtensionIds } from '../../src/extensions/mount';
import type { PdfExtensionSource } from '../../src/extensions/registry';
import type { PdfExtensionBundle, ProjectSnapshot, RenderRequest } from '../../src/protocol';
import type { PdfExtensionCatalogueEntry } from '@asciidocollab/asciidoc-core';

/** A catalogue entry for `id`, available and shipped unless told otherwise. */
function entry(
  id: string,
  overrides: Partial<PdfExtensionCatalogueEntry> = {},
): PdfExtensionCatalogueEntry {
  return {
    manifest: {
      id,
      displayName: id,
      description: '',
      targeting: '',
      themeKeys: [],
      sampleContent: '',
    },
    origin: 'shipped',
    available: true,
    ...overrides,
  } as PdfExtensionCatalogueEntry;
}

/** A source for `id`, shipped unless told otherwise. */
function source(id: string, overrides: Partial<PdfExtensionSource> = {}): PdfExtensionSource {
  return { id, origin: 'shipped', source: `# ${id}\n`, ...overrides };
}

/** A render request enabling `ids`, backed by `bundle` when one is given. */
function request(ids: readonly string[], bundle?: PdfExtensionBundle): RenderRequest {
  const snapshot = {
    files: {},
    binaryAssets: {},
    rootPath: 'main.adoc',
    openPath: 'main.adoc',
    fontPaths: [],
    attributes: {},
    enabledExtensions: ids,
  } as ProjectSnapshot;
  return {
    requestId: '1',
    mode: 'export',
    snapshot,
    optimize: false,
    ...(bundle === undefined ? {} : { extensions: bundle }),
  };
}

/** A VFS write port that records what was written. */
function recordingPort(): { writeFile: (path: string, bytes: Uint8Array) => void; written: Map<string, string> } {
  const written = new Map<string, string>();
  const decoder = new TextDecoder();
  return {
    written,
    writeFile: (path, bytes) => written.set(path, decoder.decode(bytes)),
  };
}

describe('requestedExtensionIds — one set, one spelling', () => {
  it('reports nothing for a snapshot that enables nothing', () => {
    expect(requestedExtensionIds(request([]))).toEqual([]);
  });

  it('de-duplicates and orders, so two spellings of one selection compare equal', () => {
    // Load ORDER decides output when two extensions touch one hook, so a selection stored in a
    // different order must not become a differently-ordered load list (SC-015b).
    expect(requestedExtensionIds(request(['b', 'a', 'b']))).toEqual(['a', 'b']);
  });
});

describe('mountPdfExtensions — writing the code the convert requires', () => {
  it('writes nothing and asks for nothing when no extension is enabled', () => {
    const port = recordingPort();
    const mounted = mountPdfExtensions(port, request([]));
    expect(mounted.loadedExtensions).toEqual([]);
    expect(port.written.size).toBe(0);
    expect(mounted.rejected).toEqual([]);
  });

  it('writes each source to the path the registry chose, outside the project mount', () => {
    const port = recordingPort();
    const mounted = mountPdfExtensions(
      port,
      request(['alpha'], { catalogue: [entry('alpha')], sources: [source('alpha')] }),
    );
    expect(mounted.loadedExtensions).toEqual([
      { id: 'alpha', vfsPath: '/extensions/shipped/alpha.rb' },
    ]);
    expect(port.written.get('/extensions/shipped/alpha.rb')).toBe('# alpha\n');
    // The security boundary this whole feature rests on: project content is never executable.
    for (const path of port.written.keys()) expect(path.startsWith('/project')).toBe(false);
  });

  it('orders the paths by id regardless of how the selection was stored', () => {
    // Two extensions touching one converter hook produce different output depending on which loads
    // first, so load order must not follow the order an author happened to select them (SC-015b).
    const port = recordingPort();
    const bundle = {
      catalogue: [entry('alpha'), entry('beta')],
      sources: [source('beta'), source('alpha')],
    };
    expect(
      mountPdfExtensions(port, request(['beta', 'alpha'], bundle)).loadedExtensions.map(
        (extension) => extension.id,
      ),
    ).toEqual(['alpha', 'beta']);
  });

  it('reports every id when the request carries no code at all', () => {
    // A wiring fault, not an author's mistake — but it must not render silently without them, which
    // is exactly the failure that looks correct.
    const port = recordingPort();
    const mounted = mountPdfExtensions(port, request(['alpha']));
    expect(mounted.loadedExtensions).toEqual([]);
    expect(mounted.rejected).toEqual([
      { id: 'alpha', reason: expect.stringContaining('No extension code') },
    ]);
  });

  it('reports an id the catalogue no longer offers, and loads the rest', () => {
    const port = recordingPort();
    const mounted = mountPdfExtensions(
      port,
      request(['alpha', 'retired'], {
        catalogue: [entry('alpha')],
        sources: [source('alpha')],
      }),
    );
    expect(mounted.loadedExtensions).toEqual([
      { id: 'alpha', vfsPath: '/extensions/shipped/alpha.rb' },
    ]);
    expect(mounted.rejected.map((rejection) => rejection.id)).toEqual(['retired']);
  });

  it('reports a source whose origin disagrees with the catalogue', () => {
    // The origin decides the mount, so believing the source over the catalogue would let a mismatch
    // choose where code is loaded from.
    const port = recordingPort();
    const mounted = mountPdfExtensions(
      port,
      request(['alpha'], {
        catalogue: [entry('alpha')],
        sources: [source('alpha', { origin: 'administrator-provided' })],
      }),
    );
    expect(mounted.loadedExtensions).toEqual([]);
    expect(mounted.rejected.map((rejection) => rejection.id)).toEqual(['alpha']);
    expect(port.written.size).toBe(0);
  });

  it('loads an id exactly once however many times the selection names it', () => {
    // An extension that prepends a module is not idempotent under a double load.
    const port = recordingPort();
    const mounted = mountPdfExtensions(
      port,
      request(['alpha', 'alpha'], { catalogue: [entry('alpha')], sources: [source('alpha')] }),
    );
    expect(mounted.loadedExtensions).toEqual([
      { id: 'alpha', vfsPath: '/extensions/shipped/alpha.rb' },
    ]);
  });
});

/**
 * A render request from a project that has never mentioned extensions, with `bundle` on offer.
 *
 * Distinct from `request([], bundle)`: this omits `enabledExtensions` entirely, which is the shape
 * `buildProjectSnapshot` produces for every project that enables nothing.
 */
function requestFromProjectPredatingExtensions(bundle: PdfExtensionBundle): RenderRequest {
  const snapshot = {
    files: {},
    binaryAssets: {},
    rootPath: 'main.adoc',
    openPath: 'main.adoc',
    fontPaths: [],
    attributes: {},
    // No `enabledExtensions` key — deliberately absent, not empty.
  } as ProjectSnapshot;
  return { requestId: '1', mode: 'export', snapshot, optimize: false, extensions: bundle };
}

describe('a new extension is disabled for an existing project (T061, FR-032g, SC-012b)', () => {
  // Adding an extension to a deployment must never change what an existing project renders. That
  // holds only if "this project has said nothing about extensions" means NOTHING ENABLED at every
  // step — and the one place it could plausibly mean the opposite is real: the Ruby convert treats a
  // nil enabled-set as "everything loaded is active", which is the canonical `asciidoctor-pdf -r`
  // contract. What keeps the two apart is that nothing is ever loaded in the first place.
  //
  // The distinction that matters here is ABSENT versus empty. A project predating this feature has
  // no `extensions` key at all, and `buildProjectSnapshot` omits the field rather than sending `[]`,
  // so `undefined` is the shape production actually produces for exactly these projects.

  it('asks for nothing when the project never mentioned extensions', () => {
    expect(requestedExtensionIds(requestFromProjectPredatingExtensions({ catalogue: [], sources: [] }))).toEqual([]);
  });

  it('loads nothing even when the deployment offers extensions that are ready to load', () => {
    // The scenario an administrator actually creates: a new release ships extensions, complete with
    // catalogue entries and sources. Every existing project must render as it did the day before.
    const port = recordingPort();
    const mounted = mountPdfExtensions(
      port,
      requestFromProjectPredatingExtensions({
        catalogue: [entry('newly-shipped'), entry('also-new')],
        sources: [source('newly-shipped'), source('also-new')],
      }),
    );
    expect(mounted.loadedExtensions).toEqual([]);
    // Not rejected either — the project did not ask for these, so there is nothing to report to
    // anyone. A rejection here would put a warning in front of an owner who changed nothing.
    expect(mounted.rejected).toEqual([]);
    // Nothing written: the code never reaches the VM, so it cannot be required by a later render
    // that shares the warm VM.
    expect(port.written.size).toBe(0);
  });

  it('is indistinguishable from a project that explicitly enabled nothing', () => {
    // Absent and empty must resolve identically, or the feature would behave differently for
    // projects created before it than for projects created after it that simply enabled nothing.
    const absent = recordingPort();
    const empty = recordingPort();
    const bundle = { catalogue: [entry('newly-shipped')], sources: [source('newly-shipped')] };
    expect(mountPdfExtensions(absent, requestFromProjectPredatingExtensions(bundle))).toEqual(
      mountPdfExtensions(empty, request([], bundle)),
    );
    expect(absent.written).toEqual(empty.written);
  });
});
