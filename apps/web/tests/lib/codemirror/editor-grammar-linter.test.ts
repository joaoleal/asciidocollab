/* @jest-environment jsdom */

import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LRLanguage, LanguageSupport, ensureSyntaxTree } from '@codemirror/language';
import { forceLinting } from '@codemirror/lint';
import {
  createGrammarLinter,
  refreshGrammarLints,
  grammarRefreshEffect,
} from '@/lib/codemirror/editor-grammar-linter';
import type { HarperLintSourceDeps } from '@/lib/codemirror/harper/harper-linter-source';
import type { HarperWorkerClient, SegmentInput, SegmentLints } from '@/lib/codemirror/harper/harper-worker-client';
import { createTestBlockTokenizer } from '../../helpers/asciidoc-test-tokenizer';

const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const lezerParser = buildParser(fs.readFileSync(grammarPath, 'utf8'), {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
});
const langExtension = new LanguageSupport(LRLanguage.define({ name: 'asciidoc', parser: lezerParser }));

/** The lint debounce configured by the grammar linter, plus a margin, in ms. */
const PAST_THE_DEBOUNCE_MS = 1000;

/** A client that reports no issues; these tests only count how often the lint source is driven. */
function countingClient(onLint: () => void): HarperWorkerClient {
  const stub: Partial<HarperWorkerClient> = {
    async lint(segments: SegmentInput[]): Promise<SegmentLints[]> {
      onLint();
      return segments.map((segment) => ({ id: segment.id, lints: [] }));
    },
  };
  return stub as HarperWorkerClient;
}

/** Deps with a fixed scope; the source only has to be driven, not to produce issues. */
function countingDeps(onLint: () => void): HarperLintSourceDeps {
  return {
    client: countingClient(onLint),
    getScope: () => 'whole-document',
  };
}

/** An effect unrelated to grammar, used to prove ordinary transactions do not re-lint. */
const unrelatedEffect = StateEffect.define<null>();

describe('grammar lint refresh', () => {
  let view: EditorView;
  let runs: number;

  beforeEach(() => {
    runs = 0;
    view = new EditorView({
      state: EditorState.create({
        doc: 'The wrold turns.\n',
        extensions: [langExtension, createGrammarLinter(countingDeps(() => { runs += 1; }))],
      }),
    });
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    jest.useFakeTimers();
    // Flush the lint pass the plugin schedules on creation so every test starts from a known count.
    forceLinting(view);
    runs = 0;
  });

  afterEach(() => {
    view.destroy();
    jest.useRealTimers();
  });

  test('dispatching the refresh effect re-runs the lint source without a document change', () => {
    view.dispatch({ effects: grammarRefreshEffect.of(null) });
    jest.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    expect(runs).toBe(1);
  });

  test('a transaction carrying no refresh effect does not re-run the lint source', () => {
    view.dispatch({ effects: unrelatedEffect.of(null), selection: { anchor: 4 } });
    jest.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    forceLinting(view); // even forcing finds nothing scheduled — the plugin saw no reason to re-lint
    expect(runs).toBe(0);
  });

  test('an empty transaction does not re-run the lint source', () => {
    view.dispatch({});
    jest.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    expect(runs).toBe(0);
  });

  test('refreshGrammarLints re-lints immediately instead of waiting out the debounce', () => {
    refreshGrammarLints(view);
    expect(runs).toBe(1); // no timer advance needed: the run already happened
    jest.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    expect(runs).toBe(1); // the forced run replaced the debounced one rather than duplicating it
  });

  test('an inactive grammar linter contributes no extension', () => {
    expect(createGrammarLinter(null)).toEqual([]);
  });
});
