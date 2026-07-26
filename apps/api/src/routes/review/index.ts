import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CreateReviewCommentUseCase,
  ReplyToThreadUseCase,
  EditReviewItemUseCase,
  ResolveReviewItemUseCase,
  ListReviewItemsUseCase,
  ReactToItemUseCase,
  ConvertToTaskUseCase,
  AssignTaskUseCase,
  SetTaskStatusUseCase,
  ListProjectReviewItemsUseCase,
  ReanchorReviewItemUseCase,
  DeleteReviewItemUseCase,
  BulkDeleteForDocumentUseCase,
  BulkDeleteForProjectUseCase,
  ReviewItemNotFoundError,
  UserId,
  ProjectId,
  DocumentId,
  ReviewCommentId,
  isReviewItemKind,
  isReviewItemStatus,
  // The body limit is a business rule, and the API is a layer that may read the domain directly. The
  // route's `maxLength` rejects an over-long body early, but it is enforcing the DOMAIN's rule, so it
  // cites the owner rather than the browser-facing mirror in `@asciidocollab/shared`.
  REVIEW_BODY_MAX_LEN,
  type ReviewComment,
} from '@asciidocollab/domain';
import { isAllowedReactionEmoji } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../plugins/require-auth';
import { requestContextFrom } from '../../lib/request-context';
import { sendReviewError } from './errors';
import { toReviewItemDto, toThreads, toReactionSummaries, type ReviewItemFileReference } from './dto';
import { buildUserLookup, collectUserIds } from './user-lookup';

/** Decodes a base64 relative-position string to bytes, or null when absent/blank. */
function decodeRelativePos(relativePos: string | undefined | null): Uint8Array | null {
  if (!relativePos) return null;
  return new Uint8Array(Buffer.from(relativePos, 'base64'));
}

/**
 * Emits the review-items-changed signal on the project SSE stream. `documentId` is the affected
 * document, or `null` for a project-wide change (bulk clear across every document) so clients scoped
 * to a single document — and the cross-document panel — all refetch.
 */
function emitReviewChanged(request: FastifyRequest, projectId: string, documentId: string | null): void {
  request.server.fileTreeEventBus.emit(projectId, { type: 'review-items-changed', documentId });
}

/**
 * Builds a single-item DTO, resolving its participant display names and its live
 * reactions. Fetching the reactions (rather than assuming none) keeps a mutation
 * response — resolve/convert/assign/status/reanchor — authoritative for a client
 * that merges it into its store; a freshly created item simply has none.
 */
async function singleItemDto(request: FastifyRequest, item: ReviewComment, callerId: string) {
  const reactions = await request.server.repos.reviewReaction.listForItems([item.id]);
  const lookup = await buildUserLookup(request.server.repos.user, collectUserIds([item], reactions));
  return toReviewItemDto(item, reactions, lookup, callerId);
}

const anchorSchema = {
  type: 'object',
  required: ['quote'],
  properties: {
    relPos: { type: 'string' },
    quote: {
      type: 'object',
      required: ['exact'],
      properties: {
        prefix: { type: 'string' },
        exact: { type: 'string', minLength: 1 },
        suffix: { type: 'string' },
      },
    },
    lineHint: { type: 'integer' },
    sectionId: { type: 'string' },
  },
} as const;

/** Extracts the authenticated actor's UserId from a request. */
function actorOf(request: FastifyRequest): UserId {
  return UserId.create(getAuthenticatedUserId(request));
}

/**
 * Resolves the backing file (id + display name) for each document referenced by `items`, keyed by
 * document id. Fetches once per distinct document so the project-wide list can label items by file
 * and open them. A document (or its file node) that no longer resolves is simply left out — the
 * client falls back to showing the item without a file jump.
 */
async function buildDocumentFileReferences(
  request: FastifyRequest,
  items: ReviewComment[],
): Promise<Map<string, ReviewItemFileReference>> {
  const references = new Map<string, ReviewItemFileReference>();
  const distinctDocumentIds = [...new Set(items.map((item) => item.documentId.value))];
  await Promise.all(
    distinctDocumentIds.map(async (documentId) => {
      const document = await request.server.repos.document.findById(DocumentId.create(documentId));
      if (!document) return;
      const fileNode = await request.server.repos.fileNode.findById(document.fileNodeId);
      if (!fileNode) return;
      references.set(documentId, { fileNodeId: document.fileNodeId.value, fileName: fileNode.name });
    }),
  );
  return references;
}

