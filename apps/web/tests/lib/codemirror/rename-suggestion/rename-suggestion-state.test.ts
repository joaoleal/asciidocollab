/*
 * @jest-environment jsdom
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { RenameSymbolResult, SymbolUsage } from '@/lib/api/projects';
import {
  renameSuggestion,
  suggestionField,
  type RenameSuggestionConfig,
} from '@/lib/codemirror/rename-suggestion/rename-suggestion-state';
import {
  applyRequestEffect,
  dismissRequestEffect,
  setSuggestionEffect,
  undoRequestEffect,
  contentChangedRefreshEffect,
} from '@/lib/codemirror/rename-suggestion/rename-suggestion-effects';

const u = (
  fileNodeId: string,
  kind: string,
  from: number,
  definitionKind: 'section' | 'anchor' | 'attribute' = 'attribute',
): SymbolUsage => ({
  fileNodeId,
  path: `${fileNodeId}.adoc`,
  kind,
  ...(kind === 'definition' && { definitionKind }),
  range: { from, to: from + 5 },
});

/** find-usages: `edition` has a def in F + two xrefs in G; a name given via `collideFor` collides. */
function makeConfig(overrides: Partial<RenameSuggestionConfig> = {}): {
  config: RenameSuggestionConfig;
  findSymbolUsages: jest.Mock;
  renameSymbol: jest.Mock;
} {
  const findSymbolUsages = jest.fn(async (_p: string, name: string): Promise<SymbolUsage[]> => {
    if (name === 'edition') return [u('F', 'definition', 0), u('G', 'xref', 5), u('G', 'xref', 20)];
    return [];
  });
  const renameSymbol = jest.fn(
    async (): Promise<RenameSymbolResult> => ({ rewrittenFiles: 1, updatedReferences: 2, warnings: [] }),
  );
  const config: RenameSuggestionConfig = {
    getProjectId: () => 'p1',
    getFileNodeId: () => 'F',
    findSymbolUsages,
    renameSymbol,
    settleMs: 2000,
    leaveMs: 5000,
    ...overrides,
  };
  return { config, findSymbolUsages, renameSymbol };
}

function mount(document_: string, config: RenameSuggestionConfig): EditorView {
  return new EditorView({
    state: EditorState.create({ doc: document_, extensions: [renameSuggestion(config)] }),
    parent: document.body,
  });
}

const shown = (view: EditorView) => view.state.field(suggestionField);
const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

/** Establish the baseline (cursor on `:edition:`), then rename it to `release`. */
function beginRename(view: EditorView, to = 'release'): void {
  view.dispatch({ selection: { anchor: 4 } }); // baseline captured: oldName = 'edition'
  view.dispatch({ changes: { from: 1, to: 8, insert: to }, selection: { anchor: 4 } });
}

