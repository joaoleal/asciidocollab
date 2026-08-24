import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {
  Document,
  DocumentId,
  ContentId,
  YjsStateId,
  Email,
  FileNode,
  FileNodeId,
  FileNodeType,
  FilePath,
  MimeType,
  Project,
  ProjectId,
  ProjectMember,
  ProjectName,
  Role,
  Timestamps,
  User,
  UserId,
} from '@asciidocollab/domain';
import { InMemoryActiveCloneRegistry } from '@asciidocollab/infrastructure';
import { cloneRoutes } from '../../../src/routes/projects/clone';
import { projectRoutes } from '../../../src/routes/projects';
import { errorHandler } from '../../../src/plugins/error-handler';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const SOURCE_PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const ROOT_FOLDER_ID = '550e8400-e29b-41d4-a716-446655440003';
const FILE_NODE_ID = '550e8400-e29b-41d4-a716-446655440004';
const DOCUMENT_ID = '550e8400-e29b-41d4-a716-446655440005';

/** The project-relative path the source's one document occupies. */
const DOCUMENT_PATH = '/chapters/intro.adoc';

interface HarnessOptions {
  /** The actor's role in the source project, or null when they are not a member. */
  role?: string | null;
  /** Registry the route shares across requests; a fresh one per harness by default. */
  registry?: InMemoryActiveCloneRegistry;
  /** Maximum clone requests the rate limiter allows in the window. */
  rateLimitMax?: number;
  /** Length of that window in milliseconds. */
  rateLimitWindow?: number;
  /** What the live-content reader answers when the document's room is open. */
  liveContent?: { success: true; value: string | null } | { success: false; error: Error };
  /** Whether the source document has an open collaboration room. */
  sessionActive?: boolean;
  /** Empties the file store, so a file row has no bytes behind it. */
  missingBytes?: boolean;
}

interface Harness {
  /** The server under test, already awaited and ready. */
  app: FastifyInstance;
  /** Project rows the run wrote, newest last. */
  savedProjects: Project[];
  /** Membership rows the run wrote. */
  savedMembers: ProjectMember[];
  /** Audit entries the run wrote. */
  savedAudits: { action: string }[];
}

/**
 * Rebuilds a saved project the way the database gives it back.
 *
 * The real mapper cannot return a root folder id — there is no column for one, so every project it
 * reconstructs reports none, whatever the entity that was saved had set. A fake that hands back the
 * very instance it stored is more generous than production and hides exactly that: a response
 * describing the in-memory entity would carry a root folder id the dashboard's next refresh
 * contradicts, and a test comparing two such entities would never notice.
 *
 * @param project - The entity as it was saved.
 * @returns An equivalent entity carrying only what a read can actually recover.
 */
function asStored(project: Project): Project {
  return new Project(
    project.id,
    project.name,
    project.description,
    [...project.tags],
    null,
    new Timestamps(project.createdAt, project.updatedAt),
    project.archivedAt,
    project.mainFileNodeId,
    project.language,
  );
}

function sourceProject(): Project {
  return new Project(
    ProjectId.create(SOURCE_PROJECT_ID),
    ProjectName.create('Team Handbook'),
    'Everything the team needs',
    ['handbook'],
    FileNodeId.create(ROOT_FOLDER_ID),
    new Timestamps(),
    null,
    FileNodeId.create(FILE_NODE_ID),
    'en',
  );
}

function sourceNodes(): FileNode[] {
  return [
    new FileNode(
      FileNodeId.create(ROOT_FOLDER_ID),
      ProjectId.create(SOURCE_PROJECT_ID),
      null,
      'Team Handbook',
      FileNodeType.create('folder'),
      FilePath.create('/'),
    ),
    new FileNode(
      FileNodeId.create(FILE_NODE_ID),
      ProjectId.create(SOURCE_PROJECT_ID),
      FileNodeId.create(ROOT_FOLDER_ID),
      'intro.adoc',
      FileNodeType.create('file'),
      FilePath.create(DOCUMENT_PATH),
    ),
  ];
}

