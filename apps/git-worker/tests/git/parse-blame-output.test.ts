import { parseBlameOutput } from '../../src/git/output-parsers.js';

/**
 * Unit tests for {@link parseBlameOutput} against SYNTHETIC `git blame --line-porcelain` text.
 *
 * `RealGitCommandRunner.blame`'s own integration tests (`git-command-runner.test.ts`) exercise this
 * parser against real blame output on a SHA-1 repository; this file targets shapes that repository
 * cannot produce here — a SHA-256 (64-hex) object name, and a group missing its author headers — so
 * those branches have real coverage rather than being silently dead code.
 */
const SHA1 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);

function group(hash: string, finalLine: number, content: string, options: { withAuthor?: boolean } = {}): string {
  const { withAuthor = true } = options;
  const lines = [`${hash} ${finalLine} ${finalLine} 1`];
  if (withAuthor) {
    lines.push('author Jane Doe', 'author-mail <jane@example.com>', 'author-time 1700000000', 'author-tz +0000');
  }
  lines.push('filename file.txt', `\t${content}`);
  return lines.join('\n');
}

describe('parseBlameOutput', () => {
  it('parses a SHA-1 (40-hex) object name', () => {
    const entries = parseBlameOutput(`${group(SHA1, 1, 'hello')}\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ lineNumber: 1, hash: SHA1, authorEmail: 'jane@example.com', content: 'hello' });
  });

  it('parses a SHA-256 (64-hex) object name from an --object-format=sha256 repository', () => {
    const entries = parseBlameOutput(`${group(SHA256, 1, 'hello')}\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ lineNumber: 1, hash: SHA256, content: 'hello' });
  });

  it('emits one entry per content line and takes each line number from its header', () => {
    const text = `${group(SHA1, 1, 'first')}\n${group(SHA256, 2, 'second')}\n`;
    const entries = parseBlameOutput(text);
    expect(entries.map((entry) => entry.lineNumber)).toEqual([1, 2]);
    expect(entries.map((entry) => entry.content)).toEqual(['first', 'second']);
  });

  it('never drops a content line even when its group carries no author headers, keeping line numbers intact', () => {
    // A caller reconstructs the file by joining entries' content in order, so a dropped line would
    // shift every line below it. A degenerate group (no author-mail/author-time) still yields an
    // entry, with an empty author email and the epoch as a placeholder timestamp.
    const entries = parseBlameOutput(`${group(SHA1, 1, 'kept', { withAuthor: false })}\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ lineNumber: 1, hash: SHA1, authorEmail: '', content: 'kept' });
    expect(entries[0].authoredAt.getTime()).toBe(0);
  });
});
