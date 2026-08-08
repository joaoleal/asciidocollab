/**
 * @file The guarantee that replaced the removed project-supplied extension path.
 *
 * A project's file tree is mounted at `/project` and every member with write access controls its
 * contents. The Ruby VM exposes `JS.global`, so anything loaded into it can reach the host page.
 * The administrator-folder model was adopted precisely so that project content can never introduce
 * executable code — and this file is where that claim is checked.
 *
 * **It MUST fail loudly if anyone later widens the loader's search path** (FR-034, FR-035, SC-012).
 */
import {
  ADMINISTRATOR_EXTENSIONS_MOUNT,
  PROJECT_MOUNT_PREFIX,
  SHIPPED_EXTENSIONS_MOUNT,
  isLoadableExtensionPath,
  resolvePdfExtensions,
  type PdfExtensionSource,
} from '../../src/extensions/registry';
import type { PdfExtensionCatalogueEntry } from '@asciidocollab/asciidoc-core';

/** A catalogue entry for `id`, available by default. */
function entry(
  id: string,
  origin: 'shipped' | 'administrator-provided' = 'shipped',
  available = true,
): PdfExtensionCatalogueEntry {
  return {
    manifest: {
      id,
      displayName: id,
      description: 'An extension.',
      targeting: '',
      themeKeys: [],
      sampleContent: '',
    },
    origin,
    available,
  };
}

/** A source for `id`. */
function source(
  id: string,
  origin: 'shipped' | 'administrator-provided' = 'shipped',
): PdfExtensionSource {
  return { id, origin, source: '# ruby' };
}

describe('isLoadableExtensionPath — project content is never executable', () => {
  it('refuses every path under the project mount', () => {
    for (const candidate of [
      `${PROJECT_MOUNT_PREFIX}/evil.rb`,
      `${PROJECT_MOUNT_PREFIX}/nested/evil.rb`,
      `${PROJECT_MOUNT_PREFIX}/extensions/evil.rb`,
      PROJECT_MOUNT_PREFIX,
    ]) {
      expect(isLoadableExtensionPath(candidate)).toBe(false);
    }
  });

  it('refuses a traversal that would climb into the project mount', () => {
    expect(
      isLoadableExtensionPath(`${SHIPPED_EXTENSIONS_MOUNT}/../../project/evil.rb`),
    ).toBe(false);
    expect(isLoadableExtensionPath(`${ADMINISTRATOR_EXTENSIONS_MOUNT}/../evil.rb`)).toBe(false);
  });

  it('refuses any traversal at all, rather than resolving it', () => {
    // A path containing `..` could resolve under `/project` while textually starting elsewhere.
    // Refusing is safe; resolving is a judgement call this boundary should not be making.
    expect(isLoadableExtensionPath(`${SHIPPED_EXTENSIONS_MOUNT}/a/../b.rb`)).toBe(false);
  });

  it('refuses paths outside every known mount', () => {
    for (const candidate of [
      '/etc/passwd',
      '/tmp/evil.rb',
      '/out/evil.rb',
      'relative.rb',
      '',
      '/extensions/evil.rb',
    ]) {
      expect(isLoadableExtensionPath(candidate)).toBe(false);
    }
  });

  it('permits only the two deployment-controlled mounts', () => {
    expect(isLoadableExtensionPath(`${SHIPPED_EXTENSIONS_MOUNT}/paragraph-numbering.rb`)).toBe(true);
    expect(isLoadableExtensionPath(`${ADMINISTRATOR_EXTENSIONS_MOUNT}/house-style.rb`)).toBe(true);
  });

  it('keeps the two extension mounts outside the project mount', () => {
    // The whole guarantee rests on these being disjoint; a refactor that nested them under
    // `/project` would defeat every check above while leaving them passing.
    expect(SHIPPED_EXTENSIONS_MOUNT.startsWith(`${PROJECT_MOUNT_PREFIX}/`)).toBe(false);
    expect(ADMINISTRATOR_EXTENSIONS_MOUNT.startsWith(`${PROJECT_MOUNT_PREFIX}/`)).toBe(false);
  });
});

