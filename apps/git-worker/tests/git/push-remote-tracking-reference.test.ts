import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ProjectId } from '@asciidocollab/domain';
import { RealGitCommandRunner } from '../../src/git/git-command-runner.js';
import { type HostAddressResolver } from '../../src/git/egress-allowlist.js';
import {
  commitAll,
  createTemporaryBareRemote,
  createTemporaryStorageRootWithProject,
} from '../helpers/temporary-git-repo.js';
import { startGitHttpServer, type GitHttpServer } from '../helpers/git-http-server.js';

const execFile = promisify(execFileCallback);

/** The out-of-band credential the served remote demands (its username is git-worker's fixed one). */
const USERNAME = 'x-access-token';
const TOKEN = 'super-secret-push-token-DO-NOT-LEAK-4d9a';

/** The loopback host the test git-HTTP server binds to; allowlisted so the egress gate admits it. */
const LOOPBACK_HOST = '127.0.0.1';

/**
 * A {@link HostAddressResolver} answering every lookup with a fixed public IP literal, so the egress
 * gate admits the loopback-bound test server (whose real `127.0.0.1` address it would otherwise
 * reject as private). Git itself still connects to the URL's real loopback address.
 */
const resolveToPublicAddress: HostAddressResolver = async () => [{ address: '93.184.216.34' }];

/** Reads the tip commit a ref resolves to in the working tree (test helper, plain `git`). */
async function readReference(cwd: string, reference: string): Promise<string> {
  const result = await execFile('git', ['rev-parse', reference], { cwd });
  return result.stdout.trim();
}

describe('RealGitCommandRunner.push (real git, real served remote)', () => {
  let server: GitHttpServer;

  afterEach(async () => {
    await server.close();
  });

  it('advances refs/remotes/origin/<branch> to the pushed HEAD after a successful push', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440066');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);

    // Initial commit, published to a fresh bare remote via plain `git` (test setup only).
    await writeFile(path.join(cwd, 'document.adoc'), '= Title\n\nFirst.\n');
    await commitAll(cwd, 'initial');
    const initialCommit = await readReference(cwd, 'HEAD');
    const bareRemote = await createTemporaryBareRemote();
    await execFile('git', ['push', '-q', bareRemote, 'HEAD:refs/heads/main'], { cwd });

    // Seed a STALE local remote-tracking ref at the initial commit — the exact state that makes the
    // bug visible: after the next push the local branch is one commit ahead of this ref, so
    // getBehindAhead would keep reporting "ahead 1 / push available" until a background fetch ran.
    await execFile('git', ['update-ref', 'refs/remotes/origin/main', initialCommit], { cwd });

    // A new local commit — now genuinely ahead of both the remote and the stale tracking ref.
    await writeFile(path.join(cwd, 'document.adoc'), '= Title\n\nSecond.\n');
    await commitAll(cwd, 'second');
    const secondCommit = await readReference(cwd, 'HEAD');
    expect(secondCommit).not.toBe(initialCommit);

    server = await startGitHttpServer({
      projectRoot: path.join(bareRemote, '..'),
      requireAuth: { username: USERNAME, password: TOKEN },
    });

    const runner = new RealGitCommandRunner(storageRoot, [LOOPBACK_HOST], resolveToPublicAddress);
    const result = await runner.push(projectId, {
      remoteUrl: `${server.url}/repo.git`,
      token: TOKEN,
      branch: 'main',
    });

    expect(result).toEqual({ success: true, value: { headCommit: secondCommit } });

    // The regression: a bare `git push` uploads the commit but never advances the local
    // remote-tracking ref, so it lingers at the pre-push commit until the periodic background fetch
    // runs. push now advances it itself to the just-pushed HEAD.
    const trackingReference = await readReference(cwd, 'refs/remotes/origin/main');
    expect(trackingReference).toBe(secondCommit);

    // The concrete payoff: getBehindAhead now reports the branch as up to date (0/0) immediately
    // after the push, instead of keeping "ahead 1" until the background fetch reconciles the ref.
    const behindAhead = await runner.getBehindAhead(projectId, 'main');
    expect(behindAhead).toEqual({ success: true, value: { behind: 0, ahead: 0 } });
  });
});
