import { SearchProjectContentUseCase, SearchLimits } from '../../../src/use-cases/content/search-project-content';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryProjectFileStore } from '../../ports/storage/in-memory-project-file-store';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryRegexEngine } from '../../ports/text/in-memory-regex-engine';
import { FileNode } from '../../../src/entities/file-node';
import { ProjectMember } from '../../../src/entities/project-member';
import { Document } from '../../../src/entities/document';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { DocumentId } from '../../../src/value-objects/ids/document-id';
import { ContentId } from '../../../src/value-objects/ids/content-id';
import { YjsStateId } from '../../../src/value-objects/ids/yjs-state-id';
import { MimeType } from '../../../src/value-objects/files/mime-type';
import { Role } from '../../../src/value-objects/identity/role';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { ValidationError } from '../../../src/errors/common/validation-error';
import type { CollaborativeContentReader } from '../../../src/ports/storage/collaborative-content-reader';
import type { Logger } from '../../../src/ports/observability/logger';
import type { Result } from '../../../src/types/result';
import type { SearchQuery } from '../../../src/use-cases/content/text-match';

const memberId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const nonMemberId = UserId.create('660e8400-e29b-41d4-a716-446655440002');
const projectId = ProjectId.create('880e8400-e29b-41d4-a716-446655440004');
const rootId = FileNodeId.create('990e8400-e29b-41d4-a716-446655440005');
const alphaId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');
const betaId = FileNodeId.create('bb0e8400-e29b-41d4-a716-446655440007');
const liveYjs = YjsStateId.create('cc0e8400-e29b-41d4-a716-446655440008');

const LIMITS: SearchLimits = { maxMatchesReturned: 1000, perFileTimeBudgetMs: 250, maxFileBytes: 2_000_000 };

/** A collaborative reader that always answers with the same outcome. */
const readerReturning = (outcome: Result<string | null, Error>): CollaborativeContentReader => ({
  async readContent(): Promise<Result<string | null, Error>> {
    return outcome;
  },
});

const literal = (text: string, over: Partial<SearchQuery> = {}): SearchQuery => ({
  text,
  mode: 'literal',
  caseSensitive: true,
  wholeWord: false,
  ...over,
});

