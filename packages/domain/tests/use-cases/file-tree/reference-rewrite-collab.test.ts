import {
  rewriteReferencesForPathChanges,
  clearMainFileIfMatches,
  type ReferenceRewriteDeps,
} from '../../../src/use-cases/file-tree/reference-rewrite';
import { RenameFileUseCase } from '../../../src/use-cases/file-tree/rename-file';
import { MoveFileUseCase } from '../../../src/use-cases/file-tree/move-file';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryProjectFileStore } from '../../ports/storage/in-memory-project-file-store';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryProjectRepository } from '../../ports/project/in-memory-project.repository';
import { Document } from '../../../src/entities/document';
import { Project } from '../../../src/entities/project';
import { ProjectName } from '../../../src/value-objects/project/project-name';
import { FileNode } from '../../../src/entities/file-node';
import { ProjectMember } from '../../../src/entities/project-member';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { DocumentId } from '../../../src/value-objects/ids/document-id';
import { ContentId } from '../../../src/value-objects/ids/content-id';
import { YjsStateId } from '../../../src/value-objects/ids/yjs-state-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { MimeType } from '../../../src/value-objects/files/mime-type';
import { Role } from '../../../src/value-objects/identity/role';
import type { CollaborativeContentEditor, ContentReplacement } from '../../../src/ports/storage/collaborative-content-editor';
import type { CollaborativeContentReader } from '../../../src/ports/storage/collaborative-content-reader';
import type { Result } from '../../../src/types/result';

// Reference rewrite must treat the Yjs document as the source of truth for any referencing file
// that is a collaborative Document: it applies the corrected reference through the
// CollaborativeContentEditor port (live + persisted by the collab writeback) instead of writing
// the plain-text file store, which would be invisible to live editors and clobbered on writeback.

class FakeCollaborativeContentEditor implements CollaborativeContentEditor {
  calls: Array<{ yjsStateId: string; replacements: ContentReplacement[] }> = [];
  // Default: report each replacement as applied once. Override to force a failure / zero-applied.
  result?: Result<number, Error>;

  async applyReplacements(
    _projectId: ProjectId,
    yjsStateId: YjsStateId,
    replacements: ReadonlyArray<ContentReplacement>,
  ): Promise<Result<number, Error>> {
    this.calls.push({ yjsStateId: yjsStateId.value, replacements: [...replacements] });
    return this.result ?? { success: true, value: replacements.length };
  }
}

