// Regresses a fix to the ordering of MergeConflictOps' inline undo-point prune: it must run as the
// LAST effectful step on each clean-success path, strictly AFTER every fallible step in that path's
// tail (the post-merge/post-checkout `rev-parse HEAD` and change-set computation). Before the fix,
// the prune ran BEFORE that fallible tail — so a tail failure reached the outer `catch`, which cleans
// up only the CURRENT (failed) op's own undo artifacts, while the PRIOR op's undo point had already
// been deleted by the prune that ran moments earlier. The project was then left with ZERO undo
// points, even though the merge/checkout itself had already committed real work to git.
//
// Exercising this requires injecting a failure into the specific tail step that runs immediately
// after the merge/checkout succeeds, without disturbing any other git call (including the cleanup
// calls the outer `catch` makes in response) — done here by wrapping the REAL `runGitCommand` so it
// throws exactly once, right after a designated "arming" command succeeds, and delegates to the real
// implementation for every other call. Native ESM (this package is `"type": "module"`) means
// `jest.mock()` cannot intercept the static import inside `merge-conflict-ops.ts`; the mock is
// registered with `jest.unstable_mockModule` and the code under test is loaded via a dynamic
// `import()` afterward (see `tests/jest-esm.d.ts` and `tests/index.test.ts` for the same pattern).
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitOperationId, ProjectId } from '@asciidocollab/domain';
import * as RealRunGitCommand from '../../src/git/run-git-command.js';
import type { GitCommandResult, GitCommandSpec } from '../../src/git/run-git-command.js';
import { FilesystemConflictStageStore } from '../../src/git/filesystem-conflict-stage-store.js';
import { commitAll, createTemporaryStorageRootWithProject } from '../helpers/temporary-git-repo.js';

const execFile = promisify(execFileCallback);

// `jest.unstable_mockModule` resolves its specifier differently from a plain `import`/`import()`:
// a relative `.js` specifier here fails to resolve (this project's `moduleNameMapper` strips the
// `.js` for a normal import so ts-jest picks up the `.ts` source, but that mapping does not apply to
// `unstable_mockModule`'s own resolution). An absolute path straight to the `.ts` source sidesteps
// that entirely; `import.meta.url` keeps it anchored to this file regardless of the process cwd.
const RUN_GIT_COMMAND_MODULE = fileURLToPath(new URL('../../src/git/run-git-command.ts', import.meta.url));

const OPERATION_ID = GitOperationId.create('550e8400-e29b-41d4-a716-446655440330');
const PRIOR_OPERATION_ID = GitOperationId.create('550e8400-e29b-41d4-a716-446655440331');

/** Reads the tip commit of the given ref (test setup/assertion helper). */
async function readReference(cwd: string, reference: string): Promise<string> {
  const { stdout } = await execFile('git', ['rev-parse', reference], { cwd });
  return stdout.trim();
}

/**
 * Builds a project whose local `main` is an ancestor of `refs/remotes/origin/main` ("theirs"), which
 * is ahead by one commit — a clean, non-conflicting merge target. Mirrors the identically-named
 * fixture in `merge-conflict-stage.test.ts`; duplicated here (rather than shared) since it is a small,
 * self-contained piece of test setup and this file otherwise has no dependency on that one.
 */
async function setupCleanlyMergeableRemote(projectId: string): Promise<{ storageRoot: string; cwd: string }> {
  const storageRoot = await createTemporaryStorageRootWithProject(projectId);
  const cwd = path.join(storageRoot, projectId);

  await writeFile(path.join(cwd, 'base.adoc'), 'base\n');
  await commitAll(cwd, 'base');

  await execFile('git', ['checkout', '-q', '-b', 'incoming'], { cwd });
  await writeFile(path.join(cwd, 'remote.adoc'), 'remote\n');
  await commitAll(cwd, 'theirs adds remote.adoc');
  const theirsCommit = await readReference(cwd, 'HEAD');
  await execFile('git', ['update-ref', 'refs/remotes/origin/main', theirsCommit], { cwd });
  await execFile('git', ['checkout', '-q', 'main'], { cwd });
  await execFile('git', ['branch', '-q', '-D', 'incoming'], { cwd });

  return { storageRoot, cwd };
}

/**
 * Builds a project on `main` with a second local branch `feature`, one commit ahead — a clean,
 * non-conflicting `checkout` target.
 */
async function setupCleanlySwitchableBranch(projectId: string): Promise<{ storageRoot: string; cwd: string }> {
  const storageRoot = await createTemporaryStorageRootWithProject(projectId);
  const cwd = path.join(storageRoot, projectId);

  await writeFile(path.join(cwd, 'base.adoc'), 'base\n');
  await commitAll(cwd, 'base');

  await execFile('git', ['checkout', '-q', '-b', 'feature'], { cwd });
  await writeFile(path.join(cwd, 'feature.adoc'), 'feature\n');
  await commitAll(cwd, 'feature commit');
  await execFile('git', ['checkout', '-q', 'main'], { cwd });

  return { storageRoot, cwd };
}

/** A fresh `FilesystemConflictStageStore` rooted OUTSIDE every project's working tree. */
async function createTemporaryConflictStageStore(): Promise<FilesystemConflictStageStore> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-worker-test-conflict-store-'));
  return new FilesystemConflictStageStore(root);
}

/**
 * Wraps the real `runGitCommand` so that the `failOnOccurrence`-th call matching `matches` throws
 * instead of running for real; every other call — matching or not, before or after — delegates to the
 * real implementation untouched. Targeting a specific COMMAND SHAPE (rather than "whichever call
 * happens to run right after some other one") keeps the injection point fixed to the exact fallible
 * tail step under test regardless of where the inline prune itself currently sits in the method —
 * which is exactly what makes this fixture usable as a regression test for the prune's ordering: it
 * fails the same real step whether the prune runs before or after it.
 */
