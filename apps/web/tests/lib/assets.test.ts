// No imports or exports of its own would make this a SCRIPT, putting its top-level helpers in the
// global scope where they collide by name with another spec's. This export makes it a module.
export const IS_MODULE = true;

function mockOk(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: jest.fn().mockResolvedValue(body) });
}

function mockError(status: number, body: unknown) {
  return Promise.resolve({ ok: false, status, json: jest.fn().mockResolvedValue(body) });
}

function makeFile(name: string, type: string, size: number): File {
  const blob = new Blob(['x'.repeat(size)], { type });
  return new File([blob], name, { type });
}

describe('uploadAsset', () => {
  let fetchMock: jest.Mock;
  let uploadAsset: typeof import('@/lib/api/assets').uploadAsset;

  beforeEach(() => {
    jest.resetModules();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    ({ uploadAsset } = require('@/lib/api/assets'));
  });

  test('sends POST to URL containing http://localhost:4000/projects', async () => {
    fetchMock.mockReturnValueOnce(mockOk({ assetId: 'a1', storagePath: '/uploads/img.png' }));
    const file = makeFile('img.png', 'image/png', 100);
    await uploadAsset('p1', 'folder1', file);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('http://localhost:4000');
    expect(url).toContain('/projects/p1/assets');
  });

  test('sends credentials: include', async () => {
    fetchMock.mockReturnValueOnce(mockOk({ assetId: 'a1', storagePath: '/uploads/img.png' }));
    const file = makeFile('img.png', 'image/png', 100);
    await uploadAsset('p1', 'folder1', file);
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });

  test('sends multipart POST and returns AssetMetadata on success', async () => {
    fetchMock.mockReturnValueOnce(
      mockOk({ assetId: 'a1', storagePath: '/uploads/img.png' }),
    );
    const file = makeFile('img.png', 'image/png', 1024);
    const result = await uploadAsset('p1', 'folder1', file);

    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/projects/p1/assets');
    expect(String(fetchMock.mock.calls[0][0])).toContain('parentId=folder1');

    // Verify the FormData uses the field name "file" — if this changes the API rejects the upload
    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const uploadedFile = body.get('file') as File;
    expect(uploadedFile).not.toBeNull();
    expect(uploadedFile.name).toBe('img.png');
    expect(uploadedFile.type).toBe('image/png');

    expect(result.assetId).toBe('a1');
    expect(result.filename).toBe('img.png');
    expect(result.mimeType).toBe('image/png');
    expect(result.sizeBytes).toBe(1024);
  });

  test('throws an error with status and code on non-ok response', async () => {
    fetchMock.mockReturnValueOnce(
      mockError(413, { error: { code: 'FILE_TOO_LARGE', message: 'File exceeds limit' } }),
    );
    const file = makeFile('big.png', 'image/png', 99_999_999);
    const error = await uploadAsset('p1', 'folder1', file).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { status?: number }).status).toBe(413);
    expect((error as Error & { code?: string }).code).toBe('FILE_TOO_LARGE');
  });

  test('falls back to generic error message when error body is empty', async () => {
    fetchMock.mockReturnValueOnce(mockError(500, {}));
    const file = makeFile('file.png', 'image/png', 100);
    const error = await uploadAsset('p1', 'f', file).catch((error_: unknown) => error_);
    expect((error as Error).message).toContain('500');
    expect((error as Error & { code?: string }).code).toBe('UPLOAD_ERROR');
  });

  test('error.message uses body.error.message when present', async () => {
    fetchMock.mockReturnValueOnce(mockError(400, { error: { message: 'File too large', code: 'SIZE_LIMIT' } }));
    const file = makeFile('big.png', 'image/png', 100);
    const error = await uploadAsset('p1', 'f', file).catch((error_: unknown) => error_);
    expect((error as Error).message).toBe('File too large');
  });

  test('falls back when response.json() returns null', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) }));
    const file = makeFile('file.png', 'image/png', 100);
    const error = await uploadAsset('p1', 'f', file).catch((error_: unknown) => error_);
    expect((error as Error).message).toContain('500');
    expect((error as Error & { code?: string }).code).toBe('UPLOAD_ERROR');
  });

  test('falls back to empty object when json() rejects on error response', async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve({
        ok: false,
        status: 500,
        json: jest.fn().mockRejectedValue(new Error('parse error')),
      }),
    );
    const file = makeFile('file.png', 'image/png', 100);
    const error = await uploadAsset('p1', 'f', file).catch((error_: unknown) => error_);
    expect((error as Error).message).toContain('500');
  });
});
