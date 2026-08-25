import { GetDiffUseCase } from '../../../src/use-cases/git/get-diff';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { GitRepository } from '../../../src/entities/git-repository';
import { FileNode } from '../../../src/entities/file-node';
import { Document } from '../../../src/entities/document';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { DocumentId } from '../../../src/value-objects/ids/document-id';
import { ContentId } from '../../../src/value-objects/ids/content-id';
import { YjsStateId } from '../../../src/value-objects/ids/yjs-state-id';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { MimeType } from '../../../src/value-objects/files/mime-type';
import type { CollaborativeContentReader } from '../../../src/ports/storage/collaborative-content-reader';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryCollaborationSessionRepository } from '../../ports/project/in-memory-collaboration-session-repository';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440020');
const ROOT_NODE_ID = FileNodeId.create('550e8400-e29b-41d4-a716-446655440030');

const OPEN_PATH = 'chapters/intro.adoc';
const DORMANT_PATH = 'chapters/appendix.adoc';
const NO_NODE_PATH = 'chapters/missing.adoc';
const LIVE_TEXT = '= Introduction\nEdited live moments ago — héllo wörld';

interface SeededFile {
  node: FileNode;
  document: Document;
}

function makeFile(gitPath: string, suffix: string): SeededFile {
  const node = new FileNode(
    FileNodeId.create(`550e8400-e29b-41d4-a716-4466554${suffix}0`),
    PROJECT_ID,
    ROOT_NODE_ID,
    gitPath.split('/').pop() as string,
    FileNodeType.create('file'),
    FilePath.create('/' + gitPath),
  );
  const document = new Document(
    DocumentId.create(`550e8400-e29b-41d4-a716-4466554${suffix}1`),
    node.id,
    ContentId.create(`550e8400-e29b-41d4-a716-4466554${suffix}2`),
    YjsStateId.create(`550e8400-e29b-41d4-a716-4466554${suffix}3`),
    MimeType.create('text/asciidoc'),
  );
  return { node, document };
}

const openFile = makeFile(OPEN_PATH, '6001');
const dormantFile = makeFile(DORMANT_PATH, '6002');

function makeReader(
  result: { success: true; value: string | null } | { success: false; error: Error },
): CollaborativeContentReader {
  return { readContent: jest.fn().mockResolvedValue(result) };
}

interface Harness {
  useCase: GetDiffUseCase;
  commandRunner: InMemoryGitCommandRunner;
  collaborativeContentReader: CollaborativeContentReader;
}

interface HarnessOptions {
  connected?: boolean;
  reader?: CollaborativeContentReader;
  seedFiles?: boolean;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const {
    connected = true,
    reader = makeReader({ success: true, value: LIVE_TEXT }),
    seedFiles = true,
  } = options;

  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const commandRunner = new InMemoryGitCommandRunner();
  const fileNodeRepo = new InMemoryFileNodeRepository();
  const documentRepo = new InMemoryDocumentRepository();
  const collaborationSessionRepo = new InMemoryCollaborationSessionRepository();

  if (seedFiles) {
    for (const { node, document } of [openFile, dormantFile]) {
      await fileNodeRepo.save(node);
      await documentRepo.save(document);
    }
    // Only the "open" file has an active collaborative session; the "dormant" one has a
    // document but no active session, so it resolves to stored content.
    await collaborationSessionRepo.open(PROJECT_ID, openFile.document.id);
  }

  if (connected) {
    await gitRepositoryRepo.save(
      new GitRepository(
        GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440098'),
        PROJECT_ID,
        GitProvider.create('github'),
        'https://github.com/example/repo.git',
        PROJECT_ID.value,
      ),
    );
  }

  const useCase = new GetDiffUseCase(
    gitRepositoryRepo,
    commandRunner,
    fileNodeRepo,
    documentRepo,
    collaborationSessionRepo,
    reader,
  );

  return { useCase, commandRunner, collaborativeContentReader: reader };
}