describe('resolvePdfExtensions — a .rb file in a project is mounted but never loaded', () => {
  it('loads nothing when the project enables nothing, whatever its tree contains', () => {
    // A `.rb` file in the file tree reaches `/project` like any other asset. It is data there, and
    // no selection can turn it into code.
    const resolution = resolvePdfExtensions([], [entry('paragraph-numbering')], [source('paragraph-numbering')]);
    expect(resolution.loaded).toEqual([]);
  });

  it('refuses an id that no catalogue entry offers', () => {
    const resolution = resolvePdfExtensions(['project-supplied'], [], []);
    expect(resolution.loaded).toEqual([]);
    expect(resolution.rejected[0]).toMatchObject({ id: 'project-supplied' });
  });

  it('never derives a load path from the project mount', () => {
    const resolution = resolvePdfExtensions(
      ['paragraph-numbering'],
      [entry('paragraph-numbering')],
      [source('paragraph-numbering')],
    );
    for (const loaded of resolution.loaded) {
      expect(loaded.vfsPath.startsWith(`${PROJECT_MOUNT_PREFIX}/`)).toBe(false);
      expect(isLoadableExtensionPath(loaded.vfsPath)).toBe(true);
    }
  });

  it('refuses a source whose origin disagrees with the catalogue', () => {
    // A source turning up claiming a different origin than what was offered is a mismatch between
    // the catalogue and the code. Refuse rather than pick one to believe.
    const resolution = resolvePdfExtensions(
      ['house-style'],
      [entry('house-style', 'administrator-provided')],
      [source('house-style', 'shipped')],
    );
    expect(resolution.loaded).toEqual([]);
    expect(resolution.rejected[0].reason).toMatch(/origin/i);
  });
});

describe('resolvePdfExtensions — refusals are reported, never silent', () => {
  it('reports an enabled id that is no longer available (FR-030)', () => {
    const resolution = resolvePdfExtensions(
      ['retired'],
      [entry('retired', 'administrator-provided', false)],
      [source('retired', 'administrator-provided')],
    );
    expect(resolution.loaded).toEqual([]);
    expect(resolution.rejected[0].reason).toMatch(/no longer available/i);
  });

  it('reports an id with no supplied source', () => {
    const resolution = resolvePdfExtensions(['orphan'], [entry('orphan')], []);
    expect(resolution.rejected[0].reason).toMatch(/no source/i);
  });

  it('loads the good entries alongside the refused ones', () => {
    // One bad selection must not cost the author every other extension they enabled.
    const resolution = resolvePdfExtensions(
      ['good', 'missing'],
      [entry('good')],
      [source('good')],
    );
    expect(resolution.loaded.map((extension) => extension.id)).toEqual(['good']);
    expect(resolution.rejected.map((extension) => extension.id)).toEqual(['missing']);
  });
});

describe('resolvePdfExtensions — determinism (FR-031c, SC-007)', () => {
  const CATALOGUE = [entry('alpha'), entry('beta'), entry('gamma')];
  const SOURCES = [source('alpha'), source('beta'), source('gamma')];

  it('loads in id order regardless of the order they were selected in', () => {
    const forwards = resolvePdfExtensions(['alpha', 'beta', 'gamma'], CATALOGUE, SOURCES);
    const backwards = resolvePdfExtensions(['gamma', 'beta', 'alpha'], CATALOGUE, SOURCES);
    expect(forwards.loaded.map((extension) => extension.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(backwards.loaded.map((extension) => extension.id)).toEqual(forwards.loaded.map((extension) => extension.id));
  });

  it('does not let origin affect load order', () => {
    // An administrator adding an extension must not reorder the shipped ones relative to it and
    // change existing output.
    const catalogue = [entry('zebra', 'shipped'), entry('alpha', 'administrator-provided')];
    const sources = [source('zebra', 'shipped'), source('alpha', 'administrator-provided')];
    const resolution = resolvePdfExtensions(['zebra', 'alpha'], catalogue, sources);
    expect(resolution.loaded.map((extension) => extension.id)).toEqual(['alpha', 'zebra']);
  });

  it('loads an id listed twice only once', () => {
    // The VM is warm and never torn down, so an extension that `prepend`s a module corrupts later
    // renders if loaded twice (contract C3).
    const resolution = resolvePdfExtensions(['alpha', 'alpha'], CATALOGUE, SOURCES);
    expect(resolution.loaded.map((extension) => extension.id)).toEqual(['alpha']);
  });

  it('reports refusals in a stable order too', () => {
    const resolution = resolvePdfExtensions(['zzz', 'aaa'], [], []);
    expect(resolution.rejected.map((extension) => extension.id)).toEqual(['aaa', 'zzz']);
  });
});
