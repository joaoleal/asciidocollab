/**
 * @file The shipped-extension loader's handling of a directory that is not what it expects.
 *
 * `tests/shipped-pdf-extensions.test.ts` judges the set that ACTUALLY ships. This file covers the
 * loader itself, which runs once at module load and so can only be exercised by re-importing the
 * module against a substituted filesystem.
 *
 * The case worth having a test for is the last one: a shipped manifest that does not validate THROWS
 * rather than being quietly excluded. That is deliberate and asymmetric with the administrator drop
 * folder, where a bad manifest is reported and skipped — a shipped extension travels with the
 * application, so a broken one is a build error and failing at startup is where it belongs. It would
 * be an easy thing to "fix" into an exclusion later, which is why it is pinned.
 */

/** A minimal `Dirent`, carrying only what the loader asks of it. */
function dirent(name: string, isDirectory: boolean) {
  return { name, isDirectory: () => isDirectory };
}

/**
 * The two places the loader looks, in its own order of preference.
 *
 * `packaged` is the copy the production image carries beside `config/` and `data/`; `gem` is the
 * engine gem read directly, which is all a development checkout has. Naming them lets a test say
 * which exist, because WHICH ONE WINS is the whole point of there being two.
 */
type Root = 'packaged' | 'gem';

/** Classify a path the loader probes, or undefined when it is not one of the roots. */
function rootOf(candidate: string): Root | undefined {
  if (candidate.endsWith('/pdf-extensions')) return 'packaged';
  if (candidate.endsWith('asciidocollab-pdf-extensions/lib')) return 'gem';
  return undefined;
}

interface FakeTree {
  /** Directory entries each existing root enumerates. */
  readonly entries: readonly ReturnType<typeof dirent>[];
  /** File contents, keyed by the path suffix the loader builds. */
  readonly files: Readonly<Record<string, string>>;
  /** Which roots exist. Defaults to the development checkout: the gem only. */
  readonly roots?: readonly Root[];
  /** Entries a specific root enumerates, when a test needs the two to differ. */
  readonly entriesByRoot?: Readonly<Partial<Record<Root, readonly ReturnType<typeof dirent>[]>>>;
}

/** Load a fresh copy of the module against `tree`. */
function loadWith(tree: FakeTree): typeof import('../../src/lib/pdf-extensions') {
  const { entries, files, roots = ['gem'], entriesByRoot = {} } = tree;
  const has = (candidate: string): boolean =>
    Object.keys(files).some((suffix) => candidate.endsWith(suffix));

  jest.resetModules();
  jest.doMock('node:fs', () => ({
    existsSync: (candidate: string) => {
      const root = rootOf(candidate);
      return root === undefined ? has(candidate) : roots.includes(root);
    },
    readdirSync: (candidate: string) => {
      const root = rootOf(candidate);
      return (root !== undefined && entriesByRoot[root]) || entries;
    },
    readFileSync: (candidate: string) => {
      const suffix = Object.keys(files).find((key) => candidate.endsWith(key));
      if (suffix === undefined) throw new Error(`unexpected read: ${candidate}`);
      return files[suffix];
    },
  }));

  return require('../../src/lib/pdf-extensions');
}

/** A valid manifest for `id`, as JSON. */
function manifestJson(id: string): string {
  return JSON.stringify({
    id,
    displayName: id,
    description: `The ${id} extension.`,
    targeting: '',
    themeKeys: [],
    sampleContent: '',
  });
}

afterEach(() => {
  jest.dontMock('node:fs');
  jest.resetModules();
});

