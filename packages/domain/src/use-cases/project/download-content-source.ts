import { ProjectId } from '../../value-objects/ids/project-id';
import { FileNode } from '../../entities/file-node';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { CollaborationSessionRepository } from '../../ports/project/collaboration-session.repository';
import { CollaborativeContentReader } from '../../ports/storage/collaborative-content-reader';
import { Logger } from '../../ports/observability/logger';

/** The file's current content, taken live from its collaborative room. */
export interface InlineContentSource {
  /** Discriminant. */
  kind: 'inline';
  /** The live text, verbatim UTF-8. */
  bytes: Buffer;
}

/** An instruction to serve whatever the file store holds. */
export interface StoredContentSource {
  /** Discriminant. */
  kind: 'stored';
}

/** A file whose current content could not be determined, named so the caller can say which. */
export interface UnavailableContentSource {
  /** Discriminant. */
  kind: 'unavailable';
  /** The file the live read failed for. */
  fileNode: FileNode;
}

/** Per-file content source resolved before serving a download. */
export type DownloadContentSource =
  | InlineContentSource
  | StoredContentSource
  | UnavailableContentSource;

/**
 * What a caller wants to happen when the live collaborative read of a document fails.
 * `'fallback'` serves the last bytes written to the file store, which may be stale;
 * `'fail'` refuses to substitute them and surfaces the file as unavailable instead.
 *
 * Names the two policies for the implementation below; it is deliberately not exported and is
 * not the type to annotate an argument with. `resolveDownloadContentSource` is overloaded on the
 * two literals so that each one gets the narrower return type it actually produces, and a value
 * widened to this union matches neither overload.
 */
type LiveReadErrorPolicy = 'fallback' | 'fail';

/**
 * The sources a given policy can actually produce.
 *
 * `'unavailable'` is unreachable under `'fallback'`, and saying so in the type rather than only in
 * prose is what keeps the download routes honest: they branch on `'inline'` and treat everything
 * else as stored, which is correct precisely because they ask for `'fallback'`. Were one of them to
 * switch to `'fail'` it would start receiving a refusal it silently serves the stored bytes for —
 * the stale-content outcome the policy exists to prevent. Narrowing the return type makes that
 * switch a compile error at the call site instead of a quiet regression.
 */
export type ResolvedWithFallback = Exclude<DownloadContentSource, UnavailableContentSource>;

/** Dependencies required by {@link resolveDownloadContentSource}. */
export interface ResolveDownloadContentSourceDeps {
  /** Repository used to find the document associated with a file node. */
  documentRepo: Pick<DocumentRepository, 'findByFileNodeId'>;
  /** Repository used to check whether a collaboration session is active. */
  collaborationSessionRepo: Pick<CollaborationSessionRepository, 'isActive'>;
  /** Reader for live Yjs document content from the collab server. */
  collaborativeContentReader: CollaborativeContentReader;
  /** Optional logger for fallback warnings (metadata-only). */
  logger?: Logger;
}

/**
 * Builds a `ResolveDownloadContentSourceDeps` object from optional collaborator deps.
 * Returns `null` if any required dep is absent, preventing silent partial-wiring.
 */
export function buildResolverDeps(
  documentRepo: Pick<DocumentRepository, 'findByFileNodeId'> | undefined,
  collaborationSessionRepo: Pick<CollaborationSessionRepository, 'isActive'> | undefined,
  collaborativeContentReader: CollaborativeContentReader | undefined,
  logger?: Logger,
): ResolveDownloadContentSourceDeps | null {
  if (!documentRepo || !collaborationSessionRepo || !collaborativeContentReader) return null;
  return { documentRepo, collaborationSessionRepo, collaborativeContentReader, logger };
}

