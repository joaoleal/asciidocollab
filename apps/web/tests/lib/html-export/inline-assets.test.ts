/**
 * The preview's images point at an authenticated endpoint, which is right on screen and useless in a
 * file. These pin what the export resolves, what it deliberately leaves alone, and what it does when
 * an image cannot be fetched.
 */
import {
  assetFileName,
  collectImageSources,
  resolveImageAssets,
  rewriteImageSources,
  toDataUri,
  type AssetFetcher,
} from '@/lib/html-export/inline-assets';

const PNG = new Uint8Array([137, 80, 78, 71]);

const fetchOk: AssetFetcher = async () => ({ bytes: PNG, contentType: 'image/png' });
const fetchNone: AssetFetcher = async () => null;
/** Succeeds for everything except `bad.png`, so one failure can be observed beside a success. */
const fetchOneBad: AssetFetcher = async (source) =>
  source === 'bad.png' ? null : { bytes: PNG, contentType: 'image/png' };
/** Always throws, standing in for a network that is simply down. */
const fetchThrows: AssetFetcher = async () => {
  throw new Error('network down');
};

describe('collectImageSources', () => {
  test('finds every project-relative source, in document order', () => {
    const html = '<img src="a.png"><p>x</p><img src="dir/b.jpg">';
    expect(collectImageSources(html)).toEqual(['a.png', 'dir/b.jpg']);
  });

  test('collapses duplicates so a repeated image is fetched once', () => {
    expect(collectImageSources('<img src="a.png"><img src="a.png">')).toEqual(['a.png']);
  });

  test('leaves already-embedded and remote sources alone', () => {
    // A data: URI is already self-contained, and a remote URL is the author's explicit choice —
    // silently localising it would change what the document means.
    const html =
      '<img src="data:image/png;base64,AAA"><img src="https://example.com/x.png">' +
      '<img src="//cdn.example.com/y.png"><img src="local.png">';
    expect(collectImageSources(html)).toEqual(['local.png']);
  });

  test('handles single-quoted attributes and extra attributes around src', () => {
    expect(collectImageSources(`<img alt="a" src='q.png' width="10">`)).toEqual(['q.png']);
  });

  test('returns nothing for a document with no images', () => {
    expect(collectImageSources('<p>no pictures here</p>')).toEqual([]);
  });
});

describe('rewriteImageSources', () => {
  test('replaces only the sources it has a replacement for', () => {
    const html = '<img src="a.png"><img src="b.png">';
    const out = rewriteImageSources(html, new Map([['a.png', 'assets/001-a.png']]));
    expect(out).toContain('src="assets/001-a.png"');
    expect(out).toContain('src="b.png"');
  });

  test('preserves the surrounding attributes and the quote style', () => {
    const out = rewriteImageSources(`<img alt="A cat" src='c.png' class="x">`, new Map([['c.png', 'z']]));
    expect(out).toBe(`<img alt="A cat" src='z' class="x">`);
  });

  test('rewrites every occurrence of a repeated source', () => {
    const out = rewriteImageSources('<img src="a.png"><img src="a.png">', new Map([['a.png', 'z']]));
    expect(out).toBe('<img src="z"><img src="z">');
  });
});

describe('toDataUri', () => {
  test('encodes bytes as a base64 data URI carrying the content type', () => {
    expect(toDataUri(new Uint8Array([1, 2, 3]), 'image/png')).toBe(`data:image/png;base64,${btoa('\u0001\u0002\u0003')}`);
  });

  test('encodes a payload larger than one chunk without truncating it', () => {
    // Encoded in chunks so a big image cannot blow String.fromCharCode's argument limit; the seam
    // between chunks is where a naive implementation loses bytes.
    const big = new Uint8Array(20_000).fill(65);
    const uri = toDataUri(big, 'image/png');
    expect(atob(uri.slice('data:image/png;base64,'.length))).toHaveLength(20_000);
  });
});

describe('assetFileName', () => {
  test('takes the extension from the resolved content type, not the URL', () => {
    // The endpoint serves opaque URLs; the server's own content type is the reliable answer.
    expect(assetFileName('/api/assets/abc', 0, 'image/png')).toMatch(/\.png$/);
    expect(assetFileName('photo.png', 1, 'image/jpeg')).toMatch(/\.jpg$/);
  });

  test('numbers each asset so two images with the same leaf name cannot collide', () => {
    const first = assetFileName('a/logo.png', 0, 'image/png');
    const second = assetFileName('b/logo.png', 1, 'image/png');
    expect(first).not.toBe(second);
  });

  test('never escapes the assets folder, whatever the source path looks like', () => {
    // Sources can be absolute or contain traversal; a zip must not be able to write outside itself.
    for (const source of ['../../etc/passwd.png', '/abs/x.png', 'a/../../b.png', String.raw`C:\win\x.png`]) {
      const name = assetFileName(source, 0, 'image/png');
      expect(name.startsWith('assets/')).toBe(true);
      expect(name).not.toContain('..');
    }
  });

  test('falls back to a generic extension when nothing identifies the type', () => {
    expect(assetFileName('mystery', 0, 'application/octet-stream')).toMatch(/\.bin$/);
  });
});

