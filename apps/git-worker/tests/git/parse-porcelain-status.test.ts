import { parsePorcelainStatus } from '../../src/git/git-command-runner.js';

/**
 * Unit tests for {@link parsePorcelainStatus} against SYNTHETIC porcelain v2 text.
 *
 * `RealGitCommandRunner.getStatus`'s own integration tests (`git-command-runner.test.ts`) exercise
 * this parser against real `git status` output; this file targets shapes real `git status` (in
 * this git version, with the flags this adapter passes) can never actually produce — a missing
 * `# branch.head` header, an ignored (`!`) line, and an unmerged (`u`) conflict line — so those
 * branches still have real coverage instead of being silently dead code.
 */
describe('parsePorcelainStatus', () => {
  it('returns null when the mandatory branch.head header is missing', () => {
    expect(parsePorcelainStatus('# branch.oid deadbeef\n')).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(parsePorcelainStatus('')).toBeNull();
  });

  it('ignores a `!` (ignored file) line', () => {
    const status = parsePorcelainStatus('# branch.head main\n! build/output.bin\n');

    expect(status).toEqual({ currentBranch: 'main', changes: [] });
  });

  it('maps an unmerged (`u`) conflict line to state "conflicted"', () => {
    const status = parsePorcelainStatus(
      '# branch.head main\nu UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflicted.adoc\n',
    );

    expect(status).toEqual({
      currentBranch: 'main',
      changes: [{ path: 'conflicted.adoc', changeType: 'modified', state: 'conflicted' }],
    });
  });

  it('maps a type-change code (T) to "modified"', () => {
    const status = parsePorcelainStatus(
      '# branch.head main\n1 T. N... 120000 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb link-turned-file\n',
    );

    expect(status).toEqual({
      currentBranch: 'main',
      changes: [{ path: 'link-turned-file', changeType: 'modified', state: 'staged' }],
    });
  });

  it('maps an untracked (`?`) line to state "untracked" (not "unstaged")', () => {
    const status = parsePorcelainStatus('# branch.head main\n? brand-new.adoc\n');

    expect(status).toEqual({
      currentBranch: 'main',
      changes: [{ path: 'brand-new.adoc', changeType: 'added', state: 'untracked' }],
    });
  });

  it('reports both sides of a file staged AND unstaged as two separate entries', () => {
    const status = parsePorcelainStatus(
      '# branch.head main\n1 MM N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb both.adoc\n',
    );

    expect(status).toEqual({
      currentBranch: 'main',
      changes: expect.arrayContaining([
        { path: 'both.adoc', changeType: 'modified', state: 'staged' },
        { path: 'both.adoc', changeType: 'modified', state: 'unstaged' },
      ]),
    });
    expect(status?.changes).toHaveLength(2);
  });
});