describe('SearchProjectContentUseCase', () => {
  let memberRepo: InMemoryProjectMemberRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let fileStore: InMemoryProjectFileStore;
  let documentRepo: InMemoryDocumentRepository;
  let engine: InMemoryRegexEngine;

  const build = (reader?: CollaborativeContentReader): SearchProjectContentUseCase =>
    new SearchProjectContentUseCase(memberRepo, fileNodeRepo, fileStore, engine, documentRepo, reader);

  const seedFile = async (id: FileNodeId, name: string, content: Buffer | string): Promise<void> => {
    await fileNodeRepo.save(new FileNode(id, projectId, rootId, name, FileNodeType.create('file'), FilePath.create(`/${name}`)));
    await fileStore.write(projectId, FilePath.create(`/${name}`), Buffer.isBuffer(content) ? content : Buffer.from(content));
  };

  /** Seeds `live.adoc` as an open, document-backed file with the given file-store projection. */
  const seedOpenDocument = async (projection: string): Promise<void> => {
    await seedFile(alphaId, 'live.adoc', projection);
    await documentRepo.save(
      new Document(
        DocumentId.create('22222222-e29b-41d4-a716-446655440222'),
        alphaId,
        ContentId.create('33333333-e29b-41d4-a716-446655440333'),
        liveYjs,
        MimeType.create('text/asciidoc'),
      ),
    );
  };

  beforeEach(async () => {
    memberRepo = new InMemoryProjectMemberRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    fileStore = new InMemoryProjectFileStore();
    documentRepo = new InMemoryDocumentRepository();
    engine = new InMemoryRegexEngine();
    await fileNodeRepo.save(new FileNode(rootId, projectId, null, 'Root', FileNodeType.create('folder'), FilePath.create('/')));
    await memberRepo.addMember(new ProjectMember(projectId, memberId, Role.create('viewer'), new Date()));
  });

  it('denies a non-member', async () => {
    const result = await build().execute(nonMemberId, projectId, { query: literal('x'), limits: LIMITS });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(PermissionDeniedError);
  });

  it('finds a term across files (grouped by path) with true and per-file counts', async () => {
    await seedFile(alphaId, 'alpha.adoc', 'foo here\nand foo again\n');
    await seedFile(betaId, 'beta.txt', 'no match here\n');
    await seedFile(FileNodeId.create('dd0e8400-e29b-41d4-a716-446655440009'), 'gamma.md', 'foo in gamma\n');

    const result = await build().execute(memberId, projectId, { query: literal('foo'), limits: LIMITS });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { groups, totalMatches, returnedMatches, capped, skippedFiles } = result.value;
    expect(groups.map((g) => g.path)).toEqual(['alpha.adoc', 'gamma.md']); // path-ordered, beta absent
    expect(groups[0]).toMatchObject({ path: 'alpha.adoc', matchCount: 2 });
    expect(totalMatches).toBe(3);
    expect(returnedMatches).toBe(3);
    expect(capped).toBe(false);
    expect(skippedFiles).toBe(0);
  });

  it('locates matches with line/column/lineText for navigation', async () => {
    await seedFile(alphaId, 'alpha.adoc', 'first line\nsecond has foo in it\n');
    const result = await build().execute(memberId, projectId, { query: literal('foo'), limits: LIMITS });
    if (!result.success) return;
    const match = result.value.groups[0].matches[0];
    expect(match).toMatchObject({ ordinal: 0, line: 2, column: 12, matchText: 'foo', lineText: 'second has foo in it' });
  });

  it('honours case and whole-word toggles', async () => {
    await seedFile(alphaId, 'alpha.adoc', 'Foo food foobar foo\n');
    const insensitive = await build().execute(memberId, projectId, { query: literal('foo', { caseSensitive: false }), limits: LIMITS });
    if (!insensitive.success) return;
    expect(insensitive.value.totalMatches).toBe(4); // Foo, foo(d), foo(bar), foo

    const wholeWord = await build().execute(memberId, projectId, { query: literal('foo', { caseSensitive: false, wholeWord: true }), limits: LIMITS });
    if (!wholeWord.success) return;
    expect(wholeWord.value.totalMatches).toBe(2); // "Foo" and standalone "foo"
  });

  it('matches a regex with capture groups via the injected engine', async () => {
    await seedFile(alphaId, 'dates.txt', 'on 2026-07-05 and 1999-12-31\n');
    const result = await build().execute(memberId, projectId, {
      query: literal(String.raw`(\d{4})-(\d{2})-(\d{2})`, { mode: 'regex' }),
      limits: LIMITS,
    });
    if (!result.success) return;
    expect(result.value.totalMatches).toBe(2);
    expect(result.value.groups[0].matches[0].matchText).toBe('2026-07-05');
  });

  it('rejects an invalid regex before scanning (even with no files)', async () => {
    const result = await build().execute(memberId, projectId, { query: literal('(unclosed', { mode: 'regex' }), limits: LIMITS });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('skips binary and oversize files, reporting the count', async () => {
    await seedFile(alphaId, 'text.adoc', 'foo\n');
    await seedFile(betaId, 'image.bin', Buffer.from([0x66, 0x00, 0x6F, 0x6F])); // NUL => binary
    await seedFile(FileNodeId.create('ee0e8400-e29b-41d4-a716-44665544000a'), 'big.txt', 'foo foo foo foo\n');

    const result = await build().execute(memberId, projectId, { query: literal('foo'), limits: { ...LIMITS, maxFileBytes: 6 } });
    if (!result.success) return;
    expect(result.value.groups.map((g) => g.path)).toEqual(['text.adoc']);
    expect(result.value.skippedFiles).toBe(2); // binary + oversize
  });

  it('caps returned matches while still reporting the true total', async () => {
    await seedFile(alphaId, 'alpha.adoc', 'foo foo foo\n');
    await seedFile(betaId, 'beta.adoc', 'foo foo\n');
    const result = await build().execute(memberId, projectId, { query: literal('foo'), limits: { ...LIMITS, maxMatchesReturned: 2 } });
    if (!result.success) return;
    expect(result.value.totalMatches).toBe(5);
    expect(result.value.returnedMatches).toBe(2);
    expect(result.value.capped).toBe(true);
    expect(result.value.groups[0].matchCount).toBe(3); // count is honest even though only 2 returned
    expect(result.value.groups[0].matches).toHaveLength(2);
  });

  it('reads the last line of a file that has no trailing newline', async () => {
    await seedFile(alphaId, 'alpha.adoc', 'intro\nfoo at the very end');
    const result = await build().execute(memberId, projectId, { query: literal('foo'), limits: LIMITS });
    if (!result.success) return;
    expect(result.value.groups[0].matches[0]).toMatchObject({ line: 2, column: 1, lineText: 'foo at the very end' });
  });

  it('strips the carriage return from a CRLF line snippet', async () => {
    await seedFile(alphaId, 'alpha.adoc', 'foo on a windows line\r\nsecond\r\n');
    const result = await build().execute(memberId, projectId, { query: literal('foo'), limits: LIMITS });
    if (!result.success) return;
    expect(result.value.groups[0].matches[0].lineText).toBe('foo on a windows line');
  });

  it('ignores a file node that has no bytes in the store', async () => {
    await fileNodeRepo.save(new FileNode(alphaId, projectId, rootId, 'ghost.adoc', FileNodeType.create('file'), FilePath.create('/ghost.adoc')));
    await seedFile(betaId, 'beta.adoc', 'foo\n');
    const result = await build().execute(memberId, projectId, { query: literal('foo'), limits: LIMITS });
    if (!result.success) return;
    expect(result.value.groups.map((g) => g.path)).toEqual(['beta.adoc']);
    expect(result.value.skippedFiles).toBe(0); // absent content is not a "skipped" file
  });

  it('reports the results as capped when a file exhausts its time budget', async () => {
    await seedFile(alphaId, 'alpha.adoc', 'foo foo foo\n');
    const result = await build().execute(memberId, projectId, { query: literal('foo'), limits: { ...LIMITS, perFileTimeBudgetMs: 0 } });
    if (!result.success) return;
    expect(result.value.capped).toBe(true);
    expect(result.value.totalMatches).toBe(0);
  });

  it('reports named capture groups, with a non-participating group as null', async () => {
    await seedFile(alphaId, 'alpha.adoc', 'foo\n');
    const result = await build().execute(memberId, projectId, {
      query: literal('(?<word>foo)(?<tail>bar)?', { mode: 'regex' }),
      limits: LIMITS,
    });
    if (!result.success) return;
    const match = result.value.groups[0].matches[0];
    expect(match.named).toEqual({ word: 'foo', tail: null });
    expect(match.groups).toEqual(['foo', 'foo', null]);
  });

  it('searches the file-store projection when no document repository is wired', async () => {
    await seedFile(alphaId, 'alpha.adoc', 'foo\n');
    const withoutDocuments = new SearchProjectContentUseCase(memberRepo, fileNodeRepo, fileStore, engine);
    const result = await withoutDocuments.execute(memberId, projectId, { query: literal('foo'), limits: LIMITS });
    if (!result.success) return;
    expect(result.value.totalMatches).toBe(1);
  });

  it('searches the LIVE content of an open file, not the stale projection', async () => {
    await fileNodeRepo.save(new FileNode(alphaId, projectId, rootId, 'live.adoc', FileNodeType.create('file'), FilePath.create('/live.adoc')));
    await fileStore.write(projectId, FilePath.create('/live.adoc'), Buffer.from('stale, no needle\n'));
    await documentRepo.save(
      new Document(
        DocumentId.create('22222222-e29b-41d4-a716-446655440222'),
        alphaId,
        ContentId.create('33333333-e29b-41d4-a716-446655440333'),
        liveYjs,
        MimeType.create('text/asciidoc'),
      ),
    );
    const reader: CollaborativeContentReader = {
      async readContent(_p, id): Promise<Result<string | null, Error>> {
        return id.value === liveYjs.value
          ? { success: true, value: 'freshly typed needle here\n' }
          : { success: true, value: null };
      },
    };
    const result = await build(reader).execute(memberId, projectId, { query: literal('needle'), limits: LIMITS });
    if (!result.success) return;
    expect(result.value.totalMatches).toBe(1);
    expect(result.value.groups[0].matches[0].lineText).toBe('freshly typed needle here');
  });

  describe('when a file is document-backed but its live content is unavailable', () => {
    it('falls back to the file-store projection when the room holds no content', async () => {
      await seedOpenDocument('needle in the projection\n');
      const result = await build(readerReturning({ success: true, value: null })).execute(memberId, projectId, {
        query: literal('needle'),
        limits: LIMITS,
      });
      if (!result.success) return;
      expect(result.value.totalMatches).toBe(1);
      expect(result.value.groups[0].matches[0].lineText).toBe('needle in the projection');
    });

    it('skips a live document larger than the per-file size budget', async () => {
      await seedOpenDocument('needle\n');
      const reader = readerReturning({ success: true, value: 'needle '.repeat(50) });
      const result = await build(reader).execute(memberId, projectId, {
        query: literal('needle'),
        limits: { ...LIMITS, maxFileBytes: 16 },
      });
      if (!result.success) return;
      expect(result.value.totalMatches).toBe(0);
      expect(result.value.skippedFiles).toBe(1);
    });

    it('warns and falls back to the file store when the live read fails', async () => {
      await seedOpenDocument('needle in the projection\n');
      const warnings: string[] = [];
      const logger: Logger = {
        warn(message): void {
          warnings.push(message);
        },
      };
      const reader = readerReturning({ success: false, error: new Error('room unavailable') });
      const useCase = new SearchProjectContentUseCase(memberRepo, fileNodeRepo, fileStore, engine, documentRepo, reader, logger);
      const result = await useCase.execute(memberId, projectId, { query: literal('needle'), limits: LIMITS });
      if (!result.success) return;
      expect(result.value.totalMatches).toBe(1);
      expect(warnings).toHaveLength(1);
    });
  });
});
