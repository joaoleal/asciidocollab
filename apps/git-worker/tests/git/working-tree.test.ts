import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ProjectId } from '@asciidocollab/domain';
import { ensureCleanWorkingTree, resolveWorkingTreePath } from '../../src/git/working-tree.js';
import { commitAll, createTemporaryWorkingTree } from '../helpers/temporary-git-repo.js';

describe('resolveWorkingTreePath', () => {
  it('joins the storage root and the project id', () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440040');

    expect(resolveWorkingTreePath('/var/storage', projectId)).toBe(`/var/storage/${projectId.value}`);
  });
});

describe('ensureCleanWorkingTree', () => {
  it('removes untracked files and discards uncommitted modifications, keeping committed content', async () => {
    const cwd = await createTemporaryWorkingTree();
    await writeFile(path.join(cwd, 'tracked.txt'), 'original\n');
    await commitAll(cwd, 'init');

    await writeFile(path.join(cwd, 'tracked.txt'), 'modified-uncommitted\n');
    await writeFile(path.join(cwd, 'untracked.txt'), 'should be removed\n');

    await ensureCleanWorkingTree(cwd);

    await expect(readFile(path.join(cwd, 'tracked.txt'), 'utf8')).resolves.toBe('original\n');
    await expect(access(path.join(cwd, 'untracked.txt'))).rejects.toThrow();
  });

  it('does not fail on a freshly initialized repository with no commits yet (unborn HEAD)', async () => {
    const cwd = await createTemporaryWorkingTree();
    await writeFile(path.join(cwd, 'untracked.txt'), 'stray file before any commit\n');

    await expect(ensureCleanWorkingTree(cwd)).resolves.toBeUndefined();
    await expect(access(path.join(cwd, 'untracked.txt'))).rejects.toThrow();
  });

  it('never removes the .collab/ Yjs blob store, even though it is untracked', async () => {
    const cwd = await createTemporaryWorkingTree();
    await writeFile(path.join(cwd, 'tracked.txt'), 'original\n');
    await commitAll(cwd, 'init');

    await mkdir(path.join(cwd, '.collab'), { recursive: true });
    await writeFile(path.join(cwd, '.collab', 'state.bin'), 'live collaboration state');
    await writeFile(path.join(cwd, 'untracked.txt'), 'should still be removed\n');

    await ensureCleanWorkingTree(cwd);

    await expect(readFile(path.join(cwd, '.collab', 'state.bin'), 'utf8')).resolves.toBe(
      'live collaboration state',
    );
    await expect(access(path.join(cwd, 'untracked.txt'))).rejects.toThrow();
  });
});
