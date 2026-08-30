// Regresses the "a snapshot exists for an op ⟺ its backup ref exists" invariant in MergeConflictOps.
// The pull path used to write the undo snapshot UNCONDITIONALLY, before its backup ref was pinned, and
// the pins were best-effort — so if a pin failed, a snapshot was left with NO backup ref. Ref-driven
// retention (the inline prune and the sweeper) is listing-driven over `refs/adc/undo/*`, so a ref-less
// snapshot is never listed and leaks forever in the shared conflict-stage root. The fix pins the ref
// FIRST and writes the snapshot only once the pin succeeds, so a failed pin leaves NEITHER behind (the
// pull itself still lands — a failed pin never tears it down).
//
// Exercising this requires failing the specific `update-ref` that pins the base backup ref, without
// disturbing any other git call, and observing that the clean pull still succeeds while leaving no
// ref-less snapshot. As in `merge-conflict-undo-ordering.test.ts`, native ESM means `jest.mock()`
// cannot intercept the static import inside `merge-conflict-ops.ts`; the mock is registered with
// `jest.unstable_mockModule` and the code under test is loaded via a dynamic `import()` afterward.
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

// See `merge-conflict-undo-ordering.test.ts` for why the specifier is an absolute path to the `.ts`
// source rather than a relative `.js` one.
const RUN_GIT_COMMAND_MODULE = fileURLToPath(new URL('../../src/git/run-git-command.ts', import.meta.url));

const OPERATION_ID = GitOperationId.create('550e8400-e29b-41d4-a716-446655440501');

/** Reads the tip commit of a ref, or null when it does not exist. */
async function readReferenceOrNull(cwd: string, reference: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--verify', '--quiet', reference], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Builds a project whose local `main` is one commit behind `refs/remotes/origin/main` — a clean,
 * non-conflicting, NO-flush merge target (a plain fast-forward). Mirrors the fixtures the sibling
 * merge tests use; duplicated here since it is small, self-contained setup.
 */
async function setupCleanlyMergeableRemote(projectId: string): Promise<{ storageRoot: string; cwd: string }> {
  const storageRoot = await createTemporaryStorageRootWithProject(projectId);
  const cwd = path.join(storageRoot, projectId);

  await writeFile(path.join(cwd, 'base.adoc'), 'base\n');
  await commitAll(cwd, 'base');

  await execFile('git', ['checkout', '-q', '-b', 'incoming'], { cwd });
  await writeFile(path.join(cwd, 'remote.adoc'), 'remote\n');
  await commitAll(cwd, 'theirs adds remote.adoc');
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
  await execFile('git', ['update-ref', 'refs/remotes/origin/main', stdout.trim()], { cwd });
  await execFile('git', ['checkout', '-q', 'main'], { cwd });
  await execFile('git', ['branch', '-q', '-D', 'incoming'], { cwd });

  return { storageRoot, cwd };
}

/** A fresh `FilesystemConflictStageStore` rooted OUTSIDE every project's working tree. */
async function createTemporaryConflictStageStore(): Promise<FilesystemConflictStageStore> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-worker-test-conflict-store-'));
  return new FilesystemConflictStageStore(root);
}

/**
 * Wraps the real `runGitCommand` so the `failOnOccurrence`-th call matching `matches` throws instead
 * of running for real; every other call delegates untouched. (Same helper shape as
 * `merge-conflict-undo-ordering.test.ts`.)
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
        throw new Error('injected backup-ref pin failure');
      }
    }
    return RealRunGitCommand.runGitCommand(cwd, spec);
  };
}

beforeEach(() => {
  jest.resetModules();
});

describe('MergeConflictOps.merge (snapshot ⟺ backup ref invariant on a failed pin)', () => {
  it('a failed base-ref pin on a clean no-flush pull leaves NO ref-less snapshot (and the pull still lands)', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440500');
    const { storageRoot, cwd } = await setupCleanlyMergeableRemote(projectId.value);
    const store = await createTemporaryConflictStageStore();

    // Fail the FIRST `update-ref` that pins the op's backup ref (the base pin at preOpHead). With no
    // flush and a base pin that fails, that `update-ref` is the sole match in the clean-merge path —
    // the prune is skipped because this op establishes no undo point, so it issues none of its own.
    jest.unstable_mockModule(RUN_GIT_COMMAND_MODULE, () => ({
      ...RealRunGitCommand,
      runGitCommand: createFailOnNthMatchRunGitCommand((spec) => spec.command === 'update-ref', 1),
    }));
    const { MergeConflictOps } = await import('../../src/git/merge-conflict-ops.js');
    const mergeConflictOps = new MergeConflictOps(storageRoot, store);

    const result = await mergeConflictOps.merge(projectId, { branch: 'main', flush: [], operationId: OPERATION_ID });

    // A failed best-effort pin never tears down the merge — the pull still lands cleanly.
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the merge to succeed');
    expect(result.value.status).toBe('merged');

    // The invariant holds: because the pin failed, NEITHER the backup ref NOR the snapshot exists —
    // there is no snapshot left without a ref to leak forever in the shared conflict-stage root.
    expect(await readReferenceOrNull(cwd, `refs/adc/undo/${OPERATION_ID.value}`)).toBeNull();
    expect(await store.readSnapshot(OPERATION_ID)).toEqual({ success: true, value: null });
  });
});
