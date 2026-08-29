import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ProjectId } from '@asciidocollab/domain';
import { RealGitCommandRunner } from '../../src/git/git-command-runner.js';
import { type HostAddressResolver } from '../../src/git/egress-allowlist.js';
import { createTemporaryBareRemote, createTemporaryStorageRootWithUninitializedProject } from '../helpers/temporary-git-repo.js';
import { startGitHttpServer, type GitHttpServer } from '../helpers/git-http-server.js';

const execFile = promisify(execFileCallback);

/** The out-of-band credential the served remote demands (its username is git-worker's fixed one). */
const USERNAME = 'x-access-token';
const TOKEN = 'super-secret-initialize-token-DO-NOT-LEAK-6b2c';

/** The loopback host the test git-HTTP server binds to; allowlisted so the egress gate admits it. */
const LOOPBACK_HOST = '127.0.0.1';

/**
 * A {@link HostAddressResolver} that answers every lookup with a fixed public IP literal, so the
 * egress gate admits the loopback-bound test server (whose real `127.0.0.1` address the gate would
 * otherwise reject as private). Git itself still connects to the URL's real loopback address — the
 * documented, accepted check-time-versus-connect-time window.
 */
const resolveToPublicAddress: HostAddressResolver = async () => [{ address: '93.184.216.34' }];

/** Reads the tip commit a ref resolves to in the working tree (test assertion helper, plain `git`). */
async function readReference(cwd: string, reference: string): Promise<string> {
  const result = await execFile('git', ['rev-parse', reference], { cwd });
  return result.stdout.trim();
}

describe('RealGitCommandRunner.initializeAndPublish (real git, real served remote)', () => {
  let server: GitHttpServer;

  afterEach(async () => {
    await server.close();
  });

  it('creates the refs/remotes/origin/<branch> tracking ref at the pushed HEAD after publishing', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440077');
    const storageRoot = await createTemporaryStorageRootWithUninitializedProject(projectId.value, async (workingTree) => {
      await writeFile(path.join(workingTree, 'document.adoc'), '= Title\n\nBody.\n');
    });
    const cwd = path.join(storageRoot, projectId.value);

    const bareRemote = await createTemporaryBareRemote();
    server = await startGitHttpServer({
      projectRoot: path.join(bareRemote, '..'),
      requireAuth: { username: USERNAME, password: TOKEN },
    });

    const runner = new RealGitCommandRunner(storageRoot, [LOOPBACK_HOST], resolveToPublicAddress);
    const result = await runner.initializeAndPublish(projectId, {
      remoteUrl: `${server.url}/repo.git`,
      token: TOKEN,
      branch: 'main',
    });

    expect(result.success).toBe(true);

    // The regression: a bare `git push` uploads the commit but never creates the local
    // remote-tracking ref, so `getBehindAhead` (comparing main...refs/remotes/origin/main) fails
    // with "unknown revision" until the periodic background fetch first runs. initializeAndPublish
    // now creates that ref itself, pointing at the just-pushed HEAD.
    const trackingReference = await readReference(cwd, 'refs/remotes/origin/main');
    const localHead = await readReference(cwd, 'HEAD');
    expect(trackingReference).toBe(localHead);

    // `show-ref --verify` fails non-zero if the exact ref does not exist — proves it is a real ref,
    // not just something `rev-parse` happened to resolve by another rule.
    await expect(execFile('git', ['show-ref', '--verify', 'refs/remotes/origin/main'], { cwd })).resolves.toBeDefined();

    // The concrete payoff: getBehindAhead (which reads main...refs/remotes/origin/main) now RESOLVES
    // immediately instead of erroring with "unknown revision" until the background fetch runs. Right
    // after publish the pushed HEAD is exactly origin/main, so the truthful count is 0/0.
    const behindAhead = await runner.getBehindAhead(projectId, 'main');
    expect(behindAhead).toEqual({ success: true, value: { behind: 0, ahead: 0 } });
  });
});
