import {
  Project,
  ProjectMember,
  FileNode,
  Document,
  Asset,
  ProjectRenderConfig,
  ProjectId,
  ProjectName,
  FileNodeId,
  FileNodeType,
  FilePath,
  DocumentId,
  ContentId,
  YjsStateId,
  MimeType,
  ProjectRenderConfigId,
  Role,
  UserId,
  type ProjectRepository,
  type ProjectMemberRepository,
  type FileNodeRepository,
  type DocumentRepository,
  type AssetRepository,
  type ProjectRenderConfigRepository,
  type SystemSettingRepository,
  type ProjectFileStore,
} from '@asciidocollab/domain';
import { normalizeRenderConfig } from '@asciidocollab/shared';
import {
  DEMO_PROJECT_ID,
  DEMO_PROJECT_NAME,
  DEMO_PROJECT_DESCRIPTION,
  DEMO_PROJECT_TAGS,
  DEMO_RENDER_CONFIG,
  DEMO_MAIN_FILE_ID,
  DEMO_FOLDERS,
  DEMO_FILES,
  DEMO_CONTENT_HASH_KEY,
  loadDemoAssetBytes,
  computeDemoContentHash,
  type DemoFileSpec,
} from './manifest';

/**
 * Minimal logger surface the provisioner needs. Satisfied by Fastify's Pino
 * instance (`app.log`); kept structural so the bootstrap can log without pulling
 * in a request context.
 */
export interface BootstrapLogger {
  /**
   * Logs an informational message.
   *
   * @param payload - Structured fields to attach to the log line.
   * @param message - The human-readable message.
   */
  info(payload: Record<string, unknown>, message: string): void;
  /**
   * Logs a warning.
   *
   * @param payload - Structured fields to attach to the log line.
   * @param message - The human-readable message.
   */
  warn(payload: Record<string, unknown>, message: string): void;
  /**
   * Logs an error.
   *
   * @param payload - Structured fields to attach to the log line.
   * @param message - The human-readable message.
   */
  error(payload: Record<string, unknown>, message: string): void;
}

/**
 * The exact Prisma surface the viewer-membership backfill needs: read every
 * user id, then bulk-insert memberships skipping the ones that already exist.
 * Narrowed to a tiny structural interface (rather than the whole `PrismaClient`)
 * so the seeder is unit-testable without a database — the real `PrismaClient`
 * satisfies it structurally.
 */
export interface DemoMembershipStore {
  /** The `user` model delegate, narrowed to the id projection the backfill reads. */
  readonly user: {
    /**
     * Returns the id of every user.
     *
     * @param query - Prisma find-many arguments, narrowed to select only `id`.
     * @returns One `{ id }` per user.
     */
    findMany(query: DemoUserIdQuery): Promise<Array<{ id: string }>>;
  };
  /** The `projectMember` model delegate, narrowed to the bulk insert the backfill performs. */
  readonly projectMember: {
    /**
     * Inserts membership rows, skipping any that already exist.
     *
     * @param input - The rows to insert and the skip-duplicates flag.
     * @returns The number of rows actually inserted.
     */
    createMany(input: DemoMemberCreateManyInput): Promise<{ count: number }>;
  };
}

/** Prisma find-many arguments narrowed to the id-only projection the backfill uses. */
export interface DemoUserIdQuery {
  /** Column projection: select the user id only. */
  select: { id: true };
}

/** Bulk membership-insert arguments used by the backfill. */
export interface DemoMemberCreateManyInput {
  /** The membership rows to insert (one `VIEWER` row per user). */
  data: Array<{ projectId: string; userId: string; role: 'VIEWER' }>;
  /** When true, rows whose composite key already exists are silently skipped. */
  skipDuplicates: boolean;
}

/**
 * Everything the demo-project provisioner touches. Deliberately a narrow slice
 * of the app container (the repositories + the file store it writes, plus the
 * narrowed Prisma surface used only for the efficient bulk membership backfill)
 * so the seeding logic stays testable with in-memory fakes.
 */