function sourceDocument(): Document {
  return new Document(
    DocumentId.create(DOCUMENT_ID),
    FileNodeId.create(FILE_NODE_ID),
    ContentId.create('550e8400-e29b-41d4-a716-446655440006'),
    YjsStateId.create('550e8400-e29b-41d4-a716-446655440007'),
    MimeType.create('text/asciidoc'),
  );
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const {
    role = 'viewer',
    registry = new InMemoryActiveCloneRegistry(),
    rateLimitMax = 20,
    rateLimitWindow = 60_000,
    liveContent = { success: true, value: 'live text' },
    sessionActive = false,
    missingBytes = false,
  } = options;

  const savedProjects: Project[] = [];
  const savedMembers: ProjectMember[] = [];
  const savedAudits: { action: string }[] = [];
  const savedNodes: FileNode[] = [];

  const app = Fastify();
  // The same handler the application installs globally, so the codes a rejected
  // body or an exhausted rate limit produce here are the ones callers really see.
  app.setErrorHandler(errorHandler);
  await app.register(rateLimit, { global: false });
  app.decorate('config', {
    project: { clone: { rateLimitMax, rateLimitWindow } },
  } as never);
  app.decorate('services', { activeCloneRegistry: registry } as never);
  app.decorate('repos', {
    project: {
      findById: jest.fn(async (projectId: ProjectId) => {
        if (projectId.value === SOURCE_PROJECT_ID) return sourceProject();
        const saved = savedProjects.find((project) => project.id.value === projectId.value);
        return saved === undefined ? null : asStored(saved);
      }),
      save: jest.fn(async (project: Project) => {
        const existing = savedProjects.findIndex((saved) => saved.id.value === project.id.value);
        if (existing === -1) savedProjects.push(project);
        else savedProjects[existing] = project;
      }),
      findByMemberId: jest.fn(async (userId: UserId) => {
        const projects = savedProjects
          .filter((project) =>
            savedMembers.some(
              (member) => member.projectId.value === project.id.value && member.userId.value === userId.value,
            ),
          )
          .map(asStored);
        return { projects, total: projects.length, page: 1, limit: 20, totalPages: 1 };
      }),
      delete: jest.fn(async (projectId: ProjectId) => {
        const at = savedProjects.findIndex((saved) => saved.id.value === projectId.value);
        if (at !== -1) savedProjects.splice(at, 1);
      }),
    },
    projectMember: {
      findByCompositeKey: jest.fn(async (_projectId: ProjectId, _userId: UserId) =>
        role === null ? null : new ProjectMember(ProjectId.create(SOURCE_PROJECT_ID), UserId.create(ACTOR_ID), Role.create(role)),
      ),
      findByProjectId: jest.fn(async (projectId: ProjectId) =>
        savedMembers.filter((member) => member.projectId.value === projectId.value),
      ),
      addMember: jest.fn(async (member: ProjectMember) => {
        savedMembers.push(member);
      }),
    },
    fileNode: {
      findByProjectId: jest.fn(async (projectId: ProjectId) =>
        projectId.value === SOURCE_PROJECT_ID
          ? sourceNodes()
          : savedNodes.filter((node) => node.projectId.value === projectId.value),
      ),
      save: jest.fn(async (node: FileNode) => {
        savedNodes.push(node);
      }),
    },
    document: {
      findByFileNodeIds: jest.fn(async (ids: FileNodeId[]) =>
        ids.some((id) => id.value === FILE_NODE_ID) ? [sourceDocument()] : [],
      ),
      save: jest.fn(async () => undefined),
    },
    asset: {
      findById: jest.fn(async () => null),
      findByIds: jest.fn(async () => []),
      save: jest.fn(async () => undefined),
    },
    auditLog: {
      save: jest.fn(async (entry: { action: string }) => {
        savedAudits.push(entry);
      }),
    },
    collaborationSession: {
      isActive: jest.fn(async () => sessionActive),
      // The clone resolves live sessions in one batch (findActiveDocumentIds) rather than one
      // isActive call per document, so the double answers the same toggle in that shape: the source
      // document's id is active exactly when sessionActive, keyed on the id the resolver checks.
      findActiveDocumentIds: jest.fn(async () => (sessionActive ? [sourceDocument().id] : [])),
    },
    projectRenderConfig: {
      findByProjectId: jest.fn(async () => null),
      save: jest.fn(async () => undefined),
    },
    projectDictionary: {
      listByProject: jest.fn(async () => []),
      add: jest.fn(async () => undefined),
    },
    user: {
      findById: jest.fn(async (userId: UserId) =>
        userId.value === ACTOR_ID
          ? new User(
              UserId.create(ACTOR_ID),
              Email.create('ada@example.com'),
              'Ada Lovelace',
              'hash',
              [],
              null,
              null,
            )
          : null,
      ),
    },
  } as never);
  app.decorate('stores', {
    fileStore: {
      createDirectory: jest.fn(async () => undefined),
      read: jest.fn(async () => (missingBytes ? null : Buffer.from('stored text', 'utf8'))),
      write: jest.fn(async () => undefined),
      removeProject: jest.fn(async () => undefined),
    },
    collaborativeContentEditor: {
      readContent: jest.fn(async () => liveContent),
    },
  } as never);

  await app.register(cloneRoutes);
  // Registered alongside so the copy's shape can be compared against the list's
  // in one process, against one set of repositories.
  await app.register(projectRoutes);
  await app.ready();

  return { app, savedProjects, savedMembers, savedAudits };
}

