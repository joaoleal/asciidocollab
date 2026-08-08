// This file has no imports or exports of its own, which would make it a SCRIPT: its top-level
// helpers would land in the global scope and collide by name with another spec's. This export makes it one.
export const IS_MODULE = true;

// Issue 4: file-tree.ts must not define its own NEXT_PUBLIC_API_URL constant —
// the same divergence risk that was just fixed in use-auto-save.ts and
// use-file-selection.ts. It must import API_BASE_URL from lib/api/file-content.
describe('file-tree module must not duplicate API_BASE_URL', () => {
  test('file-tree.ts does not define its own NEXT_PUBLIC_API_URL expression', () => {
    const fs = require('node:fs');
    const source: string = fs.readFileSync(
      require.resolve('@/lib/api/file-tree'),
      'utf8',
    );
    expect(source).not.toContain('process.env.NEXT_PUBLIC_API_URL');
    expect(source).toContain('API_BASE_URL');
  });
});

// ── file-tree API function behaviour ─────────────────────────────────────────

function mockOk(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: jest.fn().mockResolvedValue(body) });
}

function mockError(status: number, body: unknown) {
  return Promise.resolve({ ok: false, status, json: jest.fn().mockResolvedValue(body) });
}

describe('FileTreeApiError', () => {
  let FileTreeApiError: typeof import('@/lib/api/file-tree').FileTreeApiError;

  beforeEach(() => {
    jest.resetModules();
    ({ FileTreeApiError } = require('@/lib/api/file-tree'));
  });

  test('has name "FileTreeApiError"', () => {
    const error = new FileTreeApiError(404, 'NOT_FOUND', 'Not found');
    expect(error.name).toBe('FileTreeApiError');
  });

  test('stores status, code, and message', () => {
    const error = new FileTreeApiError(400, 'INVALID', 'Bad request');
    expect(error.status).toBe(400);
    expect(error.code).toBe('INVALID');
    expect(error.message).toBe('Bad request');
  });

  test('stores existingFileNodeId when provided', () => {
    const error = new FileTreeApiError(409, 'CONFLICT', 'Exists', 'fn-existing');
    expect(error.existingFileNodeId).toBe('fn-existing');
  });

  test('existingFileNodeId is undefined when not provided', () => {
    const error = new FileTreeApiError(404, 'NOT_FOUND', 'Not found');
    expect(error.existingFileNodeId).toBeUndefined();
  });
});

describe('createFolder', () => {
  let fetchMock: jest.Mock;
  let createFolder: typeof import('@/lib/api/file-tree').createFolder;
  let FileTreeApiError: typeof import('@/lib/api/file-tree').FileTreeApiError;

  beforeEach(() => {
    jest.resetModules();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    ({ createFolder, FileTreeApiError } = require('@/lib/api/file-tree'));
  });

  test('sends POST and returns fileNodeId and path on success', async () => {
    fetchMock.mockReturnValueOnce(mockOk({ fileNodeId: 'fn1', path: '/docs' }));
    const result = await createFolder('p1', 'root', 'docs');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/projects/p1/files');
    expect(result.fileNodeId).toBe('fn1');
  });

  test('sends credentials: include', async () => {
    fetchMock.mockReturnValueOnce(mockOk({ fileNodeId: 'fn1', path: '/docs' }));
    await createFolder('p1', 'root', 'docs');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });

  test('sends Content-Type application/json header', async () => {
    fetchMock.mockReturnValueOnce(mockOk({ fileNodeId: 'fn1', path: '/docs' }));
    await createFolder('p1', 'root', 'docs');
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
  });

  test('sends body with type folder, parentId, and name', async () => {
    fetchMock.mockReturnValueOnce(mockOk({ fileNodeId: 'fn1', path: '/docs' }));
    await createFolder('p1', 'root', 'docs');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('folder');
    expect(body.parentId).toBe('root');
    expect(body.name).toBe('docs');
  });

  test('throws FileTreeApiError on non-ok response', async () => {
    fetchMock.mockReturnValueOnce(mockError(409, { error: { code: 'CONFLICT', message: 'Already exists' }, existingFileNodeId: 'fn0' }));
    await expect(createFolder('p1', 'root', 'docs')).rejects.toBeInstanceOf(FileTreeApiError);
  });

  test('error carries exact message and code from body', async () => {
    fetchMock.mockReturnValueOnce(mockError(409, { error: { code: 'CONFLICT', message: 'Folder already exists' }, existingFileNodeId: 'fn0' }));
    const error = await createFolder('p1', 'root', 'docs').catch((error_: unknown) => error_);
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Folder already exists');
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('CONFLICT');
    expect((error as InstanceType<typeof FileTreeApiError>).existingFileNodeId).toBe('fn0');
  });

  test('throws FileTreeApiError with fallback code "ERROR" and fallback message when error body is empty', async () => {
    fetchMock.mockReturnValueOnce(mockError(500, {}));
    const error = await createFolder('p1', 'root', 'docs').catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(FileTreeApiError);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to create folder');
  });

  test('falls back to defaults when response.json() returns null', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) }));
    const error = await createFolder('p1', 'root', 'docs').catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(FileTreeApiError);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to create folder');
    expect((error as InstanceType<typeof FileTreeApiError>).existingFileNodeId).toBeUndefined();
  });

  test('falls back to defaults when response.json() throws (parse error)', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 503, json: () => Promise.reject(new Error('parse')) }));
    const error = await createFolder('p1', 'root', 'docs').catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(FileTreeApiError);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to create folder');
  });
});

