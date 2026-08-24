import {
  resolveDownloadContentSource,
  buildResolverDeps,
  type DownloadContentSource,
  type ResolveDownloadContentSourceDeps,
} from '../../../src/use-cases/project/download-content-source';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryCollaborationSessionRepository } from '../../ports/project/in-memory-collaboration-session-repository';
import { FileNode } from '../../../src/entities/file-node';
import { Document } from '../../../src/entities/document';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { DocumentId } from '../../../src/value-objects/ids/document-id';
import { ContentId } from '../../../src/value-objects/ids/content-id';
import { YjsStateId } from '../../../src/value-objects/ids/yjs-state-id';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { MimeType } from '../../../src/value-objects/files/mime-type';
import type { CollaborativeContentReader } from '../../../src/ports/storage/collaborative-content-reader';
import type { Logger } from '../../../src/ports/observability/logger';

const PROJECT_ID    = '550e8400-e29b-41d4-a716-446655440001';
const FILE_NODE_ID  = '550e8400-e29b-41d4-a716-446655440002';
const DOCUMENT_ID   = '550e8400-e29b-41d4-a716-446655440003';
const CONTENT_ID    = '550e8400-e29b-41d4-a716-446655440004';
const YJS_STATE_ID  = '550e8400-e29b-41d4-a716-446655440005';
const ROOT_NODE_ID  = '550e8400-e29b-41d4-a716-446655440006';

const projectId = ProjectId.create(PROJECT_ID);
const fileNodeId = FileNodeId.create(FILE_NODE_ID);
const rootNodeId = FileNodeId.create(ROOT_NODE_ID);

function makeFileNode(): FileNode {
  return new FileNode(
    fileNodeId,
    projectId,
    rootNodeId,
    'readme.adoc',
    FileNodeType.create('file'),
    FilePath.create('/readme.adoc'),
  );
}

function makeDocument(): Document {
  return new Document(
    DocumentId.create(DOCUMENT_ID),
    fileNodeId,
    ContentId.create(CONTENT_ID),
    YjsStateId.create(YJS_STATE_ID),
    MimeType.create('text/asciidoc'),
  );
}

function makeReader(result: { success: true; value: string | null } | { success: false; error: Error }): CollaborativeContentReader {
  return { readContent: jest.fn().mockResolvedValue(result) };
}

