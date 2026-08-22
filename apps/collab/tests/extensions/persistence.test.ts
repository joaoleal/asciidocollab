import * as Y from 'yjs';
import { PersistenceExtension } from '../../src/extensions/persistence';
import type {
  YjsStateStore,
  ProjectFileStore,
  DocumentRepository,
  FileNodeRepository,
} from '@asciidocollab/domain';
import {
  ProjectId,
  YjsStateId,
  DocumentId,
  FileNodeId,
  FilePath,
  ContentId,
  MimeType,
  Document,
  FileNode,
  FileNodeType,
  Timestamps,
} from '@asciidocollab/domain';

function makeDocument() {
  return new Y.Doc();
}

const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440001');
const yjsStateIdValue = '550e8400-e29b-41d4-a716-446655440002';
const yjsStateId = YjsStateId.create(yjsStateIdValue);
const documentName = `${projectId.value}/${yjsStateIdValue}`;
const filePath = FilePath.create('/docs/file.adoc');
const fileNodeIdValue = '550e8400-e29b-41d4-a716-446655440003';

function makeStores(options: { yjsState?: Buffer | null; fileContent?: Buffer | null } = {}) {
  const yjsStateStore = {
    load: jest.fn().mockResolvedValue(options.yjsState ?? null),
    save: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn(),
    deleteAllForProject: jest.fn(),
  } as unknown as jest.Mocked<YjsStateStore>;

  const projectFileStore = {
    read: jest.fn().mockResolvedValue(options.fileContent ?? null),
    write: jest.fn().mockResolvedValue(undefined),
    createExclusive: jest.fn(),
    remove: jest.fn(),
    move: jest.fn(),
    createDirectory: jest.fn(),
    removeDirectory: jest.fn(),
    removeProject: jest.fn(),
    readStream: jest.fn(),
  } as unknown as jest.Mocked<ProjectFileStore>;

  const testDocument = new Document(
    DocumentId.create('550e8400-e29b-41d4-a716-446655440010'),
    FileNodeId.create(fileNodeIdValue),
    ContentId.create('550e8400-e29b-41d4-a716-446655440004'),
    yjsStateId,
    MimeType.create('text/asciidoc'),
    new Timestamps(),
  );

  const testFileNode = new FileNode(
    FileNodeId.create(fileNodeIdValue),
    projectId,
    FileNodeId.create('550e8400-e29b-41d4-a716-446655440020'),
    'file.adoc',
    FileNodeType.create('file'),
    filePath,
    new Timestamps(),
  );

  const documentRepository = {
    findByYjsStateId: jest.fn().mockResolvedValue(testDocument),
    findById: jest.fn(),
    findByFileNodeId: jest.fn(),
    findByFileNodeIds: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
  } as unknown as jest.Mocked<DocumentRepository>;

  const fileNodeRepository = {
    findById: jest.fn().mockResolvedValue(testFileNode),
    findByParentId: jest.fn(),
    findByProjectId: jest.fn(),
    findByPath: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    findDescendants: jest.fn(),
    findByProjectIdAndType: jest.fn(),
    deleteAllForProject: jest.fn(),
  } as unknown as jest.Mocked<FileNodeRepository>;

  return { yjsStateStore, projectFileStore, documentRepository, fileNodeRepository };
}

