import { StashChanges } from '../../../src/use-cases/git/stash-changes';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440040');

describe('StashChanges', () => {
  describe('shelve', () => {
    test('shelves the working tree and returns the seeded stashed outcome', async () => {
      const commandRunner = new InMemoryGitCommandRunner();
      commandRunner.seedStash(PROJECT_ID, { stashed: true });
      const service = new StashChanges(commandRunner);

      const result = await service.shelve(PROJECT_ID);

      expect(result).toEqual({ success: true, value: { stashed: true } });
      expect(commandRunner.stashCalls).toEqual([PROJECT_ID]);
    });

    test('a clean working tree returns stashed: false', async () => {
      const commandRunner = new InMemoryGitCommandRunner();
      commandRunner.seedStash(PROJECT_ID, { stashed: false });
      const service = new StashChanges(commandRunner);

      const result = await service.shelve(PROJECT_ID);

      expect(result).toEqual({ success: true, value: { stashed: false } });
    });

    test('a failing stash command propagates its GitCommandFailedError', async () => {
      const commandRunner = new InMemoryGitCommandRunner();
      const failure = new GitCommandFailedError('stash push failed');
      commandRunner.seedStashFailure(PROJECT_ID, failure);
      const service = new StashChanges(commandRunner);

      const result = await service.shelve(PROJECT_ID);

      expect(result).toEqual({ success: false, error: failure });
    });
  });

  describe('restore', () => {
    test('restores cleanly and returns hadConflicts: false', async () => {
      const commandRunner = new InMemoryGitCommandRunner();
      commandRunner.seedRestoreStash(PROJECT_ID, { hadConflicts: false });
      const service = new StashChanges(commandRunner);

      const result = await service.restore(PROJECT_ID);

      expect(result).toEqual({ success: true, value: { hadConflicts: false } });
      expect(commandRunner.restoreStashCalls).toEqual([PROJECT_ID]);
    });

    test('a conflicted restore is a successful Result, not an error', async () => {
      const commandRunner = new InMemoryGitCommandRunner();
      commandRunner.seedRestoreStash(PROJECT_ID, { hadConflicts: true });
      const service = new StashChanges(commandRunner);

      const result = await service.restore(PROJECT_ID);

      expect(result.success).toBe(true);
      expect(result.success && result.value).toEqual({ hadConflicts: true });
    });

    test('a failing restore command propagates its GitCommandFailedError', async () => {
      const commandRunner = new InMemoryGitCommandRunner();
      const failure = new GitCommandFailedError('stash pop failed');
      commandRunner.seedRestoreStashFailure(PROJECT_ID, failure);
      const service = new StashChanges(commandRunner);

      const result = await service.restore(PROJECT_ID);

      expect(result).toEqual({ success: false, error: failure });
    });
  });
});
