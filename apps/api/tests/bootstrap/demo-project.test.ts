import { promises as fs } from 'fs';
import path from 'path';
import { Buffer } from 'buffer';
import type {
  ProjectRepository,
  ProjectMemberRepository,
  FileNodeRepository,
  DocumentRepository,
  AssetRepository,
  ProjectRenderConfigRepository,
  ProjectDictionaryRepository,
  ProjectFileStore,
  Project,
  ProjectMember,
  FileNode,
  Document,
  Asset,
  ProjectRenderConfig,
  ProjectDictionaryTerm,
} from '@asciidocollab/domain';
import { ProjectId, UserId, FilePath } from '@asciidocollab/domain';
import {
  provisionDemoProject,
  ensureDemoProjectMembership,
  backfillDemoViewerMemberships,
  DEMO_PROJECT_ID,
  DEMO_PROJECT_NAME,
  DEMO_MAIN_FILE_ID,
  DEMO_FOLDERS,
  DEMO_FILES,
  DEMO_DICTIONARY_TERMS,
  DEMO_DICTIONARY_AUTHOR_ID,
  DEMO_CONTENT_HASH_KEY,
  loadDemoAssetBytes,
  computeDemoContentHash,
  type DemoProjectDeps,
  type DemoMembershipStore,
} from '../../src/bootstrap/demo-project';

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'demo-project');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** In-memory state the fake repositories/store read and write, for assertions. */
interface FakeState {
  projects: Map<string, Project>;
  members: Map<string, ProjectMember>;
  fileNodes: Map<string, FileNode>;
  documents: Map<string, Document>;
  assets: Map<string, Asset>;
  renderConfigs: Map<string, ProjectRenderConfig>;
  dictionaryTerms: Map<string, ProjectDictionaryTerm>;
  fileBytes: Map<string, Buffer>;
  settings: Map<string, string>;
  users: string[];
  removedProjects: string[];
}

const memberKey = (projectId: string, userId: string): string => `${projectId}:${userId}`;

/**
 * Builds a full set of in-memory fakes plus the state they operate on. Only the
 * methods the provisioner exercises are implemented; the rest are present to
 * satisfy the interfaces and throw if unexpectedly called.
 */
