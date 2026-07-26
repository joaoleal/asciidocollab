/* @jest-environment jsdom */

/**
 * A font an export cannot reach is worse than a font it never promised: the reader waits for a request
 * that fails, sees the fallback anyway, and the file names the machine it was made on. These pin that no
 * `@font-face` ever leaves here still pointing at somebody else's origin, and that the faces which do
 * survive are the ones worth their bytes.
 */
import {
  coversBasicLatin,
  filterFontFaces,
  fontFileName,
  parseFontFaces,
  resolveFontFaces,
  rewriteFontFaceUrls,
  stripRemoteFontFaces,
  unquote,
} from '@/lib/html-export/font-faces';
import type { AssetFetcher } from '@/lib/html-export/inline-assets';

/** One realistic `next/font` face: plain family name, subset range, hashed file. */
const LATIN_FACE = `@font-face {
  font-family: Inter;
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("http://localhost:3000/_next/static/media/abc123-s.woff2") format("woff2");
  unicode-range: U+??, U+131, U+152-153;
}`;

/** The Cyrillic subset of the same family — same weight, different range, 25 KB nobody reads. */
const CYRILLIC_FACE = `@font-face {
  font-family: Inter;
  src: url("http://localhost:3000/_next/static/media/def456-s.woff2") format("woff2");
  unicode-range: U+460-52F, U+1C80-1C88, U+20B4;
}`;

const WOFF = new Uint8Array([119, 79, 70, 50]);
const fetchOk: AssetFetcher = async () => ({ bytes: WOFF, contentType: 'font/woff2' });
/** Serves every font except the Cyrillic subset, so a partial failure can be observed. */
const fetchExceptCyrillic: AssetFetcher = async (source) =>
  source.includes('def456') ? null : { bytes: WOFF, contentType: 'font/woff2' };

describe('parseFontFaces', () => {
  test('reads the family, the range and every url of each face', () => {
    const [face] = parseFontFaces(LATIN_FACE);
    expect(face.family).toBe('Inter');
    expect(face.unicodeRange).toBe('U+??, U+131, U+152-153');
    expect(face.urls).toEqual(['http://localhost:3000/_next/static/media/abc123-s.woff2']);
  });

  test('finds every face in a stylesheet and ignores the rest of it', () => {
    const css = `.a { color: red; }\n${LATIN_FACE}\n.b { color: blue; }\n${CYRILLIC_FACE}`;
    expect(parseFontFaces(css).map((face) => face.urls[0])).toEqual([
      'http://localhost:3000/_next/static/media/abc123-s.woff2',
      'http://localhost:3000/_next/static/media/def456-s.woff2',
    ]);
  });

  test('handles every quoting style a url() may use', () => {
    const css = `@font-face { font-family: "A"; src: url(plain.woff2), url('single.woff2'), url("double.woff2"); }`;
    expect(parseFontFaces(css)[0].urls).toEqual(['plain.woff2', 'single.woff2', 'double.woff2']);
  });

  test('a stylesheet with no faces yields nothing rather than throwing', () => {
    expect(parseFontFaces('.a { color: red; }')).toEqual([]);
  });
});

describe('unquote', () => {
  test('strips one layer of either quote style, and leaves bare values alone', () => {
    expect(unquote('"Open Sans"')).toBe('Open Sans');
    expect(unquote("'Noto Serif'")).toBe('Noto Serif');
    expect(unquote('  Inter  ')).toBe('Inter');
  });
});

describe('coversBasicLatin', () => {
  test('keeps the face that renders ordinary prose', () => {
    expect(coversBasicLatin('U+??, U+131, U+152-153')).toBe(true);
    expect(coversBasicLatin('U+0-FF')).toBe(true);
    expect(coversBasicLatin(undefined)).toBe(true);
    expect(coversBasicLatin('')).toBe(true);
  });

  test('drops the subsets that would double the size of every export', () => {
    // Latin Extended alone is 182 KB for Noto Serif, against 36 KB for basic Latin.
    expect(coversBasicLatin('U+100-2BA, U+2BD-2C5')).toBe(false);
    expect(coversBasicLatin('U+460-52F, U+1C80-1C88')).toBe(false);
    expect(coversBasicLatin('U+370-377, U+37A-37F')).toBe(false);
    expect(coversBasicLatin('U+1F??')).toBe(false);
  });

  test('a subset covering only control characters does not count as the Latin face', () => {
    // Open Sans ships one of these; probing U+0000 rather than a letter would embed it every time.
    expect(coversBasicLatin('U+1-C, U+E-1F, U+7F-9F')).toBe(false);
  });

  test('an unparseable range is not mistaken for a Latin one', () => {
    expect(coversBasicLatin('nonsense')).toBe(false);
  });
});

describe('filterFontFaces', () => {
  test('removes the rejected faces and keeps everything else verbatim', () => {
    const css = `.a { color: red; }\n${LATIN_FACE}\n${CYRILLIC_FACE}`;
    const kept = filterFontFaces(css, (face) => coversBasicLatin(face.unicodeRange));
    expect(kept).toContain('.a { color: red; }');
    expect(kept).toContain('abc123-s.woff2');
    expect(kept).not.toContain('def456-s.woff2');
  });
});

