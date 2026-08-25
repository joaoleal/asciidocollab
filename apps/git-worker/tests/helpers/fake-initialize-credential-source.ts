import type { ProjectId } from '@asciidocollab/domain';
import type { InitializeCredentialSource } from '../../src/dispatch/initialize-handler.js';

/**
 * A fake `InitializeCredentialSource` for handler tests: seeds a plaintext token per project
 * without ever touching real encryption, and records every `delete` call so a test can assert the
 * handler's abandoned-cleanup actually removes the credential on a failed initialize.
 */
export class FakeInitializeCredentialSource implements InitializeCredentialSource {
  private readonly tokens = new Map<string, string>();

  /** Every project id `delete` was called for, in call order. */
  readonly deleteCalls: ProjectId[] = [];

  /** Configures `loadDecrypted` to return `token` for `projectId`. */
  seed(projectId: ProjectId, token: string): void {
    this.tokens.set(projectId.value, token);
  }

  async loadDecrypted(
    projectId: ProjectId,
  ): Promise<{ readonly token: string; readonly tokenHint: string | null } | null> {
    const token = this.tokens.get(projectId.value);
    if (token === undefined) return null;
    return { token, tokenHint: token.length > 0 ? token.slice(-4) : null };
  }

  async delete(projectId: ProjectId): Promise<void> {
    this.deleteCalls.push(projectId);
    this.tokens.delete(projectId.value);
  }
}