describe('createFileNode', () => {
  let fetchMock: jest.Mock;
  let createFileNode: typeof import('@/lib/api/file-tree').createFileNode;
  let FileTreeApiError: typeof import('@/lib/api/file-tree').FileTreeApiError;

  beforeEach(() => {
    jest.resetModules();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    ({ createFileNode, FileTreeApiError } = require('@/lib/api/file-tree'));
  });

  test('sends POST and returns fileNodeId and path on success', async () => {
    fetchMock.mockReturnValueOnce(mockOk({ fileNodeId: 'fn2', path: '/readme.adoc' }));
    const result = await createFileNode('p1', 'root', 'readme.adoc');
    expect(result.fileNodeId).toBe('fn2');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  test('sends POST to /projects/:id/files URL', async () => {
    fetchMock.mockReturnValueOnce(mockOk({ fileNodeId: 'fn-url', path: '/hello.adoc' }));
    await createFileNode('proj-abc', 'root-id', 'hello.adoc');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/projects/proj-abc/files');
  });

  test('sends credentials: include', async () => {
    fetchMock.mockReturnValueOnce(mockOk({ fileNodeId: 'fn2', path: '/readme.adoc' }));
    await createFileNode('p1', 'root', 'readme.adoc');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });

  test('sends Content-Type application/json header', async () => {
    fetchMock.mockReturnValueOnce(mockOk({ fileNodeId: 'fn2', path: '/readme.adoc' }));
    await createFileNode('p1', 'root', 'readme.adoc');
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
  });

  test('sends body with type file, parentId, and name', async () => {
    fetchMock.mockReturnValueOnce(mockOk({ fileNodeId: 'fn2', path: '/readme.adoc' }));
    await createFileNode('p1', 'root', 'readme.adoc');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('file');
    expect(body.parentId).toBe('root');
    expect(body.name).toBe('readme.adoc');
  });

  test('sends default mimeType text/asciidoc in body when not provided', async () => {
    fetchMock.mockReturnValueOnce(mockOk({ fileNodeId: 'fn2', path: '/readme.adoc' }));
    await createFileNode('p1', 'root', 'readme.adoc');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.mimeType).toBe('text/asciidoc');
  });

  test('sends custom mimeType when provided', async () => {
    fetchMock.mockReturnValueOnce(mockOk({ fileNodeId: 'fn3', path: '/data.csv' }));
    await createFileNode('p1', 'root', 'data.csv', 'text/csv');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.mimeType).toBe('text/csv');
  });

  test('throws FileTreeApiError on non-ok response', async () => {
    fetchMock.mockReturnValueOnce(mockError(403, { error: { code: 'FORBIDDEN', message: 'No permission' } }));
    await expect(createFileNode('p1', 'root', 'file.adoc')).rejects.toBeInstanceOf(FileTreeApiError);
  });

  test('error carries exact message and code from body', async () => {
    fetchMock.mockReturnValueOnce(mockError(403, { error: { code: 'FORBIDDEN', message: 'No permission' } }));
    const error = await createFileNode('p1', 'root', 'file.adoc').catch((error_: unknown) => error_);
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('No permission');
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('FORBIDDEN');
  });

  test('falls back to "ERROR" code and "Failed to create file" message when body is empty', async () => {
    fetchMock.mockReturnValueOnce(mockError(500, {}));
    const error = await createFileNode('p1', 'root', 'file.adoc').catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(FileTreeApiError);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to create file');
  });

  test('falls back to defaults when response.json() returns null', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) }));
    const error = await createFileNode('p1', 'root', 'file.adoc').catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(FileTreeApiError);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to create file');
  });

  test('falls back to defaults when response.json() throws', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 503, json: () => Promise.reject(new Error('parse')) }));
    const error = await createFileNode('p1', 'root', 'file.adoc').catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(FileTreeApiError);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to create file');
  });
});

