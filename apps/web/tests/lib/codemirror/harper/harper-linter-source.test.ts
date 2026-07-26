/* @jest-environment jsdom */

import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LRLanguage, LanguageSupport, ensureSyntaxTree } from '@codemirror/language';
import { harperLintSource, buildGrammarDiagnostics } from '@/lib/codemirror/harper/harper-linter-source';
import type { HarperWorkerClient, SegmentLints, SegmentInput } from '@/lib/codemirror/harper/harper-worker-client';
import type { EngineLint } from '@/lib/codemirror/harper/harper-engine';
import type { ProseSegment } from '@/lib/codemirror/prose-segments';
import { createTestBlockTokenizer, createTestBlockContext } from '../../../helpers/asciidoc-test-tokenizer';

const grammarPath = path.resolve(__dirname, '../../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');
const lezerParser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
});
const langExtension = new LanguageSupport(LRLanguage.define({ name: 'asciidoc', parser: lezerParser }));

function makeView(documentText: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc: documentText, extensions: [langExtension] }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

/** A client that lints the word "wrold" as a spelling issue, unless overridden. */
function fakeClient(overrides: Partial<HarperWorkerClient> = {}): HarperWorkerClient {
  const base: Partial<HarperWorkerClient> = {
    async lint(segments: SegmentInput[]): Promise<SegmentLints[] | null> {
      return segments.map((segment) => {
        const lints: EngineLint[] = [];
        const at = segment.text.indexOf('wrold');
        if (at !== -1) {
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

const deps = (client: HarperWorkerClient) => ({
  client,
});

describe('buildGrammarDiagnostics', () => {
  test('maps each segment result back to its segment offset map', () => {
    const segments: ProseSegment[] = [
      { text: 'first', map: [0, 1, 2, 3, 4] },
      { text: 'the wrold', map: [10, 11, 12, 13, 14, 15, 16, 17, 18] },
    ];
    const results: SegmentLints[] = [
      { id: '0', lints: [] },
      { id: '1', lints: [{ span: { start: 4, end: 9 }, kind: 'Spelling', rule: 'SpellCheck', message: 'x', suggestions: [] }] },
    ];
    const diagnostics = buildGrammarDiagnostics(segments, results);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ from: 14, to: 19, category: 'spelling' });
  });

  test('skips results whose id no longer matches a segment (document changed under us)', () => {
    const segments: ProseSegment[] = [{ text: 'x', map: [0] }];
    const results: SegmentLints[] = [
      { id: '5', lints: [{ span: { start: 0, end: 1 }, kind: 'Grammar', rule: 'TheirToThere', message: 'x', suggestions: [] }] },
    ];
    expect(buildGrammarDiagnostics(segments, results)).toEqual([]);
  });
});

describe('harperLintSource', () => {
  test('underlines only the misspelled prose word, not code or macros', async () => {
    const view = makeView('The wrold turns.\n\n----\nwrold_ok\n----\n');
    const diagnostics = await harperLintSource(deps(fakeClient()))(view);
    const flagged = diagnostics.map((d) => view.state.sliceDoc(d.from, d.to));
    expect(flagged).toEqual(['wrold']); // the one in prose; the one in the code block is never linted
    view.destroy();
  });

  test('returns [] (no throw) when the engine is unavailable', async () => {
    const view = makeView('The wrold turns.\n');
    const client = fakeClient({ async lint() { return null; } });
    const diagnostics = await harperLintSource(deps(client))(view);
    expect(diagnostics).toEqual([]);
    view.destroy();
  });

  test('checks every prose segment of the open file, whatever the caret covers', async () => {
    const view = makeView('The wrold turns.\n\nThe wrold spins.\n\nThe wrold waits.\n');
    const secondWrold = view.state.doc.toString().indexOf('wrold', 20);
    // Put the caret inside the middle paragraph: the source must NOT narrow to it.
    view.dispatch({ selection: { anchor: secondWrold, head: secondWrold + 5 } });
    const diagnostics = await harperLintSource(deps(fakeClient()))(view);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.map((d) => d.from)).toContain(4);
    expect(diagnostics.map((d) => d.from)).toContain(secondWrold);
    view.destroy();
  });

  test('reports the same issues for a bare caret as for a wide selection', async () => {
    const view = makeView('The wrold turns.\n\nThe wrold spins.\n');
    const source = harperLintSource(deps(fakeClient()));
    const secondWrold = view.state.doc.toString().indexOf('wrold', 20);

    view.dispatch({ selection: { anchor: secondWrold + 2 } }); // caret only, nothing selected
    const withCaret = await source(view);
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    const withSelection = await source(view);

    expect(withCaret.map((d) => d.from)).toEqual([4, secondWrold]);
    expect(withSelection.map((d) => d.from)).toEqual(withCaret.map((d) => d.from));
    view.destroy();
  });

  test('still reports the file\'s issues when the selection covers only non-prose', async () => {
    const view = makeView('The wrold turns.\n\n----\nwrold_ok\n----\n');
    const inCode = view.state.doc.toString().indexOf('wrold_ok');
    view.dispatch({ selection: { anchor: inCode, head: inCode + 8 } });
    const diagnostics = await harperLintSource(deps(fakeClient()))(view);
    expect(diagnostics.map((d) => view.state.sliceDoc(d.from, d.to))).toEqual(['wrold']);
    view.destroy();
  });

  test('returns [] for a document with no prose', async () => {
    const view = makeView('----\nonly code\n----\n');
    const client = fakeClient({
      lint: jest.fn(async () => [] as SegmentLints[]),
    });
    const diagnostics = await harperLintSource(deps(client))(view);
    expect(diagnostics).toEqual([]);
    expect(client.lint).not.toHaveBeenCalled(); // no segments → never calls the engine
    view.destroy();
  });
});

describe('harperLintSource ignore action', () => {
  test('offers Ignore on the tooltip beside the fixes when the host can store it', async () => {
    const onIgnore = jest.fn();
    const view = makeView('The wrold is round.\n');
    const diagnostics = await harperLintSource({ client: fakeClient(), onIgnore })(view);
    expect(diagnostics).toHaveLength(1);
    const actions = diagnostics[0]!.actions ?? [];
    expect(actions.map((action) => action.name)).toEqual(['world', 'Ignore']);
    view.destroy();
  });

  test('the Ignore action hands back the diagnostic, carrying the engine lint and its segment', async () => {
    // Dismissing a lint is the one operation that cannot be expressed in document coordinates: the
    // engine matches the object it handed out, against the segment text the span belongs to.
    const onIgnore = jest.fn();
    const view = makeView('The wrold is round.\n');
    const diagnostics = await harperLintSource({ client: fakeClient(), onIgnore })(view);
    const ignoreAction = (diagnostics[0]!.actions ?? []).find((action) => action.name === 'Ignore')!;
    ignoreAction.apply(view, 0, 0);
    expect(onIgnore).toHaveBeenCalledTimes(1);
    const passed = onIgnore.mock.calls[0]![0];
    expect(passed.grammarSegmentText).toContain('wrold');
    expect(passed.grammarLint).toMatchObject({ kind: 'Spelling', rule: 'SpellCheck' });
    view.destroy();
  });

  test('no Ignore action when the dismissal has nowhere to live', async () => {
    const view = makeView('The wrold is round.\n');
    const diagnostics = await harperLintSource(deps(fakeClient()))(view);
    expect((diagnostics[0]!.actions ?? []).map((action) => action.name)).toEqual(['world']);
    view.destroy();
  });
});