describe('rename suggestion state machine', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    document.body.innerHTML = '';
  });

  test('shows a suggestion 2s after a settled attribute rename', async () => {
    const { config, findSymbolUsages } = makeConfig();
    const view = mount(':edition:\n', config);
    beginRename(view);
    expect(shown(view)).toBeNull(); // nothing yet — still within the settle window
    await jest.advanceTimersByTimeAsync(2000);
    const s = shown(view);
    expect(s?.status).toBe('visible');
    expect(s?.usageCount).toBe(2);
    expect(s?.fileCount).toBe(1);
    expect(findSymbolUsages).toHaveBeenCalledWith('p1', 'edition', 'attribute');
    expect(findSymbolUsages).toHaveBeenCalledWith('p1', 'release', 'attribute');
    view.destroy();
  });

  test('the default settle shows the suggestion after 1s', async () => {
    const { config } = makeConfig({ settleMs: undefined }); // fall back to the built-in default
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(999);
    expect(shown(view)).toBeNull(); // still within the 1s settle window
    await jest.advanceTimersByTimeAsync(1);
    expect(shown(view)?.status).toBe('visible');
    view.destroy();
  });

  test('re-editing the name resets the 2s timer', async () => {
    const { config } = makeConfig();
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(1000);
    expect(shown(view)).toBeNull();
    view.dispatch({ changes: { from: 8, to: 8, insert: 'x' }, selection: { anchor: 9 } }); // keep typing
    await jest.advanceTimersByTimeAsync(1000);
    expect(shown(view)).toBeNull(); // only 1s since the last change
    await jest.advanceTimersByTimeAsync(1000);
    expect(shown(view)?.status).toBe('visible');
    view.destroy();
  });

  test('suppresses when the old name has no other occurrences', async () => {
    const findSymbolUsages = jest.fn(async () => [u('F', 'definition', 0)]);
    const { config } = makeConfig({ findSymbolUsages });
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)).toBeNull();
    view.destroy();
  });

  test('no heading suggestion when the id only appears as an unrelated same-title section in another file', async () => {
    // Two independent files each headed `== Section title` derive the same auto-id `_section_title`,
    // with no xref to it. Renaming one heading must not offer a phantom refactor for the other — the
    // rename never rewrites another file's section heading.
    const findSymbolUsages = jest.fn(async (_p: string, name: string): Promise<SymbolUsage[]> =>
      name === '_section_title' ? [u('F', 'definition', 0, 'section'), u('B', 'definition', 50, 'section')] : [],
    );
    const { config } = makeConfig({ findSymbolUsages });
    const view = mount('== Section title\n\nbody\n', config);
    view.dispatch({ selection: { anchor: 5 } }); // baseline captured on the heading: oldName = _section_title
    view.dispatch({ changes: { from: 16, to: 16, insert: 'x' }, selection: { anchor: 17 } }); // retitle
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)).toBeNull();
    expect(findSymbolUsages).toHaveBeenCalledWith('p1', '_section_title', 'anchor');
    view.destroy();
  });

  test('still offers a heading rename when a real xref to its id exists', async () => {
    const findSymbolUsages = jest.fn(async (_p: string, name: string): Promise<SymbolUsage[]> =>
      name === '_section_title' ? [u('F', 'definition', 0, 'section'), u('B', 'xref', 50)] : [],
    );
    const { config } = makeConfig({ findSymbolUsages });
    const view = mount('== Section title\n\nbody\n', config);
    view.dispatch({ selection: { anchor: 5 } });
    view.dispatch({ changes: { from: 16, to: 16, insert: 'x' }, selection: { anchor: 17 } });
    await jest.advanceTimersByTimeAsync(2000);
    const s = shown(view);
    expect(s?.status).toBe('visible');
    expect(s?.usageCount).toBe(1);
    view.destroy();
  });

  test('a heading rename whose new id collides with an explicit anchor still blocks apply', async () => {
    // The new derived id `_section_titlex` is already held by an explicit `[[...]]` anchor elsewhere —
    // a real collision the rename WOULD rewrite, so Apply must stay blocked (unlike a coincidental
    // same-id section heading, which is not a collision).
    const findSymbolUsages = jest.fn(async (_p: string, name: string): Promise<SymbolUsage[]> => {
      if (name === '_section_title') return [u('F', 'definition', 0, 'section'), u('B', 'xref', 50)];
      if (name === '_section_titlex') return [u('C', 'definition', 80, 'anchor')];
      return [];
    });
    const { config } = makeConfig({ findSymbolUsages });
    const view = mount('== Section title\n\nbody\n', config);
    view.dispatch({ selection: { anchor: 5 } });
    view.dispatch({ changes: { from: 16, to: 16, insert: 'x' }, selection: { anchor: 17 } });
    await jest.advanceTimersByTimeAsync(2000);
    const heading = shown(view);
    expect(heading?.status).toBe('visible');
    expect(heading?.collision).toBe(true);
    view.destroy();
  });

  test('blocks apply when the new name collides with an existing same-kind symbol', async () => {
    const findSymbolUsages = jest.fn(async (_p: string, name: string) =>
      name === 'edition' ? [u('F', 'definition', 0), u('G', 'xref', 5)] : [u('H', 'definition', 0)],
    );
    const { config } = makeConfig({ findSymbolUsages });
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    const s = shown(view);
    expect(s?.status).toBe('visible');
    expect(s?.collision).toBe(true);
    view.destroy();
  });

  test('reverting the name to the original clears the suggestion', async () => {
    const { config } = makeConfig();
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.status).toBe('visible');
    view.dispatch({ changes: { from: 1, to: 8, insert: 'edition' }, selection: { anchor: 4 } });
    expect(shown(view)).toBeNull();
    view.destroy();
  });

  test('keeps the open offer and updates it in place when the author types on to a different name', async () => {
    // The offer reads `edition → release`; the author then types on to `releases`. Instead of
    // flashing the dialog closed, it stays open and its new name updates at once — so Apply can never
    // rewrite references to a name the definition no longer carries — and the project-wide lookup
    // re-runs to refresh the counts when the settle fires (feature 033).
    const { config } = makeConfig();
    const view = mount(':edition:\n', config);
    beginRename(view); // doc is now `:release:` with the offer pending
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.candidate.newName).toBe('release');
    expect(shown(view)?.revalidating).toBe(false);
    view.dispatch({ changes: { from: 8, to: 8, insert: 's' }, selection: { anchor: 9 } }); // `:releases:`
    expect(shown(view)?.candidate.newName).toBe('releases'); // dialog stays open, name updated in place
    expect(shown(view)?.revalidating).toBe(true); // collision not yet re-confirmed for the new name
    await jest.advanceTimersByTimeAsync(2000); // the re-run settle refreshes it
    expect(shown(view)?.status).toBe('visible');
    expect(shown(view)?.candidate.newName).toBe('releases');
    expect(shown(view)?.revalidating).toBe(false); // re-confirmed → Apply re-enabled
    view.destroy();
  });

  test('Apply is blocked while the offer is revalidating a freshly-typed name', async () => {
    const { config, renameSymbol } = makeConfig();
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    view.dispatch({ changes: { from: 8, to: 8, insert: 's' }, selection: { anchor: 9 } }); // `:releases:`
    expect(shown(view)?.revalidating).toBe(true);
    view.dispatch({ effects: applyRequestEffect.of(null) }); // click Apply mid-revalidation
    await flush();
    expect(renameSymbol).not.toHaveBeenCalled(); // the stale-collision window cannot fire a rename
    view.destroy();
  });

  test('losing edit rights hides an already-open offer', async () => {
    let canEdit = true;
    const { config } = makeConfig({ getCanEdit: () => canEdit });
    const view = mount(':edition:\n\nbody text here\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.status).toBe('visible');
    canEdit = false; // role downgraded while the offer is open
    view.dispatch({ selection: { anchor: 15 } }); // any change re-runs tracking
    await flush(); // the clear is dispatched from a microtask (never during the update)
    expect(shown(view)).toBeNull();
    view.destroy();
  });

  test('a downgrade after Apply keeps the Undo affordance (only live offers are hidden)', async () => {
    let canEdit = true;
    const { config, renameSymbol } = makeConfig({ getCanEdit: () => canEdit });
    const view = mount(':edition:\n\nbody text here\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    view.dispatch({ effects: applyRequestEffect.of(null) });
    await flush();
    expect(shown(view)?.status).toBe('applied');

    canEdit = false; // role downgraded after the rename was applied
    view.dispatch({ selection: { anchor: 15 } }); // re-runs tracking
    await flush();
    expect(shown(view)?.status).toBe('applied'); // Undo affordance preserved

    view.dispatch({ effects: undoRequestEffect.of(null) }); // ...but the undo WRITE is blocked
    await flush();
    expect(renameSymbol).toHaveBeenCalledTimes(1); // only the forward apply, no undo call
    view.destroy();
  });

  test('a failed collision lookup clears the revalidating offer instead of leaving it stuck', async () => {
    // findSymbolUsages resolves for the old name but rejects for the freshly-typed new name.
    const findSymbolUsages = jest.fn(async (_p: string, name: string): Promise<SymbolUsage[]> => {
      if (name === 'edition') return [u('F', 'definition', 0), u('G', 'xref', 5)];
      if (name === 'boom') throw new Error('rate limited');
      return [];
    });
    const { config } = makeConfig({ findSymbolUsages });
    const view = mount(':edition:\n', config);
    beginRename(view); // → :release:, offer pending
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.status).toBe('visible');
    view.dispatch({ changes: { from: 1, to: 8, insert: 'boom' }, selection: { anchor: 4 } }); // :boom:
    expect(shown(view)?.revalidating).toBe(true);
    await jest.advanceTimersByTimeAsync(2000); // settle → collision lookup rejects
    await flush();
    expect(shown(view)).toBeNull(); // cleared, not stuck disabled in 'checking…'
    view.destroy();
  });

  test('typing back to a dismissed name clears the revalidating offer (not stuck)', async () => {
    const { config } = makeConfig();
    const view = mount(':edition:\n', config);
    beginRename(view); // → :release:
    await jest.advanceTimersByTimeAsync(2000);
    view.dispatch({ effects: dismissRequestEffect.of(null) }); // dismiss 'release'
    await flush();
    expect(shown(view)).toBeNull();

    view.dispatch({ changes: { from: 1, to: 8, insert: 'other' }, selection: { anchor: 4 } }); // :other:
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.candidate.newName).toBe('other'); // a fresh, non-dismissed offer
    view.dispatch({ changes: { from: 1, to: 6, insert: 'release' }, selection: { anchor: 4 } }); // back to dismissed
    expect(shown(view)?.revalidating).toBe(true); // field keeps it open in-place first
    await flush(); // track sees the dismissed name and clears it via microtask
    expect(shown(view)).toBeNull();
    view.destroy();
  });

  test('typing on from a colliding name clears the stale collision immediately (no false warning)', async () => {
    const findSymbolUsages = jest.fn(async (_p: string, name: string): Promise<SymbolUsage[]> => {
      if (name === 'edition') return [u('F', 'definition', 0), u('G', 'xref', 5)];
      if (name === 'taken') return [u('H', 'definition', 0)]; // collides
      return [];
    });
    const { config } = makeConfig({ findSymbolUsages });
    const view = mount(':edition:\n', config);
    view.dispatch({ selection: { anchor: 4 } });
    view.dispatch({ changes: { from: 1, to: 8, insert: 'taken' }, selection: { anchor: 4 } }); // :taken:
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.collision).toBe(true); // 'taken' already exists
    view.dispatch({ changes: { from: 6, to: 6, insert: 'x' }, selection: { anchor: 7 } }); // :takenx:
    expect(shown(view)?.collision).toBe(false); // stale collision cleared at once, not carried over
    expect(shown(view)?.revalidating).toBe(true);
    view.destroy();
  });

  test('an offer whose definitionRange is past the document end does not crash the decoration', () => {
    const view = mount(':edition:\n', makeConfig().config);
    // Simulate an async offer captured before a deletion shrank the doc: an out-of-bounds range.
    expect(() =>
      view.dispatch({
        effects: setSuggestionEffect.of({
          candidate: { kind: 'attribute', oldName: 'edition', newName: 'release', definitionRange: { from: 9999, to: 10_006 } },
          usageCount: 2,
          fileCount: 1,
          status: 'visible',
          collision: false,
          revalidating: false,
        }),
      }),
    ).not.toThrow();
    view.destroy();
  });

  test('editing on after Apply does not overwrite the Undo affordance with a fresh offer', async () => {
    // find-usages returns hits for both the old and the applied new name, so the post-apply session's
    // lookup is NOT suppressed and would otherwise emit a fresh 'visible' offer over the applied one.
    const findSymbolUsages = jest.fn(async (_p: string, name: string): Promise<SymbolUsage[]> =>
      name === 'edition' || name === 'release'
        ? [u('F', 'definition', 0), u('G', 'xref', 5)]
        : [],
    );
    const { config } = makeConfig({ findSymbolUsages });
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    view.dispatch({ effects: applyRequestEffect.of(null) });
    await flush();
    expect(shown(view)?.status).toBe('applied');

    // Keep editing the just-renamed definition (`:release:` → `:release2:`).
    view.dispatch({ changes: { from: 8, to: 8, insert: '2' }, selection: { anchor: 9 } }); // new session
    view.dispatch({ changes: { from: 9, to: 9, insert: '2' }, selection: { anchor: 10 } }); // arms settle
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.status).toBe('applied'); // Undo affordance preserved, not clobbered
    view.destroy();
  });

  test('hides 5s after leaving the definition, but a return within the window keeps it', async () => {
    const { config } = makeConfig();
    const view = mount(':edition:\n\nbody text here\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.status).toBe('visible');

    view.dispatch({ selection: { anchor: 15 } }); // cursor onto the body line (off the definition)
    await jest.advanceTimersByTimeAsync(4000);
    expect(shown(view)?.status).toBe('visible'); // still within the 5s window
    view.dispatch({ selection: { anchor: 4 } }); // return to the definition → cancels disappearance
    await jest.advanceTimersByTimeAsync(5000);
    expect(shown(view)?.status).toBe('visible');

    view.dispatch({ selection: { anchor: 15 } }); // leave again
    await jest.advanceTimersByTimeAsync(5000);
    expect(shown(view)).toBeNull();
    view.destroy();
  });

  test('apply rewrites via the reused endpoint and undo reverses it', async () => {
    const { config, renameSymbol } = makeConfig();
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.status).toBe('visible');

    view.dispatch({ effects: applyRequestEffect.of(null) });
    await flush();
    expect(renameSymbol).toHaveBeenCalledWith('p1', {
      symbolKind: 'attribute',
      oldName: 'edition',
      newName: 'release',
      definitionAlreadyRenamed: true,
      renamedDefinitionIsSection: false,
    });
    expect(shown(view)?.status).toBe('applied');

    view.dispatch({ effects: undoRequestEffect.of(null) });
    await flush();
    expect(renameSymbol).toHaveBeenLastCalledWith('p1', { symbolKind: 'attribute', oldName: 'release', newName: 'edition' });
    expect(shown(view)).toBeNull();
    view.destroy();
  });

  test('applying a heading rename flags the definition as a section and offers no undo', async () => {
    const findSymbolUsages = jest.fn(async (_p: string, name: string): Promise<SymbolUsage[]> =>
      name === '_section_title' ? [u('F', 'definition', 0, 'section'), u('B', 'xref', 50)] : [],
    );
    const { config, renameSymbol } = makeConfig({ findSymbolUsages });
    const view = mount('== Section title\n\nbody\n', config);
    view.dispatch({ selection: { anchor: 5 } });
    view.dispatch({ changes: { from: 16, to: 16, insert: 'x' }, selection: { anchor: 17 } });
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.status).toBe('visible');

    view.dispatch({ effects: applyRequestEffect.of(null) });
    await flush();
    expect(renameSymbol).toHaveBeenCalledWith('p1', {
      symbolKind: 'anchor',
      oldName: '_section_title',
      newName: '_section_titlex',
      definitionAlreadyRenamed: true,
      renamedDefinitionIsSection: true,
    });
    expect(shown(view)?.status).toBe('applied');

    // Undo would leave references dangling (the tool never retyped the heading), so it is a no-op.
    view.dispatch({ effects: undoRequestEffect.of(null) });
    await flush();
    expect(renameSymbol).toHaveBeenCalledTimes(1); // no reverse rename issued
    view.destroy();
  });

  test('no suggestion for a read-only / observer editor (getCanEdit false)', async () => {
    const { config } = makeConfig({ getCanEdit: () => false });
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)).toBeNull();
    view.destroy();
  });

  test('a failed apply leaves the offer visible (not stranded) and never rejects', async () => {
    const renameSymbol = jest.fn(async () => {
      throw new Error('rate limited');
    });
    const { config } = makeConfig({ renameSymbol });
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.status).toBe('visible');
    view.dispatch({ effects: applyRequestEffect.of(null) });
    await flush();
    expect(renameSymbol).toHaveBeenCalled();
    expect(shown(view)?.status).toBe('visible'); // still offered for retry, not stuck in 'applied'
    view.destroy();
  });

  test('a content-changed refresh re-queries usages and updates the visible offer count', async () => {
    // A collaborator adds a reference to the old name live: the reported count must rise before Apply.
    let editionUsages: SymbolUsage[] = [u('F', 'definition', 0), u('G', 'xref', 5), u('G', 'xref', 20)];
    const findSymbolUsages = jest.fn(async (_p: string, name: string): Promise<SymbolUsage[]> =>
      name === 'edition' ? editionUsages : [],
    );
    const { config } = makeConfig({ findSymbolUsages, refreshMs: 100 });
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.usageCount).toBe(2); // two xrefs in G (the definition in F is excluded)

    // A collaborator live-adds another reference in a third file; a content-changed frame arrives.
    editionUsages = [...editionUsages, u('H', 'xref', 3)];
    const callsBefore = findSymbolUsages.mock.calls.length;
    view.dispatch({ effects: contentChangedRefreshEffect.of(null) });
    await jest.advanceTimersByTimeAsync(100);
    await flush();

    expect(findSymbolUsages.mock.calls.length).toBeGreaterThan(callsBefore); // re-queried
    expect(shown(view)?.usageCount).toBe(3); // count rose to include the collaborator's new reference
    view.destroy();
  });

  test('a content-changed refresh withdraws the offer when the last occurrence is removed', async () => {
    let editionUsages: SymbolUsage[] = [u('F', 'definition', 0), u('G', 'xref', 5)];
    const findSymbolUsages = jest.fn(async (_p: string, name: string): Promise<SymbolUsage[]> =>
      name === 'edition' ? editionUsages : [],
    );
    const { config } = makeConfig({ findSymbolUsages, refreshMs: 100 });
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.status).toBe('visible');

    // The only other occurrence is removed live → nothing left to rename → the offer is suppressed.
    editionUsages = [u('F', 'definition', 0)];
    view.dispatch({ effects: contentChangedRefreshEffect.of(null) });
    await jest.advanceTimersByTimeAsync(100);
    await flush();

    expect(shown(view)).toBeNull();
    view.destroy();
  });

  test('a content-changed refresh does not disturb an applied offer', async () => {
    const { config } = makeConfig({ refreshMs: 100 });
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    view.dispatch({ effects: applyRequestEffect.of(null) });
    await flush();
    expect(shown(view)?.status).toBe('applied');

    view.dispatch({ effects: contentChangedRefreshEffect.of(null) });
    await jest.advanceTimersByTimeAsync(100);
    await flush();

    expect(shown(view)?.status).toBe('applied'); // the Undo affordance is preserved
    view.destroy();
  });

  test('a burst of content-changed frames costs one re-query, not one per frame', async () => {
    // Every keystroke a collaborator makes sends a frame. Querying per frame would spend the
    // detection rate-limit budget on answers that are obsolete before they arrive.
    const { config, findSymbolUsages } = makeConfig({ refreshMs: 100 });
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    const callsBefore = findSymbolUsages.mock.calls.length;

    for (let index = 0; index < 3; index++) {
      view.dispatch({ effects: contentChangedRefreshEffect.of(null) });
      await jest.advanceTimersByTimeAsync(20); // well inside the debounce window
    }
    await jest.advanceTimersByTimeAsync(100);
    await flush();

    // One evaluate: the old name's usages plus the new name's collision check.
    expect(findSymbolUsages.mock.calls.length - callsBefore).toBe(2);
    view.destroy();
  });

  test('a refresh that lands after the offer is gone re-queries nothing', async () => {
    const { config, findSymbolUsages } = makeConfig({ refreshMs: 100 });
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);

    view.dispatch({ effects: contentChangedRefreshEffect.of(null) });
    view.dispatch({ effects: setSuggestionEffect.of(null) }); // the author dismissed it meanwhile
    const callsBefore = findSymbolUsages.mock.calls.length;
    await jest.advanceTimersByTimeAsync(100);
    await flush();

    expect(findSymbolUsages.mock.calls.length).toBe(callsBefore);
    expect(shown(view)).toBeNull();
    view.destroy();
  });

  test('moving to a different definition drops the offer at once', async () => {
    // The offer is anchored to one definition line. Left on screen while the cursor sits on another
    // definition, Apply would rewrite a symbol the author is no longer looking at.
    const { config } = makeConfig();
    const view = mount(':edition:\n:colour:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.status).toBe('visible');

    view.dispatch({ selection: { anchor: 13 } }); // inside `:colour:` on the second line
    expect(shown(view)).toBeNull();
    view.destroy();
  });

  test('offers nothing until the project and file are known', async () => {
    // The extension is mounted with the editor, which can be ahead of the ids it needs; a lookup with
    // no project id would search nothing and report a confident "no usages".
    const { config, findSymbolUsages } = makeConfig({ getProjectId: () => undefined });
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    await flush();

    expect(shown(view)).toBeNull();
    expect(findSymbolUsages).not.toHaveBeenCalled();
    view.destroy();
  });

  test('a failed usage lookup leaves no offer stuck, and the next edit tries again', async () => {
    // Rate limit or network: the lookup cannot confirm the rename is worth offering, so nothing is
    // shown — but detection must re-arm, or one failure would end suggestions for the session.
    let failing = true;
    const findSymbolUsages = jest.fn(async (_p: string, name: string): Promise<SymbolUsage[]> => {
      if (failing) throw new Error('rate limited');
      return name === 'edition' ? [u('F', 'definition', 0), u('G', 'xref', 5), u('G', 'xref', 20)] : [];
    });
    const { config } = makeConfig({ findSymbolUsages });
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    await flush();
    expect(shown(view)).toBeNull();

    failing = false;
    view.dispatch({ changes: { from: 8, to: 8, insert: 's' }, selection: { anchor: 9 } });
    await jest.advanceTimersByTimeAsync(2000);
    await flush();
    expect(shown(view)?.status).toBe('visible');
    view.destroy();
  });
});