describe('rewriteReferencesForPathChanges — collaborative source of truth', () => {
  const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const rootId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');
  const bookId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');
  const bookPath = FilePath.create('/book.adoc');
  const BOOK = '= Book\n\ninclude::intro.adoc[]\n\nimage::intro.adoc[]\n';

  let fileNodeRepo: InMemoryFileNodeRepository;
  let fileStore: InMemoryProjectFileStore;
  let documentRepo: InMemoryDocumentRepository;
  let editor: FakeCollaborativeContentEditor;

  const pathChanges = new Map<string, string>([['intro.adoc', 'introduction.adoc']]);

  async function giveBookACollaborativeDocument(): Promise<YjsStateId> {
    const yjsStateId = YjsStateId.create('11111111-e29b-41d4-a716-446655440111');
    await documentRepo.save(
      new Document(
        DocumentId.create('22222222-e29b-41d4-a716-446655440222'),
        bookId,
        ContentId.create('33333333-e29b-41d4-a716-446655440333'),
        yjsStateId,
        MimeType.create('text/asciidoc'),
      ),
    );
    return yjsStateId;
  }

  beforeEach(async () => {
    fileNodeRepo = new InMemoryFileNodeRepository();
    fileStore = new InMemoryProjectFileStore();
    documentRepo = new InMemoryDocumentRepository();
    editor = new FakeCollaborativeContentEditor();

    await fileNodeRepo.save(new FileNode(rootId, projectId, null, 'Root', FileNodeType.create('folder'), FilePath.create('/')));
    await fileNodeRepo.save(new FileNode(bookId, projectId, rootId, 'book.adoc', FileNodeType.create('file'), bookPath));
    await fileStore.write(projectId, bookPath, Buffer.from(BOOK));
  });

  function deps(): ReferenceRewriteDeps {
    return { fileNodeRepo, fileStore, documentRepo, collaborativeContentEditor: editor };
  }

  it('routes the rewrite through the collaborative editor and leaves the file store untouched', async () => {
    const yjsStateId = await giveBookACollaborativeDocument();

    const result = await rewriteReferencesForPathChanges(deps(), projectId, pathChanges);

    expect(result.rewrittenFiles).toBe(1);
    expect(editor.calls).toHaveLength(1);
    expect(editor.calls[0].yjsStateId).toBe(yjsStateId.value);
    // The replacements, applied to the original content, produce the corrected references — this is
    // exactly how the collab server applies them to the live Y.Text (literal find→replace).
    let applied = BOOK;
    for (const { find, replace } of editor.calls[0].replacements) applied = applied.split(find).join(replace);
    expect(applied).toContain('include::introduction.adoc[]');
    expect(applied).toContain('image::introduction.adoc[]');
    expect(applied).not.toContain('intro.adoc');

    // The file store is NOT written: the collab server's writeback persists the Yjs source of truth.
    const onDisk = (await fileStore.read(projectId, bookPath))!.toString('utf8');
    expect(onDisk).toBe(BOOK);
  });

  it('falls back to writing the file store when the referencing file has no collaborative document', async () => {
    const result = await rewriteReferencesForPathChanges(deps(), projectId, pathChanges);

    expect(result.rewrittenFiles).toBe(1);
    expect(editor.calls).toHaveLength(0);
    const onDisk = (await fileStore.read(projectId, bookPath))!.toString('utf8');
    expect(onDisk).toContain('include::introduction.adoc[]');
    expect(onDisk).toContain('image::introduction.adoc[]');
    expect(onDisk).not.toContain('intro.adoc');
  });

  it('does not clobber the file store when the collaborative editor fails — warns instead', async () => {
    await giveBookACollaborativeDocument();
    editor.result = { success: false, error: new Error('collab unreachable') };

    const result = await rewriteReferencesForPathChanges(deps(), projectId, pathChanges);

    expect(result.rewrittenFiles).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    const onDisk = (await fileStore.read(projectId, bookPath))!.toString('utf8');
    expect(onDisk).toBe(BOOK); // unchanged — no stale write that the live Y.Text would later overwrite
  });

  it('without collaborative deps, behaves exactly as before (writes the file store)', async () => {
    await giveBookACollaborativeDocument();

    const result = await rewriteReferencesForPathChanges({ fileNodeRepo, fileStore }, projectId, pathChanges);

    expect(result.rewrittenFiles).toBe(1);
    expect(editor.calls).toHaveLength(0);
    const onDisk = (await fileStore.read(projectId, bookPath))!.toString('utf8');
    expect(onDisk).toContain('include::introduction.adoc[]');
  });

  it('scans LIVE content, so a reference present only in unsaved edits is still rewritten', async () => {
    // The persisted file store has NO reference to intro.adoc; the live Yjs content (what the editor
    // shows, not yet written back) does. The scan must read live content so the reference is found
    // and rewritten through the collaborative editor — otherwise a move/rename silently misses it.
    const yjsStateId = await giveBookACollaborativeDocument();
    await fileStore.write(projectId, bookPath, Buffer.from('= Book\n\nNo references yet.\n'));
    const LIVE = '= Book\n\ninclude::intro.adoc[]\n';
    const reader: CollaborativeContentReader = {
      async readContent(_p, id): Promise<Result<string | null, Error>> {
        return { success: true, value: id.value === yjsStateId.value ? LIVE : null };
      },
    };

    const result = await rewriteReferencesForPathChanges(
      { fileNodeRepo, fileStore, documentRepo, collaborativeContentEditor: editor, collaborativeContentReader: reader },
      projectId,
      pathChanges,
    );

    expect(result.rewrittenFiles).toBe(1);
    expect(editor.calls).toHaveLength(1);
    expect(editor.calls[0].yjsStateId).toBe(yjsStateId.value);
    let applied = LIVE;
    for (const { find, replace } of editor.calls[0].replacements) applied = applied.split(find).join(replace);
    expect(applied).toContain('include::introduction.adoc[]');
  });
});

