import { ReplaceProjectContentUseCase } from '../../../src/use-cases/content/replace-project-content';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryProjectFileStore } from '../../ports/storage/in-memory-project-file-store';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryRegexEngine } from '../../ports/text/in-memory-regex-engine';
import { InMemoryStructuredCollaborativeEditor } from '../../ports/storage/in-memory-structured-collaborative-editor';
import { FileNode } from '../../../src/entities/file-node';
import { ProjectMember } from '../../../src/entities/project-member';
import { Document } from '../../../src/entities/document';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { DocumentId } from '../../../src/value-objects/ids/document-id';
import { ContentId } from '../../../src/value-objects/ids/content-id';
import { YjsStateId } from '../../../src/value-objects/ids/yjs-state-id';
import { MimeType } from '../../../src/value-objects/files/mime-type';
import { Role } from '../../../src/value-objects/identity/role';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { ValidationError } from '../../../src/errors/common/validation-error';
import { AUDIT_PROJECT_CONTENT_REPLACED } from '../../../src/audit-actions';
import type { ReplaceProjectContentInput } from '../../../src/use-cases/content/replace-project-content';
import type { SearchQuery } from '../../../src/types/search';
import type { StructuredCollaborativeEditor } from '../../../src/ports/storage/structured-collaborative-editor';
import type { Logger } from '../../../src/ports/observability/logger';
import type { Result } from '../../../src/types/result';

const editorId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const viewerId = UserId.create('660e8400-e29b-41d4-a716-446655440002');
const projectId = ProjectId.create('880e8400-e29b-41d4-a716-446655440004');
const rootId = FileNodeId.create('990e8400-e29b-41d4-a716-446655440005');
const liveFileId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');
const dormantFileId = FileNodeId.create('bb0e8400-e29b-41d4-a716-446655440007');
const liveYjs = YjsStateId.create('cc0e8400-e29b-41d4-a716-446655440008');

const literal = (text: string): SearchQuery => ({ text, mode: 'literal', caseSensitive: true, wholeWord: false });

const input = (over: Partial<ReplaceProjectContentInput>): ReplaceProjectContentInput => ({
  query: literal('foo'),
  replacement: 'bar',
  scope: 'project',
  files: [],
  ...over,
});