describe('resolveDownloadContentSource', () => {
  let documentRepo: InMemoryDocumentRepository;
  let collaborationSessionRepo: InMemoryCollaborationSessionRepository;

  beforeEach(async () => {
    documentRepo = new InMemoryDocumentRepository();
    collaborationSessionRepo = new InMemoryCollaborationSessionRepository();
  });

  test('(a) document + active session + reader returns text → inline bytes equal to live text', async () => {
    const liveText = '= Live Document\nLive content edited by user';
    const document = makeDocument();
    await documentRepo.save(document);
    await collaborationSessionRepo.open(projectId, document.id);

    const reader = makeReader({ success: true, value: liveText });
    const deps: ResolveDownloadContentSourceDeps = { documentRepo, collaborationSessionRepo, collaborativeContentReader: reader };

    const result = await resolveDownloadContentSource(deps, projectId, makeFileNode(), 'fallback');

    expect(result.kind).toBe('inline');
    expect((result as Extract<DownloadContentSource, { kind: 'inline' }>).bytes).toEqual(Buffer.from(liveText, 'utf8'));
  });

  test('(b) document + active session + reader returns null → stored, no warning logged', async () => {
    const document = makeDocument();
    await documentRepo.save(document);
    await collaborationSessionRepo.open(projectId, document.id);

    const reader = makeReader({ success: true, value: null });
    const warnSpy = jest.fn();
    const logger: Logger = { warn: warnSpy };
    const deps: ResolveDownloadContentSourceDeps = { documentRepo, collaborationSessionRepo, collaborativeContentReader: reader, logger };

    const result = await resolveDownloadContentSource(deps, projectId, makeFileNode(), 'fallback');

    expect(result.kind).toBe('stored');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('(c) document + active session + reader returns error → stored and warn logged with metadata only', async () => {
    const document = makeDocument();
    await documentRepo.save(document);
    await collaborationSessionRepo.open(projectId, document.id);

    const readerError = new Error('collab server unreachable');
    const reader = makeReader({ success: false, error: readerError });
    const warnSpy = jest.fn();
    const logger: Logger = { warn: warnSpy };
    const deps: ResolveDownloadContentSourceDeps = { documentRepo, collaborationSessionRepo, collaborativeContentReader: reader, logger };

    const result = await resolveDownloadContentSource(deps, projectId, makeFileNode(), 'fallback');

    expect(result.kind).toBe('stored');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Warn payload must be metadata-only: projectId, fileNodeId, path, error message — no document bytes, no secrets
    const [, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta).toHaveProperty('projectId', PROJECT_ID);
    expect(meta).toHaveProperty('fileNodeId', FILE_NODE_ID);
    expect(meta).toHaveProperty('path', '/readme.adoc');
    expect(meta).toHaveProperty('error', readerError.message);
    expect(meta).not.toHaveProperty('bytes');
    expect(meta).not.toHaveProperty('content');
    expect(meta).not.toHaveProperty('secret');
  });

  test('(d) document exists but session NOT active → stored, reader NOT called', async () => {
    const document = makeDocument();
    await documentRepo.save(document);
    // session NOT opened → isActive returns false

    const reader = makeReader({ success: true, value: 'should not be read' });
    const deps: ResolveDownloadContentSourceDeps = { documentRepo, collaborationSessionRepo, collaborativeContentReader: reader };

    const result = await resolveDownloadContentSource(deps, projectId, makeFileNode(), 'fallback');

    expect(result.kind).toBe('stored');
    expect(reader.readContent as jest.Mock).not.toHaveBeenCalled();
  });

  test('(e) no document (binary asset) → stored, reader NOT called', async () => {
    // documentRepo is empty → findByFileNodeId returns null
    const reader = makeReader({ success: true, value: 'should not be read' });
    const deps: ResolveDownloadContentSourceDeps = { documentRepo, collaborationSessionRepo, collaborativeContentReader: reader };

    const result = await resolveDownloadContentSource(deps, projectId, makeFileNode(), 'fallback');

    expect(result.kind).toBe('stored');
    expect(reader.readContent as jest.Mock).not.toHaveBeenCalled();
  });

  test('(f) snapshot fidelity: inline bytes equal reader string byte-for-byte (UTF-8)', async () => {
    const liveText = '= Snapshot Test\nUnicode: héllo wörld — •';
    const document = makeDocument();
    await documentRepo.save(document);
    await collaborationSessionRepo.open(projectId, document.id);

    const reader = makeReader({ success: true, value: liveText });
    const deps: ResolveDownloadContentSourceDeps = { documentRepo, collaborationSessionRepo, collaborativeContentReader: reader };

    const result = await resolveDownloadContentSource(deps, projectId, makeFileNode(), 'fallback');

    expect(result.kind).toBe('inline');
    const { bytes } = result as Extract<DownloadContentSource, { kind: 'inline' }>;
    // bytes must equal Buffer.from(liveText, 'utf8') verbatim — no re-assembly
    expect(bytes).toEqual(Buffer.from(liveText, 'utf8'));
    expect(bytes.toString('utf8')).toBe(liveText);
  });

  test('(g) documentRepo.findByFileNodeId throws → stored, warn logged with metadata only (no exception propagated)', async () => {
    const databaseError = new Error('DB connection timeout');
    const throwingDocumentRepo: ResolveDownloadContentSourceDeps['documentRepo'] = {
      findByFileNodeId: jest.fn().mockRejectedValue(databaseError),
    };
    const reader = makeReader({ success: true, value: 'should not be read' });
    const warnSpy = jest.fn();
    const logger: Logger = { warn: warnSpy };
    const deps: ResolveDownloadContentSourceDeps = {
      documentRepo: throwingDocumentRepo,
      collaborationSessionRepo,
      collaborativeContentReader: reader,
      logger,
    };

    const result = await resolveDownloadContentSource(deps, projectId, makeFileNode(), 'fallback');

    expect(result.kind).toBe('stored');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta).toHaveProperty('error', databaseError.message);
    expect(meta).not.toHaveProperty('bytes');
  });

  test('(h) collaborationSessionRepo.isActive throws → stored, warn logged (no exception propagated)', async () => {
    const document = makeDocument();
    await documentRepo.save(document);
    const sessionError = new Error('Redis timeout');
    const throwingSessionRepo: ResolveDownloadContentSourceDeps['collaborationSessionRepo'] = {
      isActive: jest.fn().mockRejectedValue(sessionError),
    };
    const reader = makeReader({ success: true, value: 'should not be read' });
    const warnSpy = jest.fn();
    const logger: Logger = { warn: warnSpy };
    const deps: ResolveDownloadContentSourceDeps = {
      documentRepo,
      collaborationSessionRepo: throwingSessionRepo,
      collaborativeContentReader: reader,
      logger,
    };

    const result = await resolveDownloadContentSource(deps, projectId, makeFileNode(), 'fallback');

    expect(result.kind).toBe('stored');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta).toHaveProperty('error', sessionError.message);
  });

  describe("with the 'fail' policy", () => {
    test('a failed live read reports the file as unavailable instead of falling back', async () => {
      const document = makeDocument();
      await documentRepo.save(document);
      await collaborationSessionRepo.open(projectId, document.id);

      const reader = makeReader({ success: false, error: new Error('collab server unreachable') });
      const deps: ResolveDownloadContentSourceDeps = { documentRepo, collaborationSessionRepo, collaborativeContentReader: reader };
      const fileNode = makeFileNode();

      const result = await resolveDownloadContentSource(deps, projectId, fileNode, 'fail');

      expect(result).toEqual({ kind: 'unavailable', fileNode });
    });

    test('a failed live read never resolves to stored, so stale stored bytes are never served', async () => {
      const document = makeDocument();
      await documentRepo.save(document);
      await collaborationSessionRepo.open(projectId, document.id);

      const reader = makeReader({ success: false, error: new Error('collab server unreachable') });
      const deps: ResolveDownloadContentSourceDeps = { documentRepo, collaborationSessionRepo, collaborativeContentReader: reader };

      const result = await resolveDownloadContentSource(deps, projectId, makeFileNode(), 'fail');

      expect(result.kind).not.toBe('stored');
    });

    test('a failed live read logs no fallback warning, because nothing fell back', async () => {
      const document = makeDocument();
      await documentRepo.save(document);
      await collaborationSessionRepo.open(projectId, document.id);

      const reader = makeReader({ success: false, error: new Error('collab server unreachable') });
      const warnSpy = jest.fn();
      const logger: Logger = { warn: warnSpy };
      const deps: ResolveDownloadContentSourceDeps = { documentRepo, collaborationSessionRepo, collaborativeContentReader: reader, logger };

      const result = await resolveDownloadContentSource(deps, projectId, makeFileNode(), 'fail');

      expect(result.kind).toBe('unavailable');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test('a reader that throws is still a failed live read, not a licence to serve stored bytes', async () => {
      const document = makeDocument();
      await documentRepo.save(document);
      await collaborationSessionRepo.open(projectId, document.id);

      const throwingReader: CollaborativeContentReader = {
        readContent: jest.fn().mockRejectedValue(new Error('collab response body was truncated')),
      };
      const deps: ResolveDownloadContentSourceDeps = { documentRepo, collaborationSessionRepo, collaborativeContentReader: throwingReader };
      const fileNode = makeFileNode();

      const result = await resolveDownloadContentSource(deps, projectId, fileNode, 'fail');

      expect(result).toEqual({ kind: 'unavailable', fileNode });
    });

    test('a session check that throws leaves the current content undetermined, so nothing stored is substituted', async () => {
      const document = makeDocument();
      await documentRepo.save(document);
      const throwingSessionRepo: ResolveDownloadContentSourceDeps['collaborationSessionRepo'] = {
        isActive: jest.fn().mockRejectedValue(new Error('Redis timeout')),
      };
      const deps: ResolveDownloadContentSourceDeps = {
        documentRepo,
        collaborationSessionRepo: throwingSessionRepo,
        collaborativeContentReader: makeReader({ success: true, value: 'should not be read' }),
      };
      const fileNode = makeFileNode();

      const result = await resolveDownloadContentSource(deps, projectId, fileNode, 'fail');

      expect(result).toEqual({ kind: 'unavailable', fileNode });
    });

    test('a document lookup that throws leaves the current content undetermined, so nothing stored is substituted', async () => {
      const throwingDocumentRepo: ResolveDownloadContentSourceDeps['documentRepo'] = {
        findByFileNodeId: jest.fn().mockRejectedValue(new Error('DB connection timeout')),
      };
      const deps: ResolveDownloadContentSourceDeps = {
        documentRepo: throwingDocumentRepo,
        collaborationSessionRepo,
        collaborativeContentReader: makeReader({ success: true, value: 'should not be read' }),
      };
      const fileNode = makeFileNode();

      const result = await resolveDownloadContentSource(deps, projectId, fileNode, 'fail');

      expect(result).toEqual({ kind: 'unavailable', fileNode });
    });

    test('a dormant session still resolves to stored — a dormant document is not a failed read', async () => {
      const document = makeDocument();
      await documentRepo.save(document);
      // session NOT opened → isActive returns false

      const reader = makeReader({ success: true, value: 'should not be read' });
      const deps: ResolveDownloadContentSourceDeps = { documentRepo, collaborationSessionRepo, collaborativeContentReader: reader };

      const result = await resolveDownloadContentSource(deps, projectId, makeFileNode(), 'fail');

      expect(result).toEqual({ kind: 'stored' });
      expect(reader.readContent as jest.Mock).not.toHaveBeenCalled();
    });

    test('a file node with no document still resolves to stored — a binary asset is not a failed read', async () => {
      // documentRepo is empty → findByFileNodeId returns null
      const reader = makeReader({ success: true, value: 'should not be read' });
      const deps: ResolveDownloadContentSourceDeps = { documentRepo, collaborationSessionRepo, collaborativeContentReader: reader };

      const result = await resolveDownloadContentSource(deps, projectId, makeFileNode(), 'fail');

      expect(result).toEqual({ kind: 'stored' });
      expect(reader.readContent as jest.Mock).not.toHaveBeenCalled();
    });

    test('a successful live read still returns the live inline bytes', async () => {
      const liveText = '= Live Document\nEdited moments ago';
      const document = makeDocument();
      await documentRepo.save(document);
      await collaborationSessionRepo.open(projectId, document.id);

      const reader = makeReader({ success: true, value: liveText });
      const deps: ResolveDownloadContentSourceDeps = { documentRepo, collaborationSessionRepo, collaborativeContentReader: reader };

      const result = await resolveDownloadContentSource(deps, projectId, makeFileNode(), 'fail');

      expect(result).toEqual({ kind: 'inline', bytes: Buffer.from(liveText, 'utf8') });
    });
  });

});

describe('buildResolverDeps', () => {
  test('returns null when any dep is undefined — prevents partial wiring silently degrading', () => {
    const reader: CollaborativeContentReader = { readContent: jest.fn() };
    const sessionRepo = new InMemoryCollaborationSessionRepository();
    expect(buildResolverDeps(undefined, sessionRepo, reader)).toBeNull();
    expect(buildResolverDeps(new InMemoryDocumentRepository(), undefined, reader)).toBeNull();
    expect(buildResolverDeps(new InMemoryDocumentRepository(), sessionRepo, undefined)).toBeNull();
  });

  test('returns full deps object when all three are provided', () => {
    const documentRepo = new InMemoryDocumentRepository();
    const sessionRepo = new InMemoryCollaborationSessionRepository();
    const reader: CollaborativeContentReader = { readContent: jest.fn() };
    const deps = buildResolverDeps(documentRepo, sessionRepo, reader);
    expect(deps).not.toBeNull();
    expect(deps!.documentRepo).toBe(documentRepo);
    expect(deps!.collaborationSessionRepo).toBe(sessionRepo);
    expect(deps!.collaborativeContentReader).toBe(reader);
    expect(deps!.logger).toBeUndefined();
  });

  test('includes optional logger when provided', () => {
    const documentRepo = new InMemoryDocumentRepository();
    const sessionRepo = new InMemoryCollaborationSessionRepository();
    const reader: CollaborativeContentReader = { readContent: jest.fn() };
    const logger: Logger = { warn: jest.fn() };
    const deps = buildResolverDeps(documentRepo, sessionRepo, reader, logger);
    expect(deps!.logger).toBe(logger);
  });
});