// Confirms RenameFileUseCase / MoveFileUseCase thread the collaborative editor through to the
// rewrite (the api wires these at the composition root), so an open referencing file is rewritten
// via the Yjs source of truth rather than clobbered through the file store.
describe('Rename/Move use cases route the rewrite through the collaborative editor', () => {
  const actor = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const rootId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');
  const targetFolderId = FileNodeId.create('cc0e8400-e29b-41d4-a716-446655440009');
  const bookId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');
  const introId = FileNodeId.create('bb0e8400-e29b-41d4-a716-446655440007');
  const bookYjs = YjsStateId.create('11111111-e29b-41d4-a716-446655440111');

  let memberRepo: InMemoryProjectMemberRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let fileStore: InMemoryProjectFileStore;
  let auditLogRepo: InMemoryAuditLogRepository;
  let documentRepo: InMemoryDocumentRepository;
  let editor: FakeCollaborativeContentEditor;

  beforeEach(async () => {
    memberRepo = new InMemoryProjectMemberRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    fileStore = new InMemoryProjectFileStore();
    auditLogRepo = new InMemoryAuditLogRepository();
    documentRepo = new InMemoryDocumentRepository();
    editor = new FakeCollaborativeContentEditor();

    await fileNodeRepo.save(new FileNode(rootId, projectId, null, 'Root', FileNodeType.create('folder'), FilePath.create('/')));
    await fileNodeRepo.save(new FileNode(targetFolderId, projectId, rootId, 'sub', FileNodeType.create('folder'), FilePath.create('/sub')));
    await fileStore.createDirectory(projectId, FilePath.create('/sub'));
    await fileNodeRepo.save(new FileNode(bookId, projectId, rootId, 'book.adoc', FileNodeType.create('file'), FilePath.create('/book.adoc')));
    await fileNodeRepo.save(new FileNode(introId, projectId, rootId, 'intro.adoc', FileNodeType.create('file'), FilePath.create('/intro.adoc')));
    await fileStore.write(projectId, FilePath.create('/book.adoc'), Buffer.from('= Book\n\ninclude::intro.adoc[]\n'));
    await fileStore.write(projectId, FilePath.create('/intro.adoc'), Buffer.from('= Intro\n'));
    await documentRepo.save(
      new Document(
        DocumentId.create('22222222-e29b-41d4-a716-446655440222'),
        bookId,
        ContentId.create('33333333-e29b-41d4-a716-446655440333'),
        bookYjs,
        MimeType.create('text/asciidoc'),
      ),
    );
    await memberRepo.addMember(new ProjectMember(projectId, actor, Role.create('editor')));
  });

  it('rename routes book.adoc’s reference rewrite through the collaborative editor', async () => {
    const useCase = new RenameFileUseCase(
      memberRepo, fileNodeRepo, auditLogRepo, fileStore, undefined, undefined, documentRepo, editor,
    );

    const result = await useCase.execute(actor, introId, 'introduction.adoc', projectId);
    expect(result.success).toBe(true);
    expect(editor.calls).toHaveLength(1);
    expect(editor.calls[0].yjsStateId).toBe(bookYjs.value);
    // The file store keeps the old reference — the collab writeback owns the corrected content.
    expect((await fileStore.read(projectId, FilePath.create('/book.adoc')))!.toString('utf8')).toContain('include::intro.adoc[]');
  });

  it('move routes book.adoc’s reference rewrite through the collaborative editor', async () => {
    const useCase = new MoveFileUseCase(
      memberRepo, fileNodeRepo, fileStore, auditLogRepo, undefined, documentRepo, editor,
    );

    const result = await useCase.execute(actor, projectId, introId, targetFolderId);
    expect(result.success).toBe(true);
    expect(editor.calls).toHaveLength(1);
    expect(editor.calls[0].yjsStateId).toBe(bookYjs.value);
  });
});


