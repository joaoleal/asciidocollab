// Tests for apps/web/src/lib/api/file-tree.ts
import {
  fetchProjectFileTree,
  createFolder,
  createFileNode,
  renameFileNode,
  moveFileNode,
  deleteFileNode,
  FileTreeApiError,
} from '@/lib/api/file-tree';

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

interface FetchCall {
  url: string;
  options: RequestInit;
}

function lastCall(): FetchCall {
  const [url, options]: [string, RequestInit] = mockFetch.mock.calls[0];
  return { url, options };
}

function okJson(value: unknown): void {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(value) });
}

function errorJson(status: number, body: unknown): void {
  mockFetch.mockResolvedValueOnce({ ok: false, status, json: () => Promise.resolve(body) });
}

function rejectingJson(status: number): void {
  mockFetch.mockResolvedValueOnce({ ok: false, status, json: () => Promise.reject(new Error('not json')) });
}

/**
 * A failure whose body is the literal JSON `null`. This is well-formed JSON, so `response.json()`
 * resolves and the `.catch` fallback never runs — `null` is handed straight to the error builder,
 * which must read through it rather than dereference it.
 */
function nullJson(status: number): void {
  mockFetch.mockResolvedValueOnce({ ok: false, status, json: () => Promise.resolve(null) });
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  mockFetch.mockReset();
});

describe('FileTreeApiError', () => {
  test('carries status, code, message, and the optional existing node id', () => {
    const error = new FileTreeApiError(409, 'CONFLICT', 'already exists', 'node-9');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('FileTreeApiError');
    expect(error.status).toBe(409);
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toBe('already exists');
    expect(error.existingFileNodeId).toBe('node-9');
  });

  test('leaves existingFileNodeId undefined when omitted', () => {
    const error = new FileTreeApiError(500, 'ERROR', 'boom');
    expect(error.existingFileNodeId).toBeUndefined();
  });
});

describe('fetchProjectFileTree', () => {
  test('GETs the files endpoint with credentials and returns the root node', async () => {
    const root = { id: 'root', name: '/', type: 'folder', children: [] };
    okJson(root);
    const result = await fetchProjectFileTree('p1');
    const { url, options } = lastCall();
    expect(url).toContain('/projects/p1/files');
    expect(options.credentials).toBe('include');
    expect(options.method).toBeUndefined();
    expect(result).toEqual(root);
  });

  test('throws a FileTreeApiError with the contract code/message on failure', async () => {
    errorJson(403, { error: { code: 'FORBIDDEN', message: 'no access' } });
    await expect(fetchProjectFileTree('p1')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'no access',
    });
  });

  test('falls back to ERROR / default message when the body has no error object', async () => {
    errorJson(500, {});
    await expect(fetchProjectFileTree('p1')).rejects.toMatchObject({
      status: 500,
      code: 'ERROR',
      message: 'Failed to load files',
    });
  });

  test('falls back when the error body is not valid JSON', async () => {
    rejectingJson(502);
    await expect(fetchProjectFileTree('p1')).rejects.toMatchObject({
      status: 502,
      code: 'ERROR',
      message: 'Failed to load files',
    });
  });

  test('falls back when the error body is the literal JSON null', async () => {
    nullJson(500);
    await expect(fetchProjectFileTree('p1')).rejects.toMatchObject({
      name: 'FileTreeApiError',
      status: 500,
      code: 'ERROR',
      message: 'Failed to load files',
    });
  });
});

