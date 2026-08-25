import type { ProjectId } from '@asciidocollab/domain';
import type { PushCredentialSource } from '../../src/dispatch/push-handler.js';

/**
 * A fake `PushCredentialSource` for handler tests: seeds a plaintext token per project without
 * ever touching real encryption, so a test can assert the handler passes it through to the use
 * case and never logs it.
 */
export class FakePushCredentialSource implements PushCredentialSource {
  private readonly tokens = new Map<string, string>();

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
}
