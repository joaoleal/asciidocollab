/* @jest-environment jsdom */

import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { buildParser } from '@lezer/generator';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LRLanguage, LanguageSupport, ensureSyntaxTree } from '@codemirror/language';
import { harperLintSource } from '@/lib/codemirror/harper/harper-linter-source';
import { applyGrammarSuggestion } from '@/lib/codemirror/harper/apply-suggestion';
import { collabExtensions, COLLAB_YTEXT_KEY } from '@/components/editor/editor-collab-extensions';
import type { HarperWorkerClient, SegmentInput, SegmentLints } from '@/lib/codemirror/harper/harper-worker-client';
import type { EngineLint } from '@/lib/codemirror/harper/harper-engine';
import { createTestBlockTokenizer } from '../../../helpers/asciidoc-test-tokenizer';

const grammarPath = path.resolve(__dirname, '../../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');
const lezerParser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
});
const langExtension = new LanguageSupport(LRLanguage.define({ name: 'asciidoc', parser: lezerParser }));

/** Lints the word "wrold" as a spelling issue. */
function fakeClient(): HarperWorkerClient {
  return {
    async lint(segments: SegmentInput[]): Promise<SegmentLints[] | null> {
      return segments.map((segment) => {
        const lints: EngineLint[] = [];
        const at = segment.text.indexOf('wrold');
        if (at !== -1) {
          lints.push({ span: { start: at, end: at + 5 }, kind: 'Spelling', rule: 'SpellCheck', message: 'x', suggestions: [] });
        }
        return { id: segment.id, lints };
      });
    },
  } as HarperWorkerClient;
}

const deps = (client: HarperWorkerClient) => ({
  client,
  getScope: () => 'whole-document' as const,
});

describe('grammar checking never mutates shared content (except an accepted fix)', () => {
  test('the lint source produces diagnostics without dispatching any document change', async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: 'The wrold turns.\n', extensions: [langExtension] }),
    });
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    const dispatchSpy = jest.spyOn(view, 'dispatch');

    const diagnostics = await harperLintSource(deps(fakeClient()))(view);

    expect(diagnostics.length).toBeGreaterThan(0); // it DID find the issue
    expect(dispatchSpy).not.toHaveBeenCalled(); // …but never wrote to the document
    expect(view.state.doc.toString()).toBe('The wrold turns.\n');
    view.destroy();
  });

  test('linting a collaborative document leaves the shared Y.Text (and its only top-level type) untouched', async () => {
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({
      state: EditorState.create({ extensions: [langExtension, collabExtensions(ydoc, awareness)] }),
      parent,
    });
    const ytext = ydoc.getText(COLLAB_YTEXT_KEY);
    view.dispatch({ changes: { from: 0, insert: 'The wrold turns.' } });
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    const before = ytext.toString();

    await harperLintSource(deps(fakeClient()))(view);

    // The lint pass wrote nothing: the shared text is unchanged and the ydoc still has exactly one
    // top-level type (the editor text) — no grammar metadata type was ever created.
    expect(ytext.toString()).toBe(before);
    expect([...ydoc.share.keys()]).toEqual([COLLAB_YTEXT_KEY]);

    view.destroy();
    awareness.destroy();
    ydoc.destroy();
  });

  test('applying a suggestion IS the one allowed shared write, and it is an ordinary text edit', () => {
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({
      state: EditorState.create({ extensions: [collabExtensions(ydoc, awareness)] }),
      parent,
    });
    const ytext = ydoc.getText(COLLAB_YTEXT_KEY);
    view.dispatch({ changes: { from: 0, insert: 'The wrold turns.' } });

    applyGrammarSuggestion(view, 4, 9, { text: 'world', kind: 'replace' });

    expect(ytext.toString()).toBe('The world turns.'); // the fix reached the shared ydoc as plain text
    expect([...ydoc.share.keys()]).toEqual([COLLAB_YTEXT_KEY]);

    view.destroy();
    awareness.destroy();
    ydoc.destroy();
  });
});
