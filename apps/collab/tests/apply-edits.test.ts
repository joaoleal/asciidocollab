import { Server, type Extension } from '@hocuspocus/server';
import * as Y from 'yjs';
import { Re2RegexEngine } from '@asciidocollab/infrastructure';
import type { MatchBudget, RegexEngine, YjsStateStore } from '@asciidocollab/domain';
import {
  applyReplacementsToYText,
  applyEditsToDocument,
  applyStructuredReplacementToDocument,
  readDocumentContent,
  replaceTextMinimalDiff,
  replaceDocumentContent,
} from '../src/apply-edits';

function ytextWith(text: string): Y.Text {
  const document = new Y.Doc();
  const ytext = document.getText('codemirror');
  ytext.insert(0, text);
  return ytext;
}

describe('applyReplacementsToYText', () => {
  it('replaces every occurrence of each find', () => {
    const ytext = ytextWith('a include::intro.adoc[] b include::intro.adoc[] c');
    const applied = applyReplacementsToYText(ytext, [
      { find: 'include::intro.adoc[]', replace: 'include::overview.adoc[]' },
    ]);
    expect(applied).toBe(2);
    expect(ytext.toString()).toBe('a include::overview.adoc[] b include::overview.adoc[] c');
  });

  it('skips a find that is absent — a safe no-op when the live text has diverged', () => {
    const ytext = ytextWith('nothing to see');
    expect(applyReplacementsToYText(ytext, [{ find: 'include::x.adoc[]', replace: 'y' }])).toBe(0);
    expect(ytext.toString()).toBe('nothing to see');
  });

  it('does not loop forever when replace contains find', () => {
    const ytext = ytextWith('a');
    expect(applyReplacementsToYText(ytext, [{ find: 'a', replace: 'aa' }])).toBe(1);
    expect(ytext.toString()).toBe('aa');
  });

  it('skips empty-find and identity replacements', () => {
    const ytext = ytextWith('keep');
    expect(
      applyReplacementsToYText(ytext, [
        { find: '', replace: 'x' },
        { find: 'keep', replace: 'keep' },
      ]),
    ).toBe(0);
    expect(ytext.toString()).toBe('keep');
  });
});

// Runs replaceTextMinimalDiff inside a real Y.Doc transaction (as production code does), against a
// real Y.Text, and returns spies on the instance's own delete/insert so a test can assert the exact
// offsets/lengths used — not just the resulting string — proving the splice is minimal.
function runMinimalDiff(seed: string, target: string): { ytext: Y.Text; deleteSpy: jest.SpyInstance; insertSpy: jest.SpyInstance } {
  const document = new Y.Doc();
  const ytext = document.getText('codemirror');
  if (seed.length > 0) ytext.insert(0, seed);
  const deleteSpy = jest.spyOn(ytext, 'delete');
  const insertSpy = jest.spyOn(ytext, 'insert');
  document.transact(() => replaceTextMinimalDiff(ytext, target));
  return { ytext, deleteSpy, insertSpy };
}

