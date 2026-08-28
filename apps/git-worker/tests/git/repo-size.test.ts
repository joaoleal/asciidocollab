import { execFile as execFileCallback } from 'node:child_process';
import { rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  measureWorkingTreeSizeBytes,
  repoSizeCeilingBytes,
  repoSizeExceedsLimit,
} from '../../src/git/repo-size.js';
import { commitAll, createTemporaryWorkingTree } from '../helpers/temporary-git-repo.js';

const execFile = promisify(execFileCallback);

describe('repoSizeCeilingBytes', () => {
  it('converts a megabyte ceiling to the exact byte count it represents', () => {
    expect(repoSizeCeilingBytes(1)).toBe(1024 * 1024);
    expect(repoSizeCeilingBytes(500)).toBe(500 * 1024 * 1024);
  });
});

describe('repoSizeExceedsLimit', () => {
  it('returns false when the measured size is under the ceiling', () => {
    expect(repoSizeExceedsLimit(1024 * 1024 - 1, 1)).toBe(false);
  });

  it('returns false when the measured size exactly equals the ceiling', () => {
    expect(repoSizeExceedsLimit(1024 * 1024, 1)).toBe(false);
  });

  it('returns true when the measured size is over the ceiling', () => {
    expect(repoSizeExceedsLimit(1024 * 1024 + 1, 1)).toBe(true);
  });

  it('returns true for a size far beyond a small ceiling', () => {
    expect(repoSizeExceedsLimit(500 * 1024 * 1024, 1)).toBe(true);
  });

  it('returns false for zero measured size regardless of ceiling', () => {
    expect(repoSizeExceedsLimit(0, 1)).toBe(false);
  });
});

describe('measureWorkingTreeSizeBytes', () => {
  it('sums the on-disk size of every tracked file', async () => {
    const workingTree = await createTemporaryWorkingTree();
    await writeFile(path.join(workingTree, 'a.adoc'), 'x'.repeat(100));
    await writeFile(path.join(workingTree, 'b.adoc'), 'y'.repeat(250));
    await commitAll(workingTree, 'seed');

    await expect(measureWorkingTreeSizeBytes(workingTree)).resolves.toBe(350);
  });

  it('counts nothing for a tracked path that is no longer on disk', async () => {
    // A tracked file deleted from the working tree has no bytes to read, so the measurement must
    // skip it rather than fail the whole size check the clone gate depends on.
    const workingTree = await createTemporaryWorkingTree();
    await writeFile(path.join(workingTree, 'kept.adoc'), 'z'.repeat(40));
    await writeFile(path.join(workingTree, 'vanished.adoc'), 'z'.repeat(1000));
    await commitAll(workingTree, 'seed');
    await rm(path.join(workingTree, 'vanished.adoc'));

    await expect(measureWorkingTreeSizeBytes(workingTree)).resolves.toBe(40);
  });

  it('counts nothing for a tracked path that is not a regular file', async () => {
    // A symlink's own bytes are never read into memory by the importer, so its link-path length
    // must not inflate the measured total.
    const workingTree = await createTemporaryWorkingTree();
    await writeFile(path.join(workingTree, 'real.adoc'), 'q'.repeat(64));
    await symlink('real.adoc', path.join(workingTree, 'link.adoc'));
    await execFile('git', ['add', '-A'], { cwd: workingTree });
    await execFile('git', ['commit', '-q', '-m', 'seed'], { cwd: workingTree });

    await expect(measureWorkingTreeSizeBytes(workingTree)).resolves.toBe(64);
  });
});