describe('rewriteReferencesForPathChanges — which targets it will and will not touch', () => {
  const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const rootId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');
  const bookId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');
  const bookPath = FilePath.create('/book.adoc');

  let fileNodeRepo: InMemoryFileNodeRepository;
  let fileStore: InMemoryProjectFileStore;

  async function writeBook(content: string): Promise<void> {
    await fileStore.write(projectId, bookPath, Buffer.from(content));
  }

  async function bookOnDisk(): Promise<string> {
    return (await fileStore.read(projectId, bookPath))!.toString('utf8');
  }

  beforeEach(async () => {
    fileNodeRepo = new InMemoryFileNodeRepository();
    fileStore = new InMemoryProjectFileStore();
    await fileNodeRepo.save(new FileNode(rootId, projectId, null, 'Root', FileNodeType.create('folder'), FilePath.create('/')));
    await fileNodeRepo.save(new FileNode(bookId, projectId, rootId, 'book.adoc', FileNodeType.create('file'), bookPath));
  });

  it('does no work at all when nothing changed path', async () => {
    await writeBook('= Book\n\ninclude::intro.adoc[]\n');

    const result = await rewriteReferencesForPathChanges({ fileNodeRepo, fileStore }, projectId, new Map());

    expect(result).toEqual({ rewrittenFiles: 0, warnings: [] });
    expect(await bookOnDisk()).toContain('include::intro.adoc[]');
  });

  it('rewrites only the moved target, leaving anchors, templated, escaping and unrelated targets alone', async () => {
    await writeBook(
      [
        '= Book',
        '',
        'See <<intro>> for context.',
        '',
        'include::{docdir}/template.adoc[]',
        '',
        'include::../outside.adoc[]',
        '',
        'include::other.adoc[]',
        '',
        'include::intro.adoc[]',
        '',
      ].join('\n'),
    );

    const result = await rewriteReferencesForPathChanges(
      { fileNodeRepo, fileStore },
      projectId,
      new Map([['intro.adoc', 'introduction.adoc']]),
    );

    expect(result.rewrittenFiles).toBe(1);
    expect(result.warnings).toEqual([]);
    const onDisk = await bookOnDisk();
    expect(onDisk).toContain('include::introduction.adoc[]');
    expect(onDisk).toContain('See <<intro>> for context.');       // a same-file anchor, not a path
    expect(onDisk).toContain('include::{docdir}/template.adoc[]'); // templated: rewriting would lose the variable
    expect(onDisk).toContain('include::../outside.adoc[]');        // outside the sandbox: not ours to touch
    expect(onDisk).toContain('include::other.adoc[]');             // points at a file that did not move
  });

  it('rewrites an xref target and preserves its fragment', async () => {
    await writeBook('= Book\n\nSee xref:intro.adoc#overview[the overview].\n');

    const result = await rewriteReferencesForPathChanges(
      { fileNodeRepo, fileStore },
      projectId,
      new Map([['intro.adoc', 'chapters/introduction.adoc']]),
    );

    expect(result.rewrittenFiles).toBe(1);
    expect(await bookOnDisk()).toContain('xref:chapters/introduction.adoc#overview[the overview]');
  });

  it('writes nothing when a path change maps a file onto its own path', async () => {
    await writeBook('= Book\n\ninclude::intro.adoc[]\n');

    const result = await rewriteReferencesForPathChanges(
      { fileNodeRepo, fileStore },
      projectId,
      new Map([['intro.adoc', 'intro.adoc']]),
    );

    expect(result).toEqual({ rewrittenFiles: 0, warnings: [] });
    expect(await bookOnDisk()).toBe('= Book\n\ninclude::intro.adoc[]\n');
  });

  it('warns instead of writing a target that would not resolve back to the new location', async () => {
    await writeBook('= Book\n\ninclude::intro.adoc[]\n');

    const result = await rewriteReferencesForPathChanges(
      { fileNodeRepo, fileStore },
      projectId,
      // A destination a reference target cannot faithfully express: the surrounding whitespace is
      // dropped when the written target is resolved again, so it would point somewhere else.
      new Map([['intro.adoc', ' introduction.adoc']]),
    );

    expect(result.rewrittenFiles).toBe(0);
    expect(result.warnings).toEqual(['Could not rewrite reference to "intro.adoc" in book.adoc']);
    expect(await bookOnDisk()).toContain('include::intro.adoc[]');
  });

  it('warns when the live document matched no occurrence, rather than counting a rewrite', async () => {
    await writeBook('= Book\n\ninclude::intro.adoc[]\n');
    const documentRepo = new InMemoryDocumentRepository();
    const yjsStateId = YjsStateId.create('11111111-e29b-41d4-a716-446655440111');
    await documentRepo.save(
      new Document(
        DocumentId.create('22222222-e29b-41d4-a716-446655440222'),
        bookId,
        ContentId.create('33333333-e29b-41d4-a716-446655440333'),
        yjsStateId,
        MimeType.create('text/asciidoc'),
      ),
    );
    const editor = new FakeCollaborativeContentEditor();
    editor.result = { success: true, value: 0 };

    const result = await rewriteReferencesForPathChanges(
      { fileNodeRepo, fileStore, documentRepo, collaborativeContentEditor: editor },
      projectId,
      new Map([['intro.adoc', 'introduction.adoc']]),
    );

    expect(result.rewrittenFiles).toBe(0);
    expect(result.warnings).toEqual([
      'No references rewritten in book.adoc: the live document diverged from the scan',
    ]);
  });
});

