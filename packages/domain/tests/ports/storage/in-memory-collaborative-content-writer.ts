import { CollaborativeContentWriter } from '../../../src/ports/storage/collaborative-content-writer';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { YjsStateId } from '../../../src/value-objects/ids/yjs-state-id';
import { Result } from '../../../src/types/result';

/**
 * In-memory {@link CollaborativeContentWriter} for domain tests. It models the OUTCOME of a
 * minimal-diff reconcile: `replaceContent` sets the stored content for the `(projectId,
 * yjsStateId)` key to `targetContent` exactly — the minimal-diff reconciliation itself is the real
 * collaboration adapter's concern, so the fake just lands the final content.
 */
export class InMemoryCollaborativeContentWriter implements CollaborativeContentWriter {
  private readonly documents = new Map<string, string>();
  private nextFailure: Error | undefined;

  /** Read a document's landed content (post-replace), for assertions. `undefined` when never written. */
  contentFor(projectId: ProjectId, yjsStateId: YjsStateId): string | undefined {
    return this.documents.get(key(projectId, yjsStateId));
  }

  /** Force the next `replaceContent` call to fail with `error` instead of landing content. One-shot. */
  failNext(error: Error): void {
    this.nextFailure = error;
  }

  async replaceContent(
    projectId: ProjectId,
    yjsStateId: YjsStateId,
    targetContent: string,
  ): Promise<Result<void, Error>> {
    if (this.nextFailure) {
      const error = this.nextFailure;
      this.nextFailure = undefined;
      return { success: false, error };
    }
    this.documents.set(key(projectId, yjsStateId), targetContent);
    return { success: true, value: undefined };
  }
}

function key(projectId: ProjectId, yjsStateId: YjsStateId): string {
  return `${projectId.value}/${yjsStateId.value}`;
}