export interface DemoProjectDeps {
  /** Repositories used to persist the project's rows. */
  readonly repos: {
    readonly project: ProjectRepository;
    readonly projectMember: ProjectMemberRepository;
    readonly fileNode: FileNodeRepository;
    readonly document: DocumentRepository;
    readonly asset: AssetRepository;
    readonly projectRenderConfig: ProjectRenderConfigRepository;
    readonly systemSetting: SystemSettingRepository;
  };
  /** Filesystem-backed store that holds the user-visible file bytes. */
  readonly fileStore: ProjectFileStore;
  /** Narrowed Prisma surface used only for the single-statement viewer-membership backfill. */
  readonly prisma: DemoMembershipStore;
  /** Absolute path of the bundled `apps/api/data/demo-project` directory. */
  readonly dataDir: string;
  /** Logger for start-up diagnostics. */
  readonly logger: BootstrapLogger;
}

/**
 * Seeds (once) and reconciles (every start-up) the bundled read-only demo
 * project, then grants read access to every existing user.
 *
 * WHY it runs on every API start-up rather than in a migration or a `db seed`
 * hook:
 *   1. The demo's content lives on the FILESYSTEM (the project file store), not
 *      in Postgres — a SQL migration cannot write those bytes.
 *   2. The three schema-application paths this project uses (`prisma db push` in
 *      dev/e2e, `prisma migrate deploy` in prod) do NOT run `prisma db seed`, so
 *      a `seed.ts` would never fire on a real deployment.
 *   3. The requirement is that the demo appears on EXISTING installs after an
 *      upgrade and for their EXISTING users — a start-up reconciler is the only
 *      hook that fires on every `docker compose up` of a new image.
 *
 * Freshness: the bundled content carries a SHA-256 fingerprint (see
 * {@link computeDemoContentHash}) stored in a `SystemSetting`. On every start-up
 * the provisioner compares it against the live bundle. When they match, the demo
 * is left untouched (a cheap no-op). When they differ — a first install, or an
 * upgrade / edit that changed any tutorial file, the theme, the render config, or
 * the tree shape — the existing demo is torn down and rebuilt from the current
 * bundle, so a restart always brings the Guided Tour up to date. The reset also
 * clears the file store (and thus the collaborative Yjs state), so a reopened
 * document is re-seeded from the fresh bytes rather than a stale cached copy.
 *
 * The project and all its rows use fixed ids (see the manifest), so the rebuild
 * is deterministic. A partial failure during (re)creation is rolled back (project
 * row + file bytes removed) so the next start-up retries from a clean slate.
 *
 * This function never throws: seeding a demo must not be able to stop the API
 * from booting. Failures are logged and swallowed.
 *
 * @param deps - Repositories, file store, Prisma surface, data directory and logger.
 * @returns A promise that resolves when provisioning has been attempted.
 */
export async function provisionDemoProject(deps: DemoProjectDeps): Promise<void> {
  const projectId = ProjectId.create(DEMO_PROJECT_ID);
  try {
    const existing = await deps.repos.project.findById(projectId);
    const currentHash = await computeDemoContentHash(deps.dataDir);
    const storedHash = await deps.repos.systemSetting.get(DEMO_CONTENT_HASH_KEY);

    if (!existing || storedHash !== currentHash) {
      // Missing, or the bundled content has changed since it was last seeded.
      // Tear down any stale copy (DB rows + file bytes + Yjs state) and rebuild.
      if (existing) await resetDemoProject(deps, projectId);
      await createDemoProject(deps, projectId);
      await deps.repos.systemSetting.set(DEMO_CONTENT_HASH_KEY, currentHash);
      deps.logger.info(
        { projectId: DEMO_PROJECT_ID, refreshed: Boolean(existing) },
        existing ? 'Refreshed the outdated bundled demo project.' : 'Seeded the bundled demo project.',
      );
    }

    const granted = await backfillDemoViewerMemberships(deps.prisma);
    if (granted > 0) {
      deps.logger.info(
        { projectId: DEMO_PROJECT_ID, granted },
        'Granted read access to the demo project for existing users.',
      );
    }
  } catch (error) {
    // A demo is a nicety, never a boot blocker. Log and continue.
    deps.logger.error(
      { projectId: DEMO_PROJECT_ID, err: error instanceof Error ? error.message : String(error) },
      'Failed to provision the bundled demo project; continuing start-up without it.',
    );
  }
}

