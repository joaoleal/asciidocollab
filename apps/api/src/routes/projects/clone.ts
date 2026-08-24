import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CloneAlreadyInProgressError,
  CloneProjectUseCase,
  DomainError,
  InvalidProjectNameError,
  LiveContentUnavailableError,
  PermissionDeniedError,
  Project,
  ProjectId,
  type ProjectMember,
  UserId,
} from '@asciidocollab/domain';
import type { CloneProjectDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId, requireAuth } from '../../plugins/require-auth';
import { requestContextFrom } from '../../lib/request-context';
import { requestLogger } from '../../lib/request-logger';

/** Longest name a copy may be given, matching what the project name itself allows. */
const MAX_NAME_LENGTH = 100;

/** An HTTP answer to a refused clone: the status, the code, and any detail it carries. */
interface CloneRefusal {
  /** HTTP status to answer with. */
  status: number;
  /** Stable machine-readable code from the clone contract. */
  code: string;
  /** Extra fields the caller can act on; only the unavailable-document case has any. */
  details?: { path: string };
}

/**
 * Translates a refused clone into its HTTP answer.
 *
 * A caller who is not a member and a caller naming a project that does not exist
 * arrive here as the same `PermissionDeniedError`, and both leave as 403: a 404
 * would confirm to a non-member that the project exists.
 *
 * @param error - The refusal the use case returned.
 * @returns The status, code and any details to answer with.
 */
function mapCloneError(error: DomainError): CloneRefusal {
  if (error instanceof InvalidProjectNameError) {
    return { status: 400, code: 'VALIDATION_ERROR' };
  }
  if (error instanceof PermissionDeniedError) {
    return { status: 403, code: 'FORBIDDEN' };
  }
  if (error instanceof CloneAlreadyInProgressError) {
    return { status: 409, code: 'CLONE_IN_PROGRESS' };
  }
  if (error instanceof LiveContentUnavailableError) {
    // The error's own path is the source node's project-relative path — what the
    // caller already sees in the file tree — so it is safe to hand back, and it
    // is the only way to say which document blocked the copy.
    return { status: 503, code: 'LIVE_CONTENT_UNAVAILABLE', details: { path: error.path } };
  }
  return { status: 500, code: 'CLONE_FAILED' };
}

/**
 * Reads the display names of a project's owners, or none if they cannot be read.
 *
 * This is the only cosmetic read in a description: everything else the body
 * carries is already in hand by the time it runs. A failure here therefore costs
 * the card its owner line and nothing more — the counts, the caller's role and
 * the stored row's own fields stay true — so it is logged and answered around
 * instead of collapsing the whole description into stated values.
 *
 * The list is empty rather than filled in from the caller: a blank display name
 * rendered as if it were real is worse than none.
 *
 * @param request - The current request, used to reach the user repository and the log.
 * @param project - The project being described, named in the warning if the read fails.
 * @param members - That project's membership rows; the owners among them are looked up.
 * @returns One entry per owner whose user row was found, or an empty list if the read failed.
 */
