/**
 * @file A theme is content any project member can write, and it names resources by path. That makes
 * it an untrusted input to the asset collector, not a configuration file — so a theme referencing
 * `../../etc/passwd` or `https://evil.example/font.ttf` must cause neither a read outside the project
 * nor an outbound request (FR-021, SC-009, Principles IX and X).
 *
 * The guarantee is enforced where paths are resolved, so these tests drive the real collector rather
 * than asserting a policy exists somewhere. The shape of the assertion is deliberate: the escaping
 * reference is DROPPED and everything else in the theme still resolves. Aborting the whole render on
 * one bad reference would turn a typo into a denial of service.
 */
import { collectReferencedAssetPaths } from '@/lib/pdf/collect-referenced-assets';

const THEME_PATH = 'branding/corporate-theme.yml';

/** Run the collector over a project whose theme is `themeYaml`. */
function collect(themeYaml: string, extraFiles: Record<string, string> = {}): string[] {
  return collectReferencedAssetPaths({
    files: {
      'main.adoc': '= Doc\n\nBody.\n',
      [THEME_PATH]: themeYaml,
      ...extraFiles,
    },
    attributes: new Map([['pdf-theme', THEME_PATH]]),
  });
}

describe('a theme is untrusted input — escaping paths', () => {
  it('drops a font path that climbs out of the project', () => {
    const paths = collect(`font:
  catalog:
    Evil:
      normal: ../../../../etc/passwd.ttf
`);
    expect(paths).toEqual([]);
  });

  it('drops an absolute font path', () => {
    expect(
      collect(`font:
  catalog:
    Evil:
      normal: /etc/shadow.ttf
`),
    ).toEqual([]);
  });

  it('drops a traversal that would land back inside the project', () => {
    // Still refused: the sandbox judges the written path, not where it happens to resolve, so the
    // rule stays simple enough to be obviously correct.
    const paths = collect(`font:
  catalog:
    Sneaky:
      normal: ../branding/../../branding/real.ttf
`);
    expect(paths).toEqual([]);
  });

  it('keeps the rest of the theme working when one reference escapes', () => {
    // A typo in one font must not cost the author every other asset in the document.
    const paths = collect(`font:
  catalog:
    Escaping:
      normal: ../../outside.ttf
    Local:
      normal: fonts/real.ttf
`);
    expect(paths).toEqual(['branding/fonts/real.ttf']);
  });
});

describe('a theme is untrusted input — remote references', () => {
  it('never returns an http font reference, so nothing is fetched', () => {
    expect(
      collect(`font:
  catalog:
    Remote:
      normal: http://evil.example/font.ttf
`),
    ).toEqual([]);
  });

  it('never returns an https font reference', () => {
    expect(
      collect(`font:
  catalog:
    Remote:
      normal: https://evil.example/font.ttf
`),
    ).toEqual([]);
  });

  it('never returns a protocol-relative reference', () => {
    expect(
      collect(`font:
  catalog:
    Remote:
      normal: //evil.example/font.ttf
`),
    ).toEqual([]);
  });

  it('returns only project-relative paths, whatever the theme contains', () => {
    // The collector's output is the complete list of what will be fetched, so this single property
    // is what makes the no-egress invariant checkable rather than assumed.
    const paths = collect(`font:
  catalog:
    Mixed:
      normal: fonts/ok.ttf
      bold: https://evil.example/bold.ttf
      italic: ../../../outside.otf
`);
    for (const path of paths) {
      expect(path.startsWith('/')).toBe(false);
      expect(path).not.toMatch(/^[a-z]+:/i);
      expect(path).not.toContain('..');
    }
    expect(paths).toEqual(['branding/fonts/ok.ttf']);
  });
});

describe('a theme is untrusted input — the declared theme path itself', () => {
  it('ignores a theme path that climbs out of the project', () => {
    const paths = collectReferencedAssetPaths({
      files: { 'main.adoc': '= Doc\n' },
      attributes: new Map([['pdf-theme', '../../../etc/passwd.yml']]),
    });
    expect(paths).toEqual([]);
  });

  it('ignores a remote theme path', () => {
    const paths = collectReferencedAssetPaths({
      files: { 'main.adoc': '= Doc\n' },
      attributes: new Map([['pdf-theme', 'https://evil.example/theme.yml']]),
    });
    expect(paths).toEqual([]);
  });

  it('ignores a declared theme that is not a file in the project', () => {
    // Resolution returns the declared path; whether it EXISTS is checked here, so a theme naming a
    // file outside the supplied set yields nothing rather than a read attempt.
    const paths = collectReferencedAssetPaths({
      files: { 'main.adoc': '= Doc\n' },
      attributes: new Map([['pdf-theme', 'gone-theme.yml']]),
    });
    expect(paths).toEqual([]);
  });
});

describe('a theme is untrusted input — legitimate references still resolve', () => {
  it('resolves fonts relative to the theme’s own directory', () => {
    // The guard must not be so blunt that real themes stop working.
    expect(
      collect(`font:
  catalog:
    Brand:
      normal: fonts/brand-regular.ttf
      bold: fonts/brand-bold.ttf
`),
    ).toEqual(['branding/fonts/brand-bold.ttf', 'branding/fonts/brand-regular.ttf']);
  });

  it('resolves a font in a sibling directory of the theme', () => {
    expect(
      collect(`font:
  catalog:
    Brand:
      normal: ../assets/brand.ttf
`),
    ).toEqual(['assets/brand.ttf']);
  });
});