describe('clearMainFileIfMatches', () => {
  const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const rootId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');
  const mainId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');

  let projectRepo: InMemoryProjectRepository;
  let project: Project;

  beforeEach(async () => {
    projectRepo = new InMemoryProjectRepository();
    project = new Project(projectId, ProjectName.create('Book'), null, [], rootId);
    await projectRepo.save(project);
  });

  it('clears the configuration when the predicate matches the current main file', async () => {
    project.setMainFile(mainId);
    await projectRepo.save(project);

    const cleared = await clearMainFileIfMatches(projectRepo, projectId, (id) => id.value === mainId.value);

    expect(cleared).toBe(true);
    expect((await projectRepo.findById(projectId))!.mainFileNodeId).toBeNull();
  });

  it('leaves the configuration alone when the predicate does not match', async () => {
    project.setMainFile(mainId);
    await projectRepo.save(project);

    const cleared = await clearMainFileIfMatches(projectRepo, projectId, () => false);

    expect(cleared).toBe(false);
    expect((await projectRepo.findById(projectId))!.mainFileNodeId!.value).toBe(mainId.value);
  });

  it('does nothing when no main file is configured', async () => {
    const cleared = await clearMainFileIfMatches(projectRepo, projectId, () => true);

    expect(cleared).toBe(false);
  });

  it('does nothing when the project no longer exists', async () => {
    const missing = ProjectId.create('770e8400-e29b-41d4-a716-446655440099');

    const cleared = await clearMainFileIfMatches(projectRepo, missing, () => true);

    expect(cleared).toBe(false);
  });
});