async function readOwnerNames(
  request: FastifyRequest,
  project: Project,
  members: ProjectMember[],
): Promise<{ userId: string; displayName: string }[]> {
  try {
    const ownerUsers = await Promise.all(
      members
        .filter((member) => member.role.value === 'owner')
        .map((member) => request.server.repos.user.findById(member.userId)),
    );
    return ownerUsers
      .filter((user): user is NonNullable<typeof user> => user !== null)
      .map((user) => ({ userId: user.id.value, displayName: user.displayName }));
  } catch (error) {
    requestLogger(request).warn('Could not read the owner display names; describing the project without them', {
      projectId: project.id.value,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Describes a project exactly as `GET /api/projects` describes one, so the copy
 * can be inserted into the dashboard's list without a second request.
 *
 * The two counts and the owner names are read back from the repositories rather
 * than assumed from what the clone just wrote: deriving them the same way the
 * list route does is what keeps the two shapes from drifting apart.
 *
 * Only the counts and the stored row are load-bearing enough to fail on. The
 * owner names are fetched separately and absorb their own failure, so a blip
 * while looking them up costs the description its owner list and leaves every
 * other field, the counts included, read and true.
 *
 * @param request - The current request, used to reach the repositories.
 * @param project - The project to describe.
 * @param actorId - The caller, whose own role in the project is reported.
 * @returns The project in the list route's shape.
 */
async function describeProject(request: FastifyRequest, project: Project, actorId: UserId) {
  const [stored, members, fileNodes] = await Promise.all([
    // Described from the row as it now reads, not from the entity the clone just built in memory.
    // The two are not the same: `rootFolderId` is set on a freshly built project but has no column
    // to be stored in, so the entity reports one and every later read reports none. Describing the
    // entity would put a value in this response that the dashboard's next refresh contradicts —
    // exactly the drift this shared shape exists to prevent.
    request.server.repos.project.findById(project.id),
    request.server.repos.projectMember.findByProjectId(project.id),
    request.server.repos.fileNode.findByProjectId(project.id),
  ]);
  const described = stored ?? project;

  const owners = await readOwnerNames(request, described, members);

  const membership = members.find((member) => member.userId.value === actorId.value);

  return {
    id: described.id.value,
    name: described.name.value,
    description: described.description,
    owners,
    tags: [...described.tags],
    // Sourced from the stored row alone, never the `?? project` fallback entity: the entity carries a
    // rootFolderId that has no column and every later read reports as null, so reading it from
    // `described` would leak that value here whenever `stored` is null — the drift the note above rejects.
    rootFolderId: stored?.rootFolderId?.value ?? null,
    mainFileNodeId: described.mainFileNodeId?.value ?? null,
    language: described.language,
    archivedAt: described.archivedAt?.toISOString() ?? null,
    memberCount: members.length,
    fileCount: fileNodes.filter((node) => node.type.value === 'file').length,
    role: membership?.role.value ?? 'viewer',
    createdAt: described.createdAt.toISOString(),
    updatedAt: described.updatedAt.toISOString(),
  };
}

/**
 * Describes a committed copy, falling back to what the clone itself already
 * knows if the reads that would describe it fail.
 *
 * The counts and owner names are a convenience — they save the dashboard a
 * second request. The copy is real whether or not they can be read, so a failure
 * here is logged and answered around rather than raised: reporting a clone that
 * succeeded as a server error would tell the user nothing was copied while their
 * new project sits in the list behind the message.
 *
 * The owner names absorb their own failure, so this fallback is reached only
 * when the read of the project row, its members and its file nodes failed. Three
 * of the fields it states are nonetheless safe, each for its own reason:
 *
 * - `memberCount` is 1 and `role` is `owner` by construction. The single owner
 *   membership row is the last write the clone makes and the one that commits
 *   it, so a copy that reached here has exactly that one member, the caller.
 * - `owners` is empty rather than invented: the caller is that owner, but naming
 *   them needs the very read that failed, and a blank name rendered as if it
 *   were real is worse than none.
 * - `rootFolderId` is null because it is null for this project in every read
 *   there will ever be — it has no column to be stored in. The entity built by
 *   the clone does carry one, and answering with it would put a value here that
 *   the dashboard's next refresh contradicts.
 *
 * `fileCount` is the one value that is neither known nor derivable here, and it
 * is the one field this body does not carry. `ProjectDto` declares it optional
 * so that "unknown" can be said, and the dashboard's card drops the chip when it
 * is absent; a stated zero would instead render "0 files" over a copy that may
 * hold forty, which is a worse answer than the blank the omission leaves. Every
 * other field the full description carries is present, so nothing but the file
 * chip is missing from the card until the next listing fills it in.
 *
 * @param request - The current request, used to reach the repositories and the log.
 * @param project - The committed copy.
 * @param actorId - The caller, who owns it.
 * @returns The full description, or every field of it but `fileCount`, with the unreadable ones stated.
 */
async function describeCommittedClone(request: FastifyRequest, project: Project, actorId: UserId) {
  try {
    return await describeProject(request, project, actorId);
  } catch (error) {
    requestLogger(request).warn('Could not describe the finished clone; answering with what is known', {
      projectId: project.id.value,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      id: project.id.value,
      name: project.name.value,
      description: project.description,
      owners: [],
      tags: [...project.tags],
      rootFolderId: null,
      mainFileNodeId: project.mainFileNodeId?.value ?? null,
      language: project.language,
      archivedAt: project.archivedAt?.toISOString() ?? null,
      memberCount: 1,
      role: 'owner',
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  }
}

/**
 * Registers `POST /api/projects/:projectId/clone`, which copies a project the
 * caller can reach into a new one they own.
 *
 * The route owns none of the policy: membership, the one-clone-per-user bound
 * and the copy itself all live in the use case. What it owns is the boundary —
 * the request shape, the rate limit that bounds this amplifying operation, and
 * the translation of the typed refusal it gets back into HTTP.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function cloneRoutes(app: FastifyInstance): Promise<void> {
  // The body is the shared request shape rather than a local restatement of it,
  // so the client and the endpoint cannot drift into disagreeing about the field.
  app.post<{ Params: { projectId: string }; Body: CloneProjectDto }>(
    '/api/projects/:projectId/clone',
    {
      preHandler: [requireAuth],
      config: {
        rateLimit: {
          max: app.config.project.clone.rateLimitMax,
          timeWindow: app.config.project.clone.rateLimitWindow,
        },
      },
      schema: {
        params: {
          type: 'object',
          required: ['projectId'],
          // Checked here rather than left to `ProjectId.create`, whose throw is not caught by
          // anything on this path: a caller sending a malformed id got a 500 and a logged stack
          // trace for what is plainly a bad request. Rejecting the shape at the boundary cannot leak
          // anything either — it separates "not an id" from "an id", never one project from another.
          properties: { projectId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: MAX_NAME_LENGTH } },
        },
      },
    },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const sourceProjectId = ProjectId.create(request.params.projectId);

      const useCase = new CloneProjectUseCase(
        request.server.repos.project,
        request.server.repos.fileNode,
        request.server.repos.projectMember,
        request.server.repos.auditLog,
        // The registry is the one the composition root built, not one made here:
        // a per-request instance would bound nothing, because each request would
        // get an empty one.
        request.server.services.activeCloneRegistry,
        request.server.repos.document,
        request.server.repos.asset,
        request.server.stores.fileStore,
        request.server.repos.collaborationSession,
        request.server.stores.collaborativeContentEditor,
        request.server.repos.projectRenderConfig,
        request.server.repos.projectDictionary,
        requestLogger(request),
      );

      const result = await useCase.execute(
        actorId,
        sourceProjectId,
        request.body.name,
        requestContextFrom(request),
      );

      if (!result.success) {
        const { status, code, details } = mapCloneError(result.error);
        return reply.status(status).send({
          error: { code, message: result.error.message, ...(details ? { details } : {}) },
        });
      }

      // Past this point the copy exists and the caller owns it, so nothing that happens while
      // describing it may turn into a refusal. `describeProject` reads three more times to fill in
      // the counts and the owner names, and a connection blip on any of them used to reject the
      // handler — answering 500 for a project that is already visible, and telling the user through
      // the dialog that nothing was copied. The description is the only part that can still fail,
      // and a description is not worth losing a clone over.
      const described = await describeCommittedClone(request, result.value.project, actorId);
      return reply.status(201).send({ data: described });
    },
  );
}