function clone(app: FastifyInstance, payload: Record<string, unknown>, projectId = SOURCE_PROJECT_ID) {
  return app.inject({ method: 'POST', url: `/api/projects/${projectId}/clone`, payload });
}

describe('POST /api/projects/:projectId/clone', () => {
  it('answers 201 with the copy when a member clones a project', async () => {
    const { app, savedProjects, savedMembers } = await buildHarness({ role: 'viewer' });

    const response = await clone(app, { name: 'Handbook 2027' });

    expect(response.statusCode).toBe(201);
    const { data } = response.json();
    expect(data.name).toBe('Handbook 2027');
    expect(data.id).not.toBe(SOURCE_PROJECT_ID);
    expect(savedProjects).toHaveLength(1);
    expect(savedMembers).toHaveLength(1);

    await app.close();
  });

  it('records the copy and the source read in the audit trail', async () => {
    const { app, savedAudits } = await buildHarness();

    await clone(app, { name: 'Handbook 2027' });

    expect(savedAudits.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['project.cloned', 'project.clone_requested']),
    );

    await app.close();
  });

  it('rejects a request with no name before any project row is written', async () => {
    const { app, savedProjects } = await buildHarness();

    const response = await clone(app, {});

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(savedProjects).toHaveLength(0);

    await app.close();
  });

  it('rejects a name longer than the boundary allows', async () => {
    const { app, savedProjects } = await buildHarness();

    const response = await clone(app, { name: 'x'.repeat(101) });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(savedProjects).toHaveLength(0);

    await app.close();
  });
});