describe('renameFileNode', () => {
  let fetchMock: jest.Mock;
  let renameFileNode: typeof import('@/lib/api/file-tree').renameFileNode;
  let FileTreeApiError: typeof import('@/lib/api/file-tree').FileTreeApiError;

  beforeEach(() => {
    jest.resetModules();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    ({ renameFileNode, FileTreeApiError } = require('@/lib/api/file-tree'));
  });

  test('sends PATCH to /projects/:id/files/:nodeId', async () => {
    fetchMock.mockReturnValueOnce(mockOk({}));
    await renameFileNode('p1', 'fn1', 'new-name.adoc');
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/files/fn1');
  });

  test('sends credentials: include', async () => {
    fetchMock.mockReturnValueOnce(mockOk({}));
    await renameFileNode('p1', 'fn1', 'new-name.adoc');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });

  test('sends Content-Type application/json header', async () => {
    fetchMock.mockReturnValueOnce(mockOk({}));
    await renameFileNode('p1', 'fn1', 'new-name.adoc');
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
  });

  test('sends body with new name', async () => {
    fetchMock.mockReturnValueOnce(mockOk({}));
    await renameFileNode('p1', 'fn1', 'new-name.adoc');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.name).toBe('new-name.adoc');
  });

  test('throws FileTreeApiError on non-ok response', async () => {
    fetchMock.mockReturnValueOnce(mockError(404, { error: { code: 'NOT_FOUND', message: 'Node not found' } }));
    await expect(renameFileNode('p1', 'fn1', 'x')).rejects.toBeInstanceOf(FileTreeApiError);
  });

  test('error carries exact message and code from body', async () => {
    fetchMock.mockReturnValueOnce(mockError(404, { error: { code: 'NOT_FOUND', message: 'Node not found' } }));
    const error = await renameFileNode('p1', 'fn1', 'x').catch((error_: unknown) => error_);
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Node not found');
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('NOT_FOUND');
  });

  test('falls back to "ERROR" code and "Failed to rename" message when body is empty', async () => {
    fetchMock.mockReturnValueOnce(mockError(500, {}));
    const error = await renameFileNode('p1', 'fn1', 'x').catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(FileTreeApiError);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to rename');
  });

  test('falls back to defaults when response.json() returns null', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) }));
    const error = await renameFileNode('p1', 'fn1', 'x').catch((error_: unknown) => error_);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to rename');
  });

  test('falls back to defaults when response.json() throws', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500, json: () => Promise.reject(new Error('parse')) }));
    const error = await renameFileNode('p1', 'fn1', 'x').catch((error_: unknown) => error_);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to rename');
  });
});

