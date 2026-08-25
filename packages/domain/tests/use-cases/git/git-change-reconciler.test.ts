import { randomUUID } from 'crypto';
import { GitChangeReconciler } from '../../../src/use-cases/git/git-change-reconciler';
import { GitMergeFileChange } from '../../../src/ports/git/git-command-runner';
import { FileNode } from '../../../src/entities/file-node';
import { Document } from '../../../src/entities/document';
import { Asset } from '../../../src/entities/asset';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { DocumentId } from '../../../src/value-objects/ids/document-id';
import { ContentId } from '../../../src/value-objects/ids/content-id';
import { YjsStateId } from '../../../src/value-objects/ids/yjs-state-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { MimeType } from '../../../src/value-objects/files/mime-type';
import { Logger } from '../../../src/ports/observability/logger';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryAssetRepository } from '../../ports/file-tree/in-memory-asset.repository';
import { InMemoryProjectFileStore } from '../../ports/storage/in-memory-project-file-store';
import { InMemoryCollaborationSessionRepository } from '../../ports/project/in-memory-collaboration-session-repository';
import { InMemoryCollaborativeContentWriter } from '../../ports/storage/in-memory-collaborative-content-writer';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');

/** Everything a single reconciler run needs, freshly wired per test. */
interface Harness {
  reconciler: GitChangeReconciler;
  fileNodeRepo: InMemoryFileNodeRepository;
  documentRepo: InMemoryDocumentRepository;
  assetRepo: InMemoryAssetRepository;
  fileStore: InMemoryProjectFileStore;
  sessionRepo: InMemoryCollaborationSessionRepository;
  writer: InMemoryCollaborativeContentWriter;
  logger: { warn: jest.Mock } & Logger;
  rootFolderId: FileNodeId;
}

async function makeHarness(): Promise<Harness> {
  const fileNodeRepo = new InMemoryFileNodeRepository();
  const documentRepo = new InMemoryDocumentRepository();
  const assetRepo = new InMemoryAssetRepository();
  const fileStore = new InMemoryProjectFileStore();
  const sessionRepo = new InMemoryCollaborationSessionRepository();
  const writer = new InMemoryCollaborativeContentWriter();
  const logger = { warn: jest.fn() };

  // Every project has a root folder at '/'; the reconciler parents new files under it.
  const rootFolderId = FileNodeId.create(randomUUID());
  await fileNodeRepo.save(
    new FileNode(rootFolderId, PROJECT_ID, null, 'root', FileNodeType.create('folder'), FilePath.create('/')),
  );

  const reconciler = new GitChangeReconciler(
    fileNodeRepo,
    documentRepo,
    assetRepo,
    fileStore,
    sessionRepo,
    writer,
    logger,
  );

  return { reconciler, fileNodeRepo, documentRepo, assetRepo, fileStore, sessionRepo, writer, logger, rootFolderId };
}

/** Seeds an existing document-backed file at `path`, returning the node + document. */
async function seedDocument(h: Harness, path: string, content: string): Promise<{ node: FileNode; document: Document }> {
  const segments = path.split('/');
  const name = segments[segments.length - 1];
  const nodeId = FileNodeId.create(randomUUID());
  const node = new FileNode(nodeId, PROJECT_ID, h.rootFolderId, name, FileNodeType.create('file'), FilePath.create('/' + path));
  await h.fileNodeRepo.save(node);
  await h.fileStore.write(PROJECT_ID, node.path, Buffer.from(content, 'utf8'));
  const document = new Document(
    DocumentId.create(randomUUID()),
    nodeId,
    ContentId.create(randomUUID()),
    YjsStateId.create(randomUUID()),
    MimeType.create('text/asciidoc'),
  );
  await h.documentRepo.save(document);
  return { node, document };
}

/** Seeds an existing asset-backed file at `path`. */
async function seedAsset(h: Harness, path: string, content: Buffer): Promise<FileNode> {
  const segments = path.split('/');
  const name = segments[segments.length - 1];
  const nodeId = FileNodeId.create(randomUUID());
  const node = new FileNode(nodeId, PROJECT_ID, h.rootFolderId, name, FileNodeType.create('file'), FilePath.create('/' + path));
  await h.fileNodeRepo.save(node);
  await h.fileStore.write(PROJECT_ID, node.path, content);
  await h.assetRepo.save(new Asset(nodeId, MimeType.create('image/png'), BigInt(content.length)));
  return node;
}

function added(path: string, content: string, mimeType = 'text/asciidoc'): GitMergeFileChange {
  return { type: 'added', path, content: Buffer.from(content, 'utf8'), mimeType };
}
function modified(path: string, content: string, mimeType = 'text/asciidoc'): GitMergeFileChange {
  return { type: 'modified', path, content: Buffer.from(content, 'utf8'), mimeType };
}
function removed(path: string): GitMergeFileChange {
  return { type: 'removed', path };
}
function renamed(fromPath: string, toPath: string, content: string, mimeType = 'text/asciidoc'): GitMergeFileChange {
  return { type: 'renamed', fromPath, toPath, content: Buffer.from(content, 'utf8'), mimeType };
}

