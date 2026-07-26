import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import type { Tree } from '@lezer/common';
import { createIncludedFileLinter, type IncludedFile } from '@/lib/codemirror/harper/included-file-lint';
import type { HarperWorkerClient, SegmentInput, SegmentLints } from '@/lib/codemirror/harper/harper-worker-client';
import type { EngineLint } from '@/lib/codemirror/harper/harper-engine';
import { createTestBlockTokenizer, createTestBlockContext } from '../../../helpers/asciidoc-test-tokenizer';

// The generated parser ships as ESM the commonjs transform cannot load, so the grammar is built from
// source — the approach every other prose-extraction suite uses. The linter takes `parse` as an input
// precisely so it can be driven this way.
const grammarPath = path.resolve(__dirname, '../../../../src/lib/codemirror/asciidoc.grammar');
const lezerParser = buildParser(fs.readFileSync(grammarPath, 'utf8'), {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
});

function parse(text: string): Tree {
  return lezerParser.parse(text);
}

/** A client that flags every occurrence of "wrold" as a spelling issue, counting the calls it took. */
function fakeClient(overrides: Partial<HarperWorkerClient> = {}): HarperWorkerClient {
  const base: Partial<HarperWorkerClient> = {
    async lint(segments: SegmentInput[]): Promise<SegmentLints[] | null> {
      return segments.map((segment) => {
        const lints: EngineLint[] = [];
        for (let at = segment.text.indexOf('wrold'); at !== -1; at = segment.text.indexOf('wrold', at + 1)) {
          lints.push({
            span: { start: at, end: at + 5 },
            kind: 'Spelling',
            rule: 'SpellCheck',
            message: '“wrold” may be misspelled',
            suggestions: [{ text: 'world', kind: 'replace' }],
          });
        }
        return { id: segment.id, lints };
      });
    },
  };
  return { ...base, ...overrides } as HarperWorkerClient;
}

/** Resolve immediately instead of waiting on a real macrotask between files. */
const noYield = async (): Promise<void> => {};

function file(filePath: string, content: string): IncludedFile {
  return { fileId: `id:${filePath}`, path: filePath, content };
}

