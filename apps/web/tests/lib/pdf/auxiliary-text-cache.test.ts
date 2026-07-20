import {
  createAuxiliaryTextCache,
  isAuxiliaryTextPath,
} from '@/lib/pdf/auxiliary-text-cache';

describe('isAuxiliaryTextPath', () => {
  it('claims the text files the include graph can never reach', () => {
    expect(isAuxiliaryTextPath('corporate-theme.yml')).toBe(true);
    expect(isAuxiliaryTextPath('branding/Brand-Theme.YAML')).toBe(true);
    expect(isAuxiliaryTextPath('refs.bib')).toBe(true);
    expect(isAuxiliaryTextPath('citations/Sources.BIB')).toBe(true);
  });

  it('leaves ordinary project files to the include-graph cache', () => {
    expect(isAuxiliaryTextPath('main.adoc')).toBe(false);
    expect(isAuxiliaryTextPath('config.yml')).toBe(false);
    expect(isAuxiliaryTextPath('logo.png')).toBe(false);
  });
});

function fetcherFor(contents: Record<string, string>) {
  return jest.fn(async (fileNodeId: string) => contents[fileNodeId] ?? null);
}

/** The theme file most cases here hold, as the tree reports it. */
const themeEntry = { path: 'corporate-theme.yml', fileNodeId: 'node-theme' };

describe('createAuxiliaryTextCache', () => {
  const bibEntry = { path: 'refs.bib', fileNodeId: 'node-bib' };

  it('starts empty', () => {
    const cache = createAuxiliaryTextCache(fetcherFor({}));
    expect(cache.getFiles()).toEqual({});
  });

  it('fetches auxiliary files seeded from the file tree, not from include reachability', async () => {
    // The defect this closes: a theme is never reachable by walking `include::` from the main file,
    // so on a fresh page load its content was absent and the export silently rendered unthemed.
    const fetchContent = fetcherFor({ 'node-theme': 'base:\n  font-color: #333333\n' });
    const cache = createAuxiliaryTextCache(fetchContent);

    await cache.sync([themeEntry, { path: 'main.adoc', fileNodeId: 'node-main' }]);

    expect(cache.getFiles()).toEqual({ 'corporate-theme.yml': 'base:\n  font-color: #333333\n' });
    expect(fetchContent).toHaveBeenCalledTimes(1);
    expect(fetchContent).toHaveBeenCalledWith('node-theme');
  });

  it('reports whether a sync changed anything, so a caller can rebuild only when it must', async () => {
    const cache = createAuxiliaryTextCache(fetcherFor({ 'node-theme': 'base:\n' }));
    expect(await cache.sync([themeEntry])).toBe(true);
    expect(await cache.sync([themeEntry])).toBe(false);
  });

  it('fetches each file once across repeated syncs', async () => {
    const fetchContent = fetcherFor({ 'node-theme': 'base:\n', 'node-bib': '@book{a}' });
    const cache = createAuxiliaryTextCache(fetchContent);

    await cache.sync([themeEntry, bibEntry]);
    await cache.sync([themeEntry, bibEntry]);

    expect(fetchContent).toHaveBeenCalledTimes(2);
  });

  it('refetches a file after it is invalidated', async () => {
    // A collaborator's theme edit arrives as a content-changed frame. Without this the cache would
    // keep serving the copy fetched on page load and the preview would never show their change.
    let text = 'base:\n  font-color: #000000\n';
    const fetchContent = jest.fn(async () => text);
    const cache = createAuxiliaryTextCache(fetchContent);

    await cache.sync([themeEntry]);
    text = 'base:\n  font-color: #ff0000\n';
    expect(cache.invalidate('node-theme')).toBe(true);
    await cache.sync([themeEntry]);

    expect(cache.getFiles()['corporate-theme.yml']).toBe('base:\n  font-color: #ff0000\n');
    expect(fetchContent).toHaveBeenCalledTimes(2);
  });

  it('reports an invalidation for a file it does not hold as a no-op', async () => {
    const cache = createAuxiliaryTextCache(fetcherFor({}));
    expect(cache.invalidate('node-unknown')).toBe(false);
  });

  it('drops a file that has left the tree', async () => {
    const cache = createAuxiliaryTextCache(fetcherFor({ 'node-theme': 'base:\n', 'node-bib': '@book{a}' }));
    await cache.sync([themeEntry, bibEntry]);

    expect(await cache.sync([bibEntry])).toBe(true);
    expect(cache.getFiles()).toEqual({ 'refs.bib': '@book{a}' });
  });

  it('follows a rename to the new path', async () => {
    const cache = createAuxiliaryTextCache(fetcherFor({ 'node-theme': 'base:\n' }));
    await cache.sync([themeEntry]);

    await cache.sync([{ path: 'branding/corporate-theme.yml', fileNodeId: 'node-theme' }]);

    expect(cache.getFiles()).toEqual({ 'branding/corporate-theme.yml': 'base:\n' });
  });

  it('omits a file whose fetch fails rather than failing the whole sync', async () => {
    // An unreadable auxiliary file must not break the render — the document still has to export.
    const fetchContent = jest.fn(async (fileNodeId: string) => {
      if (fileNodeId === 'node-theme') throw new Error('403');
      return '@book{a}';
    });
    const cache = createAuxiliaryTextCache(fetchContent);

    await expect(cache.sync([themeEntry, bibEntry])).resolves.toBe(true);
    expect(cache.getFiles()).toEqual({ 'refs.bib': '@book{a}' });
  });

  it('does not issue a second fetch for a file already in flight', async () => {
    const deferred: { release?: (value: string) => void } = {};
    const fetchContent = jest.fn(
      () => new Promise<string>((resolve) => { deferred.release = resolve; }),
    );
    const cache = createAuxiliaryTextCache(fetchContent);

    const first = cache.sync([themeEntry]);
    const second = cache.sync([themeEntry]);
    deferred.release?.('base:\n');
    await Promise.all([first, second]);

    expect(fetchContent).toHaveBeenCalledTimes(1);
  });
});