describe('ReplaceProjectContentUseCase', () => {
  let memberRepo: InMemoryProjectMemberRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let fileStore: InMemoryProjectFileStore;
  let documentRepo: InMemoryDocumentRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let engine: InMemoryRegexEngine;
  let structured: InMemoryStructuredCollaborativeEditor;
  let useCase: ReplaceProjectContentUseCase;

  beforeEach(async () => {
    memberRepo = new InMemoryProjectMemberRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    fileStore = new InMemoryProjectFileStore();
    documentRepo = new InMemoryDocumentRepository();
    auditRepo = new InMemoryAuditLogRepository();
    engine = new InMemoryRegexEngine();
    structured = new InMemoryStructuredCollaborativeEditor(engine);
    useCase = new ReplaceProjectContentUseCase(memberRepo, fileNodeRepo, fileStore, auditRepo, engine, structured, documentRepo);

    await fileNodeRepo.save(new FileNode(rootId, projectId, null, 'Root', FileNodeType.create('folder'), FilePath.create('/')));
    await fileNodeRepo.save(new FileNode(liveFileId, projectId, rootId, 'live.adoc', FileNodeType.create('file'), FilePath.create('/live.adoc')));
    await fileNodeRepo.save(new FileNode(dormantFileId, projectId, rootId, 'dormant.adoc', FileNodeType.create('file'), FilePath.create('/dormant.adoc')));
    // The live file is backed by a Document (collab room); its live content lives in the structured editor.
    await documentRepo.save(new Document(
      DocumentId.create('22222222-e29b-41d4-a716-446655440222'),
      liveFileId,
      ContentId.create('33333333-e29b-41d4-a716-446655440333'),
      liveYjs,
      MimeType.create('text/asciidoc'),
    ));
    structured.seed(liveYjs, 'foo and foo');
    // The dormant file has no Document — only a file-store projection.
    await fileStore.write(projectId, FilePath.create('/dormant.adoc'), Buffer.from('foo dormant'));
    await memberRepo.addMember(new ProjectMember(projectId, editorId, Role.create('editor'), new Date()));
    await memberRepo.addMember(new ProjectMember(projectId, viewerId, Role.create('viewer'), new Date()));
  });

  it('denies a viewer and audit-logs the denial', async () => {
    const result = await useCase.execute(viewerId, projectId, input({ files: [{ fileNodeId: liveFileId, selections: [{ ordinal: 0, expectedText: 'foo' }] }] }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(PermissionDeniedError);
    const denials = await auditRepo.findAll();
    expect(denials.some((l) => l.action === 'authz.denied')).toBe(true);
  });

  it('replaces confirmed selections in an open (document-backed) file via the structured editor', async () => {
    const result = await useCase.execute(editorId, projectId, input({
      files: [{ fileNodeId: liveFileId, selections: [{ ordinal: 0, expectedText: 'foo' }, { ordinal: 1, expectedText: 'foo' }] }],
    }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toMatchObject({ replacedCount: 2, affectedFiles: 1, skipped: [] });
    expect(structured.contentOf(liveYjs)).toBe('bar and bar');
  });

  it('replaces in a dormant (no-Document) file via the file store', async () => {
    const result = await useCase.execute(editorId, projectId, input({
      files: [{ fileNodeId: dormantFileId, selections: [{ ordinal: 0, expectedText: 'foo' }] }],
    }));
    if (!result.success) return;
    expect(result.value.replacedCount).toBe(1);
    expect((await fileStore.read(projectId, FilePath.create('/dormant.adoc')))!.toString('utf8')).toBe('bar dormant');
  });

  it('skips a file whose live content diverged (0 applied)', async () => {
    structured.seed(liveYjs, 'nothing here'); // no "foo" anymore
    const result = await useCase.execute(editorId, projectId, input({
      files: [{ fileNodeId: liveFileId, selections: [{ ordinal: 0, expectedText: 'foo' }] }],
    }));
    if (!result.success) return;
    expect(result.value.replacedCount).toBe(0);
    expect(result.value.skipped).toEqual([{ fileNodeId: liveFileId, reason: 'diverged' }]);
  });

  it('rejects an invalid regex pattern', async () => {
    const result = await useCase.execute(editorId, projectId, input({ query: { ...literal('(bad'), mode: 'regex' }, files: [] }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('emits an absent capture-group reference literally rather than failing', async () => {
    structured.seed(liveYjs, 'wrap foo here');
    const result = await useCase.execute(editorId, projectId, input({
      query: { text: '(foo)', mode: 'regex', caseSensitive: true, wholeWord: false },
      replacement: '[$1|$5]',
      files: [{ fileNodeId: liveFileId, selections: [{ ordinal: 0, expectedText: 'foo' }] }],
    }));
    expect(result.success).toBe(true);
    // $1 → "foo"; $5 (no such group) stays literal.
    expect(structured.contentOf(liveYjs)).toBe('wrap [foo|$5] here');
  });

  it('ignores a file entry that confirms no selections', async () => {
    const result = await useCase.execute(editorId, projectId, input({
      files: [{ fileNodeId: liveFileId, selections: [] }],
    }));
    if (!result.success) return;
    expect(result.value).toMatchObject({ replacedCount: 0, affectedFiles: 0, skipped: [] });
    expect(structured.contentOf(liveYjs)).toBe('foo and foo');
  });

  it('refuses to edit a file node that does not belong to the project', async () => {
    const foreignFileId = FileNodeId.create('dd0e8400-e29b-41d4-a716-446655440009');
    const result = await useCase.execute(editorId, projectId, input({
      files: [{ fileNodeId: foreignFileId, selections: [{ ordinal: 0, expectedText: 'foo' }] }],
    }));
    if (!result.success) return;
    expect(result.value.replacedCount).toBe(0);
    expect(result.value.skipped).toEqual([{ fileNodeId: foreignFileId, reason: 'not-editable' }]);
  });

  it('skips and warns when the collaborative apply cannot be delivered', async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      warn(message): void {
        warnings.push(message);
      },
    };
    const unreachableEditor: StructuredCollaborativeEditor = {
      async applyStructuredReplacement(): Promise<Result<number, Error>> {
        return { success: false, error: new Error('collab room unreachable') };
      },
    };
    const withUnreachableEditor = new ReplaceProjectContentUseCase(
      memberRepo, fileNodeRepo, fileStore, auditRepo, engine, unreachableEditor, documentRepo, logger,
    );

    const result = await withUnreachableEditor.execute(editorId, projectId, input({
      files: [{ fileNodeId: liveFileId, selections: [{ ordinal: 0, expectedText: 'foo' }] }],
    }));
    if (!result.success) return;
    expect(result.value.replacedCount).toBe(0);
    expect(result.value.skipped).toEqual([{ fileNodeId: liveFileId, reason: 'not-editable' }]);
    expect(warnings).toHaveLength(1);
  });

  it('skips a dormant file whose confirmed text no longer matches the projection', async () => {
    const result = await useCase.execute(editorId, projectId, input({
      files: [{ fileNodeId: dormantFileId, selections: [{ ordinal: 0, expectedText: 'FOO' }] }],
    }));
    if (!result.success) return;
    expect(result.value.replacedCount).toBe(0);
    expect(result.value.skipped).toEqual([{ fileNodeId: dormantFileId, reason: 'stale' }]);
    expect((await fileStore.read(projectId, FilePath.create('/dormant.adoc')))!.toString('utf8')).toBe('foo dormant');
  });

  it('skips a file that has neither a document nor stored bytes', async () => {
    const ghostFileId = FileNodeId.create('ee0e8400-e29b-41d4-a716-44665544000a');
    await fileNodeRepo.save(new FileNode(ghostFileId, projectId, rootId, 'ghost.adoc', FileNodeType.create('file'), FilePath.create('/ghost.adoc')));

    const result = await useCase.execute(editorId, projectId, input({
      files: [{ fileNodeId: ghostFileId, selections: [{ ordinal: 0, expectedText: 'foo' }] }],
    }));
    if (!result.success) return;
    expect(result.value.skipped).toEqual([{ fileNodeId: ghostFileId, reason: 'not-editable' }]);
  });

  it('applies a regex capture-group substitution and records the audit entry', async () => {
    structured.seed(liveYjs, 'date 2026-07 here');
    const result = await useCase.execute(editorId, projectId, input({
      query: { text: String.raw`(\d{4})-(\d{2})`, mode: 'regex', caseSensitive: true, wholeWord: false },
      replacement: '$2/$1',
      files: [{ fileNodeId: liveFileId, selections: [{ ordinal: 0, expectedText: '2026-07' }] }],
    }));
    if (!result.success) return;
    expect(structured.contentOf(liveYjs)).toBe('date 07/2026 here');
    const logs = await auditRepo.findAll();
    const entry = logs.find((l) => l.action === AUDIT_PROJECT_CONTENT_REPLACED);
    expect(entry).toBeDefined();
    expect(entry?.metadata).toMatchObject({ scope: 'project', mode: 'regex', replacedCount: 1, affectedFiles: 1 });
  });
});
