import { createStores } from '../../src/di/stores';
import type { getConfig } from '../../src/config';

/**
 * The project-wide search/replace routes resolve the RE2 regex engine off
 * `request.server.stores.regexEngine`, so the composition root MUST wire it. A
 * missing wiring would only surface at runtime, so pin it here.
 */
function fakeConfig(): ReturnType<typeof getConfig> {
  return {
    storage: { path: '/tmp/asciidocollab-stores-test' },
    collab: {
      editUrl: 'https://collab.internal:4101',
      editSecret: '',
      editTls: { cert: '', key: '', ca: '' },
    },
    git: {
      workerUrl: 'http://127.0.0.1:4010',
      workerSecret: '',
      workerTimeoutMs: 30_000,
      workerTls: { cert: '', key: '', ca: '' },
    },
    // The extension source reads its folder and its bounds from configuration — nothing is hardcoded
    // at the call site — so the composition root cannot be exercised without them.
    project: {
      pdfExtensions: {
        path: '/tmp/asciidocollab-extensions-test',
        maxExtensions: 50,
        maxSourceBytes: 262_144,
        scanCacheTtl: 30_000,
      },
    },
  } as unknown as ReturnType<typeof getConfig>;
}

describe('createStores', () => {
  it('wires the PDF extension source, the only route to the administrator folder', () => {
    // Reading that folder from anywhere else would mean each caller re-deciding the bounds on how
    // much work an outside party can cause, so the wiring is pinned here alongside the regex engine.
    const stores = createStores(fakeConfig());
    expect(stores.pdfExtensionSource).toBeDefined();
    expect(typeof stores.pdfExtensionSource.list).toBe('function');
    expect(typeof stores.pdfExtensionSource.readSource).toBe('function');
  });

  it('wires a working linear-time regex engine', () => {
    const stores = createStores(fakeConfig());
    expect(stores.regexEngine).toBeDefined();

    const compiled = stores.regexEngine.compile('(a+)b', { caseSensitive: true, multiline: false });
    expect(compiled.success).toBe(true);
    if (!compiled.success) return;
    const spans = compiled.value.matches('aab xb ab', {
      maxMatches: 100,
      deadline: Number.POSITIVE_INFINITY,
    });
    expect(spans.map((s) => s.groups[0])).toEqual(['aab', 'ab']);
  });

  it('rejects an invalid pattern instead of throwing', () => {
    const stores = createStores(fakeConfig());
    const compiled = stores.regexEngine.compile('(unterminated', { caseSensitive: true, multiline: false });
    expect(compiled.success).toBe(false);
  });

  it('wires a git-worker RPC client, the only route to the git-worker internal endpoints', () => {
    const stores = createStores(fakeConfig());
    expect(stores.gitWorkerClient).toBeDefined();
    expect(typeof stores.gitWorkerClient.getStatus).toBe('function');
    expect(typeof stores.gitWorkerClient.stageChanges).toBe('function');
    expect(typeof stores.gitWorkerClient.unstageChanges).toBe('function');
    expect(typeof stores.gitWorkerClient.commitChanges).toBe('function');
  });
});