describe('resolveImageAssets — single file', () => {
  test('embeds each image so the document needs no companion files', async () => {
    const result = await resolveImageAssets('<img src="a.png">', fetchOk, 'single-file');
    expect(result.html).toContain('src="data:image/png;base64,');
    expect(result.assets).toHaveLength(0);
  });

  test('fetches a repeated image once and embeds it at every reference', async () => {
    const fetcher = jest.fn(fetchOk);
    const result = await resolveImageAssets('<img src="a.png"><img src="a.png">', fetcher, 'single-file');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect([...result.html.matchAll(/data:image\/png/g)]).toHaveLength(2);
  });
});

describe('resolveImageAssets — zip', () => {
  test('writes each image out and links it relatively', async () => {
    const result = await resolveImageAssets('<img src="a.png">', fetchOk, 'zip');
    expect(result.assets).toHaveLength(1);
    expect(result.html).toContain(`src="${result.assets[0].path}"`);
    expect(result.html).not.toContain('data:image');
  });

  test('keeps the fetched bytes and content type for the file it will write', async () => {
    const result = await resolveImageAssets('<img src="a.png">', fetchOk, 'zip');
    expect(result.assets[0].bytes).toEqual(PNG);
    expect(result.assets[0].contentType).toBe('image/png');
  });
});

describe('resolveImageAssets — failures', () => {
  test('records an unfetchable image and leaves its reference pointing where it did', async () => {
    // A broken image the reader can investigate beats one silently removed without telling them.
    const result = await resolveImageAssets('<img src="gone.png">', fetchNone, 'single-file');
    expect(result.failures).toEqual([{ source: 'gone.png', reason: 'could not be retrieved' }]);
    expect(result.html).toContain('src="gone.png"');
  });

  test('one failure does not stop the other images being resolved', async () => {
    const result = await resolveImageAssets('<img src="bad.png"><img src="good.png">', fetchOneBad, 'single-file');
    expect(result.failures).toHaveLength(1);
    expect(result.html).toContain('src="bad.png"');
    expect(result.html).toContain('data:image/png;base64,');
  });

  test('a fetcher that throws is reported with its message rather than aborting the export', async () => {
    const result = await resolveImageAssets('<img src="a.png">', fetchThrows, 'single-file');
    expect(result.failures).toEqual([{ source: 'a.png', reason: 'network down' }]);
  });
});

describe('inline-assets — edge cases in what gets collected and named', () => {
  test('an img with an empty or absent src is skipped rather than fetched', () => {
    expect(collectImageSources('<img src="">')).toEqual([]);
    expect(collectImageSources('<img alt="no source">')).toEqual([]);
  });

  test('an extensionless source is named from the served content type', () => {
    // The asset endpoint's paths often carry no extension; a file called `001-pic.bin` would not open.
    expect(assetFileName('pic', 0, 'image/webp')).toBe('assets/001-pic.webp');
  });

  test('a content type with parameters is still recognised', () => {
    expect(assetFileName('pic', 0, 'image/png; charset=binary')).toBe('assets/001-pic.png');
  });

  test('an unknown content type falls back to the source’s own plausible extension', () => {
    expect(assetFileName('diagram.svg', 0, 'application/octet-stream')).toBe('assets/001-diagram.svg');
  });

  test('an implausible source extension is not trusted as a file type', () => {
    // A long alphabetic tail is not an extension, so it must not become the file's type.
    expect(assetFileName('archive.something', 0, 'application/octet-stream')).toBe('assets/001-archive.bin');
  });

  test('a query string is not part of the name', () => {
    expect(assetFileName('pic.png?v=2', 0, 'image/png')).toBe('assets/001-pic.png');
  });

  test('a dot-leading name keeps its whole leaf, having no stem to split', () => {
    // A leading dot is not an extension separator, so the whole leaf is the stem.
    expect(assetFileName('.hidden', 0, 'image/png')).toBe('assets/001-.hidden.png');
  });

  test('a source with nothing usable in it still gets a name', () => {
    expect(assetFileName('///', 0, 'image/png')).toBe('assets/001-image.png');
  });

  test('windows-style separators are handled like slashes', () => {
    expect(assetFileName(String.raw`folder\pic.png`, 0, 'image/png')).toBe('assets/001-pic.png');
  });

  test('a very long name is truncated without losing the extension', () => {
    const name = assetFileName(`${'a'.repeat(80)}.png`, 0, 'image/png');
    expect(name.endsWith('.png')).toBe(true);
    expect(name.length).toBeLessThan(60);
  });

  test('the index makes names unique when two sources share a leaf', () => {
    // Folder structure is deliberately not reproduced, so `a/pic.png` and `b/pic.png` collide on leaf.
    expect(assetFileName('a/pic.png', 0, 'image/png')).toBe('assets/001-pic.png');
    expect(assetFileName('b/pic.png', 1, 'image/png')).toBe('assets/002-pic.png');
  });
});