function makeDeps(overrides?: { failDocumentSave?: string; failWith?: unknown }): {
  deps: DemoProjectDeps;
  state: FakeState;
  logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
} {
  const state: FakeState = {
    projects: new Map(),
    members: new Map(),
    fileNodes: new Map(),
    documents: new Map(),
    assets: new Map(),
    renderConfigs: new Map(),
    dictionaryTerms: new Map(),
    fileBytes: new Map(),
    settings: new Map(),
    users: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
    removedProjects: [],
  };

  const projectRepo: ProjectRepository = {
    findById: async (id) => state.projects.get(id.value) ?? null,
    findByMemberId: async () => ({ projects: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
    save: async (project) => {
      state.projects.set(project.id.value, project);
    },
    archive: async () => undefined,
    restore: async () => undefined,
    delete: async (id) => {
      state.projects.delete(id.value);
      // `ProjectDictionaryTerm.projectId` is `onDelete: Cascade`, so a torn-down demo takes its
      // seeded terms with it — model that, or a "rebuild" test would silently assert stale rows.
      for (const [termId, term] of state.dictionaryTerms) {
        if (term.projectId.value === id.value) state.dictionaryTerms.delete(termId);
      }
      state.removedProjects.push(id.value);
    },
  };

  const memberRepo: ProjectMemberRepository = {
    findByProjectId: async (projectId) =>
      [...state.members.values()].filter((m) => m.projectId.value === projectId.value),
    findByUserId: async () => [],
    findByCompositeKey: async (projectId, userId) =>
      state.members.get(memberKey(projectId.value, userId.value)) ?? null,
    addMember: async (member) => {
      state.members.set(memberKey(member.projectId.value, member.userId.value), member);
    },
    removeMember: async () => undefined,
    updateRole: async () => undefined,
    findSoleOwnerProjects: async () => [],
  };

  const fileNodeRepo = {
    save: async (node: FileNode) => {
      state.fileNodes.set(node.id.value, node);
    },
  } as unknown as FileNodeRepository;

  const documentRepo = {
    save: async (document: Document) => {
      if (overrides?.failDocumentSave && document.fileNodeId.value === overrides.failDocumentSave) {
        throw 'failWith' in (overrides ?? {}) ? overrides.failWith : new Error('simulated document save failure');
      }
      state.documents.set(document.id.value, document);
    },
  } as unknown as DocumentRepository;

  const assetRepo = {
    save: async (asset: Asset) => {
      state.assets.set(asset.id.value, asset);
    },
  } as unknown as AssetRepository;

  const renderConfigRepo = {
    findByProjectId: async (projectId: ProjectId) => state.renderConfigs.get(projectId.value) ?? null,
    save: async (config: ProjectRenderConfig) => {
      state.renderConfigs.set(config.projectId.value, config);
    },
  } as unknown as ProjectRenderConfigRepository;

  const dictionaryRepo = {
    add: async (term: ProjectDictionaryTerm) => {
      state.dictionaryTerms.set(term.id.value, term);
    },
  } as unknown as ProjectDictionaryRepository;

  const systemSettingRepo = {
    get: async (key: string) => state.settings.get(key) ?? null,
    set: async (key: string, value: string) => {
      state.settings.set(key, value);
    },
  };

  const fileStore = {
    write: async (projectId: ProjectId, filePath: FilePath, content: Buffer) => {
      state.fileBytes.set(`${projectId.value}${filePath.value}`, content);
    },
    removeProject: async (projectId: ProjectId) => {
      const keys = [...state.fileBytes.keys()];
      for (const key of keys) {
        if (key.startsWith(projectId.value)) state.fileBytes.delete(key);
      }
    },
  } as unknown as ProjectFileStore;

  const prisma: DemoMembershipStore = {
    user: { findMany: async () => state.users.map((id) => ({ id })) },
    projectMember: {
      createMany: async ({ data, skipDuplicates }) => {
        let count = 0;
        for (const row of data) {
          const key = memberKey(row.projectId, row.userId);
          if (skipDuplicates && state.members.has(key)) continue;
          state.members.set(
            key,
            { projectId: ProjectId.create(row.projectId), userId: UserId.create(row.userId), role: { value: row.role.toLowerCase() } } as unknown as ProjectMember,
          );
          count += 1;
        }
        return { count };
      },
    },
  };

  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const deps: DemoProjectDeps = {
    repos: {
      project: projectRepo,
      projectMember: memberRepo,
      fileNode: fileNodeRepo,
      document: documentRepo,
      asset: assetRepo,
      projectRenderConfig: renderConfigRepo,
      projectDictionary: dictionaryRepo,
      systemSetting: systemSettingRepo,
    },
    fileStore,
    prisma,
    dataDir: DATA_DIR,
    logger,
  };

  return { deps, state, logger };
}

describe('demo-project manifest integrity', () => {
  it('references source files that all exist on disk', async () => {
    for (const file of DEMO_FILES) {
      const resolved = path.join(DATA_DIR, file.source);
      await expect(fs.access(resolved)).resolves.toBeUndefined();
    }
  });

  it('uses valid UUID v4 ids everywhere and a single main file', () => {
    const ids = [
      DEMO_PROJECT_ID,
      ...DEMO_FOLDERS.map((f) => f.id),
      ...DEMO_FILES.flatMap((f) =>
        f.kind === 'text' ? [f.id, f.documentId, f.contentId, f.yjsStateId] : [f.id],
      ),
      ...DEMO_DICTIONARY_TERMS.map((t) => t.id),
      DEMO_DICTIONARY_AUTHOR_ID,
    ];
    for (const id of ids) expect(id).toMatch(UUID_V4);

    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    expect(DEMO_FILES.filter((f) => f.isMain)).toHaveLength(1);
    expect(DEMO_FILES.find((f) => f.isMain)?.id).toBe(DEMO_MAIN_FILE_ID);
  });

  it('has unique file paths', () => {
    const paths = DEMO_FILES.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('reads a real bundled source file and rejects a path escaping the data directory', async () => {
    const bytes = await loadDemoAssetBytes(DATA_DIR, 'index.adoc');
    expect(bytes.length).toBeGreaterThan(0);
    await expect(loadDemoAssetBytes(DATA_DIR, '../../../etc/passwd')).rejects.toThrow(/escapes/);
  });
});

describe('provisionDemoProject', () => {
  it('seeds the project, files, render config, and grants read to existing users', async () => {
    const { deps, state } = makeDeps();

    await provisionDemoProject(deps);

    const project = state.projects.get(DEMO_PROJECT_ID);
    expect(project?.name.value).toBe(DEMO_PROJECT_NAME);
    expect(project?.mainFileNodeId?.value).toBe(DEMO_MAIN_FILE_ID);

    // Every folder and file node was created, plus bytes for each file.
    expect(state.fileNodes.size).toBe(DEMO_FOLDERS.length + DEMO_FILES.length);
    expect(state.fileBytes.size).toBe(DEMO_FILES.length);

    // Text files became documents; the SVG became an asset.
    expect(state.documents.size).toBe(DEMO_FILES.filter((f) => f.kind === 'text').length);
    expect(state.assets.size).toBe(DEMO_FILES.filter((f) => f.kind === 'asset').length);

    // Render config selects the bundled theme.
    expect(state.renderConfigs.get(DEMO_PROJECT_ID)?.config.pdfTheme).toBe('theme/showcase-theme.yml');

    // Both existing users can read it, and NOBODY is an editor/owner.
    const members = [...state.members.values()].filter((m) => m.projectId.value === DEMO_PROJECT_ID);
    expect(members).toHaveLength(2);
    expect(members.every((m) => m.role.value === 'viewer')).toBe(true);
  });

  it('ships the tutorial vocabulary in the project dictionary, so the checker does not flag it', async () => {
    // The three names the tour repeats on nearly every page. They MUST be seeded: the demo grants
    // every user `VIEWER`, and adding a term needs editor/owner, so there is no one who could accept
    // them afterwards — an unseeded demo would underline its own subject matter forever.
    const { deps, state } = makeDeps();

    await provisionDemoProject(deps);

    const terms = [...state.dictionaryTerms.values()]
      .filter((term) => term.projectId.value === DEMO_PROJECT_ID)
      .map((term) => term.term);
    expect(terms).toEqual(expect.arrayContaining(['AsciiDoc', 'Asciidoctor', 'AsciidoCollab']));
    expect(terms).toHaveLength(DEMO_DICTIONARY_TERMS.length);
  });

  it('attributes the seeded terms to the fixed bootstrap identity, not to a real account', async () => {
    const { deps, state } = makeDeps();
    await provisionDemoProject(deps);
    for (const term of state.dictionaryTerms.values()) {
      expect(term.createdByUserId.value).toBe(DEMO_DICTIONARY_AUTHOR_ID);
    }
  });

  it('re-seeds the dictionary exactly once when the demo is rebuilt', async () => {
    // The terms carry fixed ids and the project delete cascades, so a refresh must leave the same
    // three rows — not six, and not none.
    const { deps, state } = makeDeps();
    await provisionDemoProject(deps);
    state.settings.set(DEMO_CONTENT_HASH_KEY, 'stale-hash-from-an-older-version');

    await provisionDemoProject(deps);

    expect(state.dictionaryTerms.size).toBe(DEMO_DICTIONARY_TERMS.length);
  });

  it('stores the content hash on seed and leaves the demo untouched when it matches', async () => {
    const { deps, state } = makeDeps();

    await provisionDemoProject(deps);
    const seededHash = state.settings.get(DEMO_CONTENT_HASH_KEY);
    expect(seededHash).toBe(await computeDemoContentHash(DATA_DIR));

    const nodesAfterFirst = state.fileNodes.size;
    const membersAfterFirst = state.members.size;
    state.removedProjects.length = 0;

    await provisionDemoProject(deps); // hash matches → no rebuild

    expect(state.removedProjects).toHaveLength(0);
    expect(state.projects.size).toBe(1);
    expect(state.fileNodes.size).toBe(nodesAfterFirst);
    expect(state.members.size).toBe(membersAfterFirst);
  });

  it('rebuilds the demo on start-up when the stored content hash is outdated', async () => {
    const { deps, state, logger } = makeDeps();

    await provisionDemoProject(deps);
    const currentHash = state.settings.get(DEMO_CONTENT_HASH_KEY);

    // Simulate a prior install seeded from older content.
    state.settings.set(DEMO_CONTENT_HASH_KEY, 'stale-hash-from-an-older-version');
    state.removedProjects.length = 0;
    logger.info.mockClear();

    await provisionDemoProject(deps); // mismatch → tear down + rebuild

    expect(state.removedProjects).toContain(DEMO_PROJECT_ID); // old copy removed
    expect(state.projects.has(DEMO_PROJECT_ID)).toBe(true); // rebuilt
    expect(state.fileBytes.size).toBe(DEMO_FILES.length); // fresh bytes rewritten
    expect(state.settings.get(DEMO_CONTENT_HASH_KEY)).toBe(currentHash); // hash brought current
    // The dictionary is part of the fingerprint, so this rebuild is also how an install that ALREADY
    // has the Guided Tour receives a newly-added term.
    expect(state.dictionaryTerms.size).toBe(DEMO_DICTIONARY_TERMS.length);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ refreshed: true }), expect.any(String));
  });

  it('rolls back a partial creation and does not persist a half-built project', async () => {
    // Fail on the first chapter's document save.
    const firstChapter = DEMO_FILES.find((f) => f.name === '01-welcome.adoc');
    const { deps, state, logger } = makeDeps({ failDocumentSave: firstChapter?.id });

    await expect(provisionDemoProject(deps)).resolves.toBeUndefined(); // never throws

    expect(state.projects.has(DEMO_PROJECT_ID)).toBe(false);
    expect(state.removedProjects).toContain(DEMO_PROJECT_ID);
    expect(state.fileBytes.size).toBe(0); // store tree torn down
    expect(logger.error).toHaveBeenCalled();
  });

  it('logs and swallows even when the failure is not an Error object', async () => {
    const firstChapter = DEMO_FILES.find((f) => f.name === '01-welcome.adoc');
    const { deps, state, logger } = makeDeps({ failDocumentSave: firstChapter?.id, failWith: 'plain string failure' });

    await expect(provisionDemoProject(deps)).resolves.toBeUndefined();

    expect(state.projects.has(DEMO_PROJECT_ID)).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('ensureDemoProjectMembership', () => {
  it('grants a viewer membership to a new user and is idempotent', async () => {
    const { deps, state } = makeDeps();
    await provisionDemoProject(deps);

    const newUser = '33333333-3333-4333-8333-333333333333';
    await ensureDemoProjectMembership(deps, newUser);
    await ensureDemoProjectMembership(deps, newUser); // second call is a no-op

    const membership = state.members.get(memberKey(DEMO_PROJECT_ID, newUser));
    expect(membership?.role.value).toBe('viewer');
    expect([...state.members.values()].filter((m) => m.userId.value === newUser)).toHaveLength(1);
  });

  it('does nothing when the demo project has not been seeded yet', async () => {
    const { deps, state } = makeDeps();
    await ensureDemoProjectMembership(deps, '44444444-4444-4444-8444-444444444444');
    expect(state.members.size).toBe(0);
  });

  it('never throws when the membership store fails', async () => {
    const { deps, logger } = makeDeps();
    await provisionDemoProject(deps);
    deps.repos.projectMember.addMember = async () => {
      throw new Error('db down');
    };
    await expect(
      ensureDemoProjectMembership(deps, '55555555-5555-4555-8555-555555555555'),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never throws when the store rejects with a non-Error value', async () => {
    const { deps } = makeDeps();
    await provisionDemoProject(deps);
    // A non-Error rejection value exercises the `String(error)` branch of the catch.
    const nonError: unknown = { reason: 'not an Error instance' };
    deps.repos.projectMember.addMember = async () => {
      throw nonError;
    };
    await expect(
      ensureDemoProjectMembership(deps, '66666666-6666-4666-8666-666666666666'),
    ).resolves.toBeUndefined();
  });
});

describe('backfillDemoViewerMemberships', () => {
  it('returns 0 when there are no users', async () => {
    const prisma: DemoMembershipStore = {
      user: { findMany: async () => [] },
      projectMember: { createMany: async () => ({ count: 0 }) },
    };
    expect(await backfillDemoViewerMemberships(prisma)).toBe(0);
  });

  it('inserts a viewer row per user, skipping duplicates', async () => {
    const inserted: Array<{ userId: string; role: string }> = [];
    const prisma: DemoMembershipStore = {
      user: { findMany: async () => [{ id: 'a' }, { id: 'b' }] },
      projectMember: {
        createMany: async ({ data }) => {
          for (const row of data) inserted.push({ userId: row.userId, role: row.role });
          return { count: data.length };
        },
      },
    };
    const count = await backfillDemoViewerMemberships(prisma);
    expect(count).toBe(2);
    expect(inserted.every((r) => r.role === 'VIEWER')).toBe(true);
  });
});
