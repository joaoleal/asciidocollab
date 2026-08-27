import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireEditorRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/**
 * Body accepted by `POST /projects/:projectId/git/discard`. Exactly one of the two shapes is
 * valid: a non-empty `paths` array (a plain discard of those paths back to HEAD), or a non-empty
 * `path`/`commit` pair (restore one file from that commit). See {@link normalizeDiscardBody}.
 */
interface GitDiscardBody {
  /** Project-relative paths of the files to discard back to HEAD. */
  paths?: unknown;
  /** A single project-relative path to restore from `commit`. */
  path?: unknown;
  /** The commit to restore `path` from. */
  commit?: unknown;
}

/** The worker-shaped request this route normalizes {@link GitDiscardBody} into. */
interface NormalizedDiscard {
  readonly paths: string[];
  readonly fromCommit: string | undefined;
}

/**
 * Validates and normalizes the route's dual-shaped body: exactly one of a non-empty `paths` array
 * of strings, XOR a non-empty `path` + `commit` string pair. Any other shape — both present, neither
 * present, an empty `paths` array, a non-array `paths`, or a non-string/empty `path`/`commit` — is
 * rejected (null), which the route answers with a `400`.
 *
 * @param body - The raw, still-unvalidated request body.
 * @returns The normalized `{paths, fromCommit}` worker input, or null if the body matches neither shape.
 */
export function normalizeDiscardBody(body: GitDiscardBody): NormalizedDiscard | null {
  const hasPaths = Array.isArray(body.paths);
  const hasPathCommit = typeof body.path === 'string' && typeof body.commit === 'string';
  if (hasPaths === hasPathCommit) return null;

  if (hasPaths && Array.isArray(body.paths)) {
    if (body.paths.length === 0) return null;
    const paths: string[] = [];
    for (const entry of body.paths) {
      if (typeof entry !== 'string') return null;
      paths.push(entry);
    }
    return { paths, fromCommit: undefined };
  }

  if (typeof body.path === 'string' && typeof body.commit === 'string') {
    if (body.path.length === 0 || body.commit.length === 0) return null;
    return { paths: [body.path], fromCommit: body.commit };
  }

  return null;
}

/**
 * Registers `POST /projects/:projectId/git/discard` — discards a file's uncommitted working-tree
 * changes, or restores it to a chosen commit. Synchronous, via the git-worker's `discardChanges`
 * RPC, which owns the project's single-flight guard the same way commit does.
 *
 * The body is dual-shaped: `{paths}` for a plain discard to HEAD, or `{path, commit}` to restore one
 * file from a specific commit. Both shapes are validated and normalized by
 * {@link normalizeDiscardBody}; a body matching neither answers `400` before the worker is ever called.
 *
 * Requires EDITOR tier or above; the gate runs BEFORE the worker call, as defense-in-depth alongside
 * the worker's own editor self-gate.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitDiscardRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: GitDiscardBody }>(
    '/api/projects/:projectId/git/discard',
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
          required: ['projectId'],
          properties: { projectId: { type: 'string' } },
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

      const normalized = normalizeDiscardBody(request.body ?? {});
      if (!normalized) {
        return reply.status(400).send({
          error: {
            code: 'invalid_discard_body',
            message: 'Provide either a non-empty "paths" array, or a "path" and "commit" pair',
          },
        });
      }

      let result;
      try {
        result = await request.server.stores.gitWorkerClient.discardChanges({
          projectId: projectId.value,
          actorId: actorId.value,
          paths: normalized.paths,
          fromCommit: normalized.fromCommit,
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

      return reply.status(200).send({ ok: true });
    },
  );
}
