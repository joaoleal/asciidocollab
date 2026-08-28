import {
  relativeIncludePath,
  relativeImagePath,
  substitutePathAttributes,
  imagesDirectory,
  resolveIncludeTarget,
  resolveImageTarget,
} from '@/lib/asciidoc/include-path';
import { resolveSandboxedPath } from '@/lib/asciidoc/sandbox-path';

const attributes = (entries: Record<string, string>): ReadonlyMap<string, string> => new Map(Object.entries(entries));

describe('relativeIncludePath', () => {
  it('returns the target unchanged when the authoring file is at the project root', () => {
    expect(relativeIncludePath('main.adoc', 'New Folder/new-document.adoc')).toBe('New Folder/new-document.adoc');
  });

  it('drops the shared directory when both files live in the same folder', () => {
    // The bug case: a file inside "New Folder" including a sibling must NOT repeat the folder.
    expect(relativeIncludePath('New Folder/new-document-2.adoc', 'New Folder/new-document.adoc')).toBe(
      'new-document.adoc',
    );
  });

  it('climbs out with ../ when the target is in an ancestor directory', () => {
    expect(relativeIncludePath('New Folder/sub/a.adoc', 'New Folder/b.adoc')).toBe('../b.adoc');
    expect(relativeIncludePath('a/b/c.adoc', 'root.adoc')).toBe('../../root.adoc');
  });

  it('descends into a sibling subtree', () => {
    expect(relativeIncludePath('a/b/c.adoc', 'a/x/y.adoc')).toBe('../x/y.adoc');
  });

  it('returns the project-relative target unchanged when no authoring path is known', () => {
    expect(relativeIncludePath(null, 'New Folder/new-document.adoc')).toBe('New Folder/new-document.adoc');
  });

  it('round-trips through resolveSandboxedPath back to the original target', () => {
    const cases: Array<[string, string]> = [
      ['New Folder/new-document-2.adoc', 'New Folder/new-document.adoc'],
      ['a/b/c.adoc', 'root.adoc'],
      ['a/b/c.adoc', 'a/x/y.adoc'],
      ['main.adoc', 'New Folder/new-document.adoc'],
    ];
    for (const [fromPath, target] of cases) {
      const written = relativeIncludePath(fromPath, target);
      const resolved = resolveSandboxedPath(fromPath, written);
      expect(resolved.ok && resolved.path).toBe(target);
    }
  });
});

describe('substitutePathAttributes', () => {
  it('substitutes known attributes case-insensitively and leaves unknown ones intact', () => {
    expect(substitutePathAttributes('{partsdir}/intro.adoc', attributes({ partsdir: 'shared' }))).toBe('shared/intro.adoc');
    expect(substitutePathAttributes('{PartsDir}/intro.adoc', attributes({ partsdir: 'shared' }))).toBe('shared/intro.adoc');
    expect(substitutePathAttributes('{nope}/x.adoc', new Map())).toBe('{nope}/x.adoc');
  });

  it('resolves nested references without looping on self-reference', () => {
    expect(substitutePathAttributes('{p}/i.adoc', attributes({ root: 'b', p: '{root}/parts' }))).toBe('b/parts/i.adoc');
    expect(substitutePathAttributes('{a}', attributes({ a: '{a}' }))).toBe('{a}');
  });
});

describe('resolveIncludeTarget', () => {
  it('substitutes attributes then resolves relative to the including file', () => {
    const result = resolveIncludeTarget('book/main.adoc', '{partsdir}/intro.adoc', attributes({ partsdir: 'shared' }));
    expect(result.ok && result.path).toBe('book/shared/intro.adoc');
  });
});

describe('resolveImageTarget / imagesDirectory', () => {
  it('resolves relative to the project root, with imagesdir prepended', () => {
    const result = resolveImageTarget('logo.png', attributes({ imagesdir: 'img' }));
    expect(result.ok && result.path).toBe('img/logo.png');
  });

  it('uses the target as a project-root-relative path when imagesdir is not defined', () => {
    // The reported case: an image at the project root referenced (no imagesdir) from a nested file.
    const result = resolveImageTarget('gummy.jpg', new Map());
    expect(result.ok && result.path).toBe('gummy.jpg');
  });

  it('substitutes attributes in the target and imagesdir', () => {
    const folder = resolveImageTarget('{folder}/pic.png', attributes({ folder: 'New Folder' }));
    expect(folder.ok && folder.path).toBe('New Folder/pic.png');
    const sub = resolveImageTarget('{name}.png', attributes({ base: 'assets', imagesdir: '{base}/img', name: 'logo' }));
    expect(sub.ok && sub.path).toBe('assets/img/logo.png');
  });

  it('rejects an imagesdir that escapes the project root', () => {
    expect(resolveImageTarget('logo.png', attributes({ imagesdir: '../assets' })).ok).toBe(false);
  });

  it('imagesDirectory is empty when unset and trailing-slash-free when set', () => {
    expect(imagesDirectory(new Map())).toBe('');
    expect(imagesDirectory(attributes({ imagesdir: 'assets/' }))).toBe('assets');
  });
});

describe('relativeImagePath', () => {
  it('writes the project-relative path as-is when no imagesdir is set', () => {
    expect(relativeImagePath('New Folder/pic.png', new Map())).toBe('New Folder/pic.png');
  });

  it('writes the path relative to imagesdir, round-tripping through resolveImageTarget', () => {
    const attributeMap = attributes({ imagesdir: 'assets' });
    const written = relativeImagePath('assets/pic.png', attributeMap);
    expect(written).toBe('pic.png');
    const resolved = resolveImageTarget(written, attributeMap);
    expect(resolved.ok && resolved.path).toBe('assets/pic.png');
  });

  it('folds a leading "./" in imagesdir instead of treating it as a folder', () => {
    const attributeMap = attributes({ imagesdir: './assets' });
    expect(relativeImagePath('assets/pic.png', attributeMap)).toBe('pic.png');
  });

  it('folds an empty segment left by a doubled slash in imagesdir', () => {
    const attributeMap = attributes({ imagesdir: 'assets//nested' });
    expect(relativeImagePath('assets/nested/pic.png', attributeMap)).toBe('pic.png');
  });

  it('folds a ".." segment in imagesdir against the segment before it', () => {
    const attributeMap = attributes({ imagesdir: 'assets/../images' });
    expect(relativeImagePath('images/pic.png', attributeMap)).toBe('pic.png');
  });

  it('treats an imagesdir of "." as the project root, writing the path unchanged', () => {
    const attributeMap = attributes({ imagesdir: '.' });
    const written = relativeImagePath('New Folder/pic.png', attributeMap);
    expect(written).toBe('New Folder/pic.png');
    const resolved = resolveImageTarget(written, attributeMap);
    expect(resolved.ok && resolved.path).toBe('New Folder/pic.png');
  });

  it('clamps a leading ".." in imagesdir at the project root', () => {
    // `..` at the top pops nothing, so the base collapses to the root and the path is written whole.
    expect(relativeImagePath('pic.png', attributes({ imagesdir: '..' }))).toBe('pic.png');
  });
});
