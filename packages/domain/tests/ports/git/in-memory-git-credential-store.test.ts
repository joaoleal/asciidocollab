import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { InMemoryGitCredentialStore } from './in-memory-git-credential-store';

describe('InMemoryGitCredentialStore', () => {
  const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440010');
  const otherProjectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440011');

  it('reads back the same encrypted token and hint that were saved', async () => {
    const store = new InMemoryGitCredentialStore();
    await store.save(projectId, { encryptedToken: 'iv:tag:ciphertext', tokenHint: 'a1b2' });

    const found = await store.load(projectId);

    expect(found).toEqual({ encryptedToken: 'iv:tag:ciphertext', tokenHint: 'a1b2' });
  });

  it('returns null when reading a project with no stored credential', async () => {
    const store = new InMemoryGitCredentialStore();

    const found = await store.load(projectId);

    expect(found).toBeNull();
  });

  it('overwrites the previous credential when saving again for the same project', async () => {
    const store = new InMemoryGitCredentialStore();
    await store.save(projectId, { encryptedToken: 'iv:tag:old', tokenHint: 'aaaa' });
    await store.save(projectId, { encryptedToken: 'iv:tag:new', tokenHint: 'bbbb' });

    const found = await store.load(projectId);

    expect(found).toEqual({ encryptedToken: 'iv:tag:new', tokenHint: 'bbbb' });
  });

  it('deletes the stored credential so a later read returns null', async () => {
    const store = new InMemoryGitCredentialStore();
    await store.save(projectId, { encryptedToken: 'iv:tag:ciphertext', tokenHint: 'a1b2' });

    await store.delete(projectId);

    expect(await store.load(projectId)).toBeNull();
  });

  it('treats deleting a project with no stored credential as a no-op', async () => {
    const store = new InMemoryGitCredentialStore();

    await expect(store.delete(projectId)).resolves.toBeUndefined();
  });

  it('keeps credentials for different projects independent', async () => {
    const store = new InMemoryGitCredentialStore();
    await store.save(projectId, { encryptedToken: 'iv:tag:one', tokenHint: '1111' });
    await store.save(otherProjectId, { encryptedToken: 'iv:tag:two', tokenHint: '2222' });

    await store.delete(projectId);

    expect(await store.load(projectId)).toBeNull();
    expect(await store.load(otherProjectId)).toEqual({ encryptedToken: 'iv:tag:two', tokenHint: '2222' });
  });

  it('allows a null tokenHint to round-trip', async () => {
    const store = new InMemoryGitCredentialStore();
    await store.save(projectId, { encryptedToken: 'iv:tag:ciphertext', tokenHint: null });

    expect(await store.load(projectId)).toEqual({ encryptedToken: 'iv:tag:ciphertext', tokenHint: null });
  });
});
