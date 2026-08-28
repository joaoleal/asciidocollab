/* @jest-environment jsdom */

/**
 * The two packagings differ in one place — what bytes come out and under what name. These pin that,
 * and pin that a zip is self-consistent: the paths inside it are the paths the document links to.
 */
import { unzipSync, strFromU8 } from 'fflate';
import {
  downloadExport,
  packageExport,
  stylesheetAsset,
  ZIP_DOCUMENT_NAME,
  ZIP_STYLESHEET_NAME,
} from '@/lib/html-export/package-export';
import type { ExportAsset } from '@/lib/html-export/inline-assets';

const ASSETS: ExportAsset[] = [
  { path: 'assets/001-logo.png', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
  { path: 'assets/002-photo.jpg', bytes: new Uint8Array([4, 5]), contentType: 'image/jpeg' },
];

/** Read a packaged zip back into a path → bytes map. */
function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

describe('packageExport — single file', () => {
  test('produces the HTML itself, with nothing alongside it', () => {
    const packaged = packageExport('<html>doc</html>', ASSETS, 'single-file', 'Guide Project');
    expect(packaged.fileName).toMatch(/^guide-project-\d{4}-\d{2}-\d{2}\.html$/);
    expect(strFromU8(packaged.bytes)).toBe('<html>doc</html>');
    expect(packaged.blob.type).toContain('text/html');
  });

  test('ignores any assets, because a single-file export has already embedded them', () => {
    const packaged = packageExport('<html>doc</html>', ASSETS, 'single-file', 'Guide Project');
    expect(strFromU8(packaged.bytes)).not.toContain('assets/');
  });
});

describe('packageExport — zip', () => {
  test('names the document index.html, which a browser opens without being asked', () => {
    const packaged = packageExport('<html>doc</html>', ASSETS, 'zip', 'Guide Project');
    const entries = unzip(packaged.bytes);
    expect(Object.keys(entries)).toContain(ZIP_DOCUMENT_NAME);
    expect(strFromU8(entries[ZIP_DOCUMENT_NAME])).toBe('<html>doc</html>');
  });

  test('places each asset at exactly the path the document links to', () => {
    // The archive has to be self-consistent the moment it is opened: a mismatch here is a broken
    // image that only shows up after the file has been sent to someone.
    const packaged = packageExport('<img src="assets/001-logo.png">', ASSETS, 'zip', 'Guide Project');
    const entries = unzip(packaged.bytes);
    for (const asset of ASSETS) {
      expect(entries[asset.path]).toEqual(asset.bytes);
    }
  });

  test('is offered as a zip, under the project name', () => {
    const packaged = packageExport('<html>doc</html>', ASSETS, 'zip', 'Report Project');
    expect(packaged.fileName).toMatch(/^report-project-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(packaged.blob.type).toBe('application/zip');
  });

  test('produces a valid archive for a document with no assets at all', () => {
    const packaged = packageExport('<html>doc</html>', [], 'zip', 'Guide Project');
    const entries = unzip(packaged.bytes);
    expect(Object.keys(entries)).toEqual([ZIP_DOCUMENT_NAME]);
  });
});

describe('stylesheetAsset', () => {
  test('names and types the stylesheet so the zip carries it like any other file', () => {
    const asset = stylesheetAsset('body { color: red }');

    expect(asset.path).toBe(ZIP_STYLESHEET_NAME);
    expect(asset.contentType).toBe('text/css;charset=utf-8');
    expect(strFromU8(asset.bytes)).toBe('body { color: red }');
  });

  test('is written into the archive at the root, beside the document', () => {
    const packaged = packageExport(
      '<html>doc</html>',
      [stylesheetAsset('body { color: red }')],
      'zip',
      'Guide Project',
    );

    expect(strFromU8(unzip(packaged.bytes)[ZIP_STYLESHEET_NAME])).toBe('body { color: red }');
  });
});

describe('downloadExport', () => {
  let created: Blob[];
  let revoked: string[];

  beforeEach(() => {
    created = [];
    revoked = [];
    jest.useFakeTimers();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: (blob: Blob) => {
        created.push(blob);
        return 'blob:packaged-export';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: (url: string) => {
        revoked.push(url);
      },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('clicks a named anchor for the packaged bytes and leaves no element behind', () => {
    const packaged = packageExport('<html>doc</html>', [], 'single-file', 'Guide Project');
    let clickedDownload: string | undefined;
    let clickedHref: string | undefined;
    const clickListener = (event: Event): void => {
      // jsdom would otherwise try to navigate to the object URL, which it cannot do.
      event.preventDefault();
      const target = event.target;
      if (target instanceof HTMLAnchorElement) {
        clickedDownload = target.download;
        clickedHref = target.href;
      }
    };
    document.addEventListener('click', clickListener);

    downloadExport(packaged);

    document.removeEventListener('click', clickListener);
    expect(created).toEqual([packaged.blob]);
    expect(clickedDownload).toBe(packaged.fileName);
    expect(clickedHref).toBe('blob:packaged-export');
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  test('revokes the object url on a later task, not in the click', () => {
    const packaged = packageExport('<html>doc</html>', [], 'single-file', 'Guide Project');

    downloadExport(packaged);

    expect(revoked).toEqual([]);
    jest.runAllTimers();
    expect(revoked).toEqual(['blob:packaged-export']);
  });
});