/**
 * Resolves the content source for a single file, for any caller that must decide between
 * the live collaborative text and the bytes on disk.
 *
 * Resolution rule:
 * 1. Find the document for the file node (binary assets have none → stored).
 * 2. Check if a collab session is active (dormant → stored, no collab round-trip).
 * 3. Read live Yjs text; success + non-null → inline bytes (verbatim UTF-8).
 * 4. Null (no live source) → stored silently.
 * 5. Failed live read → `onLiveReadError` decides: warn (metadata only) + stored, or unavailable.
 *
 * Steps 1, 2 and 4 are not fallbacks — nothing was lost, the file simply has no live text — so
 * they resolve to stored under either policy and `'unavailable'` is unreachable under
 * `'fallback'`. An unexpected throw from any dependency is a safety net rather than part of the
 * resolution order: under `'fallback'` it warns and resolves to stored, exactly as before the
 * policy existed. Under `'fail'` it resolves to unavailable, because a throw means the current
 * content could not be determined and that policy refuses to substitute the stored bytes.
 *
 * The inline branch wraps the reader's value verbatim with `Buffer.from(value, 'utf8')` — no
 * re-assembly — so the returned bytes are a consistent, non-torn snapshot.
 * This function never reads the file store; the caller serves the stored case.
 *
 * @param deps - Repositories, live-content reader and optional logger to resolve with.
 * @param projectId - Project that owns the file, used for the collab lookup and log metadata.
 * @param fileNode - The file whose content is being resolved; named back in the unavailable case.
 * @param onLiveReadError - Whether a failed live read falls back to the stored bytes or refuses
 * them. Required so a new caller cannot silently inherit fallback semantics.
 * @returns The live bytes, an instruction to serve the stored bytes, or — only under `'fail'` —
 * the file node whose live content could not be read.
 */
export async function resolveDownloadContentSource(
  deps: ResolveDownloadContentSourceDeps,
  projectId: ProjectId,
  fileNode: FileNode,
  onLiveReadError: 'fallback',
): Promise<ResolvedWithFallback>;
export async function resolveDownloadContentSource(
  deps: ResolveDownloadContentSourceDeps,
  projectId: ProjectId,
  fileNode: FileNode,
  onLiveReadError: 'fail',
): Promise<DownloadContentSource>;
export async function resolveDownloadContentSource(
  deps: ResolveDownloadContentSourceDeps,
  projectId: ProjectId,
  fileNode: FileNode,
  onLiveReadError: LiveReadErrorPolicy,
): Promise<DownloadContentSource> {
  try {
    const document = await deps.documentRepo.findByFileNodeId(fileNode.id);
    if (!document) return { kind: 'stored' };

    const sessionActive = await deps.collaborationSessionRepo.isActive(projectId, document.id);
    if (!sessionActive) return { kind: 'stored' };

    const live = await deps.collaborativeContentReader.readContent(projectId, document.yjsStateId);
    if (live.success && live.value !== null) {
      return { kind: 'inline', bytes: Buffer.from(live.value, 'utf8') };
    }

    if (!live.success) {
      if (onLiveReadError === 'fail') {
        return { kind: 'unavailable', fileNode };
      }

      deps.logger?.warn('Live collaborative read failed during download; falling back to file store', {
        projectId: projectId.value,
        fileNodeId: fileNode.id.value,
        path: fileNode.path.value,
        error: live.error.message,
      });
    }

    return { kind: 'stored' };
  } catch (error) {
    // A dependency that throws leaves the file's current content undetermined. Under `'fail'` the
    // caller has said it will not substitute stored bytes for content it could not confirm, so an
    // undetermined read is reported rather than quietly resolved to whatever is on disk — otherwise
    // a reader that throws instead of returning a failed result would defeat the policy entirely.
    if (onLiveReadError === 'fail') return { kind: 'unavailable', fileNode };

    deps.logger?.warn('Unexpected error resolving download content source; falling back to file store', {
      projectId: projectId.value,
      fileNodeId: fileNode.id.value,
      path: fileNode.path.value,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'stored' };
  }
}