describe('createFolder', () => {
  test('POSTs a folder body and returns the created node', async () => {
    okJson({ fileNodeId: 'n1', path: '/docs' });
    const result = await createFolder('p1', 'parent-1', 'docs');
    const { url, options } = lastCall();
    expect(url).toContain('/projects/p1/files');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(options.body))).toEqual({ type: 'folder', parentId: 'parent-1', name: 'docs' });
    expect(result).toEqual({ fileNodeId: 'n1', path: '/docs' });
  });

  test('throws with the contract code and the existing node id on a 409 conflict', async () => {
    errorJson(409, { error: { code: 'CONFLICT', message: 'exists' }, existingFileNodeId: 'dupe-1' });
    await expect(createFolder('p1', 'parent-1', 'docs')).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'exists',
      existingFileNodeId: 'dupe-1',
    });
  });

  test('falls back to default code/message when the body is empty', async () => {
    errorJson(500, {});
    const error = await createFolder('p1', 'parent-1', 'docs').catch((error_) => error_);
    expect(error).toMatchObject({ status: 500, code: 'ERROR', message: 'Failed to create folder' });
    expect(error.existingFileNodeId).toBeUndefined();
  });

  test('falls back when the error body is not valid JSON', async () => {
    rejectingJson(500);
    await expect(createFolder('p1', 'parent-1', 'docs')).rejects.toMatchObject({ status: 500, code: 'ERROR' });
  });

  test('falls back when the error body is the literal JSON null', async () => {
    nullJson(500);
    const error = await createFolder('p1', 'parent-1', 'docs').catch((error_) => error_);
    expect(error).toMatchObject({
      name: 'FileTreeApiError',
      status: 500,
      code: 'ERROR',
      message: 'Failed to create folder',
    });
    expect(error.existingFileNodeId).toBeUndefined();
  });
});

describe('createFileNode', () => {
  test('POSTs a file body with the default mime type', async () => {
    okJson({ fileNodeId: 'f1', path: '/a.adoc' });
    const result = await createFileNode('p1', 'parent-1', 'a.adoc');
    const { options } = lastCall();
    expect(options.method).toBe('POST');
    expect(JSON.parse(String(options.body))).toEqual({
      type: 'file',
      parentId: 'parent-1',
      name: 'a.adoc',
      mimeType: 'text/asciidoc',
    });
    expect(result).toEqual({ fileNodeId: 'f1', path: '/a.adoc' });
  });

  test('honours an explicit mime type', async () => {
    okJson({ fileNodeId: 'f2', path: '/d.png' });
    await createFileNode('p1', 'parent-1', 'd.png', 'image/png');
    const { options } = lastCall();
    expect(JSON.parse(String(options.body))).toMatchObject({ mimeType: 'image/png' });
  });

  test('throws the contract error on failure', async () => {
    errorJson(400, { error: { code: 'INVALID_NAME', message: 'bad name' } });
    await expect(createFileNode('p1', 'parent-1', 'bad')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_NAME',
      message: 'bad name',
    });
  });

  test('falls back to default code/message when the body is empty', async () => {
    errorJson(500, {});
    await expect(createFileNode('p1', 'parent-1', 'a.adoc')).rejects.toMatchObject({
      status: 500,
      code: 'ERROR',
      message: 'Failed to create file',
    });
  });

  test('falls back when the error body is not valid JSON', async () => {
    rejectingJson(500);
    await expect(createFileNode('p1', 'parent-1', 'a.adoc')).rejects.toMatchObject({ status: 500, code: 'ERROR' });
  });

  test('falls back when the error body is the literal JSON null', async () => {
    nullJson(500);
    await expect(createFileNode('p1', 'parent-1', 'a.adoc')).rejects.toMatchObject({
      name: 'FileTreeApiError',
      status: 500,
      code: 'ERROR',
      message: 'Failed to create file',
    });
  });
});