describe('moveFileNode', () => {
  let fetchMock: jest.Mock;
  let moveFileNode: typeof import('@/lib/api/file-tree').moveFileNode;
  let FileTreeApiError: typeof import('@/lib/api/file-tree').FileTreeApiError;

  beforeEach(() => {
    jest.resetModules();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    ({ moveFileNode, FileTreeApiError } = require('@/lib/api/file-tree'));
  });

  test('sends PATCH to /projects/:id/files/:nodeId', async () => {
    fetchMock.mockReturnValueOnce(mockOk({}));
    await moveFileNode('p1', 'fn1', 'parent2');
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/files/fn1');
  });

  test('sends credentials: include', async () => {
    fetchMock.mockReturnValueOnce(mockOk({}));
    await moveFileNode('p1', 'fn1', 'parent2');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });

  test('sends Content-Type application/json header', async () => {
    fetchMock.mockReturnValueOnce(mockOk({}));
    await moveFileNode('p1', 'fn1', 'parent2');
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
  });

  test('sends body with parentId', async () => {
    fetchMock.mockReturnValueOnce(mockOk({}));
    await moveFileNode('p1', 'fn1', 'parent2');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.parentId).toBe('parent2');
  });

  test('throws FileTreeApiError on non-ok response', async () => {
    fetchMock.mockReturnValueOnce(mockError(409, { error: { code: 'CYCLE', message: 'Would create cycle' } }));
    await expect(moveFileNode('p1', 'fn1', 'fn1')).rejects.toBeInstanceOf(FileTreeApiError);
  });

  test('error carries exact message and code from body', async () => {
    fetchMock.mockReturnValueOnce(mockError(409, { error: { code: 'CYCLE', message: 'Would create cycle' } }));
    const error = await moveFileNode('p1', 'fn1', 'fn1').catch((error_: unknown) => error_);
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Would create cycle');
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('CYCLE');
  });

  test('falls back to "ERROR" code and "Failed to move" message when body is empty', async () => {
    fetchMock.mockReturnValueOnce(mockError(500, {}));
    const error = await moveFileNode('p1', 'fn1', 'parent2').catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(FileTreeApiError);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to move');
  });

  test('falls back to defaults when response.json() returns null', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) }));
    const error = await moveFileNode('p1', 'fn1', 'parent2').catch((error_: unknown) => error_);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to move');
  });

  test('falls back to defaults when response.json() throws', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500, json: () => Promise.reject(new Error('parse')) }));
    const error = await moveFileNode('p1', 'fn1', 'parent2').catch((error_: unknown) => error_);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to move');
  });
});

describe('deleteFileNode', () => {
  let fetchMock: jest.Mock;
  let deleteFileNode: typeof import('@/lib/api/file-tree').deleteFileNode;
  let FileTreeApiError: typeof import('@/lib/api/file-tree').FileTreeApiError;

  beforeEach(() => {
    jest.resetModules();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    ({ deleteFileNode, FileTreeApiError } = require('@/lib/api/file-tree'));
  });

  test('sends DELETE to /projects/:id/files/:nodeId', async () => {
    fetchMock.mockReturnValueOnce(mockOk({}));
    await deleteFileNode('p1', 'fn1');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/files/fn1');
  });

  test('sends credentials: include', async () => {
    fetchMock.mockReturnValueOnce(mockOk({}));
    await deleteFileNode('p1', 'fn1');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });

  test('throws FileTreeApiError on non-ok response', async () => {
    fetchMock.mockReturnValueOnce(mockError(403, { error: { code: 'FORBIDDEN', message: 'No permission' } }));
    await expect(deleteFileNode('p1', 'fn1')).rejects.toBeInstanceOf(FileTreeApiError);
  });

  test('error carries exact message and code from body', async () => {
    fetchMock.mockReturnValueOnce(mockError(403, { error: { code: 'FORBIDDEN', message: 'No permission' } }));
    const error = await deleteFileNode('p1', 'fn1').catch((error_: unknown) => error_);
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('No permission');
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('FORBIDDEN');
  });

  test('falls back to "ERROR" code and "Failed to delete" message when body is empty', async () => {
    fetchMock.mockReturnValueOnce(mockError(500, {}));
    const error = await deleteFileNode('p1', 'fn1').catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(FileTreeApiError);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to delete');
  });

  test('falls back to defaults when response.json() returns null', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) }));
    const error = await deleteFileNode('p1', 'fn1').catch((error_: unknown) => error_);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to delete');
  });

  test('falls back to defaults when response.json() throws', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500, json: () => Promise.reject(new Error('parse')) }));
    const error = await deleteFileNode('p1', 'fn1').catch((error_: unknown) => error_);
    expect((error as InstanceType<typeof FileTreeApiError>).code).toBe('ERROR');
    expect((error as InstanceType<typeof FileTreeApiError>).message).toBe('Failed to delete');
  });
});
