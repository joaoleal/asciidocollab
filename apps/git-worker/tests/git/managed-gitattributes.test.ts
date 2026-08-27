import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildManagedGitattributes,
  isPathAlreadyLfsTracked,
  writeManagedGitattributes,
} from '../../src/git/managed-gitattributes.js';
import { createTemporaryWorkingTree } from '../helpers/temporary-git-repo.js';

describe('buildManagedGitattributes', () => {
  it('writes a managed filter=lfs line for each given pattern, with no prior content', () => {
    const content = buildManagedGitattributes(null, ['assets/logo.png']);

    expect(content).toContain('assets/logo.png filter=lfs diff=lfs merge=lfs -text');
  });

  it('is idempotent: regenerating with the same pattern does not duplicate the line', () => {
    const firstGeneration = buildManagedGitattributes(null, ['big.bin']);
    const secondGeneration = buildManagedGitattributes(firstGeneration, ['big.bin']);

    const occurrences = secondGeneration.split('big.bin filter=lfs').length - 1;
    expect(occurrences).toBe(1);
  });

  it('accumulates patterns across regenerations rather than replacing the previous set', () => {
    const firstGeneration = buildManagedGitattributes(null, ['first.bin']);
    const secondGeneration = buildManagedGitattributes(firstGeneration, ['second.bin']);

    expect(secondGeneration).toContain('first.bin filter=lfs diff=lfs merge=lfs -text');
    expect(secondGeneration).toContain('second.bin filter=lfs diff=lfs merge=lfs -text');
  });

  it('preserves content a maintainer added outside the managed marker block', () => {
    const handWritten = '*.psd binary\n';
    const regenerated = buildManagedGitattributes(handWritten, ['big.bin']);

    expect(regenerated).toContain('*.psd binary');
    expect(regenerated).toContain('big.bin filter=lfs diff=lfs merge=lfs -text');
  });

  it('regenerates safely with no new patterns, leaving the previously tracked set intact', () => {
    const firstGeneration = buildManagedGitattributes(null, ['tracked.bin']);
    const regenerated = buildManagedGitattributes(firstGeneration, []);

    expect(regenerated).toContain('tracked.bin filter=lfs diff=lfs merge=lfs -text');
  });

  it('escapes a space in a path so the pattern stays one token and survives regeneration intact', () => {
    const firstGeneration = buildManagedGitattributes(null, ['my assets/big.psd']);

    // Emitted with the space escaped as the POSIX class, so git reads the whole path as one pattern.
    expect(firstGeneration).toContain('my[[:space:]]assets/big.psd filter=lfs diff=lfs merge=lfs -text');
    expect(firstGeneration).not.toContain('my assets/big.psd filter=lfs');

    // Regenerating recovers the same pattern (never truncated to 'my') and does not duplicate it.
    const secondGeneration = buildManagedGitattributes(firstGeneration, ['my assets/big.psd']);
    const occurrences = secondGeneration.split('my[[:space:]]assets/big.psd filter=lfs').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('writeManagedGitattributes', () => {
  it('writes a .gitattributes into the working tree containing the managed line', async () => {
    const cwd = await createTemporaryWorkingTree();

    await writeManagedGitattributes(cwd, ['assets/big.psd']);

    const written = await readFile(path.join(cwd, '.gitattributes'), 'utf8');
    expect(written).toContain('assets/big.psd filter=lfs diff=lfs merge=lfs -text');
  });

  it('is regeneration-safe: a later call for a different path keeps the earlier one tracked', async () => {
    const cwd = await createTemporaryWorkingTree();

    await writeManagedGitattributes(cwd, ['first.bin']);
    await writeManagedGitattributes(cwd, ['second.bin']);

    const written = await readFile(path.join(cwd, '.gitattributes'), 'utf8');
    expect(written).toContain('first.bin filter=lfs diff=lfs merge=lfs -text');
    expect(written).toContain('second.bin filter=lfs diff=lfs merge=lfs -text');
  });
});

describe('isPathAlreadyLfsTracked', () => {
  it('returns true when the exact path is declared filter=lfs', () => {
    const content = 'big.bin filter=lfs diff=lfs merge=lfs -text\n';
    expect(isPathAlreadyLfsTracked(content, 'big.bin')).toBe(true);
  });

  it('returns false when a DIFFERENT path is declared filter=lfs', () => {
    const content = 'other.bin filter=lfs diff=lfs merge=lfs -text\n';
    expect(isPathAlreadyLfsTracked(content, 'big.bin')).toBe(false);
  });

  it('returns false for empty content', () => {
    expect(isPathAlreadyLfsTracked('', 'big.bin')).toBe(false);
  });

  it('matches a space-containing path against its escaped managed line', () => {
    const content = buildManagedGitattributes(null, ['my assets/big.psd']);
    expect(isPathAlreadyLfsTracked(content, 'my assets/big.psd')).toBe(true);
  });

  it('does not match a path that is merely a prefix of a longer declared pattern', () => {
    const content = 'big.bin.bak filter=lfs diff=lfs merge=lfs -text\n';
    expect(isPathAlreadyLfsTracked(content, 'big.bin')).toBe(false);
  });
});
