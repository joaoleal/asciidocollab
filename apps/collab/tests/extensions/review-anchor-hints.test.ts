import * as Y from 'yjs';
import type { onStoreDocumentPayload } from '@hocuspocus/server';
import {
  ReviewAnchorHintExtension,
  lineNumberAt,
  resolveAnchorLine,
} from '../../src/extensions/review-anchor-hints';
import { packRelativePositionPair } from '@asciidocollab/shared';
import type { DocumentRepository, ReviewCommentRepository } from '@asciidocollab/domain';
import {
  ContentId,
  Document,
  DocumentId,
  FileNodeId,
  MimeType,
  ProjectId,
  ReviewAnchor,
  ReviewComment,
  ReviewCommentId,
  Timestamps,
  YjsStateId,
} from '@asciidocollab/domain';

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440001';
const YJS_STATE_ID = '550e8400-e29b-41d4-a716-446655440002';
const DOCUMENT_ID = '550e8400-e29b-41d4-a716-446655440010';
const DOCUMENT_NAME = `${PROJECT_ID}/${YJS_STATE_ID}`;

const CODEMIRROR_TEXT = 'codemirror';

/** A document with the given text in its `codemirror` Y.Text, as the editor binding produces. */
function makeDocument(text: string): Y.Doc {
  const document = new Y.Doc();
  document.getText(CODEMIRROR_TEXT).insert(0, text);
  return document;
}

/**
 * Captures a real anchor blob for `[from, to)` exactly the way the browser does: two Yjs relative
 * positions on the live `Y.Text`, packed with the shared codec. Using the real encoding (rather than
 * a hand-rolled buffer) is the whole point — it is what proves the server resolves what the client
 * wrote.
 */
function captureRelativePositions(ydoc: Y.Doc, from: number, to: number): Uint8Array {
  const ytext = ydoc.getText(CODEMIRROR_TEXT);
  return packRelativePositionPair(
    Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, from)),
    Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, to)),
  );
}

/** A root review item carrying the given anchor blob and stored line hint. */
function rootItem(id: string, relativePos: Uint8Array | null, lineHint: number | null): ReviewComment {
  return new ReviewComment(
    ReviewCommentId.create(id),
    ProjectId.create(PROJECT_ID),
    DocumentId.create(DOCUMENT_ID),
    null,
    'comment',
    'body',
    null,
    null,
    null,
    null,
    null,
    null,
    new ReviewAnchor(relativePos, { prefix: '', exact: 'passage', suffix: '' }, lineHint, null, 'located'),
    new Timestamps(),
  );
}

/** A reply — no anchor at all, so the refresh must skip it without throwing. */
function replyItem(id: string): ReviewComment {
  return new ReviewComment(
    ReviewCommentId.create(id),
    ProjectId.create(PROJECT_ID),
    DocumentId.create(DOCUMENT_ID),
    ReviewCommentId.create('550e8400-e29b-41d4-a716-4466554400a0'),
    'comment',
    'reply body',
    null,
  );
}

function makeReviewRepo(items: ReviewComment[]) {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    listByDocument: jest.fn().mockResolvedValue(items),
    listByProject: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn(),
    deleteByDocument: jest.fn(),
    deleteByProject: jest.fn(),
    countByDocument: jest.fn(),
    countByProject: jest.fn(),
  } as unknown as jest.Mocked<ReviewCommentRepository>;
}

function makeDocumentRepo(found = true) {
  const record = new Document(
    DocumentId.create(DOCUMENT_ID),
    FileNodeId.create('550e8400-e29b-41d4-a716-446655440003'),
    ContentId.create('550e8400-e29b-41d4-a716-446655440004'),
    YjsStateId.create(YJS_STATE_ID),
    MimeType.create('text/asciidoc'),
    new Timestamps(),
  );
  return {
    findByYjsStateId: jest.fn().mockResolvedValue(found ? record : null),
    findById: jest.fn(),
    findByFileNodeId: jest.fn(),
    findByFileNodeIds: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
  } as unknown as jest.Mocked<DocumentRepository>;
}

