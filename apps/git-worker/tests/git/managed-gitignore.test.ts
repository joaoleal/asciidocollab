import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  MANAGED_GITIGNORE_ENTRIES,
  buildManagedGitignore,
  writeManagedGitignore,
} from '../../src/git/managed-gitignore.js';
import { runGitCommand } from '../../src/git/run-git-command.js';
import { createTemporaryWorkingTree, commitAll } from '../helpers/temporary-git-repo.js';

describe('buildManagedGitignore', () => {
  it('always contains every managed internal entry, even with no prior content and no user patterns', () => {
    const content = buildManagedGitignore(null, null);

    for (const entry of MANAGED_GITIGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });

  it('merges maintainer-editable patterns alongside the managed entries, both present', () => {
    const content = buildManagedGitignore(null, 'build/\n*.log');

    for (const entry of MANAGED_GITIGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
    expect(content).toContain('build/');
    expect(content).toContain('*.log');
  });

  it('regenerates the managed section from a previous version of the file without losing user patterns', () => {
    const firstGeneration = buildManagedGitignore(null, 'build/');
    // Regeneration re-derives from the freshly generated file, exactly as the worker would on its
    // next run — the managed section must still be complete and the user pattern must survive.
    const secondGeneration = buildManagedGitignore(firstGeneration, 'build/');

    for (const entry of MANAGED_GITIGNORE_ENTRIES) {
      expect(secondGeneration).toContain(entry);
    }
    expect(secondGeneration).toContain('build/');
  });

  it('updates the user section when patterns change, without duplicating or losing the managed section', () => {
    const firstGeneration = buildManagedGitignore(null, 'build/');
    const updated = buildManagedGitignore(firstGeneration, 'build/\ndist/');

    expect(updated).toContain('dist/');
    // The managed block must appear exactly once even after a regeneration cycle.
    const managedEntryOccurrences = updated.split('.collab/').length - 1;
    expect(managedEntryOccurrences).toBe(1);
  });

  it('preserves content a maintainer added outside the managed and user marker blocks', () => {
    const handWritten = 'node_modules/\n*.swp\n';
    const regenerated = buildManagedGitignore(handWritten, 'build/');

    expect(regenerated).toContain('node_modules/');
    expect(regenerated).toContain('*.swp');
    expect(regenerated).toContain('build/');
    for (const entry of MANAGED_GITIGNORE_ENTRIES) {
      expect(regenerated).toContain(entry);
    }
  });

  it('clears a previously-set user pattern on the next regeneration when patterns become null', () => {
    const firstGeneration = buildManagedGitignore(null, 'build/');
    const cleared = buildManagedGitignore(firstGeneration, null);

    expect(cleared).not.toContain('build/');
    for (const entry of MANAGED_GITIGNORE_ENTRIES) {
      expect(cleared).toContain(entry);
    }
  });
});

describe('writeManagedGitignore', () => {
  it('writes a .gitignore into the working tree containing the managed entries', async () => {
    const cwd = await createTemporaryWorkingTree();

    await writeManagedGitignore(cwd, null);

    const written = await readFile(path.join(cwd, '.gitignore'), 'utf8');
    for (const entry of MANAGED_GITIGNORE_ENTRIES) {
      expect(written).toContain(entry);
    }
  });

  it('is regeneration-safe against a real committed .gitignore: reruns preserve prior user patterns', async () => {
    const cwd = await createTemporaryWorkingTree();

    await writeManagedGitignore(cwd, 'build/');
    await commitAll(cwd, 'add managed gitignore');

    // Simulate the worker re-running on a later job with the same persisted patterns.
    await writeManagedGitignore(cwd, 'build/');

    const written = await readFile(path.join(cwd, '.gitignore'), 'utf8');
    expect(written).toContain('build/');
    for (const entry of MANAGED_GITIGNORE_ENTRIES) {
      expect(written).toContain(entry);
    }
  });

  it('never lets .collab/ or an internal temp artifact be staged, even with `git add -A`', async () => {
    const cwd = await createTemporaryWorkingTree();

    await writeManagedGitignore(cwd, null);
    await mkdir(path.join(cwd, '.collab'), { recursive: true });
    await writeFile(path.join(cwd, '.collab', 'state.bin'), 'yjs-blob');
    await writeFile(path.join(cwd, 'leftover.tmp'), 'partial atomic write');
    await writeFile(path.join(cwd, 'tracked.txt'), 'real project content\n');

    await runGitCommand(cwd, { command: 'add', flags: ['-A'] });
    const { stdout } = await runGitCommand(cwd, { command: 'status', flags: ['--porcelain'] });

    expect(stdout).not.toContain('.collab');
    expect(stdout).not.toContain('leftover.tmp');
    expect(stdout).toContain('tracked.txt');
  });
});
