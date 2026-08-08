import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {
  ReviewComment,
  ReviewCommentId,
  ReviewReaction,
  ReviewReactionId,
  ReviewAnchor,
  ProjectId,
  DocumentId,
  FileNodeId,
  UserId,
} from '@asciidocollab/domain';
import { reviewRoutes } from '../../../src/routes/review';
import { decorateApp } from '../../helpers/decorate-app';

// ── Stable ids shared across every review route test ────────────────────────
export const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
export const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
export const DOCUMENT_ID = '550e8400-e29b-41d4-a716-446655440003';
export const ITEM_ID = '550e8400-e29b-41d4-a716-446655440004';
export const REPLY_ID = '550e8400-e29b-41d4-a716-446655440005';
export const ASSIGNEE_ID = '550e8400-e29b-41d4-a716-446655440006';
export const REACTION_ID = '550e8400-e29b-41d4-a716-446655440007';
export const FILE_NODE_ID = '550e8400-e29b-41d4-a716-446655440008';
export const FILE_NODE_NAME = 'intro.adoc';

/** A located passage anchor for a root item. */
export function anchor(): ReviewAnchor {
  return new ReviewAnchor(null, { prefix: '', exact: 'x', suffix: '' }, 1, null, 'located');
}

/** A root comment authored by the acting user. */
export function comment(): ReviewComment {
  return new ReviewComment(
    ReviewCommentId.create(ITEM_ID),
    ProjectId.create(PROJECT_ID),
    DocumentId.create(DOCUMENT_ID),
    null,
    'comment',
    'a body',
    UserId.create(ACTOR_ID),
    null,
    null,
    null,
    null,
    null,
    anchor(),
  );
}

/** A root task (status `open`) authored by the acting user. */
export function task(): ReviewComment {
  return new ReviewComment(
    ReviewCommentId.create(ITEM_ID),
    ProjectId.create(PROJECT_ID),
    DocumentId.create(DOCUMENT_ID),
    null,
    'task',
    'a task body',
    UserId.create(ACTOR_ID),
    'open',
    null,
    null,
    null,
    null,
    anchor(),
  );
}

/** A reply hanging off {@link ITEM_ID}. */
export function reply(): ReviewComment {
  return new ReviewComment(
    ReviewCommentId.create(REPLY_ID),
    ProjectId.create(PROJECT_ID),
    DocumentId.create(DOCUMENT_ID),
    ReviewCommentId.create(ITEM_ID),
    'comment',
    'a reply body',
    UserId.create(ACTOR_ID),
  );
}

/** One reaction on {@link ITEM_ID} by the acting user. */
export function reaction(emoji = '👍'): ReviewReaction {
  return new ReviewReaction(
    ReviewReactionId.create(REACTION_ID),
    ReviewCommentId.create(ITEM_ID),
    UserId.create(ACTOR_ID),
    emoji,
  );
}

/** Per-sub-repo override maps merged over the defaults. */
export interface RepoOverrides {
  reviewComment?: Record<string, jest.Mock>;
  reviewReaction?: Record<string, jest.Mock>;
  projectMember?: Record<string, jest.Mock>;
  user?: Record<string, jest.Mock>;
  document?: Record<string, jest.Mock>;
  fileNode?: Record<string, jest.Mock>;
}

export interface BuildOptions extends RepoOverrides {
  /** Membership role of the acting user, or null for a non-member. */
  role?: string | null;
}

/** Reads the fileTreeEventBus.emit mock off a built test server. */
export function emitMock(app: FastifyInstance): jest.Mock {
  return (app as unknown as { fileTreeEventBus: { emit: jest.Mock } }).fileTreeEventBus.emit;
}

/** Reads the auditLog.save mock off a built test server. */
export function auditMock(app: FastifyInstance): jest.Mock {
  return (app as unknown as { repos: { auditLog: { save: jest.Mock } } }).repos.auditLog.save;
}

/**
 * Builds a bare Fastify server with the review routes registered against
 * hand-mocked repositories — mirrors the projects/main-file harness. Every repo
 * method the routes touch is stubbed with a sensible default that individual
 * tests override via the per-sub-repo maps.
 */
export async function buildServer(options: BuildOptions = {}): Promise<FastifyInstance> {
  const { role = 'editor' } = options;
  const app = Fastify();
  await app.register(rateLimit, { global: false });

  const limits = {
    rateLimitMax: 1000,
    rateLimitWindow: 60_000,
    reactionRateLimitMax: 1000,
    reactionRateLimitWindow: 60_000,
    bulkDeleteRateLimitMax: 1000,
    bulkDeleteRateLimitWindow: 60_000,
  };
  decorateApp(app, 'config', { project: { review: limits } });

  const reviewComment = {
    findById: jest.fn(async () => comment()),
    create: jest.fn(async () => undefined),
    update: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    listByDocument: jest.fn(async () => [] as ReviewComment[]),
    listByProject: jest.fn(async () => [] as ReviewComment[]),
    countByDocument: jest.fn(async () => 0),
    countByProject: jest.fn(async () => 0),
    deleteByDocument: jest.fn(async () => 0),
    deleteByProject: jest.fn(async () => 0),
    ...options.reviewComment,
  };
  const reviewReaction = {
    toggle: jest.fn(async () => undefined),
    listForItems: jest.fn(async () => [] as ReviewReaction[]),
    ...options.reviewReaction,
  };
  const projectMember = {
    findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
    ...options.projectMember,
  };
  const user = {
    findById: jest.fn(async () => ({ displayName: 'Ada', avatarKey: 'initial-face:5' })),
    ...options.user,
  };
  const auditLog = { save: jest.fn(async () => undefined) };
  // The project-wide list resolves each item's backing file (document → file node) for cross-document
  // labelling and navigation; document-scoped routes never touch these.
  const document = {
    findById: jest.fn(async () => ({ id: DocumentId.create(DOCUMENT_ID), fileNodeId: FileNodeId.create(FILE_NODE_ID) })),
    ...options.document,
  };
  const fileNode = {
    findById: jest.fn(async () => ({ id: FileNodeId.create(FILE_NODE_ID), name: FILE_NODE_NAME })),
    ...options.fileNode,
  };

  decorateApp(app, 'repos', { reviewComment, reviewReaction, projectMember, user, auditLog, document, fileNode });
  decorateApp(app, 'fileTreeEventBus', { emit: jest.fn(), subscribe: jest.fn() });

  await app.register(reviewRoutes);
  await app.ready();
  return app;
}

// ── URL helpers ─────────────────────────────────────────────────────────────
export const documentItemsUrl = `/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}/review-items`;
export const itemUrl = (id = ITEM_ID) => `/projects/${PROJECT_ID}/review-items/${id}`;
export const projectItemsUrl = `/projects/${PROJECT_ID}/review-items`;
export const documentBulkDeleteUrl = `/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}/review-items/bulk-delete`;
export const projectBulkDeleteUrl = `/projects/${PROJECT_ID}/review-items/bulk-delete`;
