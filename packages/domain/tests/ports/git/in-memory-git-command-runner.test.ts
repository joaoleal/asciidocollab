import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { RepositoryUnreachableError } from '../../../src/errors/git/repository-unreachable';
import {
  GitBehindAhead,
  GitBranchList,
  GitCreatedBranch,
  GitFetchResult,
  GitMergeOutcome,
  GitWorkingTreeStatus,
} from '../../../src/ports/git/git-command-runner';
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

  describe('fetch', () => {
    const fetchInput = { remoteUrl: 'https://example.com/repo.git', token: 'secret-token', branch: 'main' };

    it('returns the seeded GitFetchResult for a project', async () => {
      const runner = new InMemoryGitCommandRunner();
      const seeded: GitFetchResult = { remoteHead: 'abc123' };
      runner.seedFetch(projectA, seeded);

      const result = await runner.fetch(projectA, fetchInput);

      expect(result).toEqual({ success: true, value: seeded });
    });

    it('returns a default GitFetchResult when unseeded', async () => {
      const runner = new InMemoryGitCommandRunner();

      const result = await runner.fetch(projectA, fetchInput);

      expect(result.success).toBe(true);
      expect(result.success && typeof result.value.remoteHead).toBe('string');
    });

    it('returns a seeded failure instead of the happy-path result', async () => {
      const runner = new InMemoryGitCommandRunner();
      const failure = new RepositoryUnreachableError();
      runner.seedFetch(projectA, { remoteHead: 'abc123' });
      runner.seedFetchFailure(projectA, failure);

      const result = await runner.fetch(projectA, fetchInput);

      expect(result).toEqual({ success: false, error: failure });
    });

    it('records every call made, including the input', async () => {
      const runner = new InMemoryGitCommandRunner();

      await runner.fetch(projectA, fetchInput);

      expect(runner.fetchCalls).toEqual([{ projectId: projectA, input: fetchInput }]);
    });
  });

  describe('getBehindAhead', () => {
    it('returns the seeded GitBehindAhead for a project', async () => {
      const runner = new InMemoryGitCommandRunner();
      const seeded: GitBehindAhead = { behind: 2, ahead: 1 };
      runner.seedBehindAhead(projectA, seeded);

      const result = await runner.getBehindAhead(projectA, 'main');

      expect(result).toEqual({ success: true, value: seeded });
    });

    it('defaults to zero behind and ahead when unseeded', async () => {
      const runner = new InMemoryGitCommandRunner();

      const result = await runner.getBehindAhead(projectA, 'main');

      expect(result).toEqual({ success: true, value: { behind: 0, ahead: 0 } });
    });

    it('returns a seeded failure instead of the happy-path result', async () => {
      const runner = new InMemoryGitCommandRunner();
      const failure = new GitCommandFailedError('rev-list failed');
      runner.seedBehindAheadFailure(projectA, failure);

      const result = await runner.getBehindAhead(projectA, 'main');

      expect(result).toEqual({ success: false, error: failure });
    });

    it('records every call made, including the branch', async () => {
      const runner = new InMemoryGitCommandRunner();

      await runner.getBehindAhead(projectA, 'feature/x');

      expect(runner.behindAheadCalls).toEqual([{ projectId: projectA, branch: 'feature/x' }]);
    });
  });

  describe('merge', () => {
    const mergeInput = {
      branch: 'main',
      flush: [{ path: 'docs/intro.adoc', content: 'live text' }],
    };

    it('returns the seeded merged outcome with its changes', async () => {
      const runner = new InMemoryGitCommandRunner();
      const seeded: GitMergeOutcome = {
        status: 'merged',
        headCommit: 'def456',
        changes: [{ type: 'modified', path: 'docs/intro.adoc', content: Buffer.from('merged'), mimeType: 'text/asciidoc' }],
      };
      runner.seedMerge(projectA, seeded);

      const result = await runner.merge(projectA, mergeInput);

      expect(result).toEqual({ success: true, value: seeded });
    });

    it('returns the seeded conflicted outcome with its conflicts', async () => {
      const runner = new InMemoryGitCommandRunner();
      const seeded: GitMergeOutcome = {
        status: 'conflicted',
        conflicts: [{ path: 'docs/intro.adoc', isBinary: false }],
      };
      runner.seedMerge(projectA, seeded);

      const result = await runner.merge(projectA, mergeInput);

      expect(result).toEqual({ success: true, value: seeded });
    });

    it('defaults to a clean merge with no changes when unseeded', async () => {
      const runner = new InMemoryGitCommandRunner();

      const result = await runner.merge(projectA, mergeInput);

      expect(result.success).toBe(true);
      expect(result.success && result.value.status).toBe('merged');
      expect(result.success && result.value.status === 'merged' && result.value.changes).toEqual([]);
    });

    it('returns a seeded failure instead of the happy-path outcome', async () => {
      const runner = new InMemoryGitCommandRunner();
      const failure = new GitCommandFailedError('merge failed');
      runner.seedMergeFailure(projectA, failure);

      const result = await runner.merge(projectA, mergeInput);

      expect(result).toEqual({ success: false, error: failure });
    });

    it('records every call made, including the flush and branch', async () => {
      const runner = new InMemoryGitCommandRunner();

      await runner.merge(projectA, mergeInput);

      expect(runner.mergeCalls).toEqual([{ projectId: projectA, input: mergeInput }]);
    });
  });

  describe('createBranch', () => {
    const createBranchInput = { name: 'feature/new-chapter' };

    it('returns the seeded GitCreatedBranch for a project', async () => {
      const runner = new InMemoryGitCommandRunner();
      const seeded: GitCreatedBranch = { name: 'feature/new-chapter' };
      runner.seedCreateBranch(projectA, seeded);

      const result = await runner.createBranch(projectA, createBranchInput);

      expect(result).toEqual({ success: true, value: seeded });
    });

    it('defaults to a branch named exactly as requested when unseeded', async () => {
      const runner = new InMemoryGitCommandRunner();

      const result = await runner.createBranch(projectA, createBranchInput);

      expect(result).toEqual({ success: true, value: { name: 'feature/new-chapter' } });
    });

    it('returns a seeded failure instead of the happy-path result', async () => {
      const runner = new InMemoryGitCommandRunner();
      const failure = new GitCommandFailedError('a branch by that name already exists');
      runner.seedCreateBranchFailure(projectA, failure);

      const result = await runner.createBranch(projectA, createBranchInput);

      expect(result).toEqual({ success: false, error: failure });
    });

    it('records every call made, including the requested name', async () => {
      const runner = new InMemoryGitCommandRunner();

      await runner.createBranch(projectA, createBranchInput);

      expect(runner.createBranchCalls).toEqual([{ projectId: projectA, input: createBranchInput }]);
    });
  });

  describe('listBranches', () => {
    it('returns the seeded GitBranchList for a project', async () => {
      const runner = new InMemoryGitCommandRunner();
      const seeded: GitBranchList = { current: 'main', branches: ['main', 'feature/x'] };
      runner.seedBranches(projectA, seeded);

      const result = await runner.listBranches(projectA);

      expect(result).toEqual({ success: true, value: seeded });
    });

    it('defaults to a single main branch when unseeded', async () => {
      const runner = new InMemoryGitCommandRunner();

      const result = await runner.listBranches(projectA);

      expect(result).toEqual({ success: true, value: { current: 'main', branches: ['main'] } });
    });

    it('returns a seeded failure instead of the happy-path list', async () => {
      const runner = new InMemoryGitCommandRunner();
      const failure = new GitCommandFailedError('working tree is not initialized');
      runner.seedBranchesFailure(projectA, failure);

      const result = await runner.listBranches(projectA);

      expect(result).toEqual({ success: false, error: failure });
    });

    it('keeps seeded branch lists independent per project', async () => {
      const runner = new InMemoryGitCommandRunner();
      runner.seedBranches(projectA, { current: 'main', branches: ['main'] });
      runner.seedBranches(projectB, { current: 'develop', branches: ['develop', 'main'] });

      expect(await runner.listBranches(projectA)).toEqual({
        success: true,
        value: { current: 'main', branches: ['main'] },
      });
      expect(await runner.listBranches(projectB)).toEqual({
        success: true,
        value: { current: 'develop', branches: ['develop', 'main'] },
      });
    });

    it('records every call made, in order', async () => {
      const runner = new InMemoryGitCommandRunner();

      await runner.listBranches(projectA);
      await runner.listBranches(projectB);

      expect(runner.listBranchesCalls).toEqual([projectA, projectB]);
    });
  });
});