/**
 * Registers the review comments/tasks REST surface under `/projects/:projectId`.
 * Authorization lives entirely in the use cases (editor/owner RBAC, audited
 * denials); routes authenticate, validate shape, opt into per-route rate limits,
 * map typed `Result`s to HTTP, and emit the document-scoped change event.
 */
export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  const writeLimit = {
    max: app.config.project.review.rateLimitMax,
    timeWindow: app.config.project.review.rateLimitWindow,
  };
  const reactionLimit = {
    max: app.config.project.review.reactionRateLimitMax,
    timeWindow: app.config.project.review.reactionRateLimitWindow,
  };
  const bulkLimit = {
    max: app.config.project.review.bulkDeleteRateLimitMax,
    timeWindow: app.config.project.review.bulkDeleteRateLimitWindow,
  };

  // ── Create a root comment/task ────────────────────────────────────────────
  app.post<{
    Params: { projectId: string; documentId: string };
    Body: {
      kind: string;
      body: string;
      anchor: { relPos?: string; quote: { prefix?: string; exact: string; suffix?: string }; lineHint?: number; sectionId?: string };
    };
  }>(
    '/projects/:projectId/documents/:documentId/review-items',
    {
      config: { rateLimit: writeLimit },
      schema: {
        params: {
          type: 'object',
          required: ['projectId', 'documentId'],
          properties: { projectId: { type: 'string' }, documentId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['kind', 'body', 'anchor'],
          properties: {
            kind: { type: 'string', enum: ['comment', 'task'] },
            body: { type: 'string', minLength: 1, maxLength: REVIEW_BODY_MAX_LEN },
            anchor: anchorSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const projectId = ProjectId.create(request.params.projectId);
      const documentId = DocumentId.create(request.params.documentId);
      const { kind, body, anchor } = request.body;
      if (!isReviewItemKind(kind)) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'invalid kind' } });

      const useCase = new CreateReviewCommentUseCase(
        request.server.repos.reviewComment,
        request.server.repos.projectMember,
        request.server.repos.auditLog,
      );
      const result = await useCase.execute(
        actorOf(request),
        projectId,
        documentId,
        {
          kind,
          body,
          anchor: {
            relPos: decodeRelativePos(anchor.relPos),
            quote: { prefix: anchor.quote.prefix ?? '', exact: anchor.quote.exact, suffix: anchor.quote.suffix ?? '' },
            lineHint: anchor.lineHint ?? null,
            sectionId: anchor.sectionId ?? null,
          },
        },
        requestContextFrom(request),
      );
      if (!result.success) return sendReviewError(reply, result.error);
      emitReviewChanged(request, projectId.value, documentId.value);
      const dto = await singleItemDto(request, result.value.item, actorOf(request).value);
      return reply.status(201).send({ data: dto });
    },
  );

  // ── List a document's items (read — no rate limit; cheap tenant-scoped) ────
  app.get<{ Params: { projectId: string; documentId: string }; Querystring: { includeResolved?: string } }>(
    '/projects/:projectId/documents/:documentId/review-items',
    {
      schema: {
        params: {
          type: 'object',
          required: ['projectId', 'documentId'],
          properties: { projectId: { type: 'string' }, documentId: { type: 'string' } },
        },
        querystring: { type: 'object', properties: { includeResolved: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const projectId = ProjectId.create(request.params.projectId);
      const documentId = DocumentId.create(request.params.documentId);
      const includeResolved = request.query.includeResolved === 'true';
      const useCase = new ListReviewItemsUseCase(
        request.server.repos.reviewComment,
        request.server.repos.reviewReaction,
        request.server.repos.projectMember,
      );
      const result = await useCase.execute(actorOf(request), projectId, documentId, { includeResolved });
      if (!result.success) return sendReviewError(reply, result.error);
      const { items, reactions } = result.value;
      const lookup = await buildUserLookup(request.server.repos.user, collectUserIds(items, reactions));
      return reply.status(200).send({ data: { threads: toThreads(items, reactions, lookup, actorOf(request).value) } });
    },
  );

  // ── Reply in a thread ─────────────────────────────────────────────────────
  app.post<{ Params: { projectId: string; id: string }; Body: { body: string } }>(
    '/projects/:projectId/review-items/:id/replies',
    {
      config: { rateLimit: writeLimit },
      schema: {
        params: {
          type: 'object',
          required: ['projectId', 'id'],
          properties: { projectId: { type: 'string' }, id: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['body'],
          properties: { body: { type: 'string', minLength: 1, maxLength: REVIEW_BODY_MAX_LEN } },
        },
      },
    },
    async (request, reply) => {
      const projectId = ProjectId.create(request.params.projectId);
      const useCase = new ReplyToThreadUseCase(
        request.server.repos.reviewComment,
        request.server.repos.projectMember,
        request.server.repos.auditLog,
      );
      const result = await useCase.execute(
        actorOf(request),
        projectId,
        ReviewCommentId.create(request.params.id),
        { body: request.body.body },
        requestContextFrom(request),
      );
      if (!result.success) return sendReviewError(reply, result.error);
      emitReviewChanged(request, projectId.value, result.value.reply.documentId.value);
      const dto = await singleItemDto(request, result.value.reply, actorOf(request).value);
      return reply.status(201).send({ data: dto });
    },
  );

  // ── Resolve or reopen a comment thread ────────────────────────────────────
  app.post<{ Params: { projectId: string; id: string }; Body: { reopen?: boolean } }>(
    '/projects/:projectId/review-items/:id/resolve',
    {
      config: { rateLimit: writeLimit },
      schema: {
        params: {
          type: 'object',
          required: ['projectId', 'id'],
          properties: { projectId: { type: 'string' }, id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const projectId = ProjectId.create(request.params.projectId);
      const useCase = new ResolveReviewItemUseCase(
        request.server.repos.reviewComment,
        request.server.repos.projectMember,
        request.server.repos.auditLog,
      );
      // Optional `{ reopen: true }` body flips resolve → reopen; a bodyless POST resolves.
      const result = await useCase.execute(
        actorOf(request),
        projectId,
        ReviewCommentId.create(request.params.id),
        requestContextFrom(request),
        request.body?.reopen === true,
      );
      if (!result.success) return sendReviewError(reply, result.error);
      emitReviewChanged(request, projectId.value, result.value.item.documentId.value);
      const dto = await singleItemDto(request, result.value.item, actorOf(request).value);
      return reply.status(200).send({ data: dto });
    },
  );

  // ── Toggle an emoji reaction ──────────────────────────────────────────────
  app.post<{ Params: { projectId: string; id: string }; Body: { emoji: string } }>(
    '/projects/:projectId/review-items/:id/reactions',
    {
      config: { rateLimit: reactionLimit },
      schema: {
        params: {
          type: 'object',
          required: ['projectId', 'id'],
          properties: { projectId: { type: 'string' }, id: { type: 'string' } },
        },
        body: { type: 'object', required: ['emoji'], properties: { emoji: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      if (!isAllowedReactionEmoji(request.body.emoji)) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'unsupported reaction emoji' } });
      }
      const projectId = ProjectId.create(request.params.projectId);
      const reviewItemId = ReviewCommentId.create(request.params.id);
      const useCase = new ReactToItemUseCase(
        request.server.repos.reviewComment,
        request.server.repos.reviewReaction,
        request.server.repos.projectMember,
        request.server.repos.auditLog,
      );
      const result = await useCase.execute(actorOf(request), projectId, reviewItemId, { emoji: request.body.emoji }, requestContextFrom(request));
      if (!result.success) return sendReviewError(reply, result.error);
      // The item is unchanged by a reaction; fetch it once for the change event's documentId.
      const item = await request.server.repos.reviewComment.findById(projectId, reviewItemId);
      if (item) emitReviewChanged(request, projectId.value, item.documentId.value);
      return reply.status(200).send({ data: { reactions: toReactionSummaries(result.value.reactions, actorOf(request).value) } });
    },
  );

  // ── Patch an item (edit body / convert / assign / set-status / reopen) ─────
  app.patch<{
    Params: { projectId: string; id: string };
    Body: { op: string; body?: string; kind?: string; assigneeId?: string | null; dueDate?: string | null; status?: string };
  }>(
    '/projects/:projectId/review-items/:id',
    {
      config: { rateLimit: writeLimit },
      schema: {
        params: {
          type: 'object',
          required: ['projectId', 'id'],
          properties: { projectId: { type: 'string' }, id: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['op'],
          properties: {
            op: { type: 'string', enum: ['edit', 'convert', 'assign', 'status'] },
            body: { type: 'string', minLength: 1, maxLength: REVIEW_BODY_MAX_LEN },
            kind: { type: 'string', enum: ['comment', 'task'] },
            assigneeId: { type: ['string', 'null'] },
            dueDate: { type: ['string', 'null'] },
            status: { type: 'string', enum: ['open', 'in_progress', 'resolved', 'wontfix'] },
          },
        },
      },
    },
    async (request, reply) => {
      const projectId = ProjectId.create(request.params.projectId);
      const reviewItemId = ReviewCommentId.create(request.params.id);
      const actor = actorOf(request);
      const context = requestContextFrom(request);
      const { op } = request.body;

      let result;
      switch (op) {
        case 'edit': {
          const body = request.body.body;
          if (typeof body !== 'string') return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'body is required' } });
          result = await new EditReviewItemUseCase(
            request.server.repos.reviewComment,
            request.server.repos.projectMember,
            request.server.repos.auditLog,
          ).execute(actor, projectId, reviewItemId, { body }, context);
          break;
        }
        case 'convert': {
          const kind = request.body.kind;
          if (!kind || !isReviewItemKind(kind)) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'invalid kind' } });
          result = await new ConvertToTaskUseCase(
            request.server.repos.reviewComment,
            request.server.repos.projectMember,
            request.server.repos.auditLog,
          ).execute(actor, projectId, reviewItemId, { kind }, context);
          break;
        }
        case 'assign': {
          result = await new AssignTaskUseCase(
            request.server.repos.reviewComment,
            request.server.repos.projectMember,
            request.server.repos.auditLog,
          ).execute(actor, projectId, reviewItemId, { assigneeId: request.body.assigneeId ?? null, dueDate: request.body.dueDate ?? null }, context);
          break;
        }
        default: {
          const status = request.body.status;
          if (!status || !isReviewItemStatus(status)) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'invalid status' } });
          result = await new SetTaskStatusUseCase(
            request.server.repos.reviewComment,
            request.server.repos.projectMember,
            request.server.repos.auditLog,
          ).execute(actor, projectId, reviewItemId, { status }, context);
        }
      }
      if (!result.success) return sendReviewError(reply, result.error);
      emitReviewChanged(request, projectId.value, result.value.item.documentId.value);
      const dto = await singleItemDto(request, result.value.item, actor.value);
      return reply.status(200).send({ data: dto });
    },
  );

  // ── Manually reattach a section/detached item ─────────────────────────────
  app.post<{
    Params: { projectId: string; id: string };
    Body: { anchor: { relPos?: string; quote: { prefix?: string; exact: string; suffix?: string }; lineHint?: number; sectionId?: string } };
  }>(
    '/projects/:projectId/review-items/:id/reanchor',
    {
      config: { rateLimit: writeLimit },
      schema: {
        params: {
          type: 'object',
          required: ['projectId', 'id'],
          properties: { projectId: { type: 'string' }, id: { type: 'string' } },
        },
        body: { type: 'object', required: ['anchor'], properties: { anchor: anchorSchema } },
      },
    },
    async (request, reply) => {
      const projectId = ProjectId.create(request.params.projectId);
      const { anchor } = request.body;
      const useCase = new ReanchorReviewItemUseCase(
        request.server.repos.reviewComment,
        request.server.repos.projectMember,
        request.server.repos.auditLog,
      );
      const result = await useCase.execute(
        actorOf(request),
        projectId,
        ReviewCommentId.create(request.params.id),
        {
          anchor: {
            relPos: decodeRelativePos(anchor.relPos),
            quote: { prefix: anchor.quote.prefix ?? '', exact: anchor.quote.exact, suffix: anchor.quote.suffix ?? '' },
            lineHint: anchor.lineHint ?? null,
            sectionId: anchor.sectionId ?? null,
          },
        },
        requestContextFrom(request),
      );
      if (!result.success) return sendReviewError(reply, result.error);
      emitReviewChanged(request, projectId.value, result.value.item.documentId.value);
      const dto = await singleItemDto(request, result.value.item, actorOf(request).value);
      return reply.status(200).send({ data: dto });
    },
  );

  // ── Project-wide list (task panel filters — read, no rate limit) ──────────
  app.get<{ Params: { projectId: string }; Querystring: { assigneeId?: string; status?: string; documentId?: string } }>(
    '/projects/:projectId/review-items',
    {
      schema: {
        params: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string' } } },
        querystring: {
          type: 'object',
          properties: { assigneeId: { type: 'string' }, status: { type: 'string' }, documentId: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const projectId = ProjectId.create(request.params.projectId);
      const { assigneeId, status, documentId } = request.query;
      if (status !== undefined && !isReviewItemStatus(status)) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'invalid status' } });
      }
      const useCase = new ListProjectReviewItemsUseCase(
        request.server.repos.reviewComment,
        request.server.repos.projectMember,
      );
      const result = await useCase.execute(actorOf(request), projectId, {
        assigneeId: assigneeId ?? undefined,
        status: status !== undefined && isReviewItemStatus(status) ? status : undefined,
        documentId: documentId ?? undefined,
      });
      if (!result.success) return sendReviewError(reply, result.error);
      const { items } = result.value;
      const lookup = await buildUserLookup(request.server.repos.user, collectUserIds(items, []));
      // The list spans documents, so resolve each item's backing file (id + name) once per distinct
      // document, letting the cross-document view label items by file and open them.
      const fileReferenceByDocumentId = await buildDocumentFileReferences(request, items);
      return reply.status(200).send({
        data: {
          items: items.map((item) =>
            toReviewItemDto(item, [], lookup, actorOf(request).value, fileReferenceByDocumentId.get(item.documentId.value)),
          ),
        },
      });
    },
  );

  // ── Delete a single item (root ⇒ thread) ──────────────────────────────────
  app.delete<{ Params: { projectId: string; id: string } }>(
    '/projects/:projectId/review-items/:id',
    {
      config: { rateLimit: writeLimit },
      schema: {
        params: {
          type: 'object',
          required: ['projectId', 'id'],
          properties: { projectId: { type: 'string' }, id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const projectId = ProjectId.create(request.params.projectId);
      const reviewItemId = ReviewCommentId.create(request.params.id);
      // Capture the document before deletion so the change event can target it.
      const existing = await request.server.repos.reviewComment.findById(projectId, reviewItemId);
      const useCase = new DeleteReviewItemUseCase(
        request.server.repos.reviewComment,
        request.server.repos.projectMember,
        request.server.repos.auditLog,
      );
      const result = await useCase.execute(actorOf(request), projectId, reviewItemId, requestContextFrom(request));
      if (!result.success) return sendReviewError(reply, result.error);
      if (existing) emitReviewChanged(request, projectId.value, existing.documentId.value);
      return reply.status(200).send({ data: { deleted: true } });
    },
  );

  // ── Bulk delete all items on a document (editor) ──────────────────────────
  app.post<{ Params: { projectId: string; documentId: string }; Body: { confirm: boolean; expectedCount?: number } }>(
    '/projects/:projectId/documents/:documentId/review-items/bulk-delete',
    {
      config: { rateLimit: bulkLimit },
      schema: {
        params: {
          type: 'object',
          required: ['projectId', 'documentId'],
          properties: { projectId: { type: 'string' }, documentId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['confirm'],
          properties: { confirm: { type: 'boolean', const: true }, expectedCount: { type: 'integer', minimum: 0 } },
        },
      },
    },
    async (request, reply) => {
      const projectId = ProjectId.create(request.params.projectId);
      const documentId = DocumentId.create(request.params.documentId);
      const useCase = new BulkDeleteForDocumentUseCase(
        request.server.repos.reviewComment,
        request.server.repos.projectMember,
        request.server.repos.auditLog,
      );
      const result = await useCase.execute(
        actorOf(request),
        projectId,
        documentId,
        { confirm: true, expectedCount: request.body.expectedCount },
        requestContextFrom(request),
      );
      if (!result.success) return sendReviewError(reply, result.error);
      emitReviewChanged(request, projectId.value, documentId.value);
      return reply.status(200).send({ data: { deleted: result.value.deleted } });
    },
  );

  // ── Bulk delete all items across the project (owner only) ─────────────────
  app.post<{ Params: { projectId: string }; Body: { confirm: boolean; expectedCount?: number } }>(
    '/projects/:projectId/review-items/bulk-delete',
    {
      config: { rateLimit: bulkLimit },
      schema: {
        params: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['confirm'],
          properties: { confirm: { type: 'boolean', const: true }, expectedCount: { type: 'integer', minimum: 0 } },
        },
      },
    },
    async (request, reply) => {
      const projectId = ProjectId.create(request.params.projectId);
      const useCase = new BulkDeleteForProjectUseCase(
        request.server.repos.reviewComment,
        request.server.repos.projectMember,
        request.server.repos.auditLog,
      );
      const result = await useCase.execute(
        actorOf(request),
        projectId,
        { confirm: true, expectedCount: request.body.expectedCount },
        requestContextFrom(request),
      );
      if (!result.success) return sendReviewError(reply, result.error);
      // A project-wide clear spans every document; emit the broadcast (null document) signal so every
      // client — per-document rails and the cross-document panel — refetches, not just the deleter.
      emitReviewChanged(request, projectId.value, null);
      return reply.status(200).send({ data: { deleted: result.value.deleted } });
    },
  );

  // Reference kept so the unused-import guard stays quiet if a handler is trimmed.
  void ReviewItemNotFoundError;
}