describe('applying an offer the editor has moved on from', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    document.body.innerHTML = '';
  });

  /** An offer over `:edition:` proposing `release`, installed without going through detection. */
  const OFFER = {
    candidate: {
      kind: 'attribute' as const,
      oldName: 'edition',
      newName: 'release',
      definitionRange: { from: 0, to: 9 },
    },
    usageCount: 2,
    fileCount: 1,
    status: 'visible' as const,
    collision: false,
    revalidating: false,
  };

  /** Mounts `:edition:` with the caret on the definition and the offer above already open. */
  function mountWithOffer(config: RenameSuggestionConfig): EditorView {
    const view = mount(':edition:\n', config);
    view.dispatch({ selection: { anchor: 4 } });
    view.dispatch({ effects: setSuggestionEffect.of(OFFER) });
    return view;
  }

  test('drops the offer instead of rewriting when the definition no longer reads the new name', async () => {
    // The author reverted or re-edited the definition after the offer appeared. Applying now would
    // rewrite every reference to a name no definition carries — a project-wide dangling reference.
    const { config, renameSymbol } = makeConfig();
    const view = mountWithOffer(config);

    view.dispatch({ effects: applyRequestEffect.of(null) });
    await flush();

    expect(renameSymbol).not.toHaveBeenCalled();
    expect(shown(view)).toBeNull();
    view.destroy();
  });

  test('refuses to write once edit rights are gone, leaving the offer alone', async () => {
    let canEdit = true;
    const { config, renameSymbol } = makeConfig({ getCanEdit: () => canEdit });
    const view = mountWithOffer(config);

    canEdit = false; // downgraded to observer between the offer appearing and the click
    view.dispatch({ effects: applyRequestEffect.of(null) });
    await flush();

    expect(renameSymbol).not.toHaveBeenCalled();
    view.destroy();
  });

  test('refuses to write when the project id is no longer known', async () => {
    let projectId: string | undefined = 'p1';
    const { config, renameSymbol } = makeConfig({ getProjectId: () => projectId });
    const view = mountWithOffer(config);

    projectId = undefined; // the project unloaded underneath the open editor
    view.dispatch({ effects: applyRequestEffect.of(null) });
    await flush();

    expect(renameSymbol).not.toHaveBeenCalled();
    view.destroy();
  });

  test('an editor torn down mid-rename never touches the destroyed view', async () => {
    // The rewrite is a network round trip; the author can close the file inside it. Dispatching the
    // applied state onto a destroyed view would throw out of a promise nothing is awaiting.
    let settle: (() => void) | undefined;
    const renameSymbol = jest.fn(
      () =>
        new Promise<RenameSymbolResult>((resolve) => {
          settle = () => resolve({ rewrittenFiles: 1, updatedReferences: 2, warnings: [] });
        }),
    );
    const { config } = makeConfig({ renameSymbol });
    const view = mount(':edition:\n', config);
    beginRename(view);
    await jest.advanceTimersByTimeAsync(2000);
    expect(shown(view)?.status).toBe('visible');

    view.dispatch({ effects: applyRequestEffect.of(null) });
    await flush();
    expect(renameSymbol).toHaveBeenCalled();

    view.destroy();
    settle?.();
    await expect(flush()).resolves.toBeUndefined();
  });
});