describe('the shipped-extension loader', () => {
  it('offers nothing when neither location exists', () => {
    // The API can be started from a checkout where the gem has not been fetched. That is an empty
    // catalogue, not a crash. Note this is ALSO what a mis-packaged image looks like, which is why
    // the Docker build asserts the directory is there rather than relying on this path.
    const loaded = loadWith({ entries: [], files: {}, roots: [] });
    expect(loaded.SHIPPED_PDF_EXTENSION_MANIFESTS).toEqual([]);
    expect(loaded.SHIPPED_PDF_EXTENSION_SOURCES).toEqual({});
  });

  it('reads the packaged copy in preference to the gem when both are present', () => {
    // The production image is assembled by `pnpm deploy`, which flattens apps/api to the image root
    // and carries no monorepo tree — so the gem path cannot resolve there and the packaged copy is
    // the only correct answer. Reading the gem first would have worked in every development
    // checkout and shipped an image with no extensions at all, which is the bug this pins.
    const loaded = loadWith({
      roots: ['packaged', 'gem'],
      entries: [],
      entriesByRoot: { packaged: [dirent('packaged-only', true)], gem: [dirent('gem-only', true)] },
      files: {
        'packaged-only/manifest.json': manifestJson('packaged-only'),
        'packaged-only/extension.rb': '# packaged\n',
        'gem-only/manifest.json': manifestJson('gem-only'),
        'gem-only/extension.rb': '# gem\n',
      },
    });
    expect(loaded.SHIPPED_PDF_EXTENSION_MANIFESTS.map((m) => m.id)).toEqual(['packaged-only']);
  });

  it('falls back to the gem in a development checkout, where nothing is packaged', () => {
    const loaded = loadWith({
      roots: ['gem'],
      entries: [dirent('watermark', true)],
      files: {
        'watermark/manifest.json': manifestJson('watermark'),
        'watermark/extension.rb': '# watermark\n',
      },
    });
    expect(loaded.SHIPPED_PDF_EXTENSION_MANIFESTS.map((m) => m.id)).toEqual(['watermark']);
  });

  it('ignores a loose file sitting beside the extension directories', () => {
    const loaded = loadWith({
      entries: [dirent('README.md', false), dirent('watermark', true)],
      files: {
        'watermark/manifest.json': manifestJson('watermark'),
        'watermark/extension.rb': '# watermark\n',
      },
    });
    expect(loaded.SHIPPED_PDF_EXTENSION_MANIFESTS.map((m) => m.id)).toEqual(['watermark']);
  });

  it('skips a directory missing either half of the pair', () => {
    // A manifest with no Ruby is an entry the renderer cannot load; Ruby with no manifest can never
    // be enabled. Neither is offered.
    const loaded = loadWith({
      entries: [dirent('no-source', true), dirent('no-manifest', true), dirent('whole', true)],
      files: {
        'no-source/manifest.json': manifestJson('no-source'),
        'no-manifest/extension.rb': '# orphan\n',
        'whole/manifest.json': manifestJson('whole'),
        'whole/extension.rb': '# whole\n',
      },
    });
    expect(loaded.SHIPPED_PDF_EXTENSION_MANIFESTS.map((m) => m.id)).toEqual(['whole']);
  });

  it('THROWS on a shipped manifest that does not validate, naming the directory', () => {
    expect(() =>
      loadWith({
        entries: [dirent('broken', true)],
        files: {
          'broken/manifest.json': JSON.stringify({ id: 'broken' }),
          'broken/extension.rb': '# broken\n',
        },
      }),
    ).toThrow(/broken/);
  });

  it('sorts by id, so the catalogue never depends on directory enumeration order', () => {
    const loaded = loadWith({
      entries: [dirent('zebra', true), dirent('alpha', true)],
      files: {
        'zebra/manifest.json': manifestJson('zebra'),
        'zebra/extension.rb': '# zebra\n',
        'alpha/manifest.json': manifestJson('alpha'),
        'alpha/extension.rb': '# alpha\n',
      },
    });
    expect(loaded.SHIPPED_PDF_EXTENSION_MANIFESTS.map((m) => m.id)).toEqual(['alpha', 'zebra']);
    expect(loaded.SHIPPED_PDF_EXTENSION_SOURCES['alpha']).toBe('# alpha\n');
  });
});
