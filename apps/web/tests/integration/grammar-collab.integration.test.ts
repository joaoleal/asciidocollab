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
import { createTestBlockTokenizer } from '../helpers/asciidoc-test-tokenizer';

// The concurrent-edit + no-leak scenario the plan requires an integration test for (US3 / SC-002/004):
// an accepted fix is an ordinary CRDT edit, so it merges with a collaborator's concurrent edit without
// loss, while diagnostics never enter the shared document.

const grammarPath = path.resolve(__dirname, '../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');
const lezerParser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
});
const langExtension = new LanguageSupport(LRLanguage.define({ name: 'asciidoc', parser: lezerParser }));

/** Lints every occurrence of "wrold" as a spelling issue with a "world" fix. */
function fakeClient(): HarperWorkerClient {
  return {
    async lint(segments: SegmentInput[]): Promise<SegmentLints[] | null> {
      return segments.map((segment) => {
        const lints: EngineLint[] = [];
        let at = segment.text.indexOf('wrold');
        while (at !== -1) {
          lints.push({
            span: { start: at, end: at + 5 },
            kind: 'Spelling',
            rule: 'SpellCheck',
            message: '“wrold” may be misspelled',
            suggestions: [{ text: 'world', kind: 'replace' }],
          });
          at = segment.text.indexOf('wrold', at + 5);
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

function mount(ydoc: Y.Doc, awareness: Awareness): EditorView {
  const parent = document.createElement('div');
  document.body.append(parent);
  return new EditorView({
    state: EditorState.create({ extensions: [langExtension, collabExtensions(ydoc, awareness)] }),
    parent,
  });
}

describe('grammar fixes under concurrent collaboration', () => {
  test('an accepted fix merges with a collaborator’s concurrent edit — no lost edits, no leaked metadata', () => {
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    const view = mount(ydoc, awareness);
    const ytext = ydoc.getText(COLLAB_YTEXT_KEY);

    view.dispatch({ changes: { from: 0, insert: 'The wrold and more.' } });

    // A second collaborator edits a DIFFERENT region at the same time (remote Yjs origin).
    ydoc.transact(() => ytext.insert(ytext.length, ' [added by peer]'), 'remote-peer');

    // The local author accepts the grammar fix for "wrold" (document offsets 4..9).
    applyGrammarSuggestion(view, 4, 9, { text: 'world', kind: 'replace' });

    // Both edits survive and converge; the shared document is plain text with no grammar metadata.
    expect(ytext.toString()).toBe('The world and more. [added by peer]');
    expect(view.state.doc.toString()).toBe('The world and more. [added by peer]');
    expect([...ydoc.share.keys()]).toEqual([COLLAB_YTEXT_KEY]);

    view.destroy();
    awareness.destroy();
    ydoc.destroy();
  });

  test('an issue’s mark stays anchored when a remote edit inserts text above it', async () => {
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    const view = mount(ydoc, awareness);
    const ytext = ydoc.getText(COLLAB_YTEXT_KEY);

    view.dispatch({ changes: { from: 0, insert: 'The wrold turns.' } });
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);

    const before = await harperLintSource(deps(fakeClient()))(view);
    expect(view.state.sliceDoc(before[0].from, before[0].to)).toBe('wrold');

    // A collaborator inserts a whole sentence ABOVE the issue.
    ydoc.transact(() => ytext.insert(0, 'A new opening sentence. '), 'remote-peer');
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);

    // Re-linting the updated document still lands the mark exactly on "wrold", now shifted down.
    const after = await harperLintSource(deps(fakeClient()))(view);
    expect(after[0].from).toBeGreaterThan(before[0].from);
    expect(view.state.sliceDoc(after[0].from, after[0].to)).toBe('wrold');

    view.destroy();
    awareness.destroy();
    ydoc.destroy();
  });

  test('two collaborators’ issues never appear in each other’s shared state (only text syncs)', () => {
    // Model two peers as two Y.Docs synced by exchanging updates.
    const ydocA = new Y.Doc();
    const ydocB = new Y.Doc();
    const awarenessA = new Awareness(ydocA);
    const awarenessB = new Awareness(ydocB);
    ydocA.on('update', (update: Uint8Array) => Y.applyUpdate(ydocB, update));
    ydocB.on('update', (update: Uint8Array) => Y.applyUpdate(ydocA, update));
    const viewA = mount(ydocA, awarenessA);
    const viewB = mount(ydocB, awarenessB);

    viewA.dispatch({ changes: { from: 0, insert: 'Peer A wrote wrold here.' } });

    // B sees A's text, and only the text — no diagnostics/counts crossed the wire.
    expect(ydocB.getText(COLLAB_YTEXT_KEY).toString()).toBe('Peer A wrote wrold here.');
    expect([...ydocB.share.keys()]).toEqual([COLLAB_YTEXT_KEY]);

    viewA.destroy();
    viewB.destroy();
    awarenessA.destroy();
    awarenessB.destroy();
    ydocA.destroy();
    ydocB.destroy();
  });
});