describe('replaceTextMinimalDiff', () => {
  it('is a no-op when the content is already identical', () => {
    const { ytext, deleteSpy, insertSpy } = runMinimalDiff('unchanged text', 'unchanged text');
    expect(ytext.toString()).toBe('unchanged text');
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('appends only the new suffix', () => {
    const { ytext, deleteSpy, insertSpy } = runMinimalDiff('hello', 'hello world');
    expect(ytext.toString()).toBe('hello world');
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledWith(5, ' world');
  });

  it('prepends only the new prefix', () => {
    const { ytext, deleteSpy, insertSpy } = runMinimalDiff('world', 'hello world');
    expect(ytext.toString()).toBe('hello world');
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledWith(0, 'hello ');
  });

  it('inserts only the changed middle, leaving the shared prefix/suffix untouched', () => {
    const { ytext, deleteSpy, insertSpy } = runMinimalDiff('foobaz', 'foobarbaz');
    expect(ytext.toString()).toBe('foobarbaz');
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledWith(5, 'rba');
  });

  it('deletes only the changed middle, leaving the shared prefix/suffix untouched', () => {
    const { ytext, deleteSpy, insertSpy } = runMinimalDiff('foobarbaz', 'foobaz');
    expect(ytext.toString()).toBe('foobaz');
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(5, 3);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('replaces the whole text when there is no common prefix or suffix', () => {
    const { ytext, deleteSpy, insertSpy } = runMinimalDiff('abc', 'xyz');
    expect(ytext.toString()).toBe('xyz');
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(0, 3);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledWith(0, 'xyz');
  });

  it('inserts into an empty document', () => {
    const { ytext, deleteSpy, insertSpy } = runMinimalDiff('', 'hello');
    expect(ytext.toString()).toBe('hello');
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledWith(0, 'hello');
  });

  it('clears a document down to empty', () => {
    const { ytext, deleteSpy, insertSpy } = runMinimalDiff('hello', '');
    expect(ytext.toString()).toBe('');
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(0, 5);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('handles a single-character edit as a single-character splice', () => {
    const { ytext, deleteSpy, insertSpy } = runMinimalDiff('a', 'b');
    expect(ytext.toString()).toBe('b');
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(0, 1);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledWith(0, 'b');
  });

  it('clamps the suffix so it cannot overlap the prefix on a repetitive string', () => {
    // Naively matching from the end (without capping against the remaining length after the
    // prefix) would find a 3-char common suffix ("aaa") on top of a 3-char common prefix — 6
    // total against a 4-char source. The clamp must keep prefix(3) + suffix(0) instead.
    const { ytext, deleteSpy, insertSpy } = runMinimalDiff('aaaa', 'aaa');
    expect(ytext.toString()).toBe('aaa');
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(3, 1);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe('replaceDocumentContent', () => {
  it('loads a dormant document, reconciles it to the target content, and the writeback persists it', async () => {
    const stored: string[] = [];
    const seed = '= Doc\n\nold content\n';
    const extension = {
      onLoadDocument: async ({ document }: { document: Y.Doc }) => {
        const ytext = document.getText('codemirror');
        if (ytext.length === 0) ytext.insert(0, seed);
      },
      onStoreDocument: async ({ document }: { document: Y.Doc }) => {
        stored.push(document.getText('codemirror').toString());
      },
    };
    const server = new Server({ port: 0, extensions: [extension as unknown as Extension] });
    try {
      await replaceDocumentContent(server.hocuspocus, {
        projectId: '770e8400-e29b-41d4-a716-446655440003',
        yjsStateId: '11111111-e29b-41d4-a716-446655440111',
        content: '= Doc\n\nnew content\n',
      });

      // disconnect() forces a writeback; it must see the reconciled (not the stale seeded) text.
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.at(-1)).toBe('= Doc\n\nnew content\n');
    } finally {
      await server.destroy();
    }
  });
});

describe('applyEditsToDocument', () => {
  it('loads a dormant document, applies the edit, and the writeback persists corrected text', async () => {
    const stored: string[] = [];
    const seed = '= Doc\n\ninclude::intro.adoc[]\n';
    const extension = {
      onLoadDocument: async ({ document }: { document: Y.Doc }) => {
        const ytext = document.getText('codemirror');
        if (ytext.length === 0) ytext.insert(0, seed);
      },
      onStoreDocument: async ({ document }: { document: Y.Doc }) => {
        stored.push(document.getText('codemirror').toString());
      },
    };
    const server = new Server({ port: 0, extensions: [extension as unknown as Extension] });
    try {
      const applied = await applyEditsToDocument(server.hocuspocus, {
        projectId: '770e8400-e29b-41d4-a716-446655440003',
        yjsStateId: '11111111-e29b-41d4-a716-446655440111',
        replacements: [{ find: 'include::intro.adoc[]', replace: 'include::overview.adoc[]' }],
      });

      expect(applied).toBe(1);
      // disconnect() forces a writeback; it must see the corrected (not the seeded stale) text.
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.at(-1)).toContain('include::overview.adoc[]');
      expect(stored.at(-1)).not.toContain('intro.adoc');
    } finally {
      await server.destroy();
    }
  });
});

function serverSeeded(seed: string): { server: Server; stored: string[] } {
  const stored: string[] = [];
  const extension = {
    onLoadDocument: async ({ document }: { document: Y.Doc }) => {
      const ytext = document.getText('codemirror');
      if (ytext.length === 0) ytext.insert(0, seed);
    },
    onStoreDocument: async ({ document }: { document: Y.Doc }) => {
      stored.push(document.getText('codemirror').toString());
    },
  };
  return { server: new Server({ port: 0, extensions: [extension as unknown as Extension] }), stored };
}

const literalQuery = (text: string) => ({ text, mode: 'literal' as const, caseSensitive: true, wholeWord: false });

describe('applyStructuredReplacementToDocument', () => {
  const engine = new Re2RegexEngine();
  const PROJECT_ID = '770e8400-e29b-41d4-a716-446655440003';
  const YJS_STATE_ID = '11111111-e29b-41d4-a716-446655440111';
  const ROOM = `${PROJECT_ID}/${YJS_STATE_ID}`;

  it('rewrites only the confirmed ordinals of a dormant document and persists the result', async () => {
    const { server, stored } = serverSeeded('foo foo foo');
    try {
      const applied = await applyStructuredReplacementToDocument(server.hocuspocus, engine, {
        projectId: PROJECT_ID,
        yjsStateId: YJS_STATE_ID,
        query: literalQuery('foo'),
        replacement: 'bar',
        selections: [{ ordinal: 0, expectedText: 'foo' }, { ordinal: 2, expectedText: 'foo' }],
      });
      expect(applied).toBe(2);
      expect(stored.at(-1)).toBe('bar foo bar');
    } finally {
      await server.destroy();
    }
  });

  it('skips a stale selection (live text diverged) — 0 applied, no write corruption', async () => {
    const { server, stored } = serverSeeded('the cat sat');
    try {
      const applied = await applyStructuredReplacementToDocument(server.hocuspocus, engine, {
        projectId: PROJECT_ID,
        yjsStateId: YJS_STATE_ID,
        query: literalQuery('dog'),
        replacement: 'x',
        selections: [{ ordinal: 0, expectedText: 'dog' }],
      });
      expect(applied).toBe(0);
      // Any writeback must carry the unchanged text (never a corrupted splice).
      if (stored.length > 0) expect(stored.at(-1)).toBe('the cat sat');
    } finally {
      await server.destroy();
    }
  });

  it('expands a regex capture-group template', async () => {
    const { server, stored } = serverSeeded('date 2026-07 end');
    try {
      const applied = await applyStructuredReplacementToDocument(server.hocuspocus, engine, {
        projectId: PROJECT_ID,
        yjsStateId: YJS_STATE_ID,
        query: { text: String.raw`(\d{4})-(\d{2})`, mode: 'regex', caseSensitive: true, wholeWord: false },
        replacement: '$2/$1',
        selections: [{ ordinal: 0, expectedText: '2026-07' }],
      });
      expect(applied).toBe(1);
      expect(stored.at(-1)).toBe('date 07/2026 end');
    } finally {
      await server.destroy();
    }
  });

  it('merges with a concurrent edit made in an open session', async () => {
    const { server } = serverSeeded('foo foo');
    try {
      // Open the room (loads + seeds) and make a concurrent edit that shifts offsets.
      const live = await server.hocuspocus.openDirectConnection(ROOM);
      await live.transact((document) => document.getText('codemirror').insert(0, 'PREFIX '));

      const applied = await applyStructuredReplacementToDocument(server.hocuspocus, engine, {
        projectId: PROJECT_ID,
        yjsStateId: YJS_STATE_ID,
        query: literalQuery('foo'),
        replacement: 'bar',
        selections: [{ ordinal: 0, expectedText: 'foo' }],
      });
      expect(applied).toBe(1);

      let text = '';
      await live.transact((document) => { text = document.getText('codemirror').toString(); });
      await live.disconnect();
      // Both the concurrent prefix and the replacement survive (re-matched on live content).
      expect(text).toBe('PREFIX bar foo');
    } finally {
      await server.destroy();
    }
  });

  it('hands the engine a complete budget: 1,000,000 matches and a deadline 1s out', async () => {
    // The budget is what stops an untrusted pattern from starving the transaction, and the engine is
    // the only party that ever sees it — so it is asserted here, in full, where it is handed over.
    const { server } = serverSeeded('foo foo');
    const budgets: MatchBudget[] = [];
    const capturingEngine: RegexEngine = {
      compile: () => ({
        success: true,
        value: {
          matches: (input: string, budget: MatchBudget) => {
            budgets.push(budget);
            return [{ from: input.indexOf('foo'), to: input.indexOf('foo') + 3, groups: ['foo'] }];
          },
        },
      }),
    };

    try {
      const before = Date.now();
      const applied = await applyStructuredReplacementToDocument(server.hocuspocus, capturingEngine, {
        projectId: PROJECT_ID,
        yjsStateId: YJS_STATE_ID,
        query: { text: 'foo', mode: 'regex', caseSensitive: true, wholeWord: false },
        replacement: 'bar',
        selections: [{ ordinal: 0, expectedText: 'foo' }],
      });
      const after = Date.now();

      expect(applied).toBe(1);
      expect(budgets).toHaveLength(1);
      expect(Object.keys(budgets[0]).toSorted()).toEqual(['deadline', 'maxMatches']);
      expect(budgets[0].maxMatches).toBe(1_000_000);
      expect(budgets[0].deadline).toBeGreaterThanOrEqual(before + 1000);
      expect(budgets[0].deadline).toBeLessThanOrEqual(after + 1000);
    } finally {
      await server.destroy();
    }
  });

  it('is a silent no-op when the pattern does not compile — never a rejection or a partial splice', async () => {
    // An invalid pattern is rejected upstream, so reaching here means the failure Result must be
    // honoured rather than its (absent) value being handed to selectSpans.
    const { server, stored } = serverSeeded('an ( unbalanced paren');
    try {
      const applied = await applyStructuredReplacementToDocument(server.hocuspocus, engine, {
        projectId: PROJECT_ID,
        yjsStateId: YJS_STATE_ID,
        query: { text: '(unclosed', mode: 'regex', caseSensitive: true, wholeWord: false },
        replacement: 'x',
        selections: [{ ordinal: 0, expectedText: 'an' }],
      });

      expect(applied).toBe(0);
      // Any writeback the disconnect forced must carry the untouched text.
      if (stored.length > 0) expect(stored.at(-1)).toBe('an ( unbalanced paren');
    } finally {
      await server.destroy();
    }
  });
});

// A YjsStateStore stub that records whether load/save were called (a read must NOT write back).
/**
 * The state store's port plus the mock handles, so a spec can both pass it to the unit under test
 * and assert on the calls. Typing the helper `as never` instead would erase the methods along with
 * everything else — `expect(store.load)` then checks a property TypeScript believes cannot exist.
 */
type MockYjsStateStore = YjsStateStore & {
  load: jest.Mock;
  save: jest.Mock;
  delete: jest.Mock;
  deleteAllForProject: jest.Mock;
};

function fakeStateStore(state: Buffer | null): MockYjsStateStore {
  return {
    load: jest.fn(async () => state),
    save: jest.fn(),
    delete: jest.fn(),
    deleteAllForProject: jest.fn(),
  } as unknown as MockYjsStateStore;
}

function encodeText(text: string): Buffer {
  const document = new Y.Doc();
  document.getText('codemirror').insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(document));
}

describe('readDocumentContent', () => {
  const PROJECT_ID = '770e8400-e29b-41d4-a716-446655440003';
  const YJS_STATE_ID = '11111111-e29b-41d4-a716-446655440111';
  const ROOM = `${PROJECT_ID}/${YJS_STATE_ID}`;

  it('reads the in-memory document when the room is loaded (does not touch the state store)', async () => {
    const seed = '= Doc\n\nlive in-memory text\n';
    const document = new Y.Doc();
    document.getText('codemirror').insert(0, seed);
    const hocuspocus = { documents: new Map([[ROOM, document]]) } as never;
    const store = fakeStateStore(null);

    const content = await readDocumentContent(hocuspocus, store, { projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID });

    expect(content).toBe(seed);
    expect(store.load).not.toHaveBeenCalled(); // loaded room → no state-store read, no writeback
  });

  it('decodes the persisted Yjs state for a dormant room without loading it or writing back', async () => {
    const seed = '= Doc\n\n:folder2: value\n\nUses {folder2}.\n';
    const hocuspocus = { documents: new Map() } as never; // room not loaded
    const store = fakeStateStore(encodeText(seed));

    const content = await readDocumentContent(hocuspocus, store, { projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID });

    expect(content).toBe(seed);
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(store.save).not.toHaveBeenCalled(); // pure read — never persists (no writeback side effect)
  });

  it('destroys the throwaway document it decoded the dormant state into', async () => {
    const seed = 'dormant text';
    const state = encodeText(seed); // encoded BEFORE the spy, so only the read's own Y.Doc is counted
    const hocuspocus = { documents: new Map() } as never;
    const store = fakeStateStore(state);
    const destroy = jest.spyOn(Y.Doc.prototype, 'destroy');

    try {
      const content = await readDocumentContent(hocuspocus, store, { projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID });

      expect(content).toBe(seed);
      // The scratch document is per-read: leaving it alive leaks a Y.Doc on every dormant read.
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      destroy.mockRestore();
    }
  });

  it('returns null when a dormant room has no persisted state (caller falls back to the file store)', async () => {
    const hocuspocus = { documents: new Map() } as never;
    const store = fakeStateStore(null);
    const content = await readDocumentContent(hocuspocus, store, { projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID });
    expect(content).toBeNull();
  });
});
