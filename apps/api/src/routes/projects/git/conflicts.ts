import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import {
  GitWorkerTransportError,
  type GitWorkerConflictListData,
  type GitWorkerConflictStagesData,
} from '@asciidocollab/infrastructure';
import { isConflictResolution, type ConflictListDto, type ConflictStagesDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireProjectMembership, requireEditorRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/** Maps the sync-RPC's conflict-list payload straight to the wire `ConflictListDto` (same shape). */
export function toConflictListDto(data: GitWorkerConflictListData): ConflictListDto {
  return {
    operationId: data.operationId,
    files: data.files.map((file) => ({ path: file.path, isBinary: file.isBinary, resolved: file.resolved })),
  };
}

/** Maps the sync-RPC's conflict-stages payload straight to the wire `ConflictStagesDto` (same shape). */
export function toConflictStagesDto(data: GitWorkerConflictStagesData): ConflictStagesDto {
  return { base: data.base, ours: data.ours, theirs: data.theirs, isBinary: data.isBinary };
}

/**
 * Validates an already-decoded `:path` route parameter for the conflict routes. Fastify's router
 * percent-decodes route params itself before a handler ever sees them (that decode is what lets a
 * single `:path` segment carry an embedded `/` as `%2F`), so this function must NOT decode again —
 * a second `decodeURIComponent` would throw on (or mis-decode) a path that legitimately contains a
 * literal `%`, e.g. `50%_done.adoc`. The param must be non-empty, relative (no leading `/` or
 * `\`), and contain no empty/`.`/`..` segment on either `/` or `\` as a separator (no traversal).
 * Returns null when the parameter fails any of these checks — the caller replies `400` rather than
 * ever forwarding an unvalidated path to the git-worker.
 *
 * @param decodedParameter - The already-decoded `:path` route parameter, exactly as Fastify captured it.
 * @returns The validated project-relative path (unchanged), or null when invalid.
 */
export function validateConflictPath(decodedParameter: string): string | null {
  if (decodedParameter.length === 0) return null;
  if (decodedParameter.startsWith('/') || decodedParameter.startsWith('\\')) return null;
  const segments = decodedParameter.split(/[/\\]/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return decodedParameter;
}

/**
 * Registers the conflict-resolution read/write routes for a project's currently conflicted git
 * operation:
 *
 * - `GET /projects/:projectId/git/conflicts` — every conflicting file, for the conflict list panel.
 * - `GET /projects/:projectId/git/conflicts/:path` — one file's three-way (base/ours/theirs) stages,
 *   for the merge view.
 * - `POST /projects/:projectId/git/conflicts/:path` — records one file's chosen resolution
 *   (`ours`/`theirs`/`merged`).
 *
 * All three are synchronous, via the git-worker's internal RPC. The two `GET` routes require only
 * VIEWER tier or above (any project member may read); the `POST` route requires EDITOR tier or
 * above, gated BEFORE the worker call as defense-in-depth alongside the worker's own editor
 * self-gate. Neither `GET` route takes the project's single-flight guard (reads are cheap and
 * non-content-changing); `POST` does not either — only completing/undoing the operation lands a
 * change into the working tree.
 *
 * @param app - The Fastify instance the endpoints are registered on.
 */
export async function gitConflictsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/git/conflicts',
    {
      schema: {
        params: {
          type: 'object',
          required: ['projectId'],
          properties: { projectId: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const membershipCheck = await requireProjectMembership(request, actorId, projectId);
      if (!membershipCheck.success) {
        return sendGitErrorResponse(reply, membershipCheck.error.name);
      }

      let result;
      try {
        result = await request.server.stores.gitWorkerClient.listConflicts({
          projectId: projectId.value,
          actorId: actorId.value,
        });
      } catch (error) {
        if (error instanceof GitWorkerTransportError) {
          return sendGitWorkerUnavailableResponse(reply);
        }
        throw error;
      }

      if (!result.ok) {
        return sendGitErrorResponse(reply, result.error, result.path);
      }

      return reply.status(200).send(toConflictListDto(result.data));
    },
  );

  app.get<{ Params: { projectId: string; path: string } }>(
    '/api/projects/:projectId/git/conflicts/:path',
    {
      schema: {
        params: {
          type: 'object',
          required: ['projectId', 'path'],
          properties: { projectId: { type: 'string' }, path: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const membershipCheck = await requireProjectMembership(request, actorId, projectId);
      if (!membershipCheck.success) {
        return sendGitErrorResponse(reply, membershipCheck.error.name);
      }

      const path = validateConflictPath(request.params.path);
      if (path === null) {
        return reply.status(400).send({ error: { code: 'invalid_path', message: 'The file path is invalid' } });
      }

      let result;
      try {
        result = await request.server.stores.gitWorkerClient.getConflictStages({
          projectId: projectId.value,
          actorId: actorId.value,
          path,
        });
      } catch (error) {
        if (error instanceof GitWorkerTransportError) {
          return sendGitWorkerUnavailableResponse(reply);
        }
        throw error;
      }

      if (!result.ok) {
        return sendGitErrorResponse(reply, result.error, result.path);
      }

      return reply.status(200).send(toConflictStagesDto(result.data));
    },
  );

  app.post<{ Params: { projectId: string; path: string }; Body: { resolution: string; mergedContent?: string } }>(
    '/api/projects/:projectId/git/conflicts/:path',
    {
      config: {
        rateLimit: {
          max: app.config.git.rateLimitMax,
          timeWindow: app.config.git.rateLimitWindow,
        },
      },
      schema: {
        params: {
          type: 'object',
          required: ['projectId', 'path'],
          properties: { projectId: { type: 'string' }, path: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['resolution'],
          properties: {
            resolution: { type: 'string' },
            mergedContent: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const editorCheck = await requireEditorRole(request, actorId, projectId);
      if (!editorCheck.success) {
        return sendGitErrorResponse(reply, editorCheck.error.name);
      }

      const path = validateConflictPath(request.params.path);
      if (path === null) {
        return reply.status(400).send({ error: { code: 'invalid_path', message: 'The file path is invalid' } });
      }

      // Reuses the existing shared vocabulary rather than redefining it: an unrecognised
      // resolution string never reaches the worker, and is reported through the same
      // `InvalidResolutionError` wire mapping the domain itself uses for a merged-without-content
      // or merged-on-binary refusal, so every "this resolution is invalid" case looks identical on
      // the wire regardless of which layer caught it.
      if (!isConflictResolution(request.body.resolution)) {
        return sendGitErrorResponse(reply, 'InvalidResolutionError');
      }

      let result;
      try {
        result = await request.server.stores.gitWorkerClient.resolveConflict({
          projectId: projectId.value,
          actorId: actorId.value,
          path,
          resolution: request.body.resolution,
          ...(request.body.mergedContent === undefined ? {} : { mergedContent: request.body.mergedContent }),
        });
      } catch (error) {
        if (error instanceof GitWorkerTransportError) {
          return sendGitWorkerUnavailableResponse(reply);
        }
        throw error;
      }

      if (!result.ok) {
        return sendGitErrorResponse(reply, result.error, result.path);
      }

      return reply.status(200).send({ resolved: true });
    },
  );
}