function createFailOnNthMatchRunGitCommand(
  matches: (spec: GitCommandSpec) => boolean,
  failOnOccurrence: number,
): typeof RealRunGitCommand.runGitCommand {
  let occurrence = 0;
  return async (cwd: string, spec: GitCommandSpec): Promise<GitCommandResult> => {
    if (matches(spec)) {
      occurrence += 1;
      if (occurrence === failOnOccurrence) {
        throw new Error('injected tail failure');
      }
    }
    return RealRunGitCommand.runGitCommand(cwd, spec);
  };
}

// Each test registers its own `run-git-command.js` mock and loads a fresh `MergeConflictOps` via a
// dynamic import — `resetModules` clears jest's ESM registry so the NEXT `unstable_mockModule` call
// actually takes effect rather than reusing a previous test's cached resolution.
beforeEach(() => {
  jest.resetModules();
});

describe('MergeConflictOps.merge (prune deferred past the fallible post-merge tail)', () => {
  it('a post-merge tail failure leaves the PRIOR op’s undo point (ref + snapshot) intact', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440340');
    const { storageRoot, cwd } = await setupCleanlyMergeableRemote(projectId.value);
    const store = await createTemporaryConflictStageStore();

    // A prior op already established a full, retained undo point — the ref-pinned commit and its
    // off-tree snapshot. This is exactly what the pre-fix ordering would destroy.
    const priorCommit = await readReference(cwd, 'HEAD');
    const priorBackupReference = `refs/adc/undo/${PRIOR_OPERATION_ID.value}`;
    await execFile('git', ['update-ref', priorBackupReference, priorCommit], { cwd });
    const priorSnapshot = { preOpHead: priorCommit, branch: 'main' };
    const priorWritten = await store.writeSnapshot(PRIOR_OPERATION_ID, priorSnapshot);
    expect(priorWritten.success).toBe(true);

    // Fail the `rev-parse HEAD` that reads `postMergeHead` — the first step of the tail the fix moved
    // the prune past. With no flush, `rev-parse HEAD` is called exactly 3 times in the clean-merge
    // path (preOpHead, preMergeHead, postMergeHead), so the 3rd occurrence is the one to fail.
    jest.unstable_mockModule(RUN_GIT_COMMAND_MODULE, () => ({
      ...RealRunGitCommand,
      runGitCommand: createFailOnNthMatchRunGitCommand(
        (spec) => spec.command === 'rev-parse' && (spec.flags ?? []).includes('HEAD'),
        3,
      ),
    }));
    const { MergeConflictOps } = await import('../../src/git/merge-conflict-ops.js');
    const mergeConflictOps = new MergeConflictOps(storageRoot, store);

    const result = await mergeConflictOps.merge(projectId, { branch: 'main', flush: [], operationId: OPERATION_ID });

    expect(result.success).toBe(false);

    // The prior op's undo point survives: the inline prune, deferred past the (now-failed) tail,
    // never ran.
    expect(await readReference(cwd, priorBackupReference)).toBe(priorCommit);
    expect(await store.readSnapshot(PRIOR_OPERATION_ID)).toEqual({ success: true, value: priorSnapshot });

    // The CURRENT (failed) op never established a durable undo point in the first place — the outer
    // `catch`'s cleanup clears its own orphaned snapshot.
    expect(await store.readSnapshot(OPERATION_ID)).toEqual({ success: true, value: null });
  });
});

describe('MergeConflictOps.checkout (prune deferred past the fallible post-checkout tail)', () => {
  it('a post-checkout tail failure leaves the PRIOR op’s undo point (ref + snapshot) intact', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440341');
    const { storageRoot, cwd } = await setupCleanlySwitchableBranch(projectId.value);
    const store = await createTemporaryConflictStageStore();

    const priorCommit = await readReference(cwd, 'HEAD');
    const priorBackupReference = `refs/adc/undo/${PRIOR_OPERATION_ID.value}`;
    await execFile('git', ['update-ref', priorBackupReference, priorCommit], { cwd });
    const priorSnapshot = { preOpHead: priorCommit, branch: 'main' };
    const priorWritten = await store.writeSnapshot(PRIOR_OPERATION_ID, priorSnapshot);
    expect(priorWritten.success).toBe(true);

    // Fail the `git add -A` that stages the re-applied edits — the first step of the tail the fix
    // moved the prune past (nothing is stashed here: no flush means nothing staged to shelve, so this
    // `add -A` is the sole match in the whole clean-switch path).
    jest.unstable_mockModule(RUN_GIT_COMMAND_MODULE, () => ({
      ...RealRunGitCommand,
      runGitCommand: createFailOnNthMatchRunGitCommand(
        (spec) => spec.command === 'add' && (spec.flags ?? []).includes('-A'),
        1,
      ),
    }));
    const { MergeConflictOps } = await import('../../src/git/merge-conflict-ops.js');
    const mergeConflictOps = new MergeConflictOps(storageRoot, store);

    const result = await mergeConflictOps.checkout(projectId, {
      branch: 'feature',
      flush: [],
      stashLocal: false,
      operationId: OPERATION_ID,
    });

    expect(result.success).toBe(false);

    expect(await readReference(cwd, priorBackupReference)).toBe(priorCommit);
    expect(await store.readSnapshot(PRIOR_OPERATION_ID)).toEqual({ success: true, value: priorSnapshot });
    expect(await store.readSnapshot(OPERATION_ID)).toEqual({ success: true, value: null });
  });
});
