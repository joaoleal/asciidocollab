import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { GitWorkingTreeStatus } from '../../../src/ports/git/git-command-runner';
import { InMemoryGitCommandRunner } from './in-memory-git-command-runner';

describe('InMemoryGitCommandRunner', () => {
  const projectA = ProjectId.create('550e8400-e29b-41d4-a716-446655440030');
  const projectB = ProjectId.create('550e8400-e29b-41d4-a716-446655440031');

  const cleanStatus: GitWorkingTreeStatus = { currentBranch: 'main', changes: [] };
  const dirtyStatus: GitWorkingTreeStatus = {
    currentBranch: 'feature/x',
    changes: [
      { path: 'docs/intro.adoc', changeType: 'modified', state: 'unstaged' },
      { path: 'docs/new.adoc', changeType: 'added', state: 'staged' },
    ],
  };

  describe('getStatus', () => {
    it('returns the exact status DTO seeded for a project', async () => {
      const runner = new InMemoryGitCommandRunner();
      runner.seedStatus(projectA, dirtyStatus);

      const result = await runner.getStatus(projectA);

      expect(result).toEqual({ success: true, value: dirtyStatus });
    });

    it('returns a GitCommandFailedError without throwing when no status is seeded', async () => {
      const runner = new InMemoryGitCommandRunner();

      const result = await runner.getStatus(projectA);

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBeInstanceOf(GitCommandFailedError);
    });

    it('returns a seeded failure verbatim instead of the happy-path status', async () => {
      const runner = new InMemoryGitCommandRunner();
      const failure = new GitCommandFailedError('working tree is not initialized');
      runner.seedStatus(projectA, cleanStatus);
      runner.seedStatusFailure(projectA, failure);

      const result = await runner.getStatus(projectA);

      expect(result).toEqual({ success: false, error: failure });
    });

    it('keeps seeded status independent per project', async () => {
      const runner = new InMemoryGitCommandRunner();
      runner.seedStatus(projectA, cleanStatus);
      runner.seedStatus(projectB, dirtyStatus);

      expect(await runner.getStatus(projectA)).toEqual({ success: true, value: cleanStatus });
      expect(await runner.getStatus(projectB)).toEqual({ success: true, value: dirtyStatus });
    });

    it('records every call made, in order, so use-case tests can assert interactions', async () => {
      const runner = new InMemoryGitCommandRunner();
      runner.seedStatus(projectA, cleanStatus);
      runner.seedStatus(projectB, dirtyStatus);

      await runner.getStatus(projectA);
      await runner.getStatus(projectB);
      await runner.getStatus(projectA);

      expect(runner.statusCalls).toEqual([projectA, projectB, projectA]);
    });
  });
});