describe('renameFileNode', () => {
  test('PATCHes the node with the new name and resolves to undefined', async () => {
    okJson({});
    const result = await renameFileNode('p1', 'n1', 'renamed.adoc');
    const { url, options } = lastCall();
    expect(url).toContain('/projects/p1/files/n1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(String(options.body))).toEqual({ name: 'renamed.adoc' });
    expect(result).toBeUndefined();
  });

  test('throws the contract error on failure', async () => {
    errorJson(409, { error: { code: 'CONFLICT', message: 'name taken' } });
    await expect(renameFileNode('p1', 'n1', 'x')).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'name taken',
    });
  });

  test('falls back to default code/message when the body is empty', async () => {
    errorJson(500, {});
    await expect(renameFileNode('p1', 'n1', 'x')).rejects.toMatchObject({
      status: 500,
      code: 'ERROR',
      message: 'Failed to rename',
    });
  });

  test('falls back when the error body is not valid JSON', async () => {
    rejectingJson(500);
    await expect(renameFileNode('p1', 'n1', 'x')).rejects.toMatchObject({ status: 500, code: 'ERROR' });
  });

  test('falls back when the error body is the literal JSON null', async () => {
    nullJson(500);
    await expect(renameFileNode('p1', 'n1', 'x')).rejects.toMatchObject({
      name: 'FileTreeApiError',
      status: 500,
      code: 'ERROR',
      message: 'Failed to rename',
    });
  });
});

describe('moveFileNode', () => {
  test('PATCHes the node with the new parent and resolves to undefined', async () => {
    okJson({});
    const result = await moveFileNode('p1', 'n1', 'new-parent');
    const { url, options } = lastCall();
    expect(url).toContain('/projects/p1/files/n1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(String(options.body))).toEqual({ parentId: 'new-parent' });
    expect(result).toBeUndefined();
  });

  test('throws the contract error on failure', async () => {
    errorJson(400, { error: { code: 'CYCLE', message: 'cannot move into descendant' } });
    await expect(moveFileNode('p1', 'n1', 'child')).rejects.toMatchObject({
      status: 400,
      code: 'CYCLE',
      message: 'cannot move into descendant',
    });
  });

  test('falls back to default code/message when the body is empty', async () => {
    errorJson(500, {});
    await expect(moveFileNode('p1', 'n1', 'p')).rejects.toMatchObject({
      status: 500,
      code: 'ERROR',
      message: 'Failed to move',
    });
  });

  test('falls back when the error body is not valid JSON', async () => {
    rejectingJson(500);
    await expect(moveFileNode('p1', 'n1', 'p')).rejects.toMatchObject({ status: 500, code: 'ERROR' });
  });

  test('falls back when the error body is the literal JSON null', async () => {
    nullJson(500);
    await expect(moveFileNode('p1', 'n1', 'p')).rejects.toMatchObject({
      name: 'FileTreeApiError',
      status: 500,
      code: 'ERROR',
      message: 'Failed to move',
    });
  });
});

describe('deleteFileNode', () => {
  test('DELETEs the node with credentials and resolves to undefined', async () => {
    okJson({});
    const result = await deleteFileNode('p1', 'n1');
    const { url, options } = lastCall();
    expect(url).toContain('/projects/p1/files/n1');
    expect(options.method).toBe('DELETE');
    expect(options.credentials).toBe('include');
    expect(result).toBeUndefined();
  });

  test('throws the contract error on failure', async () => {
    errorJson(403, { error: { code: 'FORBIDDEN', message: 'no delete' } });
    await expect(deleteFileNode('p1', 'n1')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'no delete',
    });
  });

  test('falls back to default code/message when the body is empty', async () => {
    errorJson(500, {});
    await expect(deleteFileNode('p1', 'n1')).rejects.toMatchObject({
      status: 500,
      code: 'ERROR',
      message: 'Failed to delete',
    });
  });

  test('falls back when the error body is not valid JSON', async () => {
    rejectingJson(500);
    await expect(deleteFileNode('p1', 'n1')).rejects.toMatchObject({ status: 500, code: 'ERROR' });
  });

  test('falls back when the error body is the literal JSON null', async () => {
    nullJson(500);
    await expect(deleteFileNode('p1', 'n1')).rejects.toMatchObject({
      name: 'FileTreeApiError',
      status: 500,
      code: 'ERROR',
      message: 'Failed to delete',
    });
  });
});