describe('createIncludedFileLinter', () => {
  test('reports an issue in an included file with its path and 1-based line', async () => {
    const linter = createIncludedFileLinter({ parse });
    const chapter = file('chapters/intro.adoc', '= Intro\n\nFirst line is clean.\n\nThe wrold turns.\n');

    const result = await linter.lint([chapter], { client: fakeClient(), yieldToUi: noYield });

    expect(result.completed).toBe(true);
    expect(result.issues).toEqual([
      {
        fileId: 'id:chapters/intro.adoc',
        path: 'chapters/intro.adoc',
        line: 5,
        category: 'spelling',
        message: '“wrold” may be misspelled',
        // Carried through from the lint so the panel can name the rule for a cross-file issue too.
        rule: 'SpellCheck',
      },
    ]);
  });

  test('checks each file of the tree and keeps the issues in file order', async () => {
    const linter = createIncludedFileLinter({ parse });
    const files = [
      file('a.adoc', 'The wrold turns.\n'),
      file('b.adoc', 'Nothing wrong here.\n'),
      file('c.adoc', 'Another wrold appears.\n'),
    ];

    const result = await linter.lint(files, { client: fakeClient(), yieldToUi: noYield });

    expect(result.issues.map((issue) => issue.path)).toEqual(['a.adoc', 'c.adoc']);
  });

  test('never reports prose that is not prose — a misspelling inside a code block is skipped', async () => {
    const linter = createIncludedFileLinter({ parse });
    const chapter = file('chapters/code.adoc', 'Clean prose.\n\n----\nwrold_ok = 1\n----\n');

    const result = await linter.lint([chapter], { client: fakeClient(), yieldToUi: noYield });

    expect(result.issues).toEqual([]);
  });

  test('reports the pass as incomplete when the shared client supersedes it mid-tree', async () => {
    const linter = createIncludedFileLinter({ parse });
    let call = 0;
    const client = fakeClient({
      async lint(segments: SegmentInput[]): Promise<SegmentLints[] | null> {
        call += 1;
        if (call > 1) return null; // a second request took the shared client's turn
        return segments.map((segment) => ({
          id: segment.id,
          lints: [{ span: { start: 4, end: 9 }, kind: 'Spelling', rule: 'SpellCheck', message: 'x', suggestions: [] }],
        }));
      },
    });

    const result = await linter.lint(
      [file('a.adoc', 'The wrold turns.\n'), file('b.adoc', 'The wrold spins.\n')],
      { client, yieldToUi: noYield },
    );

    expect(result.completed).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(['a.adoc']);
  });

  test('stops early once the pass is cancelled', async () => {
    const linter = createIncludedFileLinter({ parse });
    let cancelled = false;
    const client = fakeClient({
      async lint(segments: SegmentInput[]): Promise<SegmentLints[] | null> {
        cancelled = true; // the scope changed while the first file was in flight
        return segments.map((segment) => ({ id: segment.id, lints: [] }));
      },
    });

    const result = await linter.lint(
      [file('a.adoc', 'One.\n'), file('b.adoc', 'The wrold turns.\n')],
      { client, yieldToUi: noYield, isCancelled: () => cancelled },
    );

    expect(result.completed).toBe(false);
    expect(result.issues).toEqual([]);
  });

  test('ignores a result whose segment id no longer maps, rather than mis-locating it', async () => {
    const linter = createIncludedFileLinter({ parse });
    const client = fakeClient({
      async lint(): Promise<SegmentLints[] | null> {
        return [{ id: '7', lints: [{ span: { start: 0, end: 5 }, kind: 'Spelling', rule: 'SpellCheck', message: 'x', suggestions: [] }] }];
      },
    });

    const result = await linter.lint([file('a.adoc', 'The wrold turns.\n')], { client, yieldToUi: noYield });

    expect(result.issues).toEqual([]);
    expect(result.completed).toBe(true);
  });

  test('yields between files by default, so a long tree never blocks the UI in one go', async () => {
    const linter = createIncludedFileLinter({ parse });

    const result = await linter.lint(
      [file('a.adoc', 'The wrold turns.\n'), file('b.adoc', 'The wrold spins.\n')],
      { client: fakeClient() },
    );

    expect(result.issues.map((issue) => issue.path)).toEqual(['a.adoc', 'b.adoc']);
  });

  test('re-parses a file only when its content changed, so a repeat pass is cheap', async () => {
    let parses = 0;
    const linter = createIncludedFileLinter({
      parse: (text) => {
        parses += 1;
        return parse(text);
      },
    });
    const original = file('a.adoc', 'The wrold turns.\n');
    const client = fakeClient();

    await linter.lint([original], { client, yieldToUi: noYield });
    await linter.lint([original], { client, yieldToUi: noYield });
    expect(parses).toBe(1);

    await linter.lint([file('a.adoc', 'The wrold turns again.\n')], { client, yieldToUi: noYield });
    expect(parses).toBe(2);
  });

  test('bounds its parse cache, so a very large tree cannot grow it without limit', async () => {
    let parses = 0;
    const linter = createIncludedFileLinter({
      parse: (text) => {
        parses += 1;
        return parse(text);
      },
    });
    const first = file('f0.adoc', 'Chapter zero.\n');
    const client = fakeClient();

    await linter.lint([first], { client, yieldToUi: noYield });
    // Enough distinct files to push the first one out of the cache.
    const rest = Array.from({ length: 200 }, (_, index) => file(`f${index + 1}.adoc`, `Chapter ${index + 1}.\n`));
    await linter.lint(rest, { client, yieldToUi: noYield });
    const afterFlood = parses;

    await linter.lint([first], { client, yieldToUi: noYield });
    expect(parses).toBe(afterFlood + 1); // evicted, so it parses again rather than being remembered forever
  });
});