describe('GetDiffUseCase', () => {
  test('commit-vs-commit passes from/to/path straight through, and never touches live-content deps', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedDiff(PROJECT_ID, { unified: 'diff --git a/x b/x' });

    const result = await harness.useCase.execute({
      projectId: PROJECT_ID,
      path: OPEN_PATH,
      from: 'aaa111',
      to: 'bbb222',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({ unified: 'diff --git a/x b/x' });

    expect(harness.commandRunner.diffCalls).toHaveLength(1);
    expect(harness.commandRunner.diffCalls[0]).toEqual({
      projectId: PROJECT_ID,
      input: { path: OPEN_PATH, from: 'aaa111', to: 'bbb222' },
    });
    expect((harness.collaborativeContentReader.readContent as jest.Mock).mock.calls).toHaveLength(0);
  });

  test('uncommitted mode with an open file passes the live content as currentContent', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedDiff(PROJECT_ID, { unified: 'live diff' });

    const result = await harness.useCase.execute({ projectId: PROJECT_ID, path: OPEN_PATH });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({ unified: 'live diff' });

    expect(harness.commandRunner.diffCalls).toHaveLength(1);
    expect(harness.commandRunner.diffCalls[0].input).toEqual({
      path: OPEN_PATH,
      currentContent: { path: OPEN_PATH, content: LIVE_TEXT },
    });
  });

  test('uncommitted mode with a dormant (not open) file diffs plainly, with no currentContent override', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedDiff(PROJECT_ID, { unified: 'stored diff' });

    const result = await harness.useCase.execute({ projectId: PROJECT_ID, path: DORMANT_PATH });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(harness.commandRunner.diffCalls).toHaveLength(1);
    expect(harness.commandRunner.diffCalls[0].input).toEqual({ path: DORMANT_PATH });
  });

  test('uncommitted mode whose live read fails refuses with GitCommandFailedError, and the runner\'s diff is never called', async () => {
    const harness = await buildHarness({
      reader: makeReader({ success: false, error: new Error('collab server unreachable') }),
    });
    harness.commandRunner.seedDiff(PROJECT_ID, { unified: 'should not be reached' });

    const result = await harness.useCase.execute({ projectId: PROJECT_ID, path: OPEN_PATH });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
    expect(harness.commandRunner.diffCalls).toHaveLength(0);
  });

  test('uncommitted mode with a path matching no file node diffs plainly, with no error', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedDiff(PROJECT_ID, { unified: 'no node diff' });

    const result = await harness.useCase.execute({ projectId: PROJECT_ID, path: NO_NODE_PATH });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(harness.commandRunner.diffCalls).toHaveLength(1);
    expect(harness.commandRunner.diffCalls[0].input).toEqual({ path: NO_NODE_PATH });
    expect((harness.collaborativeContentReader.readContent as jest.Mock).mock.calls).toHaveLength(0);
  });

  test('uncommitted mode with no path diffs the whole tree, with no live-content lookup', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedDiff(PROJECT_ID, { unified: 'whole tree diff' });

    const result = await harness.useCase.execute({ projectId: PROJECT_ID });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(harness.commandRunner.diffCalls).toHaveLength(1);
    expect(harness.commandRunner.diffCalls[0].input).toEqual({});
    expect((harness.collaborativeContentReader.readContent as jest.Mock).mock.calls).toHaveLength(0);
  });

  test('a project with no connected repository refuses with RepositoryNotConnectedError, and diff is never called', async () => {
    const harness = await buildHarness({ connected: false });

    const result = await harness.useCase.execute({ projectId: PROJECT_ID, path: OPEN_PATH });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(harness.commandRunner.diffCalls).toHaveLength(0);
  });

  test('a runner failure propagates unchanged', async () => {
    const harness = await buildHarness();
    const failure = new GitCommandFailedError('git diff failed');
    harness.commandRunner.seedDiffFailure(PROJECT_ID, failure);

    const result = await harness.useCase.execute({ projectId: PROJECT_ID, path: OPEN_PATH });

    expect(result).toEqual({ success: false, error: failure });
  });
});
