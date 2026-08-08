/* @jest-environment jsdom */

import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LRLanguage, LanguageSupport, ensureSyntaxTree } from '@codemirror/language';
import { forceLinting, forEachDiagnostic, type Diagnostic } from '@codemirror/lint';
import {
  createGrammarLinter,
  readOnlyGrammarDiagnostic,
  refreshGrammarLints,
  grammarRefreshEffect,
} from '@/lib/codemirror/editor-grammar-linter';
import type { HarperLintSourceDeps } from '@/lib/codemirror/harper/harper-linter-source';
import type { HarperWorkerClient, SegmentInput, SegmentLints } from '@/lib/codemirror/harper/harper-worker-client';
import { createTestBlockTokenizer, createTestBlockContext } from '../../helpers/asciidoc-test-tokenizer';

const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const lezerParser = buildParser(fs.readFileSync(grammarPath, 'utf8'), {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
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

/** Deps for a source that only has to be driven, not to produce issues. */
function countingDeps(onLint: () => void): HarperLintSourceDeps {
  return { client: countingClient(onLint) };
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

/** The one lint every issue-reporting client below returns, with two one-click fixes. */
const MISSPELLING = {
  span: { start: 4, end: 9 },
  kind: 'Spelling',
  rule: 'SpellCheck',
  message: '“wrold” may be misspelled',
  suggestions: [
    { text: 'world', kind: 'replace' as const },
    { text: 'word', kind: 'replace' as const },
  ],
};

/** A client reporting one misspelling in the first segment, so real diagnostics reach the view. */
function misspellingDeps(onIgnore?: (diagnostic: unknown) => void): HarperLintSourceDeps {
  const stub: Partial<HarperWorkerClient> = {
    async lint(segments: SegmentInput[]): Promise<SegmentLints[]> {
      return segments.map((segment, index) => ({ id: segment.id, lints: index === 0 ? [MISSPELLING] : [] }));
    },
  };
  return {
    client: stub as HarperWorkerClient,
    ...(onIgnore ? { onIgnore: onIgnore as HarperLintSourceDeps['onIgnore'] } : {}),
  };
}

/** Runs a lint pass and collects what the view ended up showing. */
async function lintedDiagnostics(view: EditorView): Promise<Diagnostic[]> {
  forceLinting(view);
  // The source is async; let its promise and the plugin's follow-up dispatch settle.
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const found: Diagnostic[] = [];
  forEachDiagnostic(view.state, (diagnostic) => found.push(diagnostic));
  return found;
}

/** A view over a document with one misspelling, editable or not. */
function lintingView(readOnly: boolean, deps: HarperLintSourceDeps): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc: 'The wrold turns.\n',
      extensions: [langExtension, EditorState.readOnly.of(readOnly), createGrammarLinter(deps)],
    }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

// A reader who may not edit the document must still SEE what is wrong with it — checking is reading —
// but must not be handed a one-click fix. CodeMirror's built-in tooltip renders every `Action` as a
// live button with no disabled state, so for a read-only editor the fixes are removed from the tooltip
// and named in its message instead.
describe('grammar diagnostics on a read-only editor', () => {
  test('still reports the issue: checking is not gated on edit permission', async () => {
    const view = lintingView(true, misspellingDeps());
    const diagnostics = await lintedDiagnostics(view);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toBe('“wrold” may be misspelled');
    view.destroy();
  });

  test('offers no one-click fix, while an editable document still does', async () => {
    const readOnly = lintingView(true, misspellingDeps());
    const readOnlyDiagnostics = await lintedDiagnostics(readOnly);
    expect(readOnlyDiagnostics[0]!.actions ?? []).toHaveLength(0);
    readOnly.destroy();

    const editable = lintingView(false, misspellingDeps());
    const editableDiagnostics = await lintedDiagnostics(editable);
    expect(editableDiagnostics[0]!.actions?.map((action) => action.name)).toEqual(['world', 'word']);
    editable.destroy();
  });

  test('names the suggested corrections in the tooltip, so the reader can still see them', async () => {
    const view = lintingView(true, misspellingDeps());
    const [diagnostic] = await lintedDiagnostics(view);
    const rendered = diagnostic!.renderMessage!(view) as HTMLElement;
    expect(rendered.textContent).toContain('“wrold” may be misspelled');
    expect(rendered.textContent).toContain('Suggested: “world”, “word”');
    expect(rendered.textContent).toContain('read-only');
    view.destroy();
  });

  test('keeps Ignore, which stores a private per-user dismissal rather than editing anything', async () => {
    // The server authorizes the ignored-lints write for any project MEMBER (`requireDocumentMember`),
    // and the blob is scoped to the caller's own user id — so taking this away from a viewer would
    // remove their only way to quieten a false positive in a document they are reading.
    const onIgnore = jest.fn();
    const view = lintingView(true, misspellingDeps(onIgnore));
    const [diagnostic] = await lintedDiagnostics(view);
    expect(diagnostic!.actions?.map((action) => action.name)).toEqual(['Ignore']);
    diagnostic!.actions![0]!.apply(view, diagnostic!.from, diagnostic!.to);
    expect(onIgnore).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  test('the surviving lint pass leaves the document untouched either way', async () => {
    const view = lintingView(true, misspellingDeps());
    await lintedDiagnostics(view);
    expect(view.state.doc.toString()).toBe('The wrold turns.\n');
    view.destroy();
  });
});

describe('readOnlyGrammarDiagnostic', () => {
  test('drops only the fix actions, keeping any the lint source appended after them', () => {
    const ignore = { name: 'Ignore', apply: jest.fn() };
    const stripped = readOnlyGrammarDiagnostic({
      from: 4,
      to: 9,
      severity: 'info',
      message: '“wrold” may be misspelled',
      grammarSuggestions: MISSPELLING.suggestions,
      actions: [{ name: 'world', apply: jest.fn() }, { name: 'word', apply: jest.fn() }, ignore],
    } as unknown as Diagnostic);
    expect(stripped.actions).toEqual([ignore]);
  });

  test('leaves the actions of a diagnostic that carries no fixes alone', () => {
    // The fixes are identified by position — the first `grammarSuggestions.length` actions — so a
    // diagnostic with no suggestions has no fixes to drop, and nothing else is guessed at.
    const stripped = readOnlyGrammarDiagnostic({
      from: 0,
      to: 1,
      severity: 'error',
      message: 'unparseable',
      actions: [{ name: 'Fix', apply: jest.fn() }],
    } as unknown as Diagnostic);
    expect(stripped.actions).toHaveLength(1);
  });
});