describe('PersistenceExtension', () => {
  describe('onLoadDocument', () => {
    it('(a) applies existing Yjs state when store has data', async () => {
      const sourceDocument = makeDocument();
      sourceDocument.getText('codemirror').insert(0, 'existing content');
      const existingState = Buffer.from(Y.encodeStateAsUpdate(sourceDocument));

      const { yjsStateStore, projectFileStore, documentRepository, fileNodeRepository } =
        makeStores({ yjsState: existingState });
      const extension = new PersistenceExtension(yjsStateStore, projectFileStore, documentRepository, fileNodeRepository);

      const document = makeDocument();
      await extension.onLoadDocument({ documentName, document: document, context: {} } as never);

      expect(yjsStateStore.load).toHaveBeenCalledWith(
        expect.objectContaining({ value: projectId.value }),
        expect.objectContaining({ value: yjsStateIdValue }),
      );
      expect(document.getText('codemirror').toString()).toBe('existing content');
      expect(projectFileStore.read).not.toHaveBeenCalled();
    });

    it('(b) bootstraps from file content when no Yjs state exists and immediately persists', async () => {
      const fileContent = Buffer.from('# Hello World');
      const { yjsStateStore, projectFileStore, documentRepository, fileNodeRepository } =
        makeStores({ yjsState: null, fileContent });
      const extension = new PersistenceExtension(yjsStateStore, projectFileStore, documentRepository, fileNodeRepository);

      const document = makeDocument();
      await extension.onLoadDocument({ documentName, document: document, context: {} } as never);

      expect(projectFileStore.read).toHaveBeenCalledWith(
        expect.objectContaining({ value: projectId.value }),
        expect.objectContaining({ value: filePath.value }),
      );
      expect(document.getText('codemirror').toString()).toBe('# Hello World');
      expect(yjsStateStore.save).toHaveBeenCalledTimes(1);
    });

    it('(b) does not bootstrap if file content is null', async () => {
      const { yjsStateStore, projectFileStore, documentRepository, fileNodeRepository } =
        makeStores({ yjsState: null, fileContent: null });
      const extension = new PersistenceExtension(yjsStateStore, projectFileStore, documentRepository, fileNodeRepository);

      const document = makeDocument();
      await extension.onLoadDocument({ documentName, document: document, context: {} } as never);

      expect(yjsStateStore.save).not.toHaveBeenCalled();
    });
  });

  describe('resolveFilePath edge cases', () => {
    it('does not bootstrap when document record is missing (findByYjsStateId returns null)', async () => {
      const { yjsStateStore, projectFileStore, fileNodeRepository } = makeStores();
      const documentRepository = {
        findByYjsStateId: jest.fn().mockResolvedValue(null),
        findById: jest.fn(),
        findByFileNodeId: jest.fn(),
        findByFileNodeIds: jest.fn(),
        save: jest.fn(),
        delete: jest.fn(),
      } as unknown as jest.Mocked<DocumentRepository>;

      const extension = new PersistenceExtension(yjsStateStore, projectFileStore, documentRepository, fileNodeRepository);
      const document = makeDocument();
      await extension.onLoadDocument({ documentName, document: document, context: {} } as never);

      // No state, no file lookup (resolveFilePath returned null)
      expect(projectFileStore.read).not.toHaveBeenCalled();
      expect(yjsStateStore.save).not.toHaveBeenCalled();
    });

    it('skips ALL storage in onStoreDocument when the document no longer exists (deleted mid-session)', async () => {
      // Regression: a file deleted while its collaboration room is still open must NOT be
      // resurrected. The delete removed the Yjs state blob; onStoreDocument must not re-create it,
      // or the deleted document leaves an orphaned blob on disk that nothing ever cleans up.
      const { yjsStateStore, projectFileStore, fileNodeRepository } = makeStores();
      const documentRepository = {
        findByYjsStateId: jest.fn().mockResolvedValue(null),
        findById: jest.fn(),
        findByFileNodeId: jest.fn(),
        findByFileNodeIds: jest.fn(),
        save: jest.fn(),
        delete: jest.fn(),
      } as unknown as jest.Mocked<DocumentRepository>;

      const extension = new PersistenceExtension(yjsStateStore, projectFileStore, documentRepository, fileNodeRepository);
      const document = makeDocument();
      document.getText('codemirror').insert(0, 'some content');

      await extension.onStoreDocument({ documentName, document: document, context: {} } as never);

      // Neither the Yjs blob nor the file is written — the document is gone.
      expect(yjsStateStore.save).not.toHaveBeenCalled();
      expect(projectFileStore.write).not.toHaveBeenCalled();
    });

    it('skips ALL storage in onStoreDocument when the FILE NODE behind the document is gone', async () => {
      // The document record can outlive its file node (the tree row is deleted first). resolveFilePath
      // must degrade to null there — dereferencing the absent node instead would throw straight out of
      // the store hook, which is Hocuspocus's write-back path for a room full of live editors.
      const { yjsStateStore, projectFileStore, documentRepository } = makeStores();
      const fileNodeRepository = {
        findById: jest.fn().mockResolvedValue(null),
        findByParentId: jest.fn(),
        findByProjectId: jest.fn(),
        findByPath: jest.fn(),
        save: jest.fn(),
        delete: jest.fn(),
        findDescendants: jest.fn(),
        findByProjectIdAndType: jest.fn(),
        deleteAllForProject: jest.fn(),
      } as unknown as jest.Mocked<FileNodeRepository>;

      const extension = new PersistenceExtension(yjsStateStore, projectFileStore, documentRepository, fileNodeRepository);
      const document = makeDocument();
      document.getText('codemirror').insert(0, 'some content');

      await expect(
        extension.onStoreDocument({ documentName, document, context: {} } as never),
      ).resolves.toBeUndefined();

      expect(fileNodeRepository.findById).toHaveBeenCalledTimes(1);
      expect(yjsStateStore.save).not.toHaveBeenCalled();
      expect(projectFileStore.write).not.toHaveBeenCalled();
    });

    it('does not bootstrap in onLoadDocument when the file node behind the document is gone', async () => {
      const { yjsStateStore, projectFileStore, documentRepository } = makeStores({ yjsState: null });
      const fileNodeRepository = {
        findById: jest.fn().mockResolvedValue(null),
        findByParentId: jest.fn(),
        findByProjectId: jest.fn(),
        findByPath: jest.fn(),
        save: jest.fn(),
        delete: jest.fn(),
        findDescendants: jest.fn(),
        findByProjectIdAndType: jest.fn(),
        deleteAllForProject: jest.fn(),
      } as unknown as jest.Mocked<FileNodeRepository>;

      const extension = new PersistenceExtension(yjsStateStore, projectFileStore, documentRepository, fileNodeRepository);
      const document = makeDocument();

      await expect(
        extension.onLoadDocument({ documentName, document, context: {} } as never),
      ).resolves.toBeUndefined();

      expect(projectFileStore.read).not.toHaveBeenCalled();
      expect(yjsStateStore.save).not.toHaveBeenCalled();
      expect(document.getText('codemirror').toString()).toBe('');
    });
  });

  describe('onStoreDocument', () => {
    it('(c) writes encoded codemirror text to both YjsStateStore and ProjectFileStore', async () => {
      const { yjsStateStore, projectFileStore, documentRepository, fileNodeRepository } = makeStores();
      const extension = new PersistenceExtension(yjsStateStore, projectFileStore, documentRepository, fileNodeRepository);

      const document = makeDocument();
      document.getText('codemirror').insert(0, 'hello world');

      await extension.onStoreDocument({ documentName, document: document, context: {} } as never);

      expect(yjsStateStore.save).toHaveBeenCalledWith(
        expect.objectContaining({ value: projectId.value }),
        expect.objectContaining({ value: yjsStateIdValue }),
        expect.any(Buffer),
      );
      expect(projectFileStore.write).toHaveBeenCalledWith(
        expect.objectContaining({ value: projectId.value }),
        expect.objectContaining({ value: filePath.value }),
        expect.any(Buffer),
      );

      const writtenContent = (projectFileStore.write as jest.Mock).mock.calls[0][2] as Buffer;
      expect(writtenContent.toString('utf8')).toBe('hello world');
    });

    it('(d) persists regardless of context.role — observer writes are blocked at the WS layer, not here', async () => {
      // onStoreDocument is a DOCUMENT-level hook: its `context` does not reliably identify the
      // connection that produced the change, so gating the write on context.role could silently
      // drop a legitimate EDITOR's edits in a mixed (editor + observer) room. Observer writes are
      // already prevented at the transport layer (auth-hook sets connection.readOnly), so the
      // store must persist whatever is in the document regardless of the context role it sees.
      const { yjsStateStore, projectFileStore, documentRepository, fileNodeRepository } = makeStores();
      const extension = new PersistenceExtension(yjsStateStore, projectFileStore, documentRepository, fileNodeRepository);

      const document = makeDocument();
      document.getText('codemirror').insert(0, 'editor content in a mixed room');

      await extension.onStoreDocument({ documentName, document: document, context: { role: 'observer' } } as never);

      expect(yjsStateStore.save).toHaveBeenCalled();
      expect(projectFileStore.write).toHaveBeenCalled();
    });
  });

  // Feature 024: a presence room (`presence/<projectId>`) carries no document — persistence is a no-op.
  describe('presence rooms', () => {
    const presenceName = `presence/${projectId.value}`;

    it('onLoadDocument neither loads nor writes any state for a presence room', async () => {
      const { yjsStateStore, projectFileStore, documentRepository, fileNodeRepository } = makeStores();
      const extension = new PersistenceExtension(yjsStateStore, projectFileStore, documentRepository, fileNodeRepository);

      await extension.onLoadDocument({ documentName: presenceName, document: makeDocument(), context: {} } as never);

      expect(yjsStateStore.load).not.toHaveBeenCalled();
      expect(yjsStateStore.save).not.toHaveBeenCalled();
      expect(projectFileStore.read).not.toHaveBeenCalled();
    });

    it('onStoreDocument writes no document state for a presence room', async () => {
      const { yjsStateStore, projectFileStore, documentRepository, fileNodeRepository } = makeStores();
      const extension = new PersistenceExtension(yjsStateStore, projectFileStore, documentRepository, fileNodeRepository);

      const document = makeDocument();
      document.getText('codemirror').insert(0, 'should never be persisted');
      await extension.onStoreDocument({ documentName: presenceName, document, context: {} } as never);

      expect(yjsStateStore.save).not.toHaveBeenCalled();
      expect(projectFileStore.write).not.toHaveBeenCalled();
    });
  });
});
