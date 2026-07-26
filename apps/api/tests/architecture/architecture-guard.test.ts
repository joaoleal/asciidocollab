import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Tests the architecture guard itself.
 *
 * This exists because the guard it replaced was VACUOUS for months and nothing noticed: `fresh-onion`
 * skipped every import specifier that does not start with `.` or `/`, and this monorepo crosses layers
 * exclusively by workspace name — so it printed "Fresh" over a codebase it had not inspected. A gate
 * that cannot fail is worse than no gate, because it is reported as evidence. So the guard's ability to
 * FAIL is asserted here, per violation shape, rather than trusted.
 *
 * The fixture cases run against a throwaway tree with the guard copied into `<fixture>/scripts/ci/`.
 * The guard derives its root from its own location (deliberately — the old tool searched for its config
 * and picked up a stale worktree's copy), so placing it there is what re-points it at the fixture, with
 * no test-only override in production code.
 */
const GUARD = path.resolve(__dirname, '../../../../scripts/ci/architecture-guard.mjs');

interface FixtureLayer {
  /** Workspace package name, e.g. `@fixture/inner`. */
  name: string;
  /** Layers this one may import. */
  allowedImports: string[];
  /** Source files to write, as path → contents. */
  files?: Record<string, string>;
  /** Extra `dependencies` entries for its package.json. */
  dependencies?: Record<string, string>;
  /** `references` entries for its tsconfig.json. */
  references?: string[];
}

/**
 * Runs the guard over a throwaway workspace.
 *
 * @param layers - Layer name → its fixture definition.
 * @returns The guard's exit code and combined output.
 */
function runGuard(layers: Record<string, FixtureLayer>): { code: number; output: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'arch-guard-'));
  try {
    mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
    copyFileSync(GUARD, path.join(root, 'scripts', 'ci', 'architecture-guard.mjs'));

    const config = { layers: {}, rules: [] } as {
      layers: Record<string, string>;
      rules: { from: string; allowedImports: string[] }[];
    };
    for (const [layer, spec] of Object.entries(layers)) {
      const packageDirectory = path.join(root, 'packages', layer);
      mkdirSync(path.join(packageDirectory, 'src'), { recursive: true });
      writeFileSync(
        path.join(packageDirectory, 'package.json'),
        JSON.stringify({ name: spec.name, dependencies: spec.dependencies ?? {} }),
      );
      if (spec.references) {
        writeFileSync(
          path.join(packageDirectory, 'tsconfig.json'),
          JSON.stringify({ references: spec.references.map((reference) => ({ path: reference })) }),
        );
      }
      for (const [file, contents] of Object.entries(spec.files ?? { 'index.ts': 'export const x = 1;\n' })) {
        writeFileSync(path.join(packageDirectory, 'src', file), contents);
      }
      config.layers[layer] = `./packages/${layer}/src`;
      config.rules.push({ from: layer, allowedImports: spec.allowedImports });
    }
    writeFileSync(path.join(root, 'onion.config.json'), JSON.stringify(config));

    try {
      const output = execFileSync('node', [path.join(root, 'scripts', 'ci', 'architecture-guard.mjs')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, output };
    } catch (error) {
      const failure = error as { status: number; stdout: string; stderr: string };
      return { code: failure.status, output: `${failure.stdout}${failure.stderr}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** An inner layer that may import nothing, plus an outer one that may import it. */
const INNER: FixtureLayer = { name: '@fixture/inner', allowedImports: [] };
const OUTER: FixtureLayer = { name: '@fixture/outer', allowedImports: ['inner'] };

/**
 * A source file whose multi-line template literal is followed by a comment naming a package, then by
 * `tail`. Module-scoped because a helper defined inside a test body trips
 * `unicorn/consistent-function-scoping`.
 *
 * @param tail - The last line of the file, used to vary between clean prose and a real import.
 * @returns The file contents.
 */
function fileWithTemplateThen(tail: string): string {
  return [
    'export const link = `',
    '  https://example.test/docs',
    '`;',
    "// A note that says: import from '@fixture/outer' — prose, not code.",
    tail,
    '',
  ].join('\n');
}

describe('architecture guard', () => {
  test('passes a tree that respects its rules', () => {
    const { code, output } = runGuard({
      inner: INNER,
      outer: { ...OUTER, files: { 'index.ts': "import '@fixture/inner';\n" } },
    });
    expect(output).toContain('clean');
    expect(code).toBe(0);
  });

  test('fails a BARE cross-layer import — the shape fresh-onion could not see', () => {
    const { code, output } = runGuard({
      inner: { ...INNER, files: { 'index.ts': "import '@fixture/outer';\n" } },
      outer: OUTER,
    });
    expect(code).toBe(1);
    expect(output).toContain('inner → outer');
  });

  test('fails a bare import written as a subpath', () => {
    const { code, output } = runGuard({
      inner: { ...INNER, files: { 'index.ts': "import '@fixture/outer/deep/thing';\n" } },
      outer: OUTER,
    });
    expect(code).toBe(1);
    expect(output).toContain('inner → outer');
  });

  test('fails a RELATIVE cross-layer import', () => {
    const { code, output } = runGuard({
      inner: { ...INNER, files: { 'index.ts': "import '../../outer/src/index';\n" } },
      outer: OUTER,
    });
    expect(code).toBe(1);
    expect(output).toContain('inner → outer');
  });

  test('fails a declared dependency even with no import to show for it', () => {
    const { code, output } = runGuard({
      inner: { ...INNER, dependencies: { '@fixture/outer': 'workspace:*' } },
      outer: OUTER,
    });
    expect(code).toBe(1);
    expect(output).toContain('declared dependency');
  });

  test('fails a tsconfig project reference even with no import to show for it', () => {
    const { code, output } = runGuard({
      inner: { ...INNER, references: ['../outer'] },
      outer: OUTER,
    });
    expect(code).toBe(1);
    expect(output).toContain('tsconfig project reference');
  });

  test('does NOT fail on prose in comments that merely mentions a package', () => {
    // The codebase is full of comments discussing layering; one of them must not break the build.
    const prose = [
      "// A note that says: import from '@fixture/outer' — prose, not code.",
      '/**',
      " * A doc block mentioning export from '@fixture/outer' in passing.",
      ' */',
      'export const ok = 1;',
      '',
    ].join('\n');
    const { code, output } = runGuard({
      inner: { ...INNER, files: { 'index.ts': prose } },
      outer: OUTER,
    });
    expect(output).toContain('clean');
    expect(code).toBe(0);
  });

  test('does NOT fail on prose in a comment BELOW an apostrophe in JSX text', () => {
    // An apostrophe outside a string literal (JSX text, most often) used to put the comment scanner
    // into string state for the rest of the file, so every comment below it was scanned as code — and
    // a sentence naming a package failed CI as if it were an import. A quote state now ends at the
    // newline, since a `'`/`"` literal cannot span one.
    const jsx = [
      "export function A() { return <p>Don't do that</p>; }",
      "/** A doc block: import from '@fixture/outer' happens in the outer layer only. */",
      "// A note that says: import from '@fixture/outer' — prose, not code.",
      'export const ok = 1;',
      '',
    ].join('\n');
    const { code, output } = runGuard({
      inner: { ...INNER, files: { 'index.ts': jsx } },
      outer: OUTER,
    });
    expect(output).toContain('clean');
    expect(code).toBe(0);
  });

  test('a multi-line template literal does not derail the comment scanner after it', () => {
    // Template literals really do span lines, so their state must survive a newline — a `//` inside
    // one (a URL, say) is content, not a comment start. Both directions are pinned: prose naming a
    // package below the template is still stripped, and a genuine import below it is still seen.
    const clean = runGuard({
      inner: { ...INNER, files: { 'index.ts': fileWithTemplateThen('export const ok = 1;') } },
      outer: OUTER,
    });
    expect(clean.output).toContain('clean');
    expect(clean.code).toBe(0);

    const violating = runGuard({
      inner: { ...INNER, files: { 'index.ts': fileWithTemplateThen("import '@fixture/outer';") } },
      outer: OUTER,
    });
    expect(violating.code).toBe(1);
    expect(violating.output).toContain('inner → outer');
  });

  test('still sees a real import that shares a line with a comment', () => {
    const { code, output } = runGuard({
      inner: { ...INNER, files: { 'index.ts': "/* note */ import '@fixture/outer';\n" } },
      outer: OUTER,
    });
    expect(code).toBe(1);
    expect(output).toContain('inner → outer');
  });

  test('rejects a config whose layer has no rule, rather than skipping it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'arch-guard-'));
    try {
      mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
      copyFileSync(GUARD, path.join(root, 'scripts', 'ci', 'architecture-guard.mjs'));
      mkdirSync(path.join(root, 'packages', 'lonely', 'src'), { recursive: true });
      writeFileSync(path.join(root, 'packages', 'lonely', 'package.json'), JSON.stringify({ name: '@fixture/lonely' }));
      writeFileSync(path.join(root, 'packages', 'lonely', 'src', 'index.ts'), 'export const x = 1;\n');
      writeFileSync(
        path.join(root, 'onion.config.json'),
        JSON.stringify({ layers: { lonely: './packages/lonely/src' }, rules: [] }),
      );
      let output = '';
      try {
        execFileSync('node', [path.join(root, 'scripts', 'ci', 'architecture-guard.mjs')], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        output = String((error as { stderr: string }).stderr);
      }
      expect(output).toContain('has no rule');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