/**
 * Creates the demo project's rows and file bytes in dependency order. On any
 * failure it removes the project row (cascading to every child row) and the
 * on-disk tree, then rethrows so the caller can log a clean failure.
 *
 * @param deps - The provisioner dependencies.
 * @param projectId - The (fixed) demo project id.
 * @returns A promise that resolves once the project is fully built.
 */
async function createDemoProject(deps: DemoProjectDeps, projectId: ProjectId): Promise<void> {
  try {
    // 1. The project row first (FileNode.projectId FKs it). mainFileNodeId is set
    //    in a second save AFTER the file nodes exist, because that column FKs
    //    FileNode.id — the exact two-step create-project performs.
    const project = new Project(projectId, ProjectName.create(DEMO_PROJECT_NAME), DEMO_PROJECT_DESCRIPTION, [
      ...DEMO_PROJECT_TAGS,
    ], null);
    await deps.repos.project.save(project);

    // 2. Folders, parent-before-child (the manifest is ordered so).
    for (const folder of DEMO_FOLDERS) {
      const node = new FileNode(
        FileNodeId.create(folder.id),
        projectId,
        folder.parentId === null ? null : FileNodeId.create(folder.parentId),
        folder.name,
        FileNodeType.create('folder'),
        FilePath.create(folder.path),
      );
      await deps.repos.fileNode.save(node);
    }

    // 3. Files: write bytes to the store, then the FileNode, then the Document or
    //    Asset. Writing bytes first mirrors CreateFileUseCase, so a mid-way crash
    //    leaves an orphan file the rollback removes rather than a dangling row.
    for (const file of DEMO_FILES) {
      await createDemoFile(deps, projectId, file);
    }

    // 4. Render config (selects the bundled PDF theme). Re-validated through the
    //    shared schema — the same boundary check the API route applies — before
    //    it is stored as an opaque blob on the entity.
    const normalized = normalizeRenderConfig(DEMO_RENDER_CONFIG);
    await deps.repos.projectRenderConfig.save(
      new ProjectRenderConfig(ProjectRenderConfigId.create(projectId.value), projectId, normalized),
    );

    // 5. Designate the main/root include file now that its node exists.
    project.setMainFile(FileNodeId.create(DEMO_MAIN_FILE_ID));
    await deps.repos.project.save(project);
  } catch (error) {
    await rollbackDemoProject(deps, projectId);
    throw error;
  }
}

/**
 * Persists one demo file: bytes to the store, the `FileNode`, and either a
 * collaborative `Document` (text) or a binary `Asset`.
 *
 * @param deps - The provisioner dependencies.
 * @param projectId - The well-known, fixed demo project identifier from the manifest.
 * @param file - The file specification from the manifest.
 * @returns A promise that resolves once the file's row(s) and bytes are written.
 */
async function createDemoFile(deps: DemoProjectDeps, projectId: ProjectId, file: DemoFileSpec): Promise<void> {
  const bytes = await loadDemoAssetBytes(deps.dataDir, file.source);
  const filePath = FilePath.create(file.path);
  await deps.fileStore.write(projectId, filePath, bytes);

  const fileNodeId = FileNodeId.create(file.id);
  await deps.repos.fileNode.save(
    new FileNode(
      fileNodeId,
      projectId,
      FileNodeId.create(file.parentId),
      file.name,
      FileNodeType.create('file'),
      filePath,
    ),
  );

  await (file.kind === 'text'
    ? deps.repos.document.save(
        new Document(
          DocumentId.create(file.documentId),
          fileNodeId,
          ContentId.create(file.contentId),
          YjsStateId.create(file.yjsStateId),
          MimeType.create(file.mimeType),
        ),
      )
    : deps.repos.asset.save(new Asset(fileNodeId, MimeType.create(file.mimeType), BigInt(bytes.length))));
}

/**
 * Best-effort teardown of a partially-created demo project. Deleting the project
 * row cascades to file nodes, documents, assets, members and the render config;
 * the file-store tree is removed separately.
 *
 * @param deps - The provisioner dependencies.
 * @param projectId - The well-known, fixed demo project identifier from the manifest.
 * @returns A promise that resolves once cleanup has been attempted.
 */
