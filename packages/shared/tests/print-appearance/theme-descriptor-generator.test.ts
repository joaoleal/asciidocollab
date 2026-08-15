/**
 * @file What `generate-theme-descriptors.mjs` does when the gems it derives from are not all there.
 *
 * Two of the four modules that script writes are the ones this directory tests
 * (`page-sizes.generated.ts`, `deprecated-keys.generated.ts`), and it runs from the `prebuild` hook on
 * every machine — including every one with no wasm build, where the gem tree is absent by design.
 * Whether it survives that is a property of the build rather than of the theme descriptors, and
 * nothing was asserting it.
 *
 * The script is exercised as a PROCESS, in a throwaway tree laid out the way it expects, because its
 * whole subject is the file system it finds and the exit code it leaves behind. It locates everything
 * from its own path (`import.meta.url`), so a copy under a fabricated repository root reads and writes
 * entirely inside that root; `node_modules` is linked in so its one import still resolves, and the
 * real gem tree is linked in where a test needs the generation to be able to succeed.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The real script, and the real `node_modules` its `yaml` import resolves through. */
const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(PACKAGE_ROOT, 'scripts/generate-theme-descriptors.mjs');
/** Where the script looks for the gems, relative to the repository root it infers. */
const GEM_PATH = 'packages/asciidoc-pdf/ruby/.wasm-build/vendor/bundle/ruby/3.3.0/gems';
/** The gem tree of this working copy, present only where the wasm engine has been built. */
const REAL_GEMS = path.join(PACKAGE_ROOT, '..', '..', GEM_PATH);

/**
 * A fabricated repository root holding a copy of the script and nothing else.
 *
 * @param gems - `real` links this working copy's gem tree in where it has one, so the generation can
 *   actually run; `none` leaves an empty gem directory, the state of every fresh clone.
 * @returns The root.
 */
function fabricateRepository(gems: 'none' | 'real'): string {
  const base = mkdtempSync(path.join(tmpdir(), 'theme-descriptors-'));
  mkdirSync(path.join(base, 'packages/shared/scripts'), { recursive: true });
  mkdirSync(path.join(base, 'packages/shared/src/render-config'), { recursive: true });
  mkdirSync(path.join(base, 'packages/shared/src/print-appearance'), { recursive: true });
  symlinkSync(path.join(PACKAGE_ROOT, 'node_modules'), path.join(base, 'packages/shared/node_modules'));
  copyFileSync(SCRIPT, path.join(base, 'packages/shared/scripts/generate-theme-descriptors.mjs'));
  if (gems === 'real' && existsSync(REAL_GEMS)) {
    mkdirSync(path.dirname(path.join(base, GEM_PATH)), { recursive: true });
    symlinkSync(REAL_GEMS, path.join(base, GEM_PATH));
  } else {
    mkdirSync(path.join(base, GEM_PATH), { recursive: true });
  }
  return base;
}

/** Run the copied script in `base` with `flags`, capturing everything it says and leaves behind. */
function run(base: string, flags: readonly string[]) {
  const result = spawnSync(
    process.execPath,
    [path.join(base, 'packages/shared/scripts/generate-theme-descriptors.mjs'), ...flags],
    { encoding: 'utf8' },
  );
  const written = [
    ...readdirSync(path.join(base, 'packages/shared/src/render-config')),
    ...readdirSync(path.join(base, 'packages/shared/src/print-appearance')),
  ];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, written };
}

/**
 * Take the fabricated tree down, LINKS first.
 *
 * `rmSync` unlinks a symbolic link rather than descending through it, so the recursive delete is
 * already safe — but the two links here point at this working copy's `node_modules` and at its
 * vendored gem tree, and "already safe" is the wrong thing to rest that on. Removing them explicitly
 * means the recursive delete is only ever handed directories this file created.
 */