describe('POST /api/projects/:projectId/clone refusals', () => {
  it('answers 400 when the name is nothing but whitespace', async () => {
    const { app, savedProjects } = await buildHarness();

    const response = await clone(app, { name: '   ' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(savedProjects).toHaveLength(0);

    await app.close();
  });

  it('answers 403 when the caller is not a member of the source', async () => {
    const { app, savedProjects } = await buildHarness({ role: null });

    const response = await clone(app, { name: 'Handbook 2027' });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect(savedProjects).toHaveLength(0);

    await app.close();
  });

  it('answers 403 rather than 404 for a project that does not exist, so membership cannot be probed', async () => {
    const { app } = await buildHarness({ role: null });

    const missing = await clone(app, { name: 'Handbook 2027' }, '550e8400-e29b-41d4-a716-4466554400ff');
    const forbidden = await clone(app, { name: 'Handbook 2027' });

    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toEqual(forbidden.json());

    await app.close();
  });

  it('answers 400 for an id that is not an identifier at all, rather than failing inside', async () => {
    const { app, savedProjects } = await buildHarness();

    const response = await clone(app, { name: 'Handbook 2027' }, 'not-a-uuid');

    // Constructing the id used to throw past every handler on this route, so client garbage came
    // back as a 500 with a stack trace in the log. A malformed id is a bad request, and answering it
    // as one leaks nothing: it separates "not an identifier" from "an identifier", never one
    // project from another.
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(savedProjects).toHaveLength(0);

    await app.close();
  });

  it('answers 409 when the caller already has a clone running', async () => {
    const registry = new InMemoryActiveCloneRegistry();
    registry.tryAcquire(UserId.create(ACTOR_ID));
    const { app, savedProjects } = await buildHarness({ registry });

    const response = await clone(app, { name: 'Handbook 2027' });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CLONE_IN_PROGRESS');
    expect(savedProjects).toHaveLength(0);

    await app.close();
  });

  it('answers 429 once the caller has spent the clone rate limit', async () => {
    const { app } = await buildHarness({ rateLimitMax: 1 });

    const first = await clone(app, { name: 'Handbook 2027' });
    const second = await clone(app, { name: 'Handbook 2028' });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('RATE_LIMITED');

    await app.close();
  });

  it('tells the caller to come back when the window really ends, not a minute from now', async () => {
    // An hour, because the production window is one and a minute-long window here would agree with
    // the fallback by accident. The refusal used to advertise 60 seconds whatever the window was:
    // the rate limiter puts the remaining time on the REPLY and throws an error carrying no headers,
    // and the handler read the error.
    const { app } = await buildHarness({ rateLimitMax: 1, rateLimitWindow: 3_600_000 });

    await clone(app, { name: 'Handbook 2027' });
    const refused = await clone(app, { name: 'Handbook 2028' });

    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.retryAfter).toBeGreaterThan(3000);
    expect(refused.headers['retry-after']).toBe('3600');

    await app.close();
  });

  it('answers 503 naming the document whose live content could not be read', async () => {
    const { app, savedProjects } = await buildHarness({
      sessionActive: true,
      liveContent: { success: false, error: new Error('the collaboration server is unreachable') },
    });

    const response = await clone(app, { name: 'Handbook 2027' });

    expect(response.statusCode).toBe(503);
    const { error } = response.json();
    expect(error.code).toBe('LIVE_CONTENT_UNAVAILABLE');
    // The project-relative path the caller already sees in their own file tree —
    // never a storage path resolved against the file store's root.
    expect(error.details).toEqual({ path: DOCUMENT_PATH });
    expect(error.message).toContain(DOCUMENT_PATH);
    expect(savedProjects).toHaveLength(0);

    await app.close();
  });

  it('answers 500 when the copy fails for any other reason', async () => {
    const { app, savedProjects } = await buildHarness({ missingBytes: true });

    const response = await clone(app, { name: 'Handbook 2027' });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('CLONE_FAILED');
    expect(savedProjects).toHaveLength(0);

    await app.close();
  });
});

describe('the created copy as the dashboard receives it', () => {
  it('carries the same fields the project list serves for that project', async () => {
    // The dashboard inserts this response straight into its list without a
    // follow-up fetch, so a narrower body renders a card with blank counts.
    const { app } = await buildHarness();

    const created = await clone(app, { name: 'Handbook 2027' });
    const listed = await app.inject({ method: 'GET', url: '/api/projects' });

    expect(created.statusCode).toBe(201);
    expect(listed.statusCode).toBe(200);

    const copy = created.json().data;
    const [asListed] = listed.json().data;

    expect(Object.keys(copy).toSorted()).toEqual(Object.keys(asListed).toSorted());
    expect(copy).toEqual(asListed);

    await app.close();
  });

  it('describes the copy as an active project the caller alone owns', async () => {
    const { app } = await buildHarness({ role: 'viewer' });

    const created = await clone(app, { name: 'Handbook 2027' });
    const { data } = created.json();

    expect(data).toEqual({
      id: expect.any(String),
      name: 'Handbook 2027',
      description: 'Everything the team needs',
      owners: [{ userId: ACTOR_ID, displayName: 'Ada Lovelace' }],
      tags: ['handbook'],
      // Null, and deliberately so: a project's root folder is not a stored field, so every read of
      // this project — including the dashboard's next refresh — reports none. Answering with the id
      // the freshly built entity happens to hold would put a value here that the very next request
      // contradicts.
      rootFolderId: null,
      mainFileNodeId: expect.any(String),
      language: 'en',
      archivedAt: null,
      memberCount: 1,
      // The source's one file, counted from the copy's own tree.
      fileCount: 1,
      role: 'owner',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(data.mainFileNodeId).not.toBe(FILE_NODE_ID);

    await app.close();
  });

  it('still reports the real counts when only the owner display names cannot be read', async () => {
    const { app, savedMembers } = await buildHarness();
    // Break only the cosmetic read. The copy's membership rows and file nodes are already in hand
    // by the time it runs, so the card must still get the counts that were read: "0 files" over a
    // copy that has files is a confident wrong number, worse than the blank it would replace.
    app.repos.user.findById = jest.fn(async () => {
      throw new Error('connection reset');
    });

    const created = await clone(app, { name: 'Handbook 2027' });

    expect(created.statusCode).toBe(201);
    expect(created.json().data).toEqual({
      id: expect.any(String),
      name: 'Handbook 2027',
      description: 'Everything the team needs',
      // The caller is the copy's only owner, but naming them needs the read that just failed, and a
      // blank display name rendered as if it were real is worse than an empty list.
      owners: [],
      tags: ['handbook'],
      // Null for the same reason the described copy reports null: a project's root folder is not a
      // stored field, so answering with the id the freshly built entity happens to hold would put a
      // value here that no later read of this project can ever return.
      rootFolderId: null,
      mainFileNodeId: expect.any(String),
      language: 'en',
      archivedAt: null,
      // Both counts are read from the copy's own rows, not stated: the source's one file is counted
      // in the copy's tree exactly as the fully described body counts it.
      memberCount: 1,
      fileCount: 1,
      role: 'owner',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(savedMembers).toHaveLength(1);

    await app.close();
  });

  it('still answers 201 when the copy cannot be described, because the copy exists either way', async () => {
    const { app, savedMembers } = await buildHarness();
    // Break a read the description cannot work around — the copy's membership rows, which the two
    // counts and the caller's role all come from. The clone itself has already committed by the
    // time it runs, so a blip here must not be reported as a failure to copy: the user would be
    // told nothing happened while their new project sat in the list behind the message.
    app.repos.projectMember.findByProjectId = jest.fn(async () => {
      throw new Error('connection reset');
    });

    const created = await clone(app, { name: 'Handbook 2027' });

    expect(created.statusCode).toBe(201);
    expect(created.json().data).toEqual({
      id: expect.any(String),
      name: 'Handbook 2027',
      description: 'Everything the team needs',
      // The caller is the copy's only owner, but naming them needs the read that just failed, and a
      // blank display name rendered as if it were real is worse than an empty list.
      owners: [],
      tags: ['handbook'],
      // Null for the same reason the described copy reports null: a project's root folder is not a
      // stored field, so answering with the id the freshly built entity happens to hold would put a
      // value here that no later read of this project can ever return.
      rootFolderId: null,
      mainFileNodeId: expect.any(String),
      language: 'en',
      archivedAt: null,
      // Known by construction rather than read: the single owner membership row is the write that
      // commits a clone, so a copy that got this far has exactly one member and the caller owns it.
      memberCount: 1,
      role: 'owner',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    // Genuinely unknown here, and said so by being absent rather than answered with a zero the copy
    // would contradict. The field is optional for exactly this, and the card drops the file chip
    // when it is missing instead of claiming a count.
    expect(created.json().data).not.toHaveProperty('fileCount');
    expect(savedMembers).toHaveLength(1);

    await app.close();
  });

  it('answers with the same fields whether or not the copy could be described', async () => {
    // The expected field set is taken from the described body rather than written out again here,
    // so a field added to one path and forgotten in the other fails this test instead of reaching
    // the dashboard as a card with a missing count.
    const described = await buildHarness();
    const undescribable = await buildHarness();
    undescribable.app.repos.projectMember.findByProjectId = jest.fn(async () => {
      throw new Error('connection reset');
    });

    const full = await clone(described.app, { name: 'Handbook 2027' });
    const reduced = await clone(undescribable.app, { name: 'Handbook 2027' });

    expect(full.statusCode).toBe(201);
    expect(reduced.statusCode).toBe(201);
    // Every field the described body carries but one. `fileCount` comes from the read that failed
    // and cannot be recovered or guessed, so it is left out rather than answered with a zero the
    // copy would contradict; the field is optional so absence can say that, and the card drops the
    // file chip instead of claiming a number. Naming that single exclusion here rather than
    // loosening the comparison keeps this test failing for any other field that quietly stops
    // being sent.
    expect(Object.keys(reduced.json().data).toSorted()).toEqual(
      Object.keys(full.json().data)
        .filter((field) => field !== 'fileCount')
        .toSorted(),
    );

    await described.app.close();
    await undescribable.app.close();
  });
});
