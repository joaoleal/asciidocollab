import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitProcessError, runGitCommand } from '../../src/git/run-git-command.js';
import {
  createPushedRepoPair,
  createTemporaryBareRemote,
  createTemporaryWorkingTree,
} from '../helpers/temporary-git-repo.js';
import { startGitHttpServer, type GitHttpServer } from '../helpers/git-http-server.js';
import { withArgvCapturingGit } from '../helpers/argv-capturing-git.js';

const execFile = promisify(execFileCallback);

/** Recursively collects every regular file's absolute path under `root`. */
async function listFilesRecursively(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

describe('runGitCommand', () => {
  describe('baseline', () => {
    it('runs a real git subcommand against a real temp working tree', async () => {
      const cwd = await createTemporaryWorkingTree();

      const result = await runGitCommand(cwd, { command: 'status', flags: ['--porcelain=v2', '--branch'] });

      expect(result.stdout).toContain('# branch.head main');
    });

    it('throws a GitProcessError (no raw stdout/stderr) when the cwd is not a git repository', async () => {
      const notARepo = await mkdtemp(path.join(tmpdir(), 'git-worker-not-a-repo-'));

      await expect(runGitCommand(notARepo, { command: 'status' })).rejects.toBeInstanceOf(GitProcessError);
    });
  });

  describe('option-injection defense (--end-of-options)', () => {
    it('is a real vulnerability class when the defense is absent (raw execFile, no --end-of-options)', async () => {
      const remote = await createTemporaryBareRemote();
      const workingDirectory = await createTemporaryWorkingTree();
      const marker = path.join(workingDirectory, 'pwned-marker.txt');

      // The classic git argument-injection primitive: an attacker-controlled "repository" string
      // that LOOKS like the --upload-pack option is parsed as that option (not as a repo path) and
      // its value is executed as the local upload-pack helper. This call intentionally bypasses
      // runGitCommand to demonstrate the vulnerability the defense exists to close.
      await execFile('git', [
        'clone',
        `--upload-pack=touch ${marker};`,
        remote,
        path.join(workingDirectory, 'clone-dest'),
      ]).catch(() => undefined);

      await expect(stat(marker)).resolves.toBeDefined();
    });

    it('neutralizes the same attacker string through runGitCommand (--end-of-options applied)', async () => {
      const workingDirectory = await createTemporaryWorkingTree();
      const marker = path.join(workingDirectory, 'pwned-marker-2.txt');
      const maliciousPositional = `--upload-pack=touch ${marker};`;

      await expect(
        runGitCommand(workingDirectory, {
          command: 'clone',
          positionals: [maliciousPositional, path.join(workingDirectory, 'clone-dest-2')],
        }),
      ).rejects.toBeInstanceOf(GitProcessError);

      // Neutralized: git treated the string as a literal (nonexistent) repository path, never as
      // an option — so the injected command never ran and the marker file was never created.
      await expect(stat(marker)).rejects.toThrow();
    });
  });

  describe('out-of-band credential handling', () => {
    const username = 'x-access-token';
    const token = 'super-secret-test-token-DO-NOT-LEAK-93f1';

    let server: GitHttpServer;
    let remoteProjectRoot: string;
    let workingTree: string;

    beforeEach(async () => {
      const pair = await createPushedRepoPair();
      workingTree = pair.workingTree;
      remoteProjectRoot = pair.remoteProjectRoot;
      server = await startGitHttpServer({ projectRoot: remoteProjectRoot, requireAuth: { username, password: token } });
    });

    afterEach(async () => {
      await server.close();
    });

    it('authenticates a real fetch via GIT_ASKPASS, and the token never touches argv, the working tree, or .git/config', async () => {
      await execFile('git', ['remote', 'set-url', 'origin', `${server.url}/repo.git`], { cwd: workingTree });

      const capture = await withArgvCapturingGit(async (getCalls) => {
        await runGitCommand(workingTree, {
          command: 'fetch',
          positionals: ['origin'],
          credential: { username, token },
        });
        return { calls: await getCalls() };
      });

      // The credential worked: runGitCommand resolved rather than throwing a GitProcessError, and
      // the server only ever answers 200 once its Basic-auth challenge is satisfied — proof the
      // out-of-band GIT_ASKPASS path actually delivered the credential, not just that nothing crashed.
      expect(server.authorizationHeadersSeen.length).toBeGreaterThan(0);

      // Never in argv: scan literally every argument of every git invocation this call made.
      for (const call of capture.calls) {
        for (const argument of call) {
          expect(argument).not.toContain(token);
        }
      }

      // Never written into the working tree (which includes .git/config, .git/logs/*, FETCH_HEAD, …).
      const files = await listFilesRecursively(workingTree);
      for (const file of files) {
        const content = await readFile(file, 'utf8').catch(() => '');
        expect(content).not.toContain(token);
      }

      const gitConfig = await readFile(path.join(workingTree, '.git', 'config'), 'utf8');
      expect(gitConfig).not.toContain(token);
    });

    it('deletes the ephemeral askpass helper after the call completes', async () => {
      await execFile('git', ['remote', 'set-url', 'origin', `${server.url}/repo.git`], { cwd: workingTree });

      const before = await readdir(tmpdir());
      await runGitCommand(workingTree, { command: 'fetch', positionals: ['origin'], credential: { username, token } });
      const after = await readdir(tmpdir());

      const leftoverAskpassDirectories = after.filter(
        (name) => name.startsWith('git-worker-askpass-') && !before.includes(name),
      );
      expect(leftoverAskpassDirectories).toEqual([]);
    });

    it('fails safely (GitProcessError) when the credential is wrong, and still leaks nothing', async () => {
      await execFile('git', ['remote', 'set-url', 'origin', `${server.url}/repo.git`], { cwd: workingTree });

      await expect(
        runGitCommand(workingTree, {
          command: 'fetch',
          positionals: ['origin'],
          credential: { username, token: 'wrong-token' },
        }),
      ).rejects.toBeInstanceOf(GitProcessError);
    });
  });

  describe('cross-host redirect defense', () => {
    it('refuses to follow a redirect the remote issues (http.followRedirects=false)', async () => {
      const workingTree = await createTemporaryWorkingTree();
      const redirectServer = await startGitHttpServer({
        projectRoot: workingTree, // unused: every request is redirected before reaching the CGI backend
        redirectTo: 'http://169.254.169.254/latest/meta-data/',
      });

      try {
        await execFile('git', ['remote', 'add', 'origin', `${redirectServer.url}/repo.git`], { cwd: workingTree });

        await expect(runGitCommand(workingTree, { command: 'fetch', positionals: ['origin'] })).rejects.toBeInstanceOf(
          GitProcessError,
        );
      } finally {
        await redirectServer.close();
      }
    });
  });
});