function demolish(base: string): void {
  for (const link of [
    path.join(base, 'packages/shared/node_modules'),
    path.join(base, GEM_PATH),
  ]) {
    try {
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
    } catch {
      // Not a link, or already gone: the recursive delete below covers both.
    }
  }
  rmSync(base, { recursive: true, force: true });
}

describe('the theme descriptor generator’s command line', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) demolish(root);
  });

  /** A fabricated root that is cleaned up when the test ends. */
  function repository(gems: 'none' | 'real'): string {
    const base = fabricateRepository(gems);
    roots.push(base);
    return base;
  }

  it('is not runnable at all if the working tree is not the one this test assumes', () => {
    // Every test below passes if the copy never starts. This one says it does: the same copy, in the
    // same layout, refuses an empty tree loudly when it is NOT told the gems are optional — so a clean
    // exit anywhere below is a decision the script made and not a file it failed to find.
    const result = run(repository('none'), []);
    expect(result.status).not.toBe(0);
    expect(result.written).toEqual([]);
  });

  it.each([
    ['a gem directory that exists and is empty', [] as readonly string[]],
    ['a tree holding the asciidoctor-pdf gem and no pdf-core', ['asciidoctor-pdf-2.3.24/data/themes']],
    [
      'a tree holding both gems and none of the sources they are read from',
      ['asciidoctor-pdf-2.3.24/data/themes', 'pdf-core-0.10.0/lib'],
    ],
  ])('keeps the committed catalogue for %s', (_label, directories) => {
    // `--if-available` guarded the existence of the gem ROOT and nothing else; everything below it was
    // discovered by reading. An interrupted or half-restored wasm build leaves exactly these trees —
    // the state the flag exists for — and each threw out of the generation: the first with "Expected
    // exactly one vendored asciidoctor-pdf gem, found 0", the second with a raw ENOENT for
    // `page_geometry.rb`, the third with one for `theme_loader.rb`. Any of them fails the `prebuild`
    // hook, so NOTHING in the workspace builds, from a directory the build is meant not to depend on.
    // The second and third became reachable only when the generation grew a second gem and a third
    // source file to read; naming every input it reads is what stops the next one repeating this.
    const base = repository('none');
    for (const directory of directories) mkdirSync(path.join(base, GEM_PATH, directory), { recursive: true });

    const result = run(base, ['--if-available']);
    expect({ status: result.status, written: result.written }).toEqual({ status: 0, written: [] });
    expect(result.stdout).toMatch(/keeping the committed theme descriptor catalogue/);
  });

  it('still fails loudly when asked to CHECK against a tree that is not whole', () => {
    // The other half, and the reason the skip is not "swallow whatever goes wrong": a check that
    // skipped when the gems are absent would be a check that never fails, which is the defect
    // `--check` exists to end. Both flags on one line, because a caller that forwards `--if-available`
    // onto `check:theme-descriptors` is the way that would happen by accident.
    const result = run(repository('none'), ['--check', '--if-available']);
    expect(result.status).not.toBe(0);
    expect(result.written).toEqual([]);
  });

  it.each([['--check=true'], ['--check=false'], ['--if-available=1'], ['--generate']])(
    'refuses %s rather than reading it as no argument at all',
    (argument) => {
      // Both flags were looked for with `argv.includes`, which asks whether an exact string is present
      // and says nothing about the rest of the line. `--check=true` is not `--check`, and not any other
      // known flag either, so it fell through to the branch that WRITES — the one mode a caller who
      // typed `--check` was asking the script not to enter — and exited 0, reporting success for a
      // check that never ran. Against this working copy's own gems that is exactly what it did:
      // `--check=true` printed "Generated:" and wrote all four modules.
      //
      // Which is why the gems are linked in here: `written` is the assertion that carries the defect,
      // and it can only carry it where the generation would otherwise have succeeded. Where they are
      // absent the same run is still refused, one branch earlier.
      const result = run(repository('real'), [argument]);
      expect({ status: result.status, written: result.written }).toEqual({ status: 1, written: [] });
      expect(result.stderr).toContain(argument);
    },
  );
});
