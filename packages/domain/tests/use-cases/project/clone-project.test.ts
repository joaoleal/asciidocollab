import { CloneProjectUseCase } from '../../../src/use-cases/project/clone-project';
import { InMemoryProjectRepository } from '../../ports/project/in-memory-project.repository';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryActiveCloneRegistry } from '../../ports/project/in-memory-active-clone-registry';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryAssetRepository } from '../../ports/file-tree/in-memory-asset.repository';
import { InMemoryProjectFileStore } from '../../ports/storage/in-memory-project-file-store';
import { InMemoryCollaborationSessionRepository } from '../../ports/project/in-memory-collaboration-session-repository';
import { InMemoryProjectRenderConfigRepository } from '../../ports/project/in-memory-project-render-config.repository';
import { InMemoryProjectDictionaryRepository } from '../../ports/grammar/in-memory-project-dictionary.repository';
import { AuditLogRepository } from '../../../src/ports/admin/audit-log.repository';
import { CollaborativeContentReader } from '../../../src/ports/storage/collaborative-content-reader';
import { Project } from '../../../src/entities/project';
import { ProjectMember } from '../../../src/entities/project-member';
import { FileNode } from '../../../src/entities/file-node';
import { Document } from '../../../src/entities/document';
import { Asset } from '../../../src/entities/asset';
import { ProjectRenderConfig, RenderConfigData } from '../../../src/entities/project-render-config';
import { ProjectDictionaryTerm } from '../../../src/entities/project-dictionary-term';
import { AuditLog } from '../../../src/entities/audit-log';
import { AuditLogId } from '../../../src/value-objects/ids/audit-log-id';
import { ProjectRenderConfigId } from '../../../src/value-objects/ids/project-render-config-id';
import { ProjectDictionaryTermId } from '../../../src/value-objects/ids/project-dictionary-term-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { DocumentId } from '../../../src/value-objects/ids/document-id';
import { ContentId } from '../../../src/value-objects/ids/content-id';
import { YjsStateId } from '../../../src/value-objects/ids/yjs-state-id';
import { MimeType } from '../../../src/value-objects/files/mime-type';
import { ProjectName } from '../../../src/value-objects/project/project-name';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { Role } from '../../../src/value-objects/identity/role';
import { Timestamps } from '../../../src/value-objects/common/timestamps';
import type { SpellcheckLanguage } from '../../../src/constants/editor-preferences';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { CloneAlreadyInProgressError } from '../../../src/errors/project/clone-already-in-progress';
import { InvalidProjectNameError } from '../../../src/errors/project/invalid-project-name';
import { LiveContentUnavailableError } from '../../../src/errors/project/live-content-unavailable';
import { CloneFailedError } from '../../../src/errors/project/clone-failed';

const OWNER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440000');
const EDITOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const VIEWER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440002');
const STRANGER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440003');
const SOURCE_PROJECT_ID = ProjectId.create('660e8400-e29b-41d4-a716-446655440001');
const UNKNOWN_PROJECT_ID = ProjectId.create('660e8400-e29b-41d4-a716-446655440099');
const SOURCE_ROOT_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440000');
const SOURCE_CHAPTERS_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440001');
const SOURCE_INTRO_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440002');
const SOURCE_APPENDIX_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440003');
const SOURCE_NOTES_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440004');
const SOURCE_IMAGES_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440005');
const SOURCE_LOGO_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440006');
const SOURCE_INDEX_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440007');

const SOURCE_INDEX_DOCUMENT_ID = DocumentId.create('880e8400-e29b-41d4-a716-446655440001');
const SOURCE_INTRO_DOCUMENT_ID = DocumentId.create('880e8400-e29b-41d4-a716-446655440002');
const SOURCE_NOTES_DOCUMENT_ID = DocumentId.create('880e8400-e29b-41d4-a716-446655440003');

const FOLDER = FileNodeType.create('folder');
const FILE = FileNodeType.create('file');

const ASCIIDOC = MimeType.create('text/asciidoc');
const PNG = MimeType.create('image/png');

const INDEX_BYTES = Buffer.from('= Handbook\n\ninclude::chapters/intro.adoc[]\n', 'utf8');
const INTRO_BYTES = Buffer.from('== Intro\n\nWelcome to the handbook.\n', 'utf8');
const NOTES_BYTES = Buffer.from('== Notes\n\nStray thoughts.\n', 'utf8');
/** Deliberately not valid UTF-8, so a byte-for-byte copy is the only way to pass. */
const LOGO_BYTES = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFE, 0x00, 0x80]);

const SOURCE_ASSET_PATH = '/images/logo.png';

const SOURCE_DOCUMENT_BYTES: ReadonlyArray<readonly [string, Buffer]> = [
  ['/index.adoc', INDEX_BYTES],
  ['/chapters/intro.adoc', INTRO_BYTES],
  ['/chapters/appendix/notes.adoc', NOTES_BYTES],
];

const SOURCE_FILE_BYTES: ReadonlyArray<readonly [string, Buffer]> = [
  ...SOURCE_DOCUMENT_BYTES,
  [SOURCE_ASSET_PATH, LOGO_BYTES],
];

const MEMBER_ROLE_CASES: Array<[string, UserId]> = [
  ['viewer', VIEWER_ID],
  ['editor', EDITOR_ID],
  ['owner', OWNER_ID],
];

const REJECTED_NAME_CASES: Array<[string, string]> = [
  ['empty', ''],
  ['only whitespace', '   '],
  ['longer than a hundred characters', 'x'.repeat(101)],
];

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function noop(): void {
  // Placeholder until the promise executor hands over the real resolver.
}

function deferred(): Deferred {
  let resolve: () => void = noop;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: () => resolve() };
}

/** Holds the first project-row write open so a second clone can start while it runs. */
interface FirstSaveGate {
  /** Settles once the first clone has reached the project-row write. */
  reached: Promise<void>;
  /** Lets that write — and therefore the first clone — finish. */
  release: () => void;
}

function gateFirstProjectSave(repo: InMemoryProjectRepository): FirstSaveGate {
  const reached = deferred();
  const held = deferred();
  const passThrough = repo.save.bind(repo);
  let saves = 0;

  jest.spyOn(repo, 'save').mockImplementation(async (project: Project) => {
    saves += 1;
    if (saves === 1) {
      reached.resolve();
      await held.promise;
    }
    await passThrough(project);
  });

  return { reached: reached.promise, release: held.resolve };
}

/** The identity of a tree node as a reader sees it, independent of any id. */
interface NodeShape {
  /** Project-absolute path of the node. */
  path: string;
  /** Name shown in the file tree. */
  name: string;
  /** Either `file` or `folder`. */
  type: string;
}

