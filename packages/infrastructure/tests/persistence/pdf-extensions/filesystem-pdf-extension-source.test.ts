import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FilesystemPdfExtensionSource } from '../../../src/persistence/pdf-extensions/filesystem-pdf-extension-source';

const VALID_MANIFEST = {
  id: 'house-style',
  displayName: 'House style',
  description: 'Applies the house layout conventions.',
};

let folder: string;
let clock = 1000;

/** Build the adapter over the temp folder, with a controllable clock. */
function adapter(overrides: Partial<Parameters<typeof FilesystemPdfExtensionSource.prototype.constructor>[0]> = {}) {
  return new FilesystemPdfExtensionSource({
    path: folder,
    maxExtensions: 50,
    maxSourceBytes: 262_144,
    scanCacheTtl: 30_000,
    now: () => clock,
    ...overrides,
  });
}

/** Write one extension directory into the folder. */
async function writeExtension(
  directory: string,
  manifest: unknown = VALID_MANIFEST,
  source = '# ruby\n',
): Promise<void> {
  const base = path.join(folder, directory);
  await mkdir(base, { recursive: true });
  if (manifest !== undefined) {
    await writeFile(
      path.join(base, 'manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    );
  }
  if (source !== '') await writeFile(path.join(base, 'extension.rb'), source);
}

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'pdf-ext-'));
  clock = 1000;
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('FilesystemPdfExtensionSource — reading the folder', () => {
  it('lists a well-formed extension', async () => {
    await writeExtension('house-style');
    const result = await adapter().list();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.extensions).toHaveLength(1);
    expect(result.value.extensions[0].manifest.id).toBe('house-style');
    expect(result.value.excluded).toEqual([]);
  });

  it('treats a missing folder as an empty catalogue, not an error', async () => {
    // The normal case for a deployment providing no extensions: only the shipped set is offered.
    const missing = new FilesystemPdfExtensionSource({
      path: path.join(folder, 'nope'),
      maxExtensions: 50,
      maxSourceBytes: 1000,
      scanCacheTtl: 0,
    });
    const result = await missing.list();
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.extensions).toEqual([]);
  });

  it('lists extensions in a stable order', async () => {
    await writeExtension('zebra', { ...VALID_MANIFEST, id: 'zebra' });
    await writeExtension('alpha', { ...VALID_MANIFEST, id: 'alpha' });
    const result = await adapter().list();
    if (!result.success) throw new Error('expected success');
    expect(result.value.extensions.map((entry) => entry.manifest.id)).toEqual(['alpha', 'zebra']);
  });
});

describe('FilesystemPdfExtensionSource — one bad entry is excluded, not fatal', () => {
  it('excludes a directory with no manifest and keeps the good ones', async () => {
    await writeExtension('good');
    await mkdir(path.join(folder, 'broken'), { recursive: true });
    const result = await adapter().list();
    if (!result.success) throw new Error('expected success');
    expect(result.value.extensions.map((entry) => entry.manifest.id)).toEqual(['house-style']);
    expect(result.value.excluded[0]).toMatchObject({ source: 'broken' });
  });

  it('excludes a manifest that is not valid JSON', async () => {
    await writeExtension('broken', '{ not json');
    const result = await adapter().list();
    if (!result.success) throw new Error('expected success');
    expect(result.value.extensions).toEqual([]);
    expect(result.value.excluded[0].reason).toMatch(/valid JSON/);
  });

  it('excludes a manifest that fails validation, naming the field', async () => {
    await writeExtension('broken', { id: 'ok', displayName: '' });
    const result = await adapter().list();
    if (!result.success) throw new Error('expected success');
    expect(result.value.excluded[0].reason).toMatch(/displayName|description/);
  });

  it('excludes an extension whose source file is missing', async () => {
    await writeExtension('no-source', VALID_MANIFEST, '');
    const result = await adapter().list();
    if (!result.success) throw new Error('expected success');
    expect(result.value.excluded[0].reason).toMatch(/extension\.rb is missing/);
  });

  it('reports every exclusion rather than reporting a count', async () => {
    // An administrator needs to know WHICH file to fix.
    await writeExtension('a', '{ bad');
    await writeExtension('b', '{ bad');
    const result = await adapter().list();
    if (!result.success) throw new Error('expected success');
    expect(result.value.excluded.map((excluded) => excluded.source).toSorted()).toEqual(['a', 'b']);
  });
});