describe('GitChangeReconciler', () => {
  describe('added', () => {
    it('creates a FileNode + Document and writes the bytes for an AsciiDoc file', async () => {
      const h = await makeHarness();

      const result = await h.reconciler.apply(PROJECT_ID, [added('intro.adoc', '= Intro\n')]);

      expect(result.success).toBe(true);
      const node = (await h.fileNodeRepo.findByProjectId(PROJECT_ID)).find((n) => n.path.value === '/intro.adoc');
      expect(node).toBeDefined();
      expect(node!.type.value).toBe('file');
      const document = await h.documentRepo.findByFileNodeId(node!.id);
      expect(document).not.toBeNull();
      expect(await h.assetRepo.findById(node!.id)).toBeNull();
      expect((await h.fileStore.read(PROJECT_ID, node!.path))!.toString('utf8')).toBe('= Intro\n');
    });

    it('creates a FileNode + Asset (not Document) for a binary file', async () => {
      const h = await makeHarness();
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

      const result = await h.reconciler.apply(PROJECT_ID, [
        { type: 'added', path: 'logo.png', content: bytes, mimeType: 'image/png' },
      ]);

      expect(result.success).toBe(true);
      const node = (await h.fileNodeRepo.findByProjectId(PROJECT_ID)).find((n) => n.path.value === '/logo.png');
      expect(node).toBeDefined();
      expect(await h.documentRepo.findByFileNodeId(node!.id)).toBeNull();
      const asset = await h.assetRepo.findById(node!.id);
      expect(asset).not.toBeNull();
      expect(asset!.sizeBytes).toBe(BigInt(bytes.length));
    });

    it('creates the parent folder FileNode for a file under a not-yet-existing folder', async () => {
      const h = await makeHarness();

      await h.reconciler.apply(PROJECT_ID, [added('chapters/intro.adoc', '== Intro\n')]);

      const folder = (await h.fileNodeRepo.findByProjectId(PROJECT_ID)).find((n) => n.path.value === '/chapters');
      expect(folder).toBeDefined();
      expect(folder!.type.value).toBe('folder');
      const file = (await h.fileNodeRepo.findByProjectId(PROJECT_ID)).find((n) => n.path.value === '/chapters/intro.adoc');
      expect(file!.parentId!.value).toBe(folder!.id.value);
    });
  });

  describe('modified', () => {
    it('lands into the live Yjs doc AND the file store when a session is active', async () => {
      const h = await makeHarness();
      const { node, document } = await seedDocument(h, 'intro.adoc', '= Old\n');
      await h.sessionRepo.open(PROJECT_ID, document.id);

      const result = await h.reconciler.apply(PROJECT_ID, [modified('intro.adoc', '= New\n')]);

      expect(result.success).toBe(true);
      expect(h.writer.contentFor(PROJECT_ID, document.yjsStateId)).toBe('= New\n');
      expect((await h.fileStore.read(PROJECT_ID, node.path))!.toString('utf8')).toBe('= New\n');
    });

    it('writes only the file store for a dormant doc (writer never called)', async () => {
      const h = await makeHarness();
      const { node, document } = await seedDocument(h, 'intro.adoc', '= Old\n');

      const result = await h.reconciler.apply(PROJECT_ID, [modified('intro.adoc', '= New\n')]);

      expect(result.success).toBe(true);
      expect(h.writer.contentFor(PROJECT_ID, document.yjsStateId)).toBeUndefined();
      expect((await h.fileStore.read(PROJECT_ID, node.path))!.toString('utf8')).toBe('= New\n');
    });

    it('returns an error when the live writer fails on an active doc', async () => {
      const h = await makeHarness();
      const { document } = await seedDocument(h, 'intro.adoc', '= Old\n');
      await h.sessionRepo.open(PROJECT_ID, document.id);
      h.writer.failNext(new Error('collaboration server unreachable'));

      const result = await h.reconciler.apply(PROJECT_ID, [modified('intro.adoc', '= New\n')]);

      expect(result.success).toBe(false);
    });
  });

  describe('removed', () => {
    it('deletes the Document + FileNode and removes the stored bytes', async () => {
      const h = await makeHarness();
      const { node, document } = await seedDocument(h, 'intro.adoc', '= Old\n');

      const result = await h.reconciler.apply(PROJECT_ID, [removed('intro.adoc')]);

      expect(result.success).toBe(true);
      expect(await h.fileNodeRepo.findById(node.id)).toBeNull();
      expect(await h.documentRepo.findById(document.id)).toBeNull();
      expect(await h.fileStore.read(PROJECT_ID, node.path)).toBeNull();
    });

    it('deletes an asset-backed file', async () => {
      const h = await makeHarness();
      const node = await seedAsset(h, 'logo.png', Buffer.from([1, 2, 3]));

      const result = await h.reconciler.apply(PROJECT_ID, [removed('logo.png')]);

      expect(result.success).toBe(true);
      expect(await h.fileNodeRepo.findById(node.id)).toBeNull();
      expect(await h.assetRepo.findById(node.id)).toBeNull();
    });
  });

  describe('renamed', () => {
    it('re-saves the same-id FileNode at the new path and moves the stored bytes (dormant: writer not called)', async () => {
      const h = await makeHarness();
      const { node, document } = await seedDocument(h, 'intro.adoc', '= Intro\n');

      const result = await h.reconciler.apply(PROJECT_ID, [renamed('intro.adoc', 'preface.adoc', '= Intro\n')]);

      expect(result.success).toBe(true);
      const moved = await h.fileNodeRepo.findById(node.id);
      expect(moved!.path.value).toBe('/preface.adoc');
      expect(moved!.name).toBe('preface.adoc');
      expect((await h.fileStore.read(PROJECT_ID, FilePath.create('/preface.adoc')))!.toString('utf8')).toBe('= Intro\n');
      expect(await h.fileStore.read(PROJECT_ID, FilePath.create('/intro.adoc'))).toBeNull();
      expect(h.writer.contentFor(PROJECT_ID, document.yjsStateId)).toBeUndefined();
    });

    it('lands the new content into the live doc when the merge also changed content and a session is active', async () => {
      const h = await makeHarness();
      const { document } = await seedDocument(h, 'intro.adoc', '= Intro\n');
      await h.sessionRepo.open(PROJECT_ID, document.id);

      const result = await h.reconciler.apply(PROJECT_ID, [renamed('intro.adoc', 'preface.adoc', '= Preface\n')]);

      expect(result.success).toBe(true);
      expect(h.writer.contentFor(PROJECT_ID, document.yjsStateId)).toBe('= Preface\n');
      expect((await h.fileStore.read(PROJECT_ID, FilePath.create('/preface.adoc')))!.toString('utf8')).toBe('= Preface\n');
    });
  });

  describe('missing-node drift', () => {
    it('treats a modified change with no existing node as an added file and warns', async () => {
      const h = await makeHarness();

      const result = await h.reconciler.apply(PROJECT_ID, [modified('ghost.adoc', '= Ghost\n')]);

      expect(result.success).toBe(true);
      const node = (await h.fileNodeRepo.findByProjectId(PROJECT_ID)).find((n) => n.path.value === '/ghost.adoc');
      expect(node).toBeDefined();
      expect(await h.documentRepo.findByFileNodeId(node!.id)).not.toBeNull();
      expect((await h.fileStore.read(PROJECT_ID, node!.path))!.toString('utf8')).toBe('= Ghost\n');
      expect(h.logger.warn).toHaveBeenCalled();
    });

    it('treats a renamed change whose source node is missing as an added file at the target and warns', async () => {
      const h = await makeHarness();

      const result = await h.reconciler.apply(PROJECT_ID, [renamed('gone.adoc', 'here.adoc', '= Here\n')]);

      expect(result.success).toBe(true);
      const node = (await h.fileNodeRepo.findByProjectId(PROJECT_ID)).find((n) => n.path.value === '/here.adoc');
      expect(node).toBeDefined();
      expect((await h.fileStore.read(PROJECT_ID, node!.path))!.toString('utf8')).toBe('= Here\n');
      expect(h.logger.warn).toHaveBeenCalled();
    });

    it('no-ops a removed change whose node is missing and warns', async () => {
      const h = await makeHarness();

      const result = await h.reconciler.apply(PROJECT_ID, [removed('never.adoc')]);

      expect(result.success).toBe(true);
      expect(h.logger.warn).toHaveBeenCalled();
    });
  });

  describe('changedPaths', () => {
    it('reports every touched path across a mixed batch', async () => {
      const h = await makeHarness();
      await seedDocument(h, 'edit.adoc', '= Edit\n');
      await seedDocument(h, 'old.adoc', '= Move\n');
      await seedDocument(h, 'drop.adoc', '= Drop\n');

      const result = await h.reconciler.apply(PROJECT_ID, [
        added('new.adoc', '= New\n'),
        modified('edit.adoc', '= Edited\n'),
        removed('drop.adoc'),
        renamed('old.adoc', 'moved.adoc', '= Move\n'),
      ]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.changedPaths).toEqual(
        expect.arrayContaining(['new.adoc', 'edit.adoc', 'drop.adoc', 'moved.adoc']),
      );
    });
  });
});