function shapesOf(nodes: FileNode[]): NodeShape[] {
  return nodes
    .map((node) => ({ path: node.path.value, name: node.name, type: node.type.value }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

/** A node's stored identity and place in the tree, for before/after comparison. */
interface NodeIdentity {
  /** The node's own id. */
  id: string;
  /** The id of the folder holding it, or null at the root. */
  parentId: string | null;
  /** Project-absolute path of the node. */
  path: string;
  /** Name shown in the file tree. */
  name: string;
}

function identitiesOf(nodes: FileNode[]): NodeIdentity[] {
  return nodes
    .map((node) => ({
      id: node.id.value,
      parentId: node.parentId?.value ?? null,
      path: node.path.value,
      name: node.name,
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function sourceRootNode(): FileNode {
  return new FileNode(SOURCE_ROOT_ID, SOURCE_PROJECT_ID, null, 'Handbook', FOLDER, FilePath.create('/'));
}

/** A source tree two folder levels deep, with files at every level. */
function nestedSourceNodes(): FileNode[] {
  return [
    new FileNode(SOURCE_INDEX_ID, SOURCE_PROJECT_ID, SOURCE_ROOT_ID, 'index.adoc', FILE, FilePath.create('/index.adoc')),
    new FileNode(SOURCE_CHAPTERS_ID, SOURCE_PROJECT_ID, SOURCE_ROOT_ID, 'chapters', FOLDER, FilePath.create('/chapters')),
    new FileNode(
      SOURCE_INTRO_ID,
      SOURCE_PROJECT_ID,
      SOURCE_CHAPTERS_ID,
      'intro.adoc',
      FILE,
      FilePath.create('/chapters/intro.adoc'),
    ),
    new FileNode(
      SOURCE_APPENDIX_ID,
      SOURCE_PROJECT_ID,
      SOURCE_CHAPTERS_ID,
      'appendix',
      FOLDER,
      FilePath.create('/chapters/appendix'),
    ),
    new FileNode(
      SOURCE_NOTES_ID,
      SOURCE_PROJECT_ID,
      SOURCE_APPENDIX_ID,
      'notes.adoc',
      FILE,
      FilePath.create('/chapters/appendix/notes.adoc'),
    ),
    new FileNode(SOURCE_IMAGES_ID, SOURCE_PROJECT_ID, SOURCE_ROOT_ID, 'images', FOLDER, FilePath.create('/images')),
    new FileNode(
      SOURCE_LOGO_ID,
      SOURCE_PROJECT_ID,
      SOURCE_IMAGES_ID,
      'logo.png',
      FILE,
      FilePath.create('/images/logo.png'),
    ),
  ];
}

/** The three text documents the nested source tree carries, one per `.adoc` file. */
function sourceDocuments(): Document[] {
  return [
    new Document(
      SOURCE_INDEX_DOCUMENT_ID,
      SOURCE_INDEX_ID,
      ContentId.create('990e8400-e29b-41d4-a716-446655440001'),
      YjsStateId.create('aa0e8400-e29b-41d4-a716-446655440001'),
      ASCIIDOC,
    ),
    new Document(
      SOURCE_INTRO_DOCUMENT_ID,
      SOURCE_INTRO_ID,
      ContentId.create('990e8400-e29b-41d4-a716-446655440002'),
      YjsStateId.create('aa0e8400-e29b-41d4-a716-446655440002'),
      ASCIIDOC,
    ),
    new Document(
      SOURCE_NOTES_DOCUMENT_ID,
      SOURCE_NOTES_ID,
      ContentId.create('990e8400-e29b-41d4-a716-446655440003'),
      YjsStateId.create('aa0e8400-e29b-41d4-a716-446655440003'),
      ASCIIDOC,
    ),
  ];
}

/** Everything the nested tree's file nodes point at: rows for the text files, an asset row and bytes. */
async function seedSourceContent(
  documentRepo: InMemoryDocumentRepository,
  assetRepo: InMemoryAssetRepository,
  fileStore: InMemoryProjectFileStore,
): Promise<void> {
  for (const document of sourceDocuments()) {
    await documentRepo.save(document);
  }
  await assetRepo.save(new Asset(SOURCE_LOGO_ID, PNG, BigInt(LOGO_BYTES.length)));
  for (const [path, bytes] of SOURCE_FILE_BYTES) {
    await fileStore.write(SOURCE_PROJECT_ID, FilePath.create(path), bytes);
  }
}

/** Seeds the whole nested source project: its nodes, its rows and its stored bytes. */
async function seedNestedSource(
  fileNodeRepo: InMemoryFileNodeRepository,
  documentRepo: InMemoryDocumentRepository,
  assetRepo: InMemoryAssetRepository,
  fileStore: InMemoryProjectFileStore,
): Promise<void> {
  for (const node of nestedSourceNodes()) {
    await fileNodeRepo.save(node);
  }
  await seedSourceContent(documentRepo, assetRepo, fileStore);
}

/** A project's memberships as comparable strings, so a before/after check is exact. */
async function membershipSummary(repo: InMemoryProjectMemberRepository, projectId: ProjectId): Promise<string[]> {
  const members = await repo.findByProjectId(projectId);
  return members.map((member) => `${member.userId.value}:${member.role.value}`).toSorted();
}

/** A project's documents as `id:room`, so a copy can never be mistaken for the original. */
async function documentSummary(
  fileNodeRepo: InMemoryFileNodeRepository,
  documentRepo: InMemoryDocumentRepository,
  projectId: ProjectId,
): Promise<string[]> {
  const nodes = await fileNodeRepo.findByProjectId(projectId);
  const documents = await documentRepo.findByFileNodeIds(nodes.map((node) => node.id));
  return documents.map((document) => `${document.id.value}:${document.yjsStateId.value}`).toSorted();
}

/** Finds the one node a project holds at `path`, failing the test if there is none. */
async function nodeAt(repo: InMemoryFileNodeRepository, projectId: ProjectId, path: string): Promise<FileNode> {
  const nodes = await repo.findByProjectId(projectId);
  const found = nodes.find((node) => node.path.value === path);
  expect(found).toBeDefined();
  if (!found) throw new Error(`no node at ${path}`);
  return found;
}

const SOURCE_RENDER_CONFIG_ID = ProjectRenderConfigId.create('cc0e8400-e29b-41d4-a716-446655440001');

/** Render options a source moved away from the defaults, kept opaque as the domain sees them. */
const SOURCE_RENDER_CONFIG: RenderConfigData = {
  pdf: { theme: 'sepia', pageSize: 'A4' },
  attributes: { toc: 'left', sectnums: true },
};

const SOURCE_CREATED_AT = new Date('2026-01-05T09:00:00.000Z');
const SOURCE_ARCHIVED_AT = new Date('2026-02-05T09:00:00.000Z');

/** Project-level settings a test wants the source row to carry instead of the defaults. */
interface SourceProjectSettings {
  /** Long-form description, or null for none. */
  description?: string | null;
  /** Categorisation tags. */
  tags?: string[];
  /** Document and spellcheck language, or null for none. */
  language?: SpellcheckLanguage | null;
  /** When the source was archived, or null while it is active. */
  archivedAt?: Date | null;
  /** The node the source treats as its main file, or null for none. */
  mainFileNodeId?: FileNodeId | null;
}

/** Rewrites the source project row, keeping its identity and changing its settings. */
async function saveSourceProject(
  repo: InMemoryProjectRepository,
  settings: SourceProjectSettings,
): Promise<void> {
  await repo.save(
    new Project(
      SOURCE_PROJECT_ID,
      ProjectName.create('Handbook'),
      settings.description === undefined ? 'Team handbook' : settings.description,
      settings.tags ?? ['handbook'],
      SOURCE_ROOT_ID,
      new Timestamps(SOURCE_CREATED_AT, SOURCE_CREATED_AT),
      settings.archivedAt ?? null,
      settings.mainFileNodeId ?? null,
      settings.language === undefined ? null : settings.language,
    ),
  );
}

const SOURCE_TERM_IDS = [
  ProjectDictionaryTermId.create('dd0e8400-e29b-41d4-a716-446655440001'),
  ProjectDictionaryTermId.create('dd0e8400-e29b-41d4-a716-446655440002'),
];

/** Two terms the source accepted, added by two different members and not by the cloner. */
async function seedSourceDictionary(repo: InMemoryProjectDictionaryRepository): Promise<void> {
  await repo.add(
    new ProjectDictionaryTerm(SOURCE_TERM_IDS[0], SOURCE_PROJECT_ID, 'Asciidoctor', EDITOR_ID, SOURCE_CREATED_AT),
  );
  await repo.add(
    new ProjectDictionaryTerm(SOURCE_TERM_IDS[1], SOURCE_PROJECT_ID, 'Hocuspocus', OWNER_ID, SOURCE_ARCHIVED_AT),
  );
}

const SOURCE_CREATED_AUDIT_ID = AuditLogId.create('bb0e8400-e29b-41d4-a716-446655440001');
const SOURCE_FILE_AUDIT_ID = AuditLogId.create('bb0e8400-e29b-41d4-a716-446655440002');

/** Entries the source accumulated long before anyone asked for a copy of it. */
async function seedSourceAuditHistory(repo: InMemoryAuditLogRepository): Promise<void> {
  await repo.save(
    new AuditLog(
      SOURCE_CREATED_AUDIT_ID,
      OWNER_ID,
      SOURCE_PROJECT_ID,
      'project.created',
      'Project',
      SOURCE_PROJECT_ID.value,
    ),
  );
  await repo.save(
    new AuditLog(
      SOURCE_FILE_AUDIT_ID,
      EDITOR_ID,
      SOURCE_PROJECT_ID,
      'file.created',
      'FileNode',
      SOURCE_INDEX_ID.value,
    ),
  );
}

/**
 * Makes the fakes behave the way the schema does, where a project's render
 * configuration and dictionary terms hang off the project row and go with it.
 * The fakes are independent maps, so without this a deleted project would leave
 * rows behind that the database could not have left.
 */
function cascadeProjectDeletes(
  projectRepo: InMemoryProjectRepository,
  renderConfigRepo: InMemoryProjectRenderConfigRepository,
  dictionaryRepo: InMemoryProjectDictionaryRepository,
): void {
  const passThrough = projectRepo.delete.bind(projectRepo);
  jest.spyOn(projectRepo, 'delete').mockImplementation(async (projectId: ProjectId) => {
    await passThrough(projectId);
    await renderConfigRepo.removeByProject(projectId);
    for (const term of await dictionaryRepo.listByProject(projectId)) {
      await dictionaryRepo.removeById(projectId, term.id);
    }
  });
}

function failingAuditLogRepository(): AuditLogRepository {
  return {
    save: jest.fn().mockRejectedValue(new Error('audit store unavailable')),
    findByProjectId: jest.fn().mockResolvedValue([]),
    findByUserId: jest.fn().mockResolvedValue([]),
    findAll: jest.fn().mockResolvedValue([]),
    findWithFilters: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
    findDistinctActionTypes: jest.fn().mockResolvedValue([]),
  };
}

describe('CloneProjectUseCase', () => {
  let projectRepo: InMemoryProjectRepository;
  let projectMemberRepo: InMemoryProjectMemberRepository;
  let auditLogRepo: InMemoryAuditLogRepository;
  let registry: InMemoryActiveCloneRegistry;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let documentRepo: InMemoryDocumentRepository;
  let assetRepo: InMemoryAssetRepository;
  let fileStore: InMemoryProjectFileStore;
  let collaborationSessionRepo: InMemoryCollaborationSessionRepository;
  let readContent: jest.Mock;
  let collaborativeContentReader: CollaborativeContentReader;
  let renderConfigRepo: InMemoryProjectRenderConfigRepository;
  let dictionaryRepo: InMemoryProjectDictionaryRepository;
  let logger: { warn: jest.Mock };
  let dependencies: ConstructorParameters<typeof CloneProjectUseCase>;
  let useCase: CloneProjectUseCase;

  beforeEach(async () => {
    projectRepo = new InMemoryProjectRepository();
    projectMemberRepo = new InMemoryProjectMemberRepository();
    auditLogRepo = new InMemoryAuditLogRepository();
    registry = new InMemoryActiveCloneRegistry();
    fileNodeRepo = new InMemoryFileNodeRepository();
    documentRepo = new InMemoryDocumentRepository();
    assetRepo = new InMemoryAssetRepository();
    fileStore = new InMemoryProjectFileStore();
    collaborationSessionRepo = new InMemoryCollaborationSessionRepository();
    // No room is open by default, so the resolver never reaches this reader; the
    // tests that need a live read replace it with one that answers.
    readContent = jest.fn().mockResolvedValue({ success: true, value: null });
    collaborativeContentReader = { readContent };
    renderConfigRepo = new InMemoryProjectRenderConfigRepository();
    dictionaryRepo = new InMemoryProjectDictionaryRepository();
    logger = { warn: jest.fn() };
    dependencies = [
      projectRepo,
      fileNodeRepo,
      projectMemberRepo,
      auditLogRepo,
      registry,
      documentRepo,
      assetRepo,
      fileStore,
      collaborationSessionRepo,
      collaborativeContentReader,
      renderConfigRepo,
      dictionaryRepo,
      logger,
    ];
    useCase = new CloneProjectUseCase(...dependencies);

    await projectRepo.save(
      new Project(
        SOURCE_PROJECT_ID,
        ProjectName.create('Handbook'),
        'Team handbook',
        ['handbook'],
        SOURCE_ROOT_ID,
      ),
    );
    await fileNodeRepo.save(sourceRootNode());
    await projectMemberRepo.addMember(new ProjectMember(SOURCE_PROJECT_ID, OWNER_ID, Role.create('owner')));
    await projectMemberRepo.addMember(new ProjectMember(SOURCE_PROJECT_ID, EDITOR_ID, Role.create('editor')));
    await projectMemberRepo.addMember(new ProjectMember(SOURCE_PROJECT_ID, VIEWER_ID, Role.create('viewer')));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('authorization', () => {
    it.each(MEMBER_ROLE_CASES)('a %s of the source can clone it', async (_role, actorId) => {
      const result = await useCase.execute(actorId, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const stored = await projectRepo.findById(result.value.project.id);
      expect(stored).not.toBeNull();
      expect(stored?.name.value).toBe('Handbook copy');
      expect(stored?.archivedAt).toBeNull();
    });

    test('a non-member is refused permission', async () => {
      const result = await useCase.execute(STRANGER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(PermissionDeniedError);
    });

    test('a source that does not exist is refused indistinguishably from one the actor cannot see', async () => {
      const nonMember = await useCase.execute(STRANGER_ID, SOURCE_PROJECT_ID, 'Handbook copy');
      const missing = await useCase.execute(OWNER_ID, UNKNOWN_PROJECT_ID, 'Handbook copy');

      expect(nonMember.success).toBe(false);
      expect(missing.success).toBe(false);
      if (nonMember.success || missing.success) return;

      expect(missing.error).toBeInstanceOf(PermissionDeniedError);
      expect(missing.error.name).toBe(nonMember.error.name);
      expect(missing.error.message).toBe(nonMember.error.message);
    });

    test('a refusal records an authorization denial against the source project', async () => {
      await useCase.execute(STRANGER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      const entries = await auditLogRepo.findAll();
      const denial = entries.find((entry) => entry.action === 'authz.denied');
      expect(denial).toBeDefined();
      expect(denial?.userId?.value).toBe(STRANGER_ID.value);
      expect(denial?.projectId?.value).toBe(SOURCE_PROJECT_ID.value);
      expect(denial?.resourceType).toBe('Project');
      expect(denial?.resourceId).toBe(SOURCE_PROJECT_ID.value);
      expect(denial?.metadata.reason).toBe('not_authorized');
    });

    test('a refusal for a project that does not exist is recorded too, scoped to no project', async () => {
      await useCase.execute(OWNER_ID, UNKNOWN_PROJECT_ID, 'Handbook copy');

      // An audit row's project reference is a foreign key, so scoping this entry to the id that was
      // asked for would make the insert fail — and audit writes are best-effort, so it would be
      // dropped in silence. That would leave the trail blind to precisely the refusal worth seeing:
      // someone walking the id space to learn which projects exist. The id asked for is still
      // recorded as the resource, so the attempt is legible.
      const entries = await auditLogRepo.findAll();
      const denial = entries.find((entry) => entry.action === 'authz.denied');
      expect(denial).toBeDefined();
      expect(denial?.userId?.value).toBe(OWNER_ID.value);
      expect(denial?.projectId).toBeNull();
      expect(denial?.resourceId).toBe(UNKNOWN_PROJECT_ID.value);
      expect(denial?.metadata.reason).toBe('not_authorized');
    });

    test('a denial record that cannot be written leaves the refusal unchanged', async () => {
      const brokenAudit = failingAuditLogRepository();
      const withBrokenAudit = new CloneProjectUseCase(
        projectRepo,
        fileNodeRepo,
        projectMemberRepo,
        brokenAudit,
        registry,
        documentRepo,
        assetRepo,
        fileStore,
        collaborationSessionRepo,
        collaborativeContentReader,
        renderConfigRepo,
        dictionaryRepo,
        logger,
      );

      const result = await withBrokenAudit.execute(STRANGER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(PermissionDeniedError);
      expect(result.error.message).toBe(new PermissionDeniedError().message);
      expect(logger.warn).toHaveBeenCalled();
    });

    test('a refusal survives a source lookup that fails, and is recorded scoped to no project', async () => {
      // The lookup on the refusal path exists only to decide whether the entry can name a project.
      // Letting its failure out would turn a decided refusal into a thrown error the caller must
      // report as a server fault, so a read that does not come back counts as no project — the
      // same as one that came back empty. The id asked for is still recorded as the resource.
      jest.spyOn(projectRepo, 'findById').mockRejectedValue(new Error('connection pool exhausted'));

      const result = await useCase.execute(STRANGER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(PermissionDeniedError);
      expect(result.error.message).toBe(new PermissionDeniedError().message);

      const entries = await auditLogRepo.findAll();
      const denial = entries.find((entry) => entry.action === 'authz.denied');
      expect(denial).toBeDefined();
      expect(denial?.userId?.value).toBe(STRANGER_ID.value);
      expect(denial?.projectId).toBeNull();
      expect(denial?.resourceType).toBe('Project');
      expect(denial?.resourceId).toBe(SOURCE_PROJECT_ID.value);
      expect(denial?.metadata.reason).toBe('not_authorized');
    });
  });

  describe('one clone at a time per user', () => {
    test('a second clone by the same user is refused while the first is still running', async () => {
      const gate = gateFirstProjectSave(projectRepo);

      const first = useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'First copy');
      await gate.reached;

      const second = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Second copy');

      expect(second.success).toBe(false);
      if (!second.success) expect(second.error).toBeInstanceOf(CloneAlreadyInProgressError);

      // The refusal must not hand back the slot the still-running clone holds.
      expect(registry.tryAcquire(OWNER_ID)).toBe(false);

      gate.release();
      const firstResult = await first;
      expect(firstResult.success).toBe(true);
    });

    test('two different users can clone the same source at the same time', async () => {
      const gate = gateFirstProjectSave(projectRepo);

      const first = useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Owner copy');
      await gate.reached;

      const second = await useCase.execute(VIEWER_ID, SOURCE_PROJECT_ID, 'Viewer copy');
      expect(second.success).toBe(true);

      gate.release();
      const firstResult = await first;
      expect(firstResult.success).toBe(true);
    });

    test('the slot is released after a successful clone', async () => {
      await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(registry.tryAcquire(OWNER_ID)).toBe(true);
    });

    test('the slot is released after a refused clone', async () => {
      await useCase.execute(STRANGER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(registry.tryAcquire(STRANGER_ID)).toBe(true);
    });

    test('the slot is released when the very first write throws', async () => {
      jest.spyOn(projectRepo, 'save').mockRejectedValue(new Error('database unavailable'));

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      // A throw from the project row is a refused clone, not an escaping exception: the row may
      // have committed before the connection dropped, and only a refusal runs the cleanup that
      // removes it. Letting it escape answered the caller with a generic failure and left the
      // memberless row behind for good.
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(CloneFailedError);
      expect(registry.tryAcquire(OWNER_ID)).toBe(true);
    });

    test('the slot is released even when the clone escapes as an exception', async () => {
      // The authorization read runs after the slot is claimed and outside the region that converts a
      // throw into a refusal, so it can still escape `execute`. Only the `finally` releases the slot
      // on that path, and the registry has no expiry to rescue it: a momentary database failure here
      // would otherwise hold the user's slot until the process restarts, refusing every clone they
      // attempt afterwards. Nothing else now makes `execute` reject, so without this the `finally`
      // could be deleted and the whole suite would stay green.
      jest
        .spyOn(projectMemberRepo, 'findByCompositeKey')
        .mockRejectedValue(new Error('connection pool timeout'));

      await expect(useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy')).rejects.toThrow(
        'connection pool timeout',
      );
      expect(registry.tryAcquire(OWNER_ID)).toBe(true);
    });

    test('a clone the source read throws on is refused rather than escaping', async () => {
      jest.spyOn(projectRepo, 'findById').mockRejectedValue(new Error('database unavailable'));

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(CloneFailedError);
      expect(registry.tryAcquire(OWNER_ID)).toBe(true);
    });
  });

  describe('the new name', () => {
    it.each(REJECTED_NAME_CASES)('rejects a name that is %s and writes no project row', async (_label, name) => {
      const saveSpy = jest.spyOn(projectRepo, 'save');
      const addMemberSpy = jest.spyOn(projectMemberRepo, 'addMember');

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, name);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(InvalidProjectNameError);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(addMemberSpy).not.toHaveBeenCalled();
      expect(registry.tryAcquire(OWNER_ID)).toBe(true);
    });

    test('a name already used by another of the actor\'s projects is accepted', async () => {
      const first = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook');
      const second = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook');

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      if (!first.success || !second.success) return;

      expect(second.value.project.id.value).not.toBe(first.value.project.id.value);
      expect(second.value.project.name.value).toBe('Handbook');
    });
  });

  describe('membership as the commit point', () => {
    test('the clone has exactly one member, the actor as owner, however many the source has', async () => {
      const result = await useCase.execute(VIEWER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(await projectMemberRepo.findByProjectId(SOURCE_PROJECT_ID)).toHaveLength(3);

      const members = await projectMemberRepo.findByProjectId(result.value.project.id);
      expect(members).toHaveLength(1);
      expect(members[0].userId.value).toBe(VIEWER_ID.value);
      expect(members[0].role.value).toBe('owner');
    });

    test('the owner membership row is written after the project row', async () => {
      const saveSpy = jest.spyOn(projectRepo, 'save');
      const passThrough = projectMemberRepo.addMember.bind(projectMemberRepo);
      let projectRowVisibleAtMembershipWrite: boolean | null = null;
      const addMemberSpy = jest
        .spyOn(projectMemberRepo, 'addMember')
        .mockImplementation(async (member: ProjectMember) => {
          projectRowVisibleAtMembershipWrite = (await projectRepo.findById(member.projectId)) !== null;
          await passThrough(member);
        });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      expect(projectRowVisibleAtMembershipWrite).toBe(true);
      expect(saveSpy.mock.invocationCallOrder[0]).toBeLessThan(addMemberSpy.mock.invocationCallOrder[0]);
    });

    test('a failure before the membership row leaves no membership behind', async () => {
      const addMemberSpy = jest.spyOn(projectMemberRepo, 'addMember');
      const deleteSpy = jest.spyOn(projectRepo, 'delete');
      jest.spyOn(projectRepo, 'save').mockRejectedValue(new Error('database unavailable'));

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(CloneFailedError);
      expect(addMemberSpy).not.toHaveBeenCalled();
      // The compensating cleanup has to reach a project row whose own write is what failed: the
      // write may have committed and then lost its acknowledgement, and a row nobody deletes is a
      // memberless project no read path can ever reach again.
      expect(deleteSpy).toHaveBeenCalled();
    });
  });

  describe('the audit trail', () => {
    test('records the copy against the new project, naming the source it was copied from', async () => {
      const result = await useCase.execute(EDITOR_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const entries = await auditLogRepo.findByProjectId(result.value.project.id);
      const created = entries.find((entry) => entry.action === 'project.cloned');
      expect(created).toBeDefined();
      expect(created?.userId?.value).toBe(EDITOR_ID.value);
      expect(created?.resourceType).toBe('Project');
      expect(created?.resourceId).toBe(result.value.project.id.value);
      expect(created?.metadata.sourceProjectId).toBe(SOURCE_PROJECT_ID.value);
    });

    test('records against the source that the actor read its content', async () => {
      const result = await useCase.execute(EDITOR_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const entries = await auditLogRepo.findByProjectId(SOURCE_PROJECT_ID);
      const read = entries.find((entry) => entry.action === 'project.clone_requested');
      expect(read).toBeDefined();
      expect(read?.userId?.value).toBe(EDITOR_ID.value);
      expect(read?.resourceType).toBe('Project');
      expect(read?.resourceId).toBe(SOURCE_PROJECT_ID.value);
      expect(read?.metadata.cloneProjectId).toBe(result.value.project.id.value);
    });

    test('writes those two entries and nothing else', async () => {
      await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      const entries = await auditLogRepo.findAll();
      expect(entries.map((entry) => entry.action).toSorted()).toEqual([
        'project.clone_requested',
        'project.cloned',
      ]);
    });

    test('records nothing at all when the copy never reaches its commit point', async () => {
      jest.spyOn(projectMemberRepo, 'addMember').mockRejectedValue(new Error('deadlock detected'));

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      // The trail is written past the commit point precisely so this holds. Recorded before it, a
      // clone abandoned at the membership write left `project.cloned` behind: the cleanup deleted
      // the project row, the entry outlived it with its project reference nulled, and the
      // governance history then described a copy that no user ever received.
      const entries = await auditLogRepo.findAll();
      expect(entries.map((entry) => entry.action)).not.toContain('project.cloned');
      expect(entries.map((entry) => entry.action)).not.toContain('project.clone_requested');
    });

    test('gives the copy a trail of its own creation alone, carrying none of the source\'s history', async () => {
      await seedSourceAuditHistory(auditLogRepo);

      const result = await useCase.execute(EDITOR_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneEntries = await auditLogRepo.findByProjectId(result.value.project.id);
      expect(cloneEntries.map((entry) => entry.action)).toEqual(['project.cloned']);
      expect(cloneEntries[0].resourceId).toBe(result.value.project.id.value);

      // The source keeps everything it had, and gains only the record of this read.
      const sourceEntries = await auditLogRepo.findByProjectId(SOURCE_PROJECT_ID);
      expect(sourceEntries.map((entry) => entry.action).toSorted()).toEqual([
        'file.created',
        'project.clone_requested',
        'project.created',
      ]);
    });

    test('stamps both entries with the origin of the request that asked for the copy', async () => {
      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy', {
        ipAddress: '203.0.113.7',
        userAgent: 'jest-agent',
      });

      expect(result.success).toBe(true);

      const entries = await auditLogRepo.findAll();
      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        expect(entry.metadata.origin).toEqual({ ipAddress: '203.0.113.7', userAgent: 'jest-agent' });
      }
    });

    test('completes the copy even when its audit entries cannot be written', async () => {
      const withBrokenAudit = new CloneProjectUseCase(
        projectRepo,
        fileNodeRepo,
        projectMemberRepo,
        failingAuditLogRepository(),
        registry,
        documentRepo,
        assetRepo,
        fileStore,
        collaborationSessionRepo,
        collaborativeContentReader,
        renderConfigRepo,
        dictionaryRepo,
        logger,
      );

      const result = await withBrokenAudit.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(await projectMemberRepo.findByProjectId(result.value.project.id)).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('project-level settings', () => {
    beforeEach(async () => {
      await seedNestedSource(fileNodeRepo, documentRepo, assetRepo, fileStore);
    });

    test('carries the source\'s description, tags and language over unchanged', async () => {
      await saveSourceProject(projectRepo, {
        description: 'The team handbook, kept current',
        tags: ['handbook', 'internal'],
        language: 'pt',
      });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const stored = await projectRepo.findById(result.value.project.id);
      expect(stored?.description).toBe('The team handbook, kept current');
      expect(stored?.tags).toEqual(['handbook', 'internal']);
      expect(stored?.language).toBe('pt');
    });

    test('carries a description, tag list and language the source never set over as unset', async () => {
      await saveSourceProject(projectRepo, { description: null, tags: [], language: null });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const stored = await projectRepo.findById(result.value.project.id);
      expect(stored?.description).toBeNull();
      expect(stored?.tags).toEqual([]);
      expect(stored?.language).toBeNull();
    });

    test('yields an active copy of an archived source, and leaves the source archived', async () => {
      await saveSourceProject(projectRepo, { archivedAt: SOURCE_ARCHIVED_AT });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const stored = await projectRepo.findById(result.value.project.id);
      expect(stored?.archivedAt).toBeNull();
      const source = await projectRepo.findById(SOURCE_PROJECT_ID);
      expect(source?.archivedAt).toEqual(SOURCE_ARCHIVED_AT);
    });

    test('points the copy at its own node as the main file, never at the source\'s', async () => {
      await saveSourceProject(projectRepo, { mainFileNodeId: SOURCE_INDEX_ID });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneId = result.value.project.id;
      const cloneIndex = await nodeAt(fileNodeRepo, cloneId, '/index.adoc');
      const stored = await projectRepo.findById(cloneId);
      expect(stored?.mainFileNodeId?.value).toBe(cloneIndex.id.value);
      expect(stored?.mainFileNodeId?.value).not.toBe(SOURCE_INDEX_ID.value);
    });

    test('names the copy\'s main file only once that node has been written', async () => {
      await saveSourceProject(projectRepo, { mainFileNodeId: SOURCE_INDEX_ID });
      const passThrough = projectRepo.save.bind(projectRepo);
      const nodeExistedAtSave: boolean[] = [];
      jest.spyOn(projectRepo, 'save').mockImplementation(async (project: Project) => {
        const mainFileNodeId = project.mainFileNodeId;
        if (mainFileNodeId !== null) {
          nodeExistedAtSave.push((await fileNodeRepo.findById(mainFileNodeId)) !== null);
        }
        await passThrough(project);
      });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      // Exactly one write carries the pointer, and the node it names was already
      // stored — the column is a foreign key, so the first row could not have it.
      expect(nodeExistedAtSave).toEqual([true]);
    });

    test('keeps the copy\'s main file when the source is later pointed at another one', async () => {
      await saveSourceProject(projectRepo, { mainFileNodeId: SOURCE_INDEX_ID });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneId = result.value.project.id;
      const cloneIndex = await nodeAt(fileNodeRepo, cloneId, '/index.adoc');

      const source = await projectRepo.findById(SOURCE_PROJECT_ID);
      expect(source).not.toBeNull();
      if (source === null) return;
      source.setMainFile(SOURCE_NOTES_ID);
      await projectRepo.save(source);

      const stored = await projectRepo.findById(cloneId);
      expect(stored?.mainFileNodeId?.value).toBe(cloneIndex.id.value);
    });

    test('keeps the copy\'s main file when the source\'s is deleted afterwards', async () => {
      await saveSourceProject(projectRepo, { mainFileNodeId: SOURCE_INDEX_ID });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneId = result.value.project.id;
      const cloneIndex = await nodeAt(fileNodeRepo, cloneId, '/index.adoc');

      // Deleting the node clears the pointer that named it, the way the column's
      // foreign key does. Only the source's pointer is on that node.
      await fileNodeRepo.delete(SOURCE_INDEX_ID);
      const source = await projectRepo.findById(SOURCE_PROJECT_ID);
      expect(source).not.toBeNull();
      if (source === null) return;
      source.setMainFile(null);
      await projectRepo.save(source);

      const stored = await projectRepo.findById(cloneId);
      expect(stored?.mainFileNodeId?.value).toBe(cloneIndex.id.value);
      expect(await fileNodeRepo.findById(cloneIndex.id)).not.toBeNull();
    });

    test('gives a copy of a source with no main file no main file either', async () => {
      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const source = await projectRepo.findById(SOURCE_PROJECT_ID);
      const stored = await projectRepo.findById(result.value.project.id);
      expect(source?.mainFileNodeId).toBeNull();
      expect(stored?.mainFileNodeId).toBeNull();
    });

    test('writes the copy\'s row once when there is no main file to point it at', async () => {
      const saveSpy = jest.spyOn(projectRepo, 'save');

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      // The copy has a root folder, but the root folder has no column of its own, so the
      // second write a main file needs would send an update changing nothing at all.
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy.mock.calls[0][0].id.value).toBe(result.value.project.id.value);
      expect(result.value.project.rootFolderId).not.toBeNull();
    });

    test('warns and leaves the copy without a main file when the source main file is gone by the tree walk', async () => {
      await saveSourceProject(projectRepo, { mainFileNodeId: SOURCE_INDEX_ID });
      // The concurrency this use case embraces: the source's main file node is deleted between the
      // source read and the tree walk, so the copied tree holds no counterpart to the pointer the
      // source row still carries. The copy commits without a main file, and the silent loss is logged.
      await fileNodeRepo.delete(SOURCE_INDEX_ID);

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const stored = await projectRepo.findById(result.value.project.id);
      expect(stored?.mainFileNodeId).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('without a main file'),
        expect.objectContaining({ sourceMainFileId: SOURCE_INDEX_ID.value }),
      );
    });
  });

  describe('render configuration', () => {
    beforeEach(async () => {
      await seedNestedSource(fileNodeRepo, documentRepo, assetRepo, fileStore);
    });

    test('copies the source\'s render configuration verbatim', async () => {
      await renderConfigRepo.save(
        new ProjectRenderConfig(SOURCE_RENDER_CONFIG_ID, SOURCE_PROJECT_ID, SOURCE_RENDER_CONFIG),
      );

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const copied = await renderConfigRepo.findByProjectId(result.value.project.id);
      expect(copied?.config).toEqual(SOURCE_RENDER_CONFIG);
    });

    test('gives the copy a configuration record of its own, leaving the source\'s where it was', async () => {
      await renderConfigRepo.save(
        new ProjectRenderConfig(SOURCE_RENDER_CONFIG_ID, SOURCE_PROJECT_ID, SOURCE_RENDER_CONFIG),
      );

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const copied = await renderConfigRepo.findByProjectId(result.value.project.id);
      expect(copied?.id.value).not.toBe(SOURCE_RENDER_CONFIG_ID.value);
      expect(copied?.projectId.value).toBe(result.value.project.id.value);

      const original = await renderConfigRepo.findByProjectId(SOURCE_PROJECT_ID);
      expect(original?.id.value).toBe(SOURCE_RENDER_CONFIG_ID.value);
      expect(original?.config).toEqual(SOURCE_RENDER_CONFIG);
    });

    test('writes no configuration for a source that has none, so the copy keeps following the defaults', async () => {
      const saveSpy = jest.spyOn(renderConfigRepo, 'save');

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(saveSpy).not.toHaveBeenCalled();
      expect(await renderConfigRepo.findByProjectId(result.value.project.id)).toBeNull();
    });
  });

  describe('the project dictionary', () => {
    beforeEach(async () => {
      await seedNestedSource(fileNodeRepo, documentRepo, assetRepo, fileStore);
    });

    test('copies every term the source had accepted', async () => {
      await seedSourceDictionary(dictionaryRepo);

      const result = await useCase.execute(VIEWER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const copied = await dictionaryRepo.listByProject(result.value.project.id);
      expect(copied.map((entry) => entry.term).toSorted()).toEqual(['Asciidoctor', 'Hocuspocus']);
    });

    test('attributes a copied term to the user who asked for the copy, not to whoever first added it', async () => {
      await seedSourceDictionary(dictionaryRepo);

      const result = await useCase.execute(VIEWER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const copied = await dictionaryRepo.listByProject(result.value.project.id);
      expect(copied.map((entry) => entry.createdByUserId.value)).toEqual([VIEWER_ID.value, VIEWER_ID.value]);

      // The source's own attribution is untouched by having been read.
      const original = await dictionaryRepo.listByProject(SOURCE_PROJECT_ID);
      expect(original.map((entry) => entry.createdByUserId.value)).toEqual([EDITOR_ID.value, OWNER_ID.value]);
    });

    test('gives every copied term an id of its own that no source term shares', async () => {
      await seedSourceDictionary(dictionaryRepo);

      const result = await useCase.execute(VIEWER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const sourceTerms = await dictionaryRepo.listByProject(SOURCE_PROJECT_ID);
      const sourceIds = new Set(sourceTerms.map((entry) => entry.id.value));
      const copied = await dictionaryRepo.listByProject(result.value.project.id);
      expect(copied).toHaveLength(2);
      for (const entry of copied) {
        expect(sourceIds.has(entry.id.value)).toBe(false);
        expect(entry.projectId.value).toBe(result.value.project.id.value);
      }
    });

    test('adds no terms for a source whose dictionary is empty', async () => {
      const addSpy = jest.spyOn(dictionaryRepo, 'add');

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(addSpy).not.toHaveBeenCalled();
      expect(await dictionaryRepo.listByProject(result.value.project.id)).toEqual([]);
    });
  });

  describe('the file tree', () => {
    beforeEach(async () => {
      await seedNestedSource(fileNodeRepo, documentRepo, assetRepo, fileStore);
    });

    test('reproduces every folder and file of the source with its path, name and type unchanged', async () => {
      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const sourceNodes = await fileNodeRepo.findByProjectId(SOURCE_PROJECT_ID);
      const cloneNodes = await fileNodeRepo.findByProjectId(result.value.project.id);

      expect(shapesOf(cloneNodes)).toEqual(shapesOf(sourceNodes));
    });

    test('gives every copied node an id of its own that no source node shares', async () => {
      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const sourceNodes = await fileNodeRepo.findByProjectId(SOURCE_PROJECT_ID);
      const sourceIds = new Set(sourceNodes.map((node) => node.id.value));
      const cloneNodes = await fileNodeRepo.findByProjectId(result.value.project.id);
      const cloneIds = new Set(cloneNodes.map((node) => node.id.value));

      expect(cloneNodes).toHaveLength(sourceIds.size);
      expect(cloneIds.size).toBe(cloneNodes.length);
      expect([...cloneIds].filter((id) => sourceIds.has(id))).toEqual([]);
      expect(cloneNodes.every((node) => node.projectId.value === result.value.project.id.value)).toBe(true);
    });

    test('points each copied node at the clone\'s own copy of its source parent', async () => {
      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const sourceNodes = await fileNodeRepo.findByProjectId(SOURCE_PROJECT_ID);
      const cloneNodes = await fileNodeRepo.findByProjectId(result.value.project.id);
      const sourceById = new Map(sourceNodes.map((node) => [node.id.value, node]));
      const sourceIds = new Set(sourceById.keys());
      const cloneByPath = new Map(cloneNodes.map((node) => [node.path.value, node]));
      const cloneIds = new Set(cloneNodes.map((node) => node.id.value));

      const expectedParentPaths: Array<string | null> = [];
      const actualParentPaths: Array<string | null> = [];

      for (const sourceNode of sourceNodes) {
        const clonedNode = cloneByPath.get(sourceNode.path.value);
        expect(clonedNode).toBeDefined();
        if (!clonedNode) continue;

        const clonedParentId = clonedNode.parentId;
        if (clonedParentId !== null) {
          // Never a source id, and never an id nothing in the clone answers to.
          expect(sourceIds.has(clonedParentId.value)).toBe(false);
          expect(cloneIds.has(clonedParentId.value)).toBe(true);
        }

        const sourceParentId = sourceNode.parentId;
        expectedParentPaths.push(
          sourceParentId === null ? null : (sourceById.get(sourceParentId.value)?.path.value ?? null),
        );
        actualParentPaths.push(
          clonedParentId === null
            ? null
            : (cloneNodes.find((node) => node.id.value === clonedParentId.value)?.path.value ?? null),
        );
      }

      expect(actualParentPaths).toEqual(expectedParentPaths);
    });

    test('writes each copied node only once its parent is already stored', async () => {
      const passThrough = fileNodeRepo.save.bind(fileNodeRepo);
      const parentMissingAtWrite: string[] = [];
      const written: string[] = [];
      jest.spyOn(fileNodeRepo, 'save').mockImplementation(async (node: FileNode) => {
        const parentId = node.parentId;
        if (parentId !== null && (await fileNodeRepo.findById(parentId)) === null) {
          parentMissingAtWrite.push(node.path.value);
        }
        written.push(node.path.value);
        await passThrough(node);
      });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      expect(parentMissingAtWrite).toEqual([]);
      expect(written).toHaveLength(8);
    });

    test('keeps the copied root at the project root path but names it after the new project', async () => {
      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Runbook');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneNodes = await fileNodeRepo.findByProjectId(result.value.project.id);
      const roots = cloneNodes.filter((node) => node.parentId === null);

      expect(roots).toHaveLength(1);
      expect(roots[0].path.value).toBe('/');
      expect(roots[0].type.value).toBe('folder');
      expect(roots[0].name).toBe('Runbook');
      expect(roots[0].name).not.toBe('Handbook');
    });

    test('hands back a copy pointed at its own root, while the stored row keeps no root at all', async () => {
      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Runbook');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneNodes = await fileNodeRepo.findByProjectId(result.value.project.id);
      const root = cloneNodes.find((node) => node.parentId === null);
      const stored = await projectRepo.findById(result.value.project.id);

      expect(root).toBeDefined();
      expect(result.value.project.rootFolderId?.value).toBe(root?.id.value);
      expect(result.value.project.rootFolderId?.value).not.toBe(SOURCE_ROOT_ID.value);
      // The root folder has no column of its own, so the row the copy was written to
      // reports none — only the entity handed straight back to the caller carries it.
      expect(stored?.rootFolderId).toBeNull();
    });

    test('finds the root by its path, so a source whose row remembers no root still gets one', async () => {
      // A project loaded from the database never reports a root folder — it is not a stored column,
      // and every project the repository reconstructs has it set to null, whatever the entity held
      // when it was written. So the copy cannot learn the root from the source's row: identifying
      // it any other way than by its path would leave every real clone with no root at all. This
      // pins the only source of truth that survives a round trip.
      const source = await projectRepo.findById(SOURCE_PROJECT_ID);
      expect(source).not.toBeNull();
      expect(source?.rootFolderId).toBeNull();

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneNodes = await fileNodeRepo.findByProjectId(result.value.project.id);
      const pathRootCopy = cloneNodes.find((node) => node.path.value === '/');
      const chaptersCopy = cloneNodes.find((node) => node.path.value === '/chapters');

      expect(pathRootCopy).toBeDefined();
      expect(result.value.project.rootFolderId?.value).toBe(pathRootCopy?.id.value);
      expect(result.value.project.rootFolderId?.value).not.toBe(chaptersCopy?.id.value);
    });

    test('leaves the source file tree exactly as it was', async () => {
      const before = identitiesOf(await fileNodeRepo.findByProjectId(SOURCE_PROJECT_ID));

      await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      const after = identitiesOf(await fileNodeRepo.findByProjectId(SOURCE_PROJECT_ID));

      expect(after).toEqual(before);
      expect(after).toHaveLength(8);
    });
  });

  describe('text documents', () => {
    test('reads the source documents once as a batch, not once per file', async () => {
      const batchSpy = jest.spyOn(documentRepo, 'findByFileNodeIds');
      const perNodeSpy = jest.spyOn(documentRepo, 'findByFileNodeId');

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      // Resolving each document's content asks whether the node has one at all.
      // Answering that from the batch already read keeps the copy's cost linear in
      // one round trip rather than one per file, which matters most on the large
      // projects this operation exists for.
      expect(result.success).toBe(true);
      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect(perNodeSpy).not.toHaveBeenCalled();
    });

    test('checks live collaboration sessions once as a batch, not once per document', async () => {
      const batchSpy = jest.spyOn(collaborationSessionRepo, 'findActiveDocumentIds');
      const perDocumentSpy = jest.spyOn(collaborationSessionRepo, 'isActive');

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      // Resolving each document's content asks whether it has a live session; answering that from a
      // single findActiveDocumentIds read keeps the copy at one session round trip rather than one
      // per document — the N+1 the sibling download path already avoids.
      expect(result.success).toBe(true);
      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect(perDocumentSpy).not.toHaveBeenCalled();
    });

    beforeEach(async () => {
      await seedNestedSource(fileNodeRepo, documentRepo, assetRepo, fileStore);
    });

    test('writes every document\'s bytes into the clone\'s own storage at the same path', async () => {
      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneId = result.value.project.id;
      for (const [path, bytes] of SOURCE_DOCUMENT_BYTES) {
        const stored = await fileStore.read(cloneId, FilePath.create(path));
        expect(stored).not.toBeNull();
        expect(stored?.equals(bytes)).toBe(true);
      }
    });

    test('gives every copied document a document row against the clone\'s own file node', async () => {
      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneId = result.value.project.id;
      const cloneIntroNode = await nodeAt(fileNodeRepo, cloneId, '/chapters/intro.adoc');
      const cloneIntroDocument = await documentRepo.findByFileNodeId(cloneIntroNode.id);

      expect(cloneIntroDocument).not.toBeNull();
      expect(cloneIntroDocument?.mimeType.value).toBe('text/asciidoc');

      const cloneNodes = await fileNodeRepo.findByProjectId(cloneId);
      const cloneDocuments = await documentRepo.findByFileNodeIds(cloneNodes.map((node) => node.id));
      expect(cloneDocuments).toHaveLength(3);
    });

    test('shares no document id, content id or collaboration room with the source it was copied from', async () => {
      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneId = result.value.project.id;
      const source = await documentRepo.findByFileNodeId(SOURCE_INTRO_ID);
      const cloneIntroNode = await nodeAt(fileNodeRepo, cloneId, '/chapters/intro.adoc');
      const copy = await documentRepo.findByFileNodeId(cloneIntroNode.id);

      expect(source).not.toBeNull();
      expect(copy).not.toBeNull();
      if (!source || !copy) return;

      expect(copy.id.value).not.toBe(source.id.value);
      expect(copy.contentId.value).not.toBe(source.contentId.value);
      // Reusing the source's room would put two projects in one collaboration session.
      expect(copy.yjsStateId.value).not.toBe(source.yjsStateId.value);
      expect(copy.contentId.value).not.toBe(copy.yjsStateId.value);
      expect(copy.fileNodeId.value).toBe(cloneIntroNode.id.value);
    });

    test('copies the text a collaborator is editing right now, not the bytes last written to storage', async () => {
      await collaborationSessionRepo.open(SOURCE_PROJECT_ID, SOURCE_INTRO_DOCUMENT_ID);
      const liveText = '== Intro\n\nA sentence typed one second ago.\n';
      readContent.mockResolvedValue({ success: true, value: liveText });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const stored = await fileStore.read(result.value.project.id, FilePath.create('/chapters/intro.adoc'));
      expect(stored?.toString('utf8')).toBe(liveText);
      expect(stored?.equals(INTRO_BYTES)).toBe(false);
    });

    test('does not ask the collaboration server about a document nobody has open', async () => {
      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      expect(readContent).not.toHaveBeenCalled();
    });

    test('refuses the clone when a document being edited cannot be read, rather than copying stale bytes', async () => {
      await collaborationSessionRepo.open(SOURCE_PROJECT_ID, SOURCE_INTRO_DOCUMENT_ID);
      readContent.mockResolvedValue({ success: false, error: new Error('collaboration server unreachable') });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(LiveContentUnavailableError);
    });

    test('refuses the clone when a document\'s stored bytes have gone missing, rather than copying an empty file', async () => {
      await fileStore.remove(SOURCE_PROJECT_ID, FilePath.create('/chapters/intro.adoc'));

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(CloneFailedError);
    });

    test('names the unreadable document by the path the caller already sees in the source file tree', async () => {
      await collaborationSessionRepo.open(SOURCE_PROJECT_ID, SOURCE_NOTES_DOCUMENT_ID);
      readContent.mockResolvedValue({ success: false, error: new Error('collaboration server unreachable') });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) return;
      if (!(result.error instanceof LiveContentUnavailableError)) {
        throw new Error(`expected a live-content refusal, got ${result.error.name}`);
      }
      expect(result.error.path).toBe('/chapters/appendix/notes.adoc');
      expect(result.error.message).toContain('/chapters/appendix/notes.adoc');
    });
  });

  describe('binary assets and folders', () => {
    beforeEach(async () => {
      await seedNestedSource(fileNodeRepo, documentRepo, assetRepo, fileStore);
    });

    test('reads the source assets once as a batch, not once per binary file', async () => {
      const batchSpy = jest.spyOn(assetRepo, 'findByIds');
      const perNodeSpy = jest.spyOn(assetRepo, 'findById');

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      // The documents are already read in bulk; the assets were not, so a project
      // full of images cost one serialized round trip per image inside a single
      // request. Both kinds are now answered from one batch each.
      expect(result.success).toBe(true);
      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect(perNodeSpy).not.toHaveBeenCalled();
    });

    test('copies an asset into the clone byte for byte', async () => {
      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const copied = await fileStore.read(result.value.project.id, FilePath.create(SOURCE_ASSET_PATH));
      expect(copied).not.toBeNull();
      expect(copied?.equals(LOGO_BYTES)).toBe(true);
    });

    test('records the asset against the clone\'s own file node with the source\'s mime type', async () => {
      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneLogoNode = await nodeAt(fileNodeRepo, result.value.project.id, SOURCE_ASSET_PATH);
      const copied = await assetRepo.findById(cloneLogoNode.id);

      expect(copied).not.toBeNull();
      expect(copied?.id.value).toBe(cloneLogoNode.id.value);
      expect(copied?.id.value).not.toBe(SOURCE_LOGO_ID.value);
      expect(copied?.mimeType.value).toBe('image/png');
      expect(await assetRepo.findById(SOURCE_LOGO_ID)).not.toBeNull();
    });

    test('records the size of the bytes it actually wrote, not the size the source row claimed', async () => {
      await assetRepo.delete(SOURCE_LOGO_ID);
      await assetRepo.save(new Asset(SOURCE_LOGO_ID, PNG, 99_999n));

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneLogoNode = await nodeAt(fileNodeRepo, result.value.project.id, SOURCE_ASSET_PATH);
      const copied = await assetRepo.findById(cloneLogoNode.id);

      expect(copied?.sizeBytes).toBe(BigInt(LOGO_BYTES.length));
    });

    test('gives a binary asset no document row, so it stays out of the collaborative editor', async () => {
      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneLogoNode = await nodeAt(fileNodeRepo, result.value.project.id, SOURCE_ASSET_PATH);
      expect(await documentRepo.findByFileNodeId(cloneLogoNode.id)).toBeNull();
    });

    test('creates every folder in the clone\'s storage before anything is written inside it', async () => {
      const journal: string[] = [];
      const passThroughDirectory = fileStore.createDirectory.bind(fileStore);
      const passThroughWrite = fileStore.write.bind(fileStore);
      jest
        .spyOn(fileStore, 'createDirectory')
        .mockImplementation(async (projectId: ProjectId, directoryPath: FilePath) => {
          journal.push(`directory ${projectId.value} ${directoryPath.value}`);
          await passThroughDirectory(projectId, directoryPath);
        });
      jest
        .spyOn(fileStore, 'write')
        .mockImplementation(async (projectId: ProjectId, filePath: FilePath, content: Buffer) => {
          journal.push(`file ${projectId.value} ${filePath.value}`);
          await passThroughWrite(projectId, filePath, content);
        });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneId = result.value.project.id.value;
      for (const folder of ['/', '/chapters', '/chapters/appendix', '/images']) {
        expect(journal).toContain(`directory ${cloneId} ${folder}`);
      }
      expect(journal.indexOf(`directory ${cloneId} /images`)).toBeLessThan(
        journal.indexOf(`file ${cloneId} ${SOURCE_ASSET_PATH}`),
      );
      expect(journal.indexOf(`directory ${cloneId} /chapters/appendix`)).toBeLessThan(
        journal.indexOf(`file ${cloneId} /chapters/appendix/notes.adoc`),
      );
    });

    test('copies a file the source recorded no type for, as unclassified bytes', async () => {
      await assetRepo.delete(SOURCE_LOGO_ID);

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneLogoNode = await nodeAt(fileNodeRepo, result.value.project.id, SOURCE_ASSET_PATH);
      const copied = await assetRepo.findById(cloneLogoNode.id);

      expect(copied?.mimeType.value).toBe('application/octet-stream');
      expect(copied?.sizeBytes).toBe(BigInt(LOGO_BYTES.length));
    });

    test('refuses the clone when an asset\'s bytes have gone missing, rather than copying an empty file', async () => {
      await fileStore.remove(SOURCE_PROJECT_ID, FilePath.create(SOURCE_ASSET_PATH));

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(CloneFailedError);
    });
  });

  test('a source of folders alone, holding no files at all, is copied successfully', async () => {
    await fileNodeRepo.save(
      new FileNode(SOURCE_CHAPTERS_ID, SOURCE_PROJECT_ID, SOURCE_ROOT_ID, 'chapters', FOLDER, FilePath.create('/chapters')),
    );
    await fileNodeRepo.save(
      new FileNode(
        SOURCE_APPENDIX_ID,
        SOURCE_PROJECT_ID,
        SOURCE_CHAPTERS_ID,
        'appendix',
        FOLDER,
        FilePath.create('/chapters/appendix'),
      ),
    );

    const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Runbook');

    expect(result.success).toBe(true);
    if (!result.success) return;

    const cloneNodes = await fileNodeRepo.findByProjectId(result.value.project.id);
    expect(shapesOf(cloneNodes)).toEqual([
      { path: '/', name: 'Runbook', type: 'folder' },
      { path: '/chapters', name: 'chapters', type: 'folder' },
      { path: '/chapters/appendix', name: 'appendix', type: 'folder' },
    ]);
  });

  describe('cleanup after a failed clone', () => {
    beforeEach(async () => {
      await seedNestedSource(fileNodeRepo, documentRepo, assetRepo, fileStore);
    });

    test('deletes the project row the clone had already written', async () => {
      const saveSpy = jest.spyOn(projectRepo, 'save');
      jest.spyOn(documentRepo, 'save').mockRejectedValue(new Error('document store unavailable'));

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      const cloneId = saveSpy.mock.calls[0][0].id;
      expect(cloneId.value).not.toBe(SOURCE_PROJECT_ID.value);
      expect(await projectRepo.findById(cloneId)).toBeNull();
    });

    test('cleans up when the membership row itself cannot be written', async () => {
      const saveSpy = jest.spyOn(projectRepo, 'save');
      const deleteSpy = jest.spyOn(projectRepo, 'delete');
      const removeProjectSpy = jest.spyOn(fileStore, 'removeProject');
      jest.spyOn(projectMemberRepo, 'addMember').mockRejectedValue(new Error('deadlock detected'));

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      // The membership row is the commit point, so a copy that fails to write it is
      // exactly the residue nothing can ever surface: invisible to every read path,
      // and therefore never collected by anything that walks visible projects.
      // Deleting the row is what discards the tree with it; that the database really
      // cascades is proven where a real database is available, not against a fake.
      expect(result.success).toBe(false);
      const cloneId = saveSpy.mock.calls[0][0].id;
      expect(deleteSpy).toHaveBeenCalledWith(cloneId);
      expect(await projectRepo.findById(cloneId)).toBeNull();
      expect(removeProjectSpy).toHaveBeenCalledWith(cloneId);
      expect(await projectMemberRepo.findByProjectId(cloneId)).toHaveLength(0);
    });

    test('reports a membership row that cannot be written as a clone failure, not a thrown error', async () => {
      const cause = new Error('deadlock detected');
      jest.spyOn(projectMemberRepo, 'addMember').mockRejectedValue(cause);

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected the clone to fail');
      expect(result.error).toBeInstanceOf(CloneFailedError);
      expect(result.error.cause).toBe(cause);
    });

    test('leaves the source untouched when the membership row cannot be written', async () => {
      const sourceNodesBefore = await fileNodeRepo.findByProjectId(SOURCE_PROJECT_ID);
      jest.spyOn(projectMemberRepo, 'addMember').mockRejectedValue(new Error('deadlock detected'));

      await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(await fileNodeRepo.findByProjectId(SOURCE_PROJECT_ID)).toHaveLength(sourceNodesBefore.length);
      expect(await projectRepo.findById(SOURCE_PROJECT_ID)).not.toBeNull();
      expect(await fileStore.read(SOURCE_PROJECT_ID, FilePath.create('/index.adoc'))).not.toBeNull();
    });

    test('removes the storage the clone had already filled', async () => {
      const saveSpy = jest.spyOn(projectRepo, 'save');
      const removeProjectSpy = jest.spyOn(fileStore, 'removeProject');
      jest.spyOn(documentRepo, 'save').mockRejectedValue(new Error('document store unavailable'));

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      const cloneId = saveSpy.mock.calls[0][0].id;
      expect(removeProjectSpy).toHaveBeenCalledWith(cloneId);
      expect(await fileStore.read(cloneId, FilePath.create('/index.adoc'))).toBeNull();
    });

    test('reports the failure that aborted it as a clone failure carrying the cause', async () => {
      const cause = new Error('document store unavailable');
      jest.spyOn(documentRepo, 'save').mockRejectedValue(cause);

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(CloneFailedError);
      expect(result.error.cause).toBe(cause);
      // The cause names storage internals, so it stays out of what the caller is shown.
      expect(result.error.message).not.toContain('document store unavailable');
    });

    test('writes no membership row, so no half-built project can ever be seen', async () => {
      const saveSpy = jest.spyOn(projectRepo, 'save');
      const addMemberSpy = jest.spyOn(projectMemberRepo, 'addMember');
      jest.spyOn(documentRepo, 'save').mockRejectedValue(new Error('document store unavailable'));

      await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(addMemberSpy).not.toHaveBeenCalled();
      const cloneId = saveSpy.mock.calls[0][0].id;
      expect(await projectMemberRepo.findByProjectId(cloneId)).toEqual([]);
    });

    test('leaves the source project, its tree, its stored bytes and its members exactly as they were', async () => {
      const projectBefore = await projectRepo.findById(SOURCE_PROJECT_ID);
      const treeBefore = identitiesOf(await fileNodeRepo.findByProjectId(SOURCE_PROJECT_ID));
      const membersBefore = await membershipSummary(projectMemberRepo, SOURCE_PROJECT_ID);
      const documentsBefore = await documentSummary(fileNodeRepo, documentRepo, SOURCE_PROJECT_ID);
      jest.spyOn(documentRepo, 'save').mockRejectedValue(new Error('document store unavailable'));

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');
      expect(result.success).toBe(false);

      const projectAfter = await projectRepo.findById(SOURCE_PROJECT_ID);
      expect(projectAfter?.name.value).toBe(projectBefore?.name.value);
      expect(projectAfter?.mainFileNodeId).toEqual(projectBefore?.mainFileNodeId);
      // The row cannot say which node is its root, so the tree is where that is checked:
      // the source still holds its own root at the project root path.
      const sourceRootAfter = await nodeAt(fileNodeRepo, SOURCE_PROJECT_ID, '/');
      expect(sourceRootAfter.id.value).toBe(SOURCE_ROOT_ID.value);
      expect(identitiesOf(await fileNodeRepo.findByProjectId(SOURCE_PROJECT_ID))).toEqual(treeBefore);
      expect(await membershipSummary(projectMemberRepo, SOURCE_PROJECT_ID)).toEqual(membersBefore);
      expect(await documentSummary(fileNodeRepo, documentRepo, SOURCE_PROJECT_ID)).toEqual(documentsBefore);
      for (const [path, bytes] of SOURCE_FILE_BYTES) {
        const stored = await fileStore.read(SOURCE_PROJECT_ID, FilePath.create(path));
        expect(stored?.equals(bytes)).toBe(true);
      }
      expect(await assetRepo.findById(SOURCE_LOGO_ID)).not.toBeNull();
    });

    test('still names the unreadable document after cleaning up, so the caller learns what blocked it', async () => {
      const saveSpy = jest.spyOn(projectRepo, 'save');
      const removeProjectSpy = jest.spyOn(fileStore, 'removeProject');
      await collaborationSessionRepo.open(SOURCE_PROJECT_ID, SOURCE_INTRO_DOCUMENT_ID);
      readContent.mockResolvedValue({ success: false, error: new Error('collaboration server unreachable') });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(LiveContentUnavailableError);
      expect(result.error).not.toBeInstanceOf(CloneFailedError);

      const cloneId = saveSpy.mock.calls[0][0].id;
      expect(await projectRepo.findById(cloneId)).toBeNull();
      expect(removeProjectSpy).toHaveBeenCalledWith(cloneId);
    });

    test('purges no collaborative state, because a clone never persists any', () => {
      const purgers: string[] = [];
      for (const dependency of dependencies) {
        if (dependency !== undefined && 'deleteAllForProject' in dependency) {
          purgers.push(dependency.constructor.name);
        }
      }

      // Deleting a project purges its Yjs state; a clone has none to purge, and a
      // store it could reach would only invite cleanup to delete a room it never
      // wrote. Holding no such collaborator is what makes that impossible.
      expect(purgers).toEqual([]);
    });

    test('a cleanup that fails itself does not hide the failure that caused it', async () => {
      const cause = new Error('document store unavailable');
      jest.spyOn(documentRepo, 'save').mockRejectedValue(cause);
      jest.spyOn(projectRepo, 'delete').mockRejectedValue(new Error('row delete refused'));
      const removeProjectSpy = jest.spyOn(fileStore, 'removeProject');

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(CloneFailedError);
      expect(result.error.cause).toBe(cause);
      // A step that cannot run must not stop the ones after it, nor go unnoticed.
      expect(removeProjectSpy).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
      expect(registry.tryAcquire(OWNER_ID)).toBe(true);
    });

    test('a failure after the copy\'s settings are written leaves none of them behind', async () => {
      await renderConfigRepo.save(
        new ProjectRenderConfig(SOURCE_RENDER_CONFIG_ID, SOURCE_PROJECT_ID, SOURCE_RENDER_CONFIG),
      );
      await seedSourceDictionary(dictionaryRepo);
      cascadeProjectDeletes(projectRepo, renderConfigRepo, dictionaryRepo);

      const saveSpy = jest.spyOn(projectRepo, 'save');
      const configSaveSpy = jest.spyOn(renderConfigRepo, 'save');
      const passThroughAdd = dictionaryRepo.add.bind(dictionaryRepo);
      let terms = 0;
      const addSpy = jest.spyOn(dictionaryRepo, 'add').mockImplementation(async (term: ProjectDictionaryTerm) => {
        terms += 1;
        if (terms === 2) throw new Error('dictionary store unavailable');
        await passThroughAdd(term);
      });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(CloneFailedError);

      const cloneId = saveSpy.mock.calls[0][0].id;
      // The copy had a configuration and a term of its own before it failed, so
      // there is something for the cleanup to have missed.
      expect(configSaveSpy).toHaveBeenCalledWith(expect.objectContaining({ projectId: cloneId }));
      expect(addSpy).toHaveBeenCalledTimes(2);

      expect(await projectRepo.findById(cloneId)).toBeNull();
      expect(await renderConfigRepo.findByProjectId(cloneId)).toBeNull();
      expect(await dictionaryRepo.listByProject(cloneId)).toEqual([]);
      expect(await fileStore.read(cloneId, FilePath.create('/index.adoc'))).toBeNull();
      expect(await projectMemberRepo.findByProjectId(cloneId)).toEqual([]);

      // The source keeps everything the failed copy had read from it.
      expect(await renderConfigRepo.findByProjectId(SOURCE_PROJECT_ID)).not.toBeNull();
      expect(await dictionaryRepo.listByProject(SOURCE_PROJECT_ID)).toHaveLength(2);
    });

    test('a source deleted once its content had been read still yields a faithful copy', async () => {
      const passThroughWrite = fileStore.write.bind(fileStore);
      jest
        .spyOn(fileStore, 'write')
        .mockImplementation(async (projectId: ProjectId, filePath: FilePath, content: Buffer) => {
          await passThroughWrite(projectId, filePath, content);
          if (filePath.value === '/chapters/appendix/notes.adoc') {
            // The last byte the clone needed is in. Everything the source held
            // disappears now, while the clone still has rows left to write.
            await projectRepo.delete(SOURCE_PROJECT_ID);
          }
        });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(true);
      if (!result.success) return;

      const cloneId = result.value.project.id;
      for (const [path, bytes] of SOURCE_FILE_BYTES) {
        const copied = await fileStore.read(cloneId, FilePath.create(path));
        expect(copied?.equals(bytes)).toBe(true);
      }
      expect(await projectMemberRepo.findByProjectId(cloneId)).toHaveLength(1);
    });

    test('a source whose files vanish mid-clone fails cleanly, leaving no half-copied project', async () => {
      const saveSpy = jest.spyOn(projectRepo, 'save');
      const removeProjectSpy = jest.spyOn(fileStore, 'removeProject');
      const passThroughWrite = fileStore.write.bind(fileStore);
      jest
        .spyOn(fileStore, 'write')
        .mockImplementation(async (projectId: ProjectId, filePath: FilePath, content: Buffer) => {
          await passThroughWrite(projectId, filePath, content);
          if (filePath.value === '/index.adoc') {
            await fileStore.removeProject(SOURCE_PROJECT_ID);
          }
        });

      const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Handbook copy');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(CloneFailedError);

      const cloneId = saveSpy.mock.calls[0][0].id;
      expect(await projectRepo.findById(cloneId)).toBeNull();
      expect(removeProjectSpy).toHaveBeenCalledWith(cloneId);
      expect(await fileStore.read(cloneId, FilePath.create('/index.adoc'))).toBeNull();
      expect(await projectMemberRepo.findByProjectId(cloneId)).toEqual([]);
    });
  });

  test('a source whose tree is only its root folder is copied as a clone with only its root', async () => {
    const result = await useCase.execute(OWNER_ID, SOURCE_PROJECT_ID, 'Runbook');

    expect(result.success).toBe(true);
    if (!result.success) return;

    const cloneNodes = await fileNodeRepo.findByProjectId(result.value.project.id);
    expect(shapesOf(cloneNodes)).toEqual([{ path: '/', name: 'Runbook', type: 'folder' }]);
    expect(result.value.project.rootFolderId?.value).toBe(cloneNodes[0].id.value);
  });
});