describe('FilesystemPdfExtensionSource — the scan is bounded work', () => {
  it('stops at maxExtensions and reports the cap was reached', async () => {
    // Without this the cost of a catalogue read is dictated by what someone drops in the folder.
    for (const name of ['a', 'b', 'c']) {
      await writeExtension(name, { ...VALID_MANIFEST, id: name });
    }
    const result = await adapter({ maxExtensions: 2 }).list();
    if (!result.success) throw new Error('expected success');
    expect(result.value.extensions).toHaveLength(2);
    expect(result.value.excluded[0].reason).toMatch(/maximum of 2/);
  });

  it('excludes a source over the byte limit', async () => {
    await writeExtension('big', VALID_MANIFEST, 'x'.repeat(5000));
    const result = await adapter({ maxSourceBytes: 100 }).list();
    if (!result.success) throw new Error('expected success');
    expect(result.value.extensions).toEqual([]);
    expect(result.value.excluded[0].reason).toMatch(/over the 100-byte limit/);
  });
});

describe('FilesystemPdfExtensionSource — the scan cache', () => {
  it('reuses a recent scan instead of rescanning', async () => {
    await writeExtension('house-style');
    const source = adapter();
    await source.list();

    // A file added within the TTL is not seen yet — the interval is what bounds how long a newly
    // added extension takes to appear, rather than it being a vague promise.
    await writeExtension('second', { ...VALID_MANIFEST, id: 'second' });
    const cached = await source.list();
    if (!cached.success) throw new Error('expected success');
    expect(cached.value.extensions).toHaveLength(1);
  });

  it('rescans once the interval has passed', async () => {
    await writeExtension('house-style');
    const source = adapter();
    await source.list();
    await writeExtension('second', { ...VALID_MANIFEST, id: 'second' });

    clock += 30_001;
    const rescanned = await source.list();
    if (!rescanned.success) throw new Error('expected success');
    expect(rescanned.value.extensions).toHaveLength(2);
  });
});

describe('FilesystemPdfExtensionSource — handles are looked up, never joined onto a path', () => {
  it('reads the source for a handle it issued', async () => {
    await writeExtension('house-style', VALID_MANIFEST, '# the house style\n');
    const source = adapter();
    const listed = await source.list();
    if (!listed.success) throw new Error('expected success');

    const read = await source.readSource(listed.value.extensions[0].handle);
    expect(read.success).toBe(true);
    if (read.success) expect(read.value).toBe('# the house style\n');
  });

  it('refuses a handle it never issued', async () => {
    await writeExtension('house-style');
    const source = adapter();
    await source.list();
    const read = await source.readSource('invented');
    expect(read.success).toBe(false);
  });

  it('refuses a handle shaped like a path traversal', async () => {
    // A caller that could construct a handle could name any file on the disk. The lookup is what
    // makes that impossible, so these must fail on being unknown rather than on being sanitised.
    await writeExtension('house-style');
    const source = adapter();
    await source.list();
    for (const handle of [
      '../../../../etc/passwd',
      '/etc/passwd',
      'house-style:../../../etc/passwd',
      '..',
    ]) {
      const read = await source.readSource(handle);
      expect(read.success).toBe(false);
    }
  });

  it('scans on demand when a source is asked for before any listing', async () => {
    await writeExtension('house-style', VALID_MANIFEST, '# ruby\n');
    const source = adapter();
    const listed = await adapter().list();
    if (!listed.success) throw new Error('expected success');
    const read = await source.readSource(listed.value.extensions[0].handle);
    expect(read.success).toBe(true);
  });
});
