import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { InMemoryGitCredentialStore } from './in-memory-git-credential-store';

describe('InMemoryGitCredentialStore', () => {
  const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440010');
  const otherProjectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440011');
  const createdByUserId = UserId.create('550e8400-e29b-41d4-a716-446655440020');
  const provider = GitProvider.create('github');

  it('reads back an encrypted (never plaintext) token and a hint derived from it', async () => {
    const store = new InMemoryGitCredentialStore();
    await store.save(projectId, { token: 'ghp_abcdefgh1234', provider, createdByUserId });

    const found = await store.load(projectId);

    expect(found).not.toBeNull();
    expect(found!.encryptedToken).not.toBe('ghp_abcdefgh1234');
    expect(found!.tokenHint).toBe('1234');
  });

  it('returns null when reading a project with no stored credential', async () => {
    const store = new InMemoryGitCredentialStore();

    const found = await store.load(projectId);

    expect(found).toBeNull();
  });

  it('overwrites the previous credential when saving again for the same project', async () => {
    const store = new InMemoryGitCredentialStore();
    await store.save(projectId, { token: 'old-token-aaaa', provider, createdByUserId });
    await store.save(projectId, { token: 'new-token-bbbb', provider, createdByUserId });

    const found = await store.load(projectId);

    expect(found!.tokenHint).toBe('bbbb');
    expect(found!.encryptedToken).not.toBe('new-token-bbbb');
  });

  it('deletes the stored credential so a later read returns null', async () => {
    const store = new InMemoryGitCredentialStore();
    await store.save(projectId, { token: 'ghp_abcdefgh1234', provider, createdByUserId });

    await store.delete(projectId);

    expect(await store.load(projectId)).toBeNull();
  });

  it('treats deleting a project with no stored credential as a no-op', async () => {
    const store = new InMemoryGitCredentialStore();

    await expect(store.delete(projectId)).resolves.toBeUndefined();
  });

  it('keeps credentials for different projects independent', async () => {
    const store = new InMemoryGitCredentialStore();
    await store.save(projectId, { token: 'token-one-1111', provider, createdByUserId });
    await store.save(otherProjectId, { token: 'token-two-2222', provider, createdByUserId });

    await store.delete(projectId);

    expect(await store.load(projectId)).toBeNull();
    expect(await store.load(otherProjectId)).toEqual({
      encryptedToken: 'encrypted:token-two-2222',
      tokenHint: '2222',
    });
  });

  it('does not echo the save-only provider/createdByUserId context back from load', async () => {
    const store = new InMemoryGitCredentialStore();
    await store.save(projectId, { token: 'ghp_abcdefgh1234', provider, createdByUserId });

    const found = await store.load(projectId);

    expect(found).not.toHaveProperty('provider');
    expect(found).not.toHaveProperty('createdByUserId');
  });
});