function makeLogger() {
  return { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
}

function storePayload(documentName: string, document: Y.Doc): onStoreDocumentPayload {
  return { documentName, document } as unknown as onStoreDocumentPayload;
}

describe('lineNumberAt', () => {
  const text = 'one\ntwo\nthree';

  it('numbers lines from 1 and counts only the newlines strictly before the offset', () => {
    expect(lineNumberAt(text, 0)).toBe(1);
    expect(lineNumberAt(text, 3)).toBe(1); // the offset OF the first '\n' is still on line 1
    expect(lineNumberAt(text, 4)).toBe(2);
    expect(lineNumberAt(text, 8)).toBe(3);
    expect(lineNumberAt(text, text.length)).toBe(3);
  });

  it('clamps an out-of-range offset into the document', () => {
    expect(lineNumberAt(text, -5)).toBe(1);
    expect(lineNumberAt(text, 9999)).toBe(3);
  });

  it('returns 1 for an empty document', () => {
    expect(lineNumberAt('', 0)).toBe(1);
  });

  it('counts a trailing newline as opening a further line', () => {
    expect(lineNumberAt('a\n', 2)).toBe(2);
  });
});

describe('resolveAnchorLine', () => {
  it('resolves a real captured anchor to its current line after an edit above it', () => {
    const document = makeDocument('alpha\nbeta\ngamma\n');
    const passageStart = document.getText(CODEMIRROR_TEXT).toString().indexOf('gamma');
    const relativePos = captureRelativePositions(document, passageStart, passageStart + 5);

    // Captured on line 3 …
    expect(resolveAnchorLine(relativePos, document, document.getText(CODEMIRROR_TEXT).toString())).toBe(3);

    // … then two lines are inserted above it.
    document.getText(CODEMIRROR_TEXT).insert(0, 'new\nlines\n');

    expect(resolveAnchorLine(relativePos, document, document.getText(CODEMIRROR_TEXT).toString())).toBe(5);
  });

  it('uses the LOWER of the two endpoints even when they were captured reversed', () => {
    const document = makeDocument('alpha\nbeta\ngamma');
    // start = 12 (inside "gamma"), end = 1 (inside "alpha") — deliberately inverted.
    const relativePos = captureRelativePositions(document, 12, 1);

    expect(resolveAnchorLine(relativePos, document, document.getText(CODEMIRROR_TEXT).toString())).toBe(1);
  });

  it('returns null for a blob too short to be a packed pair', () => {
    const document = makeDocument('alpha');
    expect(resolveAnchorLine(new Uint8Array([1, 2]), document, 'alpha')).toBeNull();
  });

  it('returns null for corrupt relative-position bytes rather than throwing', () => {
    const document = makeDocument('alpha');
    const corrupt = packRelativePositionPair(new Uint8Array([255, 255, 255, 255]), new Uint8Array([255]));

    expect(resolveAnchorLine(corrupt, document, 'alpha')).toBeNull();
  });

  it('returns null when an endpoint belongs to a different document', () => {
    const other = makeDocument('some other document entirely');
    const relativePos = captureRelativePositions(other, 5, 9);
    const document = makeDocument('alpha\nbeta');

    expect(resolveAnchorLine(relativePos, document, 'alpha\nbeta')).toBeNull();
  });
});

describe('ReviewAnchorHintExtension.onStoreDocument', () => {
  it('re-measures a drifted hint and persists ONLY the items whose line moved', async () => {
    const document = makeDocument('alpha\nbeta\ngamma\n');
    const text = document.getText(CODEMIRROR_TEXT);
    const gammaAnchor = captureRelativePositions(document, text.toString().indexOf('gamma'), text.toString().indexOf('gamma') + 5);
    const alphaAnchor = captureRelativePositions(document, 0, 5);

    // Two lines are inserted above everything: "alpha" moves 1 → 3 and "gamma" moves 3 → 5.
    text.insert(0, 'new\nlines\n');

    // `drifted` still holds the line "gamma" was captured on (3) — the exact staleness being fixed.
    const drifted = rootItem('550e8400-e29b-41d4-a716-4466554400b1', gammaAnchor, 3);
    // `unchanged` already holds "alpha"'s new line (3), so re-measuring must find nothing to write.
    const unchanged = rootItem('550e8400-e29b-41d4-a716-4466554400b2', alphaAnchor, 3);

    const reviewCommentRepo = makeReviewRepo([drifted, unchanged]);
    const extension = new ReviewAnchorHintExtension({
      reviewCommentRepo,
      documentRepo: makeDocumentRepo(),
      logger: makeLogger() as never,
    });

    await extension.onStoreDocument(storePayload(DOCUMENT_NAME, document));

    expect(reviewCommentRepo.listByDocument).toHaveBeenCalledWith(
      expect.objectContaining({ value: PROJECT_ID }),
      expect.objectContaining({ value: DOCUMENT_ID }),
      { includeResolved: true },
    );
    expect(drifted.anchor?.lineHint).toBe(5);
    expect(unchanged.anchor?.lineHint).toBe(3);
    expect(reviewCommentRepo.update).toHaveBeenCalledTimes(1);
    expect(reviewCommentRepo.update).toHaveBeenCalledWith(drifted);
  });

  it('writes nothing when no hint moved', async () => {
    const document = makeDocument('alpha\nbeta');
    const relativePos = captureRelativePositions(document, 0, 5);
    const item = rootItem('550e8400-e29b-41d4-a716-4466554400b3', relativePos, 1);

    const reviewCommentRepo = makeReviewRepo([item]);
    const extension = new ReviewAnchorHintExtension({
      reviewCommentRepo,
      documentRepo: makeDocumentRepo(),
      logger: makeLogger() as never,
    });

    await extension.onStoreDocument(storePayload(DOCUMENT_NAME, document));

    expect(reviewCommentRepo.update).not.toHaveBeenCalled();
  });

  it('skips replies and roots with no relative-position pair', async () => {
    const document = makeDocument('alpha\nbeta');
    const hintless = rootItem('550e8400-e29b-41d4-a716-4466554400b4', null, 7);

    const reviewCommentRepo = makeReviewRepo([replyItem('550e8400-e29b-41d4-a716-4466554400b5'), hintless]);
    const extension = new ReviewAnchorHintExtension({
      reviewCommentRepo,
      documentRepo: makeDocumentRepo(),
      logger: makeLogger() as never,
    });

    await extension.onStoreDocument(storePayload(DOCUMENT_NAME, document));

    expect(reviewCommentRepo.update).not.toHaveBeenCalled();
    // The stale hint is LEFT ALONE rather than nulled: a last-known line beats no line at all.
    expect(hintless.anchor?.lineHint).toBe(7);
  });

  it('leaves the stored hint alone when the anchor no longer resolves', async () => {
    const other = makeDocument('a different document');
    const unresolvable = captureRelativePositions(other, 2, 6);
    const item = rootItem('550e8400-e29b-41d4-a716-4466554400b6', unresolvable, 4);

    const reviewCommentRepo = makeReviewRepo([item]);
    const extension = new ReviewAnchorHintExtension({
      reviewCommentRepo,
      documentRepo: makeDocumentRepo(),
      logger: makeLogger() as never,
    });

    await extension.onStoreDocument(storePayload(DOCUMENT_NAME, makeDocument('alpha\nbeta\ngamma')));

    expect(item.anchor?.lineHint).toBe(4);
    expect(reviewCommentRepo.update).not.toHaveBeenCalled();
  });

  it('does nothing for a presence room (it has no backing document)', async () => {
    const reviewCommentRepo = makeReviewRepo([]);
    const documentRepo = makeDocumentRepo();
    const extension = new ReviewAnchorHintExtension({
      reviewCommentRepo,
      documentRepo,
      logger: makeLogger() as never,
    });

    await extension.onStoreDocument(storePayload(`presence/${PROJECT_ID}`, new Y.Doc()));

    expect(documentRepo.findByYjsStateId).not.toHaveBeenCalled();
    expect(reviewCommentRepo.listByDocument).not.toHaveBeenCalled();
  });

  it('does nothing when the document record is gone (deleted while its room was open)', async () => {
    const reviewCommentRepo = makeReviewRepo([]);
    const extension = new ReviewAnchorHintExtension({
      reviewCommentRepo,
      documentRepo: makeDocumentRepo(false),
      logger: makeLogger() as never,
    });

    await extension.onStoreDocument(storePayload(DOCUMENT_NAME, makeDocument('alpha')));

    expect(reviewCommentRepo.listByDocument).not.toHaveBeenCalled();
  });

  it('absorbs and logs a repository failure — a hint must never break the content write-back', async () => {
    const document = makeDocument('alpha\nbeta');
    const reviewCommentRepo = makeReviewRepo([]);
    (reviewCommentRepo.listByDocument as jest.Mock).mockRejectedValue(new Error('db down'));
    const logger = makeLogger();
    const extension = new ReviewAnchorHintExtension({
      reviewCommentRepo,
      documentRepo: makeDocumentRepo(),
      logger: logger as never,
    });

    await expect(extension.onStoreDocument(storePayload(DOCUMENT_NAME, document))).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('absorbs a malformed room name', async () => {
    const reviewCommentRepo = makeReviewRepo([]);
    const logger = makeLogger();
    const extension = new ReviewAnchorHintExtension({
      reviewCommentRepo,
      documentRepo: makeDocumentRepo(),
      logger: logger as never,
    });

    await extension.onStoreDocument(storePayload('no-slash-here', new Y.Doc()));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(reviewCommentRepo.listByDocument).not.toHaveBeenCalled();
  });

  it('leaves a presence room BEFORE parsing it — the skip is silent, not an absorbed failure', async () => {
    // `presence/<projectId>` is not a `<projectId>/<yjsStateId>` room, so reaching parseRoomName
    // with one throws. Asserting the warn count is 0 is what distinguishes "returned early" from
    // "fell through and had the failure swallowed", which look identical from the repositories.
    const reviewCommentRepo = makeReviewRepo([]);
    const documentRepo = makeDocumentRepo();
    const logger = makeLogger();
    const extension = new ReviewAnchorHintExtension({
      reviewCommentRepo,
      documentRepo,
      logger: logger as never,
    });

    await expect(
      extension.onStoreDocument(storePayload(`presence/${PROJECT_ID}`, new Y.Doc())),
    ).resolves.toBeUndefined();

    expect(logger.warn).not.toHaveBeenCalled();
    expect(documentRepo.findByYjsStateId).not.toHaveBeenCalled();
  });

  it('returns quietly for a missing document record instead of dereferencing it', async () => {
    // Same distinction: without the `!record` guard the very next line reads `record.id` and the
    // TypeError is absorbed by the catch, so only the absence of a log proves the guard is there.
    const reviewCommentRepo = makeReviewRepo([]);
    const logger = makeLogger();
    const extension = new ReviewAnchorHintExtension({
      reviewCommentRepo,
      documentRepo: makeDocumentRepo(false),
      logger: logger as never,
    });

    await expect(
      extension.onStoreDocument(storePayload(DOCUMENT_NAME, makeDocument('alpha'))),
    ).resolves.toBeUndefined();

    expect(logger.warn).not.toHaveBeenCalled();
    expect(reviewCommentRepo.listByDocument).not.toHaveBeenCalled();
  });

  it('logs the failing room and the error itself under the best-effort message', async () => {
    const failure = new Error('db down');
    const reviewCommentRepo = makeReviewRepo([]);
    (reviewCommentRepo.listByDocument as jest.Mock).mockRejectedValue(failure);
    const logger = makeLogger();
    const extension = new ReviewAnchorHintExtension({
      reviewCommentRepo,
      documentRepo: makeDocumentRepo(),
      logger: logger as never,
    });

    await extension.onStoreDocument(storePayload(DOCUMENT_NAME, makeDocument('alpha\nbeta')));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    // The whole payload: an operator needs BOTH the cause and the room it happened in.
    expect(logger.warn.mock.calls[0][0]).toEqual({ err: failure, documentName: DOCUMENT_NAME });
    expect(logger.warn.mock.calls[0][1]).toBe(
      'Failed to refresh review anchor line hints (best-effort); the cross-file panel order may lag',
    );
  });

  it('skips an anchorless item without throwing — nothing is absorbed and logged', async () => {
    // A reply has NO anchor object at all, and a root may have an anchor with no relative-position
    // pair. Both are ordinary skips, so the pass must complete with an empty warn log; dereferencing
    // either would only surface as a swallowed error.
    const document = makeDocument('alpha\nbeta');
    const hintless = rootItem('550e8400-e29b-41d4-a716-4466554400b7', null, 7);
    const reviewCommentRepo = makeReviewRepo([replyItem('550e8400-e29b-41d4-a716-4466554400b8'), hintless]);
    const logger = makeLogger();
    const extension = new ReviewAnchorHintExtension({
      reviewCommentRepo,
      documentRepo: makeDocumentRepo(),
      logger: logger as never,
    });

    await expect(
      extension.onStoreDocument(storePayload(DOCUMENT_NAME, document)),
    ).resolves.toBeUndefined();

    expect(logger.warn).not.toHaveBeenCalled();
    expect(reviewCommentRepo.update).not.toHaveBeenCalled();
    expect(hintless.anchor?.lineHint).toBe(7);
  });

  it('counts exactly the hints it rewrote', async () => {
    // `refreshHints` returns that count and `onStoreDocument` discards it, so the tally is only
    // observable here. It is the number of `update` calls, which is why the assertion is on the
    // exact value rather than on "some number changed".
    const document = makeDocument('alpha\nbeta\ngamma\n');
    const text = document.getText(CODEMIRROR_TEXT);
    const alphaAnchor = captureRelativePositions(document, 0, 5);
    const betaAnchor = captureRelativePositions(document, text.toString().indexOf('beta'), text.toString().indexOf('beta') + 4);
    const gammaAnchor = captureRelativePositions(document, text.toString().indexOf('gamma'), text.toString().indexOf('gamma') + 5);

    // One line inserted above everything: alpha 1 → 2, beta 2 → 3, gamma 3 → 4.
    text.insert(0, 'new\n');

    const driftedAlpha = rootItem('550e8400-e29b-41d4-a716-4466554400c1', alphaAnchor, 1);
    const driftedBeta = rootItem('550e8400-e29b-41d4-a716-4466554400c2', betaAnchor, 2);
    const current = rootItem('550e8400-e29b-41d4-a716-4466554400c3', gammaAnchor, 4);

    const reviewCommentRepo = makeReviewRepo([driftedAlpha, driftedBeta, current]);
    const extension = new ReviewAnchorHintExtension({
      reviewCommentRepo,
      documentRepo: makeDocumentRepo(),
      logger: makeLogger() as never,
    });

    const refresh = (extension as unknown as {
      refreshHints(projectId: ProjectId, documentId: DocumentId, ydoc: Y.Doc): Promise<number>;
    }).refreshHints.bind(extension);

    await expect(refresh(ProjectId.create(PROJECT_ID), DocumentId.create(DOCUMENT_ID), document)).resolves.toBe(2);
    expect(reviewCommentRepo.update).toHaveBeenCalledTimes(2);
    expect(driftedAlpha.anchor?.lineHint).toBe(2);
    expect(driftedBeta.anchor?.lineHint).toBe(3);
    expect(current.anchor?.lineHint).toBe(4);
  });
});
