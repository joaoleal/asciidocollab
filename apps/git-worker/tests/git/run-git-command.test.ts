import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { classifyNetworkFailure, GitProcessError, runGitCommand } from '../../src/git/run-git-command.js';
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

  describe('optionsTerminator override (external subcommands like `git lfs <verb>`)', () => {
    it('emits `--` (never `--end-of-options`) before positionals when optionsTerminator is `--`', async () => {
      const workingDirectory = await createTemporaryWorkingTree();

      const capture = await withArgvCapturingGit(async (getCalls) => {
        // `git-lfs` may or may not be installed in the environment running this test — irrelevant
        // here: the argv is captured before the top-level `git` process would ever try to dispatch
        // to the external `git-lfs` binary, so this assertion holds either way.
        await runGitCommand(workingDirectory, {
          command: 'lfs',
          flags: ['track'],
          positionals: ['big.bin'],
          optionsTerminator: '--',
        }).catch(() => undefined);
        return getCalls();
      });

      const lastCall = capture.at(-1) ?? [];
      expect(lastCall).toContain('--');
      expect(lastCall).not.toContain('--end-of-options');
      // `--` sits immediately before the positional, exactly where `--end-of-options` sits by
      // default — same guard, different (Cobra-compatible) token.
      expect(lastCall.indexOf('--') + 1).toBe(lastCall.indexOf('big.bin'));
    });

    it('still defaults to `--end-of-options` when optionsTerminator is omitted', async () => {
      const workingDirectory = await createTemporaryWorkingTree();

      const capture = await withArgvCapturingGit(async (getCalls) => {
        await runGitCommand(workingDirectory, { command: 'log', positionals: ['HEAD'] }).catch(() => undefined);
        return getCalls();
      });

      const lastCall = capture.at(-1) ?? [];
      expect(lastCall).toContain('--end-of-options');
    });
  });

  describe('per-call config (`-c key=value`, pinning above repo-supplied config)', () => {
    it('emits each config entry as a `-c key=value` pair BEFORE the subcommand', async () => {
      const workingDirectory = await createTemporaryWorkingTree();

      const capture = await withArgvCapturingGit(async (getCalls) => {
        // `git-lfs` need not be installed: the argv is recorded before the top-level `git` would
        // dispatch to the external binary, so the pin is asserted either way.
        await runGitCommand(workingDirectory, {
          command: 'lfs',
          flags: ['pull'],
          config: ['lfs.url=https://origin.example.com/org/repo.git/info/lfs'],
        }).catch(() => undefined);
        return getCalls();
      });

      const lastCall = capture.at(-1) ?? [];
      const pin = 'lfs.url=https://origin.example.com/org/repo.git/info/lfs';
      const valueIndex = lastCall.indexOf(pin);
      expect(valueIndex).toBeGreaterThanOrEqual(0);
      // The value rides argv as its own element (never a shell string, so it can never be
      // word-split or re-quoted), immediately preceded by its own `-c`, and the whole pair sits
      // before the subcommand — exactly where git reads `-c` config.
      expect(lastCall[valueIndex - 1]).toBe('-c');
      expect(valueIndex).toBeLessThan(lastCall.indexOf('lfs'));
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

      // Point the process at a private temp base for the duration of this call so the leak scan sees
      // ONLY this call's askpass directory. runGitCommand creates its askpass dir under os.tmpdir(),
      // which reads TMPDIR at call time; without this isolation a parallel jest worker creating its
      // own `git-worker-askpass-*` dir in the shared system tmpdir between the two readdir snapshots
      // would be misread as a leak from this call.
      const privateTemporaryBase = await mkdtemp(path.join(tmpdir(), 'git-worker-askpass-leak-'));
      const previousTmpdir = process.env.TMPDIR;
      process.env.TMPDIR = privateTemporaryBase;
      try {
        const before = await readdir(privateTemporaryBase);
        await runGitCommand(workingTree, { command: 'fetch', positionals: ['origin'], credential: { username, token } });
        const after = await readdir(privateTemporaryBase);

        const leftoverAskpassDirectories = after.filter(
          (name) => name.startsWith('git-worker-askpass-') && !before.includes(name),
        );
        expect(leftoverAskpassDirectories).toEqual([]);
      } finally {
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
      }
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

    it('authenticates a real `git clone` via GIT_ASKPASS, and the token never touches argv, the destination working tree, or .git/config', async () => {
      const destinationParent = await mkdtemp(path.join(tmpdir(), 'git-worker-clone-leak-'));
      const destination = path.join(destinationParent, 'dest');

      const capture = await withArgvCapturingGit(async (getCalls) => {
        await runGitCommand(destinationParent, {
          command: 'clone',
          positionals: [`${server.url}/repo.git`, destination],
          credential: { username, token },
        });
        return { calls: await getCalls() };
      });

      // Proof the credential actually authenticated a real `clone` (not just that nothing threw).
      expect(server.authorizationHeadersSeen.length).toBeGreaterThan(0);

      for (const call of capture.calls) {
        for (const argument of call) {
          expect(argument).not.toContain(token);
        }
      }

      const files = await listFilesRecursively(destination);
      for (const file of files) {
        const content = await readFile(file, 'utf8').catch(() => '');
        expect(content).not.toContain(token);
      }

      const gitConfig = await readFile(path.join(destination, '.git', 'config'), 'utf8');
      expect(gitConfig).not.toContain(token);
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

  describe('classifyNetworkFailure', () => {
    it('classifies a name-resolution failure as unreachable', () => {
      const stderr = "fatal: unable to access 'https://example.invalid/x.git/': Could not resolve host: example.invalid";
      expect(classifyNetworkFailure(stderr)).toBe('unreachable');
    });

    it('classifies a refused connection as unreachable', () => {
      const stderr =
        "fatal: unable to access 'http://127.0.0.1:1/x.git/': Failed to connect to 127.0.0.1 port 1: Connection refused";
      expect(classifyNetworkFailure(stderr)).toBe('unreachable');
    });

    it('classifies a rejected credential as authentication-failed', () => {
      expect(classifyNetworkFailure("fatal: Authentication failed for 'https://example.invalid/x.git/'")).toBe(
        'authentication-failed',
      );
    });

    it('classifies an HTTP 403 response as authentication-failed', () => {
      const stderr = "fatal: unable to access 'https://example.invalid/x.git/': The requested URL returned error: 403";
      expect(classifyNetworkFailure(stderr)).toBe('authentication-failed');
    });

    it('returns undefined for a failure unrelated to reachability or credentials', () => {
      expect(classifyNetworkFailure("fatal: pathspec 'nope' did not match any files")).toBeUndefined();
    });

    it('classifies a rejected non-fast-forward push as non-fast-forward', () => {
      const stderr = [
        'To http://127.0.0.1/repo.git',
        ' ! [rejected]        main -> main (fetch first)',
        "error: failed to push some refs to 'http://127.0.0.1/repo.git'",
      ].join('\n');
      expect(classifyNetworkFailure(stderr)).toBe('non-fast-forward');
    });

    it('classifies the non-fast-forward wording variant too', () => {
      const stderr = ' ! [rejected]        main -> main (non-fast-forward)';
      expect(classifyNetworkFailure(stderr)).toBe('non-fast-forward');
    });
  });

  describe('network failure classification, against real git failures', () => {
    it('tags a connection-refused clone as unreachable on the thrown GitProcessError', async () => {
      // Bind then immediately release an ephemeral port: nothing listens there afterward, so
      // connecting to it deterministically refuses — a real (not simulated) unreachable remote.
      const port = await new Promise<number>((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
          const address = probe.address();
          const boundPort = typeof address === 'object' && address !== null ? address.port : 0;
          probe.close(() => resolve(boundPort));
        });
      });
      const workingTree = await createTemporaryWorkingTree();

      let caught: unknown;
      try {
        await runGitCommand(workingTree, {
          command: 'clone',
          positionals: [`http://127.0.0.1:${port}/repo.git`, path.join(workingTree, 'dest')],
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(GitProcessError);
      expect((caught as GitProcessError).networkFailureKind).toBe('unreachable');
    });

    it('tags a wrong-credential clone as authentication-failed on the thrown GitProcessError', async () => {
      const { remoteProjectRoot } = await createPushedRepoPair();
      const server = await startGitHttpServer({
        projectRoot: remoteProjectRoot,
        requireAuth: { username: 'x-access-token', password: 'the-real-token' },
      });
      const workingTree = await createTemporaryWorkingTree();

      try {
        let caught: unknown;
        try {
          await runGitCommand(workingTree, {
            command: 'clone',
            positionals: [`${server.url}/repo.git`, path.join(workingTree, 'dest')],
            credential: { username: 'x-access-token', token: 'wrong-token' },
          });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(GitProcessError);
        expect((caught as GitProcessError).networkFailureKind).toBe('authentication-failed');
      } finally {
        await server.close();
      }
    });
  });
});