/** Stands in until the promise executor hands over the real resolver. */
function unresolved(): void {
  // Never called: the executor below runs synchronously and replaces this immediately.
}

/** A promise whose resolution this test controls, for holding a fetch open. */
function deferred(): { promise: Promise<string>; release: (value: string) => void } {
  let release: (value: string) => void = unresolved;
  const promise = new Promise<string>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('an edit that lands while the file is being fetched', () => {
  it('does not install the version that was in flight', async () => {
    // The reply already on its way describes the file BEFORE the edit. Installing it leaves the
    // cache holding the previous version while looking present and fresh, so nothing ever refetches
    // and every later export renders the superseded theme — silently.
    const held = deferred();
    const fetchContent = jest
      .fn()
      .mockImplementationOnce(async () => held.promise)
      .mockImplementation(async () => 'after the edit');
    const cache = createAuxiliaryTextCache(fetchContent);

    const first = cache.sync([themeEntry]);
    cache.invalidate('node-theme');
    held.release('before the edit');
    await first;

    await cache.sync([themeEntry]);
    expect(cache.getFiles()['corporate-theme.yml']).toBe('after the edit');
  });

  it('refetches rather than trusting the shared in-flight request', async () => {
    const held = deferred();
    const fetchContent = jest
      .fn()
      .mockImplementationOnce(async () => held.promise)
      .mockImplementation(async () => 'after the edit');
    const cache = createAuxiliaryTextCache(fetchContent);

    const first = cache.sync([themeEntry]);
    cache.invalidate('node-theme');
    held.release('before the edit');
    await first;
    await cache.sync([themeEntry]);

    expect(fetchContent).toHaveBeenCalledTimes(2);
  });
});

describe('invalidation keeps the document styled while the replacement is fetched', () => {
  it('still serves the previous content between invalidating and refetching', async () => {
    // Deleting on invalidate opens a window in which the theme is simply absent. An export started
    // in that window renders unstyled — a worse outcome than rendering one revision behind.
    const cache = createAuxiliaryTextCache(fetcherFor({ 'node-theme': 'base:\n' }));
    await cache.sync([themeEntry]);

    cache.invalidate('node-theme');
    expect(cache.getFiles()['corporate-theme.yml']).toBe('base:\n');
  });

  it('keeps the stale copy and retries when the refetch fails', async () => {
    const fetchContent = jest
      .fn()
      .mockImplementationOnce(async () => 'base:\n')
      .mockImplementationOnce(async () => {
        throw new Error('offline');
      })
      .mockImplementation(async () => 'base:\n  font-color: #ff0000\n');
    const cache = createAuxiliaryTextCache(fetchContent);

    await cache.sync([themeEntry]);
    cache.invalidate('node-theme');
    await cache.sync([themeEntry]);
    // The failure did not cost the project its theme.
    expect(cache.getFiles()['corporate-theme.yml']).toBe('base:\n');

    // And the file is still known to be out of date, so the next sync tries again.
    await cache.sync([themeEntry]);
    expect(cache.getFiles()['corporate-theme.yml']).toBe('base:\n  font-color: #ff0000\n');
  });
});
