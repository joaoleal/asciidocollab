import {
  assessDocumentSize,
  DOCUMENT_TOO_LARGE_CODE,
  documentTooLargeMessage,
  MAX_PAGE_FORMAT_SOURCE_BYTES,
  sourceByteLength,
} from '../../src/pipeline/document-size-limit';

describe('assessDocumentSize', () => {
  it('accepts a document at the declared bound and refuses the first byte past it', () => {
    expect(assessDocumentSize(MAX_PAGE_FORMAT_SOURCE_BYTES).withinLimit).toBe(true);
    expect(assessDocumentSize(MAX_PAGE_FORMAT_SOURCE_BYTES + 1).withinLimit).toBe(false);
  });

  it('covers the size the engine was previously believed to fail at', () => {
    // The failure this bound replaces was reported at roughly 1,700 lines. A sparsely written
    // document of that length is about 37 kB of source; the measured engine renders several times
    // that, so a bound that refused it would be declaring a limit the engine does not have.
    expect(assessDocumentSize(37 * 1024).withinLimit).toBe(true);
  });

  it('reports the document size and the bound it was judged against', () => {
    const assessment = assessDocumentSize(200_000);

    expect(assessment.bytes).toBe(200_000);
    expect(assessment.limitBytes).toBe(MAX_PAGE_FORMAT_SOURCE_BYTES);
  });

  it('treats a negative or non-finite measurement as unmeasured rather than as an overrun', () => {
    // A size that could not be measured must never be the reason a render is refused: refusing on a
    // reading nobody can defend is exactly the opaque failure this bound exists to remove.
    expect(assessDocumentSize(Number.NaN).withinLimit).toBe(true);
    expect(assessDocumentSize(-1).withinLimit).toBe(true);
  });
});

describe('sourceByteLength', () => {
  it('counts encoded bytes, not characters, so multi-byte prose is measured as the engine sees it', () => {
    expect(sourceByteLength('abc')).toBe(3);
    expect(sourceByteLength('é')).toBe(2);
    expect(sourceByteLength('👋')).toBe(4);
  });
});

describe('documentTooLargeMessage', () => {
  const message = documentTooLargeMessage(assessDocumentSize(341_346));

  it('names the document size and the supported bound in units an author reads', () => {
    expect(message).toContain('341 kB');
    expect(message).toContain('100 kB');
  });

  it('says what to do about it rather than only that it failed', () => {
    expect(message).toMatch(/main document/i);
    expect(message).toMatch(/preview/i);
  });

  it('explains the cause without leaking an engine-internal error string', () => {
    expect(message).toMatch(/memory/i);
    expect(message).not.toMatch(/NoMemoryError|outside the bounds of the buffer|wasm/i);
  });
});

describe('DOCUMENT_TOO_LARGE_CODE', () => {
  it('is a stable machine code distinct from a generic convert failure', () => {
    expect(DOCUMENT_TOO_LARGE_CODE).toBe('document-too-large');
  });
});
