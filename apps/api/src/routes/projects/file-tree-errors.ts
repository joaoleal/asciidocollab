import type { FastifyReply } from 'fastify';
import {
  PermissionDeniedError,
  InsufficientRoleError,
  FileConflictError,
  FileNodeNotFoundError,
  CannotDeleteRootFolderError,
} from '@asciidocollab/domain';

/** Maps a string value to the `'file'` or `'folder'` node type union. */
export function toNodeType(value: string): 'file' | 'folder' {
  return value === 'folder' ? 'folder' : 'file';
}

/**
 * Names reserved for platform-internal metadata: `.git` (working-tree metadata) and `.collab`
 * (Yjs blob store). These sit beside the tracked project tree on disk and must never become a
 * file-tree node — matched as a whole name/segment only, so `.gitignore` and `.github` are unaffected.
 */
const HIDDEN_METADATA_NAMES = new Set(['.git', '.collab']);

/** Whether a single file/folder name is exactly one of the reserved hidden-metadata names. */
export function isHiddenMetadataName(name: string): boolean {
  return HIDDEN_METADATA_NAMES.has(name);
}

/** Whether a stored path has `.git` or `.collab` as one of its segments, at any depth. */
export function pathHasHiddenMetadataSegment(pathValue: string): boolean {
  return pathValue.split('/').some((segment) => HIDDEN_METADATA_NAMES.has(segment));
}

/** Sends the standard 400 response for a file operation that targets reserved internal metadata. */
export function sendHiddenMetadataError(reply: FastifyReply) {
  return reply.status(400).send({
    error: {
      code: 'RESERVED_PATH',
      message: 'This name is reserved for internal metadata and cannot be used',
    },
  });
}

/**
 * Translates a domain error into the appropriate HTTP error response.
 *
 * The `authz.denied` audit event for a {@link PermissionDeniedError} is now
 * recorded inside the file-tree use cases (in the domain), so this boundary
 * helper only maps the error to its HTTP status.
 */
export function sendFileTreeError(reply: FastifyReply, error: Error) {
  if (error instanceof PermissionDeniedError || error instanceof InsufficientRoleError) {
    return reply.status(403).send({ error: { code: 'FORBIDDEN', message: error.message } });
  }
  if (error instanceof FileConflictError) {
    const body: Record<string, unknown> = { error: { code: 'CONFLICT', message: error.message } };
    if (error.existingId) body['existingFileNodeId'] = error.existingId;
    return reply.status(409).send(body);
  }
  if (error instanceof FileNodeNotFoundError) {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'File not found' } });
  }
  if (error instanceof CannotDeleteRootFolderError) {
    return reply.status(400).send({ error: { code: 'CANNOT_DELETE_ROOT', message: error.message } });
  }
  return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
}