async function rollbackDemoProject(deps: DemoProjectDeps, projectId: ProjectId): Promise<void> {
  try {
    await deps.repos.project.delete(projectId);
  } catch {
    // The project row may never have been written; nothing to undo.
  }
  try {
    await deps.fileStore.removeProject(projectId);
  } catch {
    // The store tree may never have been written; nothing to undo.
  }
}

/**
 * Tears down an existing demo project before it is rebuilt with fresh content.
 * Deleting the project row cascades to its file nodes, documents, assets, members
 * and render config; removing the store tree clears both the file bytes and the
 * collaborative Yjs state (the `.collab` directory), so a reopened document is
 * re-seeded from the new bytes instead of a stale cached copy.
 *
 * Errors propagate to the caller (the top-level `provisionDemoProject` catch),
 * which logs and continues — a failed refresh must not block the API from booting.
 *
 * @param deps - The provisioner dependencies.
 * @param projectId - The well-known, fixed demo project identifier from the manifest.
 * @returns A promise that resolves once the old demo has been removed.
 */
async function resetDemoProject(deps: DemoProjectDeps, projectId: ProjectId): Promise<void> {
  await deps.repos.project.delete(projectId);
  await deps.fileStore.removeProject(projectId);
}

/**
 * Grants a `VIEWER` membership on the demo project to every user who does not yet
 * have one, in a single statement. This is the mechanism that makes the demo
 * "readable by all users": the app's authorization is exclusively membership
 * based, and `VIEWER` maps to read-only everywhere (the collaboration server
 * forces the WebSocket connection read-only, and content-mutating use cases
 * require `editor`/`owner`). No `OWNER`/`EDITOR` row is ever created, so nobody
 * can edit the tutorial's content.
 *
 * It targets EXISTING users (the just-upgraded install's current accounts). New
 * users created after start-up are granted access by the login/registration hook
 * ({@link ensureDemoProjectMembership}).
 *
 * `skipDuplicates` makes the call idempotent — re-running it never errors on the
 * users already granted, and only new rows are inserted.
 *
 * @param prisma - Supplies the user-id list to grant and the bulk insert to grant them with.
 * @returns The number of membership rows actually inserted.
 */
export async function backfillDemoViewerMemberships(prisma: DemoMembershipStore): Promise<number> {
  const users = await prisma.user.findMany({ select: { id: true } });
  if (users.length === 0) return 0;
  // `'VIEWER'` is the DB enum literal that maps to the domain `viewer` role
  // (Role.create('viewer')); a `VIEWER` membership is read-only everywhere.
  const result = await prisma.projectMember.createMany({
    data: users.map((user) => ({ projectId: DEMO_PROJECT_ID, userId: user.id, role: 'VIEWER' })),
    skipDuplicates: true,
  });
  return result.count;
}

/**
 * Ensures a single user has read (viewer) access to the demo project. Called from
 * the login and registration hooks so every future user — however they are
 * created — can open the tutorial the first time they authenticate, without
 * waiting for the next API restart's backfill.
 *
 * Idempotent and best-effort: it checks for an existing membership first and
 * never throws, so a demo-access hiccup can never block a login or registration.
 *
 * @param deps - The subset of dependencies needed to read and add a membership.
 * @param userId - The id of the user to grant read access to.
 * @returns A promise that resolves once access has been ensured (or safely skipped).
 */
export async function ensureDemoProjectMembership(
  deps: {
    readonly repos: { readonly project: ProjectRepository; readonly projectMember: ProjectMemberRepository };
    readonly logger: BootstrapLogger;
  },
  userId: string,
): Promise<void> {
  try {
    const projectId = ProjectId.create(DEMO_PROJECT_ID);
    // If the demo project has not been seeded yet, there is nothing to join; the
    // start-up backfill will grant this user on the next boot.
    const project = await deps.repos.project.findById(projectId);
    if (!project) return;

    const userIdVo = UserId.create(userId);
    const existing = await deps.repos.projectMember.findByCompositeKey(projectId, userIdVo);
    if (existing) return;

    await deps.repos.projectMember.addMember(new ProjectMember(projectId, userIdVo, Role.create('viewer'), new Date()));
  } catch (error) {
    deps.logger.warn(
      { projectId: DEMO_PROJECT_ID, err: error instanceof Error ? error.message : String(error) },
      'Could not ensure demo-project read access for user; it will be granted on the next start-up backfill.',
    );
  }
}
