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
  UserId,
} from '@asciidocollab/domain';
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
 * Describes a project exactly as `GET /api/projects` describes one, so the copy
 * can be inserted into the dashboard's list without a second request.
 *
 * The two counts and the owner names are read back from the repositories rather
 * than assumed from what the clone just wrote: deriving them the same way the
 * list route does is what keeps the two shapes from drifting apart.
 *
 * @param request - The current request, used to reach the repositories.
 * @param project - The project to describe.
 * @param actorId - The caller, whose own role in the project is reported.
 * @returns The project in the list route's shape.
 */
async function describeProject(request: FastifyRequest, project: Project, actorId: UserId) {
  const [members, fileNodes] = await Promise.all([
    request.server.repos.projectMember.findByProjectId(project.id),
    request.server.repos.fileNode.findByProjectId(project.id),
  ]);

  const ownerUsers = await Promise.all(
    members
      .filter((member) => member.role.value === 'owner')
      .map((member) => request.server.repos.user.findById(member.userId)),
  );
  const owners = ownerUsers
    .filter((user): user is NonNullable<typeof user> => user !== null)
    .map((user) => ({ userId: user.id.value, displayName: user.displayName }));

  const membership = members.find((member) => member.userId.value === actorId.value);

  return {
    id: project.id.value,
    name: project.name.value,
    description: project.description,
    owners,
    tags: [...project.tags],
    rootFolderId: project.rootFolderId?.value ?? null,
    mainFileNodeId: project.mainFileNodeId?.value ?? null,
    language: project.language,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    memberCount: members.length,
    fileCount: fileNodes.filter((node) => node.type.value === 'file').length,
    role: membership?.role.value ?? 'viewer',
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
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
  app.post<{ Params: { projectId: string }; Body: { name: string } }>(
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
          properties: { projectId: { type: 'string' } },
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

      return reply
        .status(201)
        .send({ data: await describeProject(request, result.value.project, actorId) });
    },
  );
}
