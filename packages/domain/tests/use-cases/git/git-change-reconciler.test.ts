import { randomUUID } from 'crypto';
import { GitChangeReconciler } from '../../../src/use-cases/git/git-change-reconciler';
import { buildGitDriftSummary } from '../../../src/types/git-drift-summary';
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
  const name = segments.at(-1)!;
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
  const name = segments.at(-1)!;
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
      const nodes = await h.fileNodeRepo.findByProjectId(PROJECT_ID);
      const node = nodes.find((n) => n.path.value === '/intro.adoc');
      expect(node).toBeDefined();
      expect(node!.type.value).toBe('file');
      const document = await h.documentRepo.findByFileNodeId(node!.id);
      expect(document).not.toBeNull();
      expect(await h.assetRepo.findById(node!.id)).toBeNull();
      expect((await h.fileStore.read(PROJECT_ID, node!.path))!.toString('utf8')).toBe('= Intro\n');
    });

    it('creates a FileNode + Asset (not Document) for a binary file', async () => {
      const h = await makeHarness();
      const bytes = Buffer.from([0x89, 0x50, 0x4E, 0x47]);

      const result = await h.reconciler.apply(PROJECT_ID, [
        { type: 'added', path: 'logo.png', content: bytes, mimeType: 'image/png' },
      ]);

      expect(result.success).toBe(true);
      const nodes = await h.fileNodeRepo.findByProjectId(PROJECT_ID);
      const node = nodes.find((n) => n.path.value === '/logo.png');
      expect(node).toBeDefined();
      expect(await h.documentRepo.findByFileNodeId(node!.id)).toBeNull();
      const asset = await h.assetRepo.findById(node!.id);
      expect(asset).not.toBeNull();
      expect(asset!.sizeBytes).toBe(BigInt(bytes.length));
    });

    it('creates the parent folder FileNode for a file under a not-yet-existing folder', async () => {
      const h = await makeHarness();

      await h.reconciler.apply(PROJECT_ID, [added('chapters/intro.adoc', '== Intro\n')]);

      const nodes = await h.fileNodeRepo.findByProjectId(PROJECT_ID);
      const folder = nodes.find((n) => n.path.value === '/chapters');
      expect(folder).toBeDefined();
      expect(folder!.type.value).toBe('folder');
      const file = nodes.find((n) => n.path.value === '/chapters/intro.adoc');
      expect(file!.parentId!.value).toBe(folder!.id.value);
    });

    it('lands into an existing FILE node and reports a single applied added_path_occupied anomaly', async () => {
      const h = await makeHarness();
      await seedDocument(h, 'intro.adoc', '= Old\n');

      const result = await h.reconciler.apply(PROJECT_ID, [added('intro.adoc', '= New\n')]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.anomalies).toHaveLength(1);
      const [anomaly] = result.value.anomalies;
      expect(anomaly.kind).toBe('added_path_occupied');
      expect(anomaly.applied).toBe(true);
      expect(anomaly.path).toBe('intro.adoc');
      // The content was updated in place — no duplicate node minted at the path.
      const nodes = await h.fileNodeRepo.findByProjectId(PROJECT_ID);
      const atPath = nodes.filter((n) => n.path.value === '/intro.adoc');
      expect(atPath).toHaveLength(1);
      expect((await h.fileStore.read(PROJECT_ID, FilePath.create('/intro.adoc')))!.toString('utf8')).toBe('= New\n');
      expect(result.value.changedPaths).toContain('intro.adoc');
    });

    it('drops the content with a single applied=false anomaly when a FOLDER occupies the added path', async () => {
      const h = await makeHarness();
      const folder = new FileNode(
        FileNodeId.create(randomUUID()),
        PROJECT_ID,
        h.rootFolderId,
        'docs',
        FileNodeType.create('folder'),
        FilePath.create('/docs'),
      );
      await h.fileNodeRepo.save(folder);

      const result = await h.reconciler.apply(PROJECT_ID, [added('docs', '= Oops\n')]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // Exactly ONE anomaly — no optimistic "updated in place" push before landContent decided the
      // folder outcome, so the change is not double-counted with contradictory applied flags.
      expect(result.value.anomalies).toHaveLength(1);
      const [anomaly] = result.value.anomalies;
      expect(anomaly.kind).toBe('content_dropped_folder_occupies_path');
      expect(anomaly.applied).toBe(false);
      expect(anomaly.path).toBe('docs');
      // A truthful recovery message: the content could not land and the user must reconcile the collision.
      expect(anomaly.message).toContain('folder occupies that path');
      expect(anomaly.message).toContain('dropped');
      // The drift total counts this change exactly once.
      const summary = buildGitDriftSummary(result.value.anomalies);
      expect(summary).not.toBeNull();
      expect(summary!.total).toBe(1);
      expect(summary!.droppedCount).toBe(1);
      // No file bytes were written onto the folder path, and the folder is left untouched.
      expect(await h.fileStore.read(PROJECT_ID, FilePath.create('/docs'))).toBeNull();
      const nodes = await h.fileNodeRepo.findByProjectId(PROJECT_ID);
      const atPath = nodes.filter((n) => n.path.value === '/docs');
      expect(atPath).toHaveLength(1);
      expect(atPath[0]!.type.value).toBe('folder');
      expect(result.value.changedPaths).not.toContain('docs');
    });

    it('drops with a single applied=false anomaly when binary content targets an occupied OPEN document', async () => {
      // Drift: a live Document row sits on a binary-named FILE node (e.g. a prior demoting rename kept
      // it open). An added change carrying binary bytes must NOT pair the optimistic added_path_occupied
      // applied:true with landContent's binary-drop — one change must yield exactly ONE truthful anomaly.
      const h = await makeHarness();
      const bytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF]);
      const nodeId = FileNodeId.create(randomUUID());
      const node = new FileNode(nodeId, PROJECT_ID, h.rootFolderId, 'logo.png', FileNodeType.create('file'), FilePath.create('/logo.png'));
      await h.fileNodeRepo.save(node);
      await h.fileStore.write(PROJECT_ID, node.path, Buffer.from('old'));
      const document = new Document(
        DocumentId.create(randomUUID()),
        nodeId,
        ContentId.create(randomUUID()),
        YjsStateId.create(randomUUID()),
        MimeType.create('image/png'),
      );
      await h.documentRepo.save(document);
      await h.sessionRepo.open(PROJECT_ID, document.id);

      const result = await h.reconciler.apply(PROJECT_ID, [
        { type: 'added', path: 'logo.png', content: bytes, mimeType: 'image/png' },
      ]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // Exactly ONE anomaly — the drop, never also a contradictory added_path_occupied applied:true.
      expect(result.value.anomalies).toHaveLength(1);
      const [anomaly] = result.value.anomalies;
      expect(anomaly.kind).toBe('content_dropped_binary_open_document');
      expect(anomaly.applied).toBe(false);
      expect(anomaly.path).toBe('logo.png');
      // The room text was never overwritten from the binary bytes.
      expect(h.writer.contentFor(PROJECT_ID, document.yjsStateId)).toBeUndefined();
      // The drift total counts this change exactly once, as dropped.
      const summary = buildGitDriftSummary(result.value.anomalies);
      expect(summary).not.toBeNull();
      expect(summary!.total).toBe(1);
      expect(summary!.droppedCount).toBe(1);
      // The bytes were NOT written to disk — the pre-existing content is untouched, so a later
      // writeback from the still-open room cannot clobber pulled bytes that were never landed.
      expect(await h.fileStore.read(PROJECT_ID, node.path)).toEqual(Buffer.from('old'));
      expect(result.value.changedPaths).not.toContain('logo.png');
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

    it('does NOT write binary bytes into the live room for a modified change on an active binary-named doc', async () => {
      // Drift: an active Document row exists on a binary-named node (e.g. a prior demoting rename left
      // it live). A modified change carrying binary bytes must never be decoded as UTF-8 into the room.
      const h = await makeHarness();
      const bytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF]);
      const nodeId = FileNodeId.create(randomUUID());
      const node = new FileNode(nodeId, PROJECT_ID, h.rootFolderId, 'logo.png', FileNodeType.create('file'), FilePath.create('/logo.png'));
      await h.fileNodeRepo.save(node);
      await h.fileStore.write(PROJECT_ID, node.path, Buffer.from('old'));
      const document = new Document(
        DocumentId.create(randomUUID()),
        nodeId,
        ContentId.create(randomUUID()),
        YjsStateId.create(randomUUID()),
        MimeType.create('image/png'),
      );
      await h.documentRepo.save(document);
      await h.sessionRepo.open(PROJECT_ID, document.id);

      const result = await h.reconciler.apply(PROJECT_ID, [
        { type: 'modified', path: 'logo.png', content: bytes, mimeType: 'image/png' },
      ]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // The live text was left untouched: nothing was written into the open room.
      expect(h.writer.contentFor(PROJECT_ID, document.yjsStateId)).toBeUndefined();
      // Exactly one truthful applied:false anomaly.
      expect(result.value.anomalies).toHaveLength(1);
      const [anomaly] = result.value.anomalies;
      expect(anomaly.kind).toBe('content_dropped_binary_open_document');
      expect(anomaly.applied).toBe(false);
      expect(anomaly.path).toBe('logo.png');
      // The bytes were NOT written to disk — the pre-existing content is untouched, so a later
      // writeback from the still-open room cannot clobber pulled bytes that were never landed.
      expect(await h.fileStore.read(PROJECT_ID, node.path)).toEqual(Buffer.from('old'));
      expect(result.value.changedPaths).not.toContain('logo.png');
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

    it('skips the removal (folder + child preserved) with a benign applied anomaly when a FOLDER occupies the removed path', async () => {
      // Drift: git reports `docs` removed as a FILE, but a FOLDER (with a child file) sits at /docs
      // locally. FileNodeRepository.delete has no cascade, so deleting the folder would orphan its
      // children or throw — the removal must be skipped, preserving the folder and its contents.
      const h = await makeHarness();
      const folderId = FileNodeId.create(randomUUID());
      const folder = new FileNode(folderId, PROJECT_ID, h.rootFolderId, 'docs', FileNodeType.create('folder'), FilePath.create('/docs'));
      await h.fileNodeRepo.save(folder);
      const childId = FileNodeId.create(randomUUID());
      const child = new FileNode(childId, PROJECT_ID, folderId, 'intro.adoc', FileNodeType.create('file'), FilePath.create('/docs/intro.adoc'));
      await h.fileNodeRepo.save(child);
      await h.fileStore.write(PROJECT_ID, child.path, Buffer.from('= Intro\n', 'utf8'));

      const result = await h.reconciler.apply(PROJECT_ID, [removed('docs')]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // Neither the folder nor its child was deleted.
      expect(await h.fileNodeRepo.findById(folderId)).not.toBeNull();
      expect(await h.fileNodeRepo.findById(childId)).not.toBeNull();
      // Exactly ONE benign, applied anomaly — nothing was lost, so nothing needs recovery.
      expect(result.value.anomalies).toHaveLength(1);
      const [anomaly] = result.value.anomalies;
      expect(anomaly.kind).toBe('removed_path_occupied_by_folder');
      expect(anomaly.applied).toBe(true);
      expect(anomaly.path).toBe('docs');
      expect(anomaly.message).toContain('a folder occupies that path');
      expect(h.logger.warn).toHaveBeenCalled();
      // A lossless (all-applied) pull surfaces no user-facing drift summary.
      expect(buildGitDriftSummary(result.value.anomalies)).toBeNull();
      // Nothing changed on disk: the path is not reported as changed.
      expect(result.value.changedPaths).not.toContain('docs');
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

  describe('rename reclassification', () => {
    it('converts an Asset to a Document when a rename changes the name to an AsciiDoc file', async () => {
      const h = await makeHarness();
      const assetNode = await seedAsset(h, 'notes.txt', Buffer.from('plain notes'));

      const result = await h.reconciler.apply(PROJECT_ID, [renamed('notes.txt', 'notes.adoc', '= Notes\n')]);

      expect(result.success).toBe(true);
      // The row now classifies as a co-editable Document; the old Asset row is gone.
      expect(await h.documentRepo.findByFileNodeId(assetNode.id)).not.toBeNull();
      expect(await h.assetRepo.findById(assetNode.id)).toBeNull();
    });

    it('converts a Document to an Asset when a rename changes the name to a non-AsciiDoc file', async () => {
      const h = await makeHarness();
      const { node } = await seedDocument(h, 'diagram.adoc', '= Diagram\n');

      const result = await h.reconciler.apply(PROJECT_ID, [renamed('diagram.adoc', 'diagram.png', 'binary-ish', 'image/png')]);

      expect(result.success).toBe(true);
      expect(await h.documentRepo.findByFileNodeId(node.id)).toBeNull();
      expect(await h.assetRepo.findById(node.id)).not.toBeNull();
    });

    it('skips the whole rename (nothing mutates) when a demoting rename would drop content into an active document', async () => {
      const h = await makeHarness();
      const { node, document } = await seedDocument(h, 'diagram.adoc', '= Diagram\n');
      await h.sessionRepo.open(PROJECT_ID, document.id);

      const result = await h.reconciler.apply(PROJECT_ID, [renamed('diagram.adoc', 'diagram.png', '= Still Live\n', 'image/png')]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // The drop is decided BEFORE any mutation, so the rename is skipped whole: the node stays at the
      // source path (NOT moved to /diagram.png)...
      const stillNode = await h.fileNodeRepo.findById(node.id);
      expect(stillNode!.path.value).toBe('/diagram.adoc');
      expect(stillNode!.name).toBe('diagram.adoc');
      // ...the same Document row survives untouched, and no Asset row was minted in its place...
      const stillDocument = await h.documentRepo.findByFileNodeId(node.id);
      expect(stillDocument?.id.value).toBe(document.id.value);
      expect(await h.assetRepo.findById(node.id)).toBeNull();
      // ...nothing is written into the room...
      expect(h.writer.contentFor(PROJECT_ID, document.yjsStateId)).toBeUndefined();
      // ...and exactly ONE truthful applied:false anomaly is recorded for the destination.
      expect(result.value.anomalies).toHaveLength(1);
      const [anomaly] = result.value.anomalies;
      expect(anomaly.kind).toBe('content_dropped_binary_open_document');
      expect(anomaly.applied).toBe(false);
      expect(anomaly.path).toBe('diagram.png');
      expect(h.logger.warn).toHaveBeenCalled();
      // The source bytes were NOT relocated: the original content stays at the source path, and nothing
      // was ever written at the destination path.
      expect((await h.fileStore.read(PROJECT_ID, FilePath.create('/diagram.adoc')))!.toString('utf8')).toBe('= Diagram\n');
      expect(await h.fileStore.read(PROJECT_ID, FilePath.create('/diagram.png'))).toBeNull();
      expect(result.value.changedPaths).not.toContain('diagram.png');
    });

    it('skips the whole rename when a rename demotes an active doc to a binary type (nothing moves or mutates)', async () => {
      // Repro: an OPEN AsciiDoc file is renamed to a binary type with binary content. The drop is
      // decided BEFORE any mutation, so the node is NOT moved, the live Document row is left in place at
      // the source, no bytes are relocated, and the reported result is consistent (applied:false, path
      // absent from changedPaths) — the persisted tree can never disagree with the reconcile result.
      const h = await makeHarness();
      const { node, document } = await seedDocument(h, 'notes.adoc', '= Notes\n');
      await h.sessionRepo.open(PROJECT_ID, document.id);
      const bytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF]);

      const result = await h.reconciler.apply(PROJECT_ID, [
        { type: 'renamed', fromPath: 'notes.adoc', toPath: 'logo.png', content: bytes, mimeType: 'image/png' },
      ]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // The live room content was never set from the binary bytes.
      expect(h.writer.contentFor(PROJECT_ID, document.yjsStateId)).toBeUndefined();
      // The node was NOT moved: it stays at the source path with its original name.
      const stillNode = await h.fileNodeRepo.findById(node.id);
      expect(stillNode!.path.value).toBe('/notes.adoc');
      expect(stillNode!.name).toBe('notes.adoc');
      // The Document row is untouched (open editors not orphaned).
      const keptDocument = await h.documentRepo.findByFileNodeId(node.id);
      expect(keptDocument?.id.value).toBe(document.id.value);
      // Exactly one truthful applied:false anomaly for the dropped binary content, keyed on the destination.
      expect(result.value.anomalies).toHaveLength(1);
      const [anomaly] = result.value.anomalies;
      expect(anomaly.kind).toBe('content_dropped_binary_open_document');
      expect(anomaly.applied).toBe(false);
      expect(anomaly.path).toBe('logo.png');
      expect(anomaly.message).toContain('Close the document');
      // The source bytes were NOT relocated: the original text stays at the source path, and nothing was
      // ever written at the destination path — the still-open room owns notes.adoc and keeps writing it back.
      expect(await h.fileStore.read(PROJECT_ID, FilePath.create('/logo.png'))).toBeNull();
      expect((await h.fileStore.read(PROJECT_ID, FilePath.create('/notes.adoc')))!.toString('utf8')).toBe('= Notes\n');
      expect(result.value.changedPaths).not.toContain('logo.png');
    });

    it('deletes the Document row for a demoting rename when the document has no open room', async () => {
      const h = await makeHarness();
      const { node, document } = await seedDocument(h, 'diagram.adoc', '= Diagram\n');

      const result = await h.reconciler.apply(PROJECT_ID, [renamed('diagram.adoc', 'diagram.png', 'binary-ish', 'image/png')]);

      expect(result.success).toBe(true);
      // No open room, so the demotion proceeds: Document row gone, Asset row minted.
      expect(await h.documentRepo.findByFileNodeId(node.id)).toBeNull();
      expect(await h.documentRepo.findById(document.id)).toBeNull();
      expect(await h.assetRepo.findById(node.id)).not.toBeNull();
    });

    it('leaves the row type untouched for a same-category rename', async () => {
      const h = await makeHarness();
      const { node, document } = await seedDocument(h, 'intro.adoc', '= Intro\n');

      const result = await h.reconciler.apply(PROJECT_ID, [renamed('intro.adoc', 'chapter.adoc', '= Chapter\n')]);

      expect(result.success).toBe(true);
      const stillDocument = await h.documentRepo.findByFileNodeId(node.id);
      // Same Document row (same id), not deleted-and-recreated.
      expect(stillDocument?.id.value).toBe(document.id.value);
    });
  });

  describe('missing-node drift', () => {
    it('treats a modified change with no existing node as an added file and warns', async () => {
      const h = await makeHarness();

      const result = await h.reconciler.apply(PROJECT_ID, [modified('ghost.adoc', '= Ghost\n')]);

      expect(result.success).toBe(true);
      const nodes = await h.fileNodeRepo.findByProjectId(PROJECT_ID);
      const node = nodes.find((n) => n.path.value === '/ghost.adoc');
      expect(node).toBeDefined();
      expect(await h.documentRepo.findByFileNodeId(node!.id)).not.toBeNull();
      expect((await h.fileStore.read(PROJECT_ID, node!.path))!.toString('utf8')).toBe('= Ghost\n');
      expect(h.logger.warn).toHaveBeenCalled();
    });

    it('treats a renamed change whose source node is missing as an added file at the target and warns', async () => {
      const h = await makeHarness();

      const result = await h.reconciler.apply(PROJECT_ID, [renamed('gone.adoc', 'here.adoc', '= Here\n')]);

      expect(result.success).toBe(true);
      const nodes = await h.fileNodeRepo.findByProjectId(PROJECT_ID);
      const node = nodes.find((n) => n.path.value === '/here.adoc');
      expect(node).toBeDefined();
      expect((await h.fileStore.read(PROJECT_ID, node!.path))!.toString('utf8')).toBe('= Here\n');
      expect(h.logger.warn).toHaveBeenCalled();
    });

    it('updates the existing destination node (no duplicate) when a renamed source is missing but the target already exists', async () => {
      const h = await makeHarness();
      const { node } = await seedDocument(h, 'here.adoc', '= Old\n');

      const result = await h.reconciler.apply(PROJECT_ID, [renamed('gone.adoc', 'here.adoc', '= New\n')]);

      expect(result.success).toBe(true);
      const allNodes = await h.fileNodeRepo.findByProjectId(PROJECT_ID);
      const atDestination = allNodes.filter((n) => n.path.value === '/here.adoc');
      // Exactly one node at the destination — the pre-existing one, updated in place, never a second.
      expect(atDestination).toHaveLength(1);
      expect(atDestination[0]!.id.value).toBe(node.id.value);
      const stored = await h.fileStore.read(PROJECT_ID, node.path);
      expect(stored!.toString('utf8')).toBe('= New\n');
      expect(h.logger.warn).toHaveBeenCalled();
    });

    it('reports a single applied renamed_source_missing_dest_exists when the destination node is a FILE', async () => {
      const h = await makeHarness();
      await seedDocument(h, 'here.adoc', '= Old\n');

      const result = await h.reconciler.apply(PROJECT_ID, [renamed('gone.adoc', 'here.adoc', '= New\n')]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // The file-destination case still reports exactly one optimistic in-place anomaly.
      expect(result.value.anomalies).toHaveLength(1);
      const [anomaly] = result.value.anomalies;
      expect(anomaly.kind).toBe('renamed_source_missing_dest_exists');
      expect(anomaly.applied).toBe(true);
      expect(anomaly.path).toBe('here.adoc');
    });

    it('drops with a single applied=false anomaly when a source-missing rename lands binary content onto an occupied OPEN document', async () => {
      // Drift: the rename source has no node, but the destination is a binary-named FILE holding a live
      // Document row (open room). The optimistic renamed_source_missing_dest_exists applied:true must NOT
      // be paired with landContent's binary-drop — one change must yield exactly ONE truthful anomaly.
      const h = await makeHarness();
      const bytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF]);
      const nodeId = FileNodeId.create(randomUUID());
      const node = new FileNode(nodeId, PROJECT_ID, h.rootFolderId, 'logo.png', FileNodeType.create('file'), FilePath.create('/logo.png'));
      await h.fileNodeRepo.save(node);
      await h.fileStore.write(PROJECT_ID, node.path, Buffer.from('old'));
      const document = new Document(
        DocumentId.create(randomUUID()),
        nodeId,
        ContentId.create(randomUUID()),
        YjsStateId.create(randomUUID()),
        MimeType.create('image/png'),
      );
      await h.documentRepo.save(document);
      await h.sessionRepo.open(PROJECT_ID, document.id);

      const result = await h.reconciler.apply(PROJECT_ID, [
        { type: 'renamed', fromPath: 'gone.png', toPath: 'logo.png', content: bytes, mimeType: 'image/png' },
      ]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // Exactly ONE anomaly — the drop, never also a contradictory renamed_source_missing_dest_exists.
      expect(result.value.anomalies).toHaveLength(1);
      const [anomaly] = result.value.anomalies;
      expect(anomaly.kind).toBe('content_dropped_binary_open_document');
      expect(anomaly.applied).toBe(false);
      expect(anomaly.path).toBe('logo.png');
      // The room text was never overwritten from the binary bytes.
      expect(h.writer.contentFor(PROJECT_ID, document.yjsStateId)).toBeUndefined();
      // The drift total counts this change exactly once, as dropped.
      const summary = buildGitDriftSummary(result.value.anomalies);
      expect(summary).not.toBeNull();
      expect(summary!.total).toBe(1);
      expect(summary!.droppedCount).toBe(1);
      // The bytes were NOT written to disk — the pre-existing content is untouched, so a later
      // writeback from the still-open room cannot clobber pulled bytes that were never landed.
      expect(await h.fileStore.read(PROJECT_ID, node.path)).toEqual(Buffer.from('old'));
      expect(result.value.changedPaths).not.toContain('logo.png');
    });

    it('drops the content with a single applied=false anomaly when a FOLDER occupies the renamed destination', async () => {
      const h = await makeHarness();
      const folder = new FileNode(
        FileNodeId.create(randomUUID()),
        PROJECT_ID,
        h.rootFolderId,
        'docs',
        FileNodeType.create('folder'),
        FilePath.create('/docs'),
      );
      await h.fileNodeRepo.save(folder);

      const result = await h.reconciler.apply(PROJECT_ID, [renamed('gone.adoc', 'docs', '= Oops\n')]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // Exactly ONE anomaly — no optimistic "updated in place" push before landContent decided the
      // folder outcome, so the change is not double-counted with contradictory applied flags.
      expect(result.value.anomalies).toHaveLength(1);
      const [anomaly] = result.value.anomalies;
      expect(anomaly.kind).toBe('content_dropped_folder_occupies_path');
      expect(anomaly.applied).toBe(false);
      expect(anomaly.path).toBe('docs');
      // The drift total counts this change exactly once, as a dropped change.
      const summary = buildGitDriftSummary(result.value.anomalies);
      expect(summary).not.toBeNull();
      expect(summary!.total).toBe(1);
      expect(summary!.droppedCount).toBe(1);
      // No file bytes were written onto the folder path, and the folder is left untouched.
      expect(await h.fileStore.read(PROJECT_ID, FilePath.create('/docs'))).toBeNull();
      const nodes = await h.fileNodeRepo.findByProjectId(PROJECT_ID);
      const atPath = nodes.filter((n) => n.path.value === '/docs');
      expect(atPath).toHaveLength(1);
      expect(atPath[0]!.type.value).toBe('folder');
      expect(result.value.changedPaths).not.toContain('docs');
    });

    it('updates the existing node (no duplicate) when an added change targets a path that already has one', async () => {
      const h = await makeHarness();
      const { node } = await seedDocument(h, 'dupe.adoc', '= Old\n');

      const result = await h.reconciler.apply(PROJECT_ID, [added('dupe.adoc', '= New\n')]);

      expect(result.success).toBe(true);
      const allNodes = await h.fileNodeRepo.findByProjectId(PROJECT_ID);
      const atPath = allNodes.filter((n) => n.path.value === '/dupe.adoc');
      // Exactly one node at the path — the pre-existing one, updated in place, never a second.
      expect(atPath).toHaveLength(1);
      expect(atPath[0]!.id.value).toBe(node.id.value);
      const stored = await h.fileStore.read(PROJECT_ID, node.path);
      expect(stored!.toString('utf8')).toBe('= New\n');
      expect(h.logger.warn).toHaveBeenCalled();
    });

    it('skips landing content onto a path held by a folder node, warning rather than corrupting the tree', async () => {
      const h = await makeHarness();
      const folder = new FileNode(
        FileNodeId.create(randomUUID()),
        PROJECT_ID,
        h.rootFolderId,
        'docs',
        FileNodeType.create('folder'),
        FilePath.create('/docs'),
      );
      await h.fileNodeRepo.save(folder);

      const result = await h.reconciler.apply(PROJECT_ID, [modified('docs', '= Oops\n')]);

      expect(result.success).toBe(true);
      // No file bytes were written onto the folder path.
      expect(await h.fileStore.read(PROJECT_ID, FilePath.create('/docs'))).toBeNull();
      expect(h.logger.warn).toHaveBeenCalled();
      // Still exactly one node at the path — the folder, untouched.
      const allNodes = await h.fileNodeRepo.findByProjectId(PROJECT_ID);
      const atPath = allNodes.filter((n) => n.path.value === '/docs');
      expect(atPath).toHaveLength(1);
      expect(atPath[0]!.type.value).toBe('folder');
    });

    it('no-ops a removed change whose node is missing and warns', async () => {
      const h = await makeHarness();

      const result = await h.reconciler.apply(PROJECT_ID, [removed('never.adoc')]);

      expect(result.success).toBe(true);
      expect(h.logger.warn).toHaveBeenCalled();
    });
  });

  describe('anomalies', () => {
    it('reports no anomalies on a clean apply', async () => {
      const h = await makeHarness();
      await seedDocument(h, 'edit.adoc', '= Edit\n');

      const result = await h.reconciler.apply(PROJECT_ID, [modified('edit.adoc', '= Edited\n')]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.anomalies).toEqual([]);
    });

    it('reports a dropped anomaly (applied=false) when content targets a folder path', async () => {
      const h = await makeHarness();
      const folder = new FileNode(
        FileNodeId.create(randomUUID()),
        PROJECT_ID,
        h.rootFolderId,
        'docs',
        FileNodeType.create('folder'),
        FilePath.create('/docs'),
      );
      await h.fileNodeRepo.save(folder);

      const result = await h.reconciler.apply(PROJECT_ID, [modified('docs', '= Oops\n')]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.anomalies).toHaveLength(1);
      const [anomaly] = result.value.anomalies;
      expect(anomaly.kind).toBe('content_dropped_folder_occupies_path');
      expect(anomaly.applied).toBe(false);
      expect(anomaly.path).toBe('docs');
      // The message carries a recovery instruction for the user who has no log access.
      expect(anomaly.message).toContain('folder occupies that path');
    });

    it('reports an applied anomaly for a modified change whose node is missing', async () => {
      const h = await makeHarness();

      const result = await h.reconciler.apply(PROJECT_ID, [modified('ghost.adoc', '= Ghost\n')]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.anomalies).toEqual([
        expect.objectContaining({ kind: 'modified_missing_node', applied: true, path: 'ghost.adoc' }),
      ]);
    });

    it('reports a no-op anomaly (applied=true) for a removed change whose node is missing', async () => {
      const h = await makeHarness();

      const result = await h.reconciler.apply(PROJECT_ID, [removed('never.adoc')]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.anomalies).toEqual([
        expect.objectContaining({ kind: 'removed_missing_node', applied: true, path: 'never.adoc' }),
      ]);
    });

    it('surfaces the folder drop within a mixed batch while landing the rest', async () => {
      const h = await makeHarness();
      await seedDocument(h, 'edit.adoc', '= Edit\n');
      const folder = new FileNode(
        FileNodeId.create(randomUUID()),
        PROJECT_ID,
        h.rootFolderId,
        'docs',
        FileNodeType.create('folder'),
        FilePath.create('/docs'),
      );
      await h.fileNodeRepo.save(folder);

      const result = await h.reconciler.apply(PROJECT_ID, [
        modified('edit.adoc', '= Edited\n'),
        modified('docs', '= Oops\n'),
      ]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      const dropped = result.value.anomalies.filter((anomaly) => !anomaly.applied);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]!.kind).toBe('content_dropped_folder_occupies_path');
      // The clean change still landed.
      expect((await h.fileStore.read(PROJECT_ID, FilePath.create('/edit.adoc')))!.toString('utf8')).toBe('= Edited\n');
      // The dropped path is NOT reported as changed — changedPaths lists only files that actually changed.
      expect(result.value.changedPaths).toContain('edit.adoc');
      expect(result.value.changedPaths).not.toContain('docs');
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

  describe('ancestor path drift', () => {
    it('drops an added change (one applied=false anomaly) when a FILE occupies an ancestor path', async () => {
      const h = await makeHarness();
      // '/a' already exists as a FILE; a pulled 'a/b.txt' must not be parented under it.
      await seedAsset(h, 'a', Buffer.from('i am a file, not a folder'));

      const result = await h.reconciler.apply(PROJECT_ID, [added('a/b.txt', '= Nope\n')]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // Exactly one truthful applied:false collision anomaly.
      expect(result.value.anomalies).toHaveLength(1);
      const [anomaly] = result.value.anomalies;
      expect(anomaly.kind).toBe('content_dropped_file_occupies_ancestor_path');
      expect(anomaly.applied).toBe(false);
      expect(anomaly.path).toBe('a');
      // No node was parented under the file — the tree is not corrupted.
      const nodes = await h.fileNodeRepo.findByProjectId(PROJECT_ID);
      expect(nodes.some((n) => n.path.value === '/a/b.txt')).toBe(false);
      const atA = nodes.filter((n) => n.path.value === '/a');
      expect(atA).toHaveLength(1);
      expect(atA[0]!.type.value).toBe('file');
      expect(result.value.changedPaths).not.toContain('a/b.txt');
      // The drift total counts this change exactly once, as dropped.
      const summary = buildGitDriftSummary(result.value.anomalies);
      expect(summary!.total).toBe(1);
      expect(summary!.droppedCount).toBe(1);
    });

    it('does not double-count when a modified-missing change hits an ancestor file collision', async () => {
      const h = await makeHarness();
      await seedAsset(h, 'a', Buffer.from('file'));

      const result = await h.reconciler.apply(PROJECT_ID, [modified('a/b.txt', '= Nope\n')]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // Only the collision anomaly — never also a modified_missing_node applied:true for the same change.
      expect(result.value.anomalies).toHaveLength(1);
      expect(result.value.anomalies[0]!.kind).toBe('content_dropped_file_occupies_ancestor_path');
    });

    it('does not hang and fails clearly when the project root is absent (empty segments)', async () => {
      const h = await makeHarness();
      // Remove the root '/' node so ensureFolder's empty-segments path cannot find it. The old code
      // recursed forever here; the guard must resolve or fail fast (jest's default timeout catches a hang).
      await h.fileNodeRepo.delete(h.rootFolderId);

      await expect(h.reconciler.apply(PROJECT_ID, [added('intro.adoc', '= Intro\n')])).rejects.toThrow();
    });

    it('resolves empty segments to the root by its null parent even when it is not keyed at "/"', async () => {
      const h = await makeHarness();
      // A root whose recorded path is not literally '/' still resolves via its null parentId.
      await h.fileNodeRepo.delete(h.rootFolderId);
      const oddRoot = new FileNode(
        FileNodeId.create(randomUUID()),
        PROJECT_ID,
        null,
        'root',
        FileNodeType.create('folder'),
        FilePath.create('/workspace'),
      );
      await h.fileNodeRepo.save(oddRoot);

      const result = await h.reconciler.apply(PROJECT_ID, [added('intro.adoc', '= Intro\n')]);

      expect(result.success).toBe(true);
      const nodes = await h.fileNodeRepo.findByProjectId(PROJECT_ID);
      const file = nodes.find((n) => n.path.value === '/intro.adoc');
      expect(file!.parentId!.value).toBe(oddRoot.id.value);
    });
  });
});