describe('rewriteFontFaceUrls', () => {
  test('replaces the url and preserves the rest of the declaration, which the browser needs', () => {
    const [face] = parseFontFaces(LATIN_FACE);
    const rewritten = rewriteFontFaceUrls(face, () => 'fonts/001-inter.woff2');
    expect(rewritten).toContain('url("fonts/001-inter.woff2") format("woff2")');
    expect(rewritten).toContain('font-weight: 100 900');
    expect(rewritten).toContain('unicode-range: U+??, U+131, U+152-153');
    expect(rewritten).not.toContain('localhost');
  });

  test('a null replacement leaves the url exactly as it was', () => {
    const [face] = parseFontFaces(LATIN_FACE);
    expect(rewriteFontFaceUrls(face, () => null)).toBe(face.text);
  });
});

describe('resolveFontFaces — single file', () => {
  test('embeds each file and leaves no trace of where it came from', async () => {
    const resolved = await resolveFontFaces(LATIN_FACE, fetchOk, 'single-file');
    expect(resolved.css).toContain('url("data:font/woff2;base64,');
    expect(resolved.css).not.toContain('localhost');
    expect(resolved.assets).toEqual([]);
  });

  test('fetches a file used by two faces once', async () => {
    const fetchFont = jest.fn(fetchOk);
    const shared = `@font-face { font-family: A; src: url(f.woff2); }\n@font-face { font-family: B; src: url(f.woff2); }`;
    await resolveFontFaces(shared, fetchFont, 'single-file');
    expect(fetchFont).toHaveBeenCalledTimes(1);
  });

  test('leaves an already-embedded face alone and asks for nothing', async () => {
    const fetchFont = jest.fn(fetchOk);
    const embedded = '@font-face { font-family: A; src: url("data:font/woff2;base64,AAA") format("woff2"); }';
    const resolved = await resolveFontFaces(embedded, fetchFont, 'single-file');
    expect(resolved.css).toBe(embedded);
    expect(fetchFont).not.toHaveBeenCalled();
  });
});

describe('resolveFontFaces — zip', () => {
  test('writes each file out and links it relatively, so a folder opened locally still renders', async () => {
    const resolved = await resolveFontFaces(LATIN_FACE, fetchOk, 'zip');
    expect(resolved.assets).toHaveLength(1);
    expect(resolved.assets[0].path).toMatch(/^fonts\/\d{3}-.*\.woff2$/);
    expect(resolved.css).toContain(`url("${resolved.assets[0].path}")`);
    expect(resolved.css).not.toContain('localhost');
  });
});

describe('resolveFontFaces — failures', () => {
  test('drops the whole face when its file cannot be had, rather than shipping a dead url', async () => {
    const resolved = await resolveFontFaces(`.a { color: red; }\n${LATIN_FACE}`, async () => null, 'single-file');
    expect(resolved.css).not.toContain('@font-face');
    expect(resolved.css).toContain('.a { color: red; }');
    expect(resolved.failures).toHaveLength(1);
  });

  test('reports the reason a fetch threw', async () => {
    const resolved = await resolveFontFaces(
      LATIN_FACE,
      async () => {
        throw new Error('offline');
      },
      'single-file',
    );
    expect(resolved.failures[0].reason).toBe('offline');
  });

  test('one unreachable file does not cost the faces that were fetched', async () => {
    const resolved = await resolveFontFaces(`${LATIN_FACE}\n${CYRILLIC_FACE}`, fetchExceptCyrillic, 'single-file');
    expect(resolved.css).toContain('data:font/woff2');
    expect(resolved.css).not.toContain('def456');
  });
});

describe('fontFileName', () => {
  test('names the file from the server\'s type', () => {
    expect(fontFileName('/media/abc-s.woff2', 0, 'font/woff2')).toBe('fonts/001-abc-s.woff2');
  });

  test('falls back to the extension in the url when the server declares something useless', () => {
    expect(fontFileName('/media/x.woff', 1, 'application/octet-stream')).toBe('fonts/002-x.woff');
  });

  test('never invents a path outside the fonts folder', () => {
    expect(fontFileName('../../etc/passwd.woff2', 0, 'font/woff2')).toBe('fonts/001-passwd.woff2');
  });
});

describe('stripRemoteFontFaces', () => {
  test('removes a face pointing at a host, which is the shape of the bug this guards', () => {
    expect(stripRemoteFontFaces(LATIN_FACE)).toBe('');
  });

  test('removes a face pointing at an absolute path, which resolves nowhere in a saved file', () => {
    const rooted = '@font-face { font-family: A; src: url("/vendor/mathjax/fonts/x.woff") format("woff"); }';
    expect(stripRemoteFontFaces(rooted)).toBe('');
  });

  test('keeps the faces an export actually carries', () => {
    const embedded = '@font-face { font-family: A; src: url("data:font/woff2;base64,AAA"); }';
    const relative = '@font-face { font-family: B; src: url("fonts/001-b.woff2"); }';
    expect(stripRemoteFontFaces(`${embedded}\n${relative}`)).toBe(`${embedded}\n${relative}`);
  });

  test('leaves the rest of the stylesheet untouched, including data: images with a namespace in them', () => {
    // The preview stylesheet inlines SVG masks whose payload contains `http://www.w3.org/2000/svg`. It
    // is a namespace, not a request, and a strip that went looking for "http" would break the icons.
    const masked = `.x { mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E"); }`;
    expect(stripRemoteFontFaces(masked)).toBe(masked);
  });
});
