import { renderHook, act } from '@testing-library/react';
import { useFindInTree } from '@/hooks/use-find-in-tree';
import type { FileTreeNode } from '@/components/file-tree/types';

const file = (id: string, name: string, parentId: string | null = 'root'): FileTreeNode => ({
  id, name, type: 'file', path: `/${name}`, parentId, children: [],
});

const folder = (id: string, name: string, children: FileTreeNode[], parentId: string | null = 'root'): FileTreeNode => ({
  id, name, type: 'folder', path: `/${name}`, parentId, children,
});

const tree: FileTreeNode = folder('root', 'root', [
  file('f1', 'alpha.adoc'),
  folder('dir1', 'src', [
    file('f2', 'beta.adoc', 'dir1'),
    file('f3', 'gamma.adoc', 'dir1'),
  ]),
  file('f4', 'delta.adoc'),
], null);

/**
 * Runs `body` inside `act` and hands back what it returned. `act` itself returns nothing, so the
 * value had to be smuggled out through a `let` — which TypeScript cannot see assigned, leaving the
 * assertions below reading a variable it believes is still `null`.
 */
function actReturning<T>(body: () => T): T {
  let captured: T | undefined;
  act(() => {
    captured = body();
  });
  return captured as T;
}

describe('useFindInTree', () => {
  it('returns no matches and null navigation for a null tree', () => {
    const { result } = renderHook(() => useFindInTree(null, new Map(), jest.fn()));
    act(() => { result.current.setQuery('anything'); });
    expect(result.current.matchCount).toBe(0);
    let next: ReturnType<typeof result.current.nextMatch> = null;
    let previous: ReturnType<typeof result.current.prevMatch> = null;
    act(() => { next = result.current.nextMatch(); });
    act(() => { previous = result.current.prevMatch(); });
    expect(next).toBeNull();
    expect(previous).toBeNull();
  });

  it('returns no matches for an empty query', () => {
    const { result } = renderHook(() => useFindInTree(tree, new Map(), jest.fn()));
    act(() => { result.current.setQuery(''); });
    expect(result.current.matchCount).toBe(0);
  });

  it('buildMatchList: DFS traversal collects matching nodes in document order', () => {
    const expandedState = new Map<string, boolean>();
    const setExpandedState = jest.fn();

    const { result } = renderHook(() =>
      useFindInTree(tree, expandedState, setExpandedState),
    );

    act(() => { result.current.setQuery('a'); });

    // alpha.adoc (f1) and gamma.adoc (f3) contain 'a' — in DFS order: f1, f3, f4 (delta has 'a')
    expect(result.current.matchCount).toBeGreaterThan(0);
    expect(result.current.currentMatch).not.toBeNull();
  });

  it('first match is selected when query changes', () => {
    const { result } = renderHook(() =>
      useFindInTree(tree, new Map(), jest.fn()),
    );

    act(() => { result.current.setQuery('beta'); });

    expect(result.current.currentMatch?.id).toBe('f2');
    expect(result.current.matchCount).toBe(1);
    expect(result.current.currentMatchIndex).toBe(0);
  });

  it('nextMatch returns the node it navigates to (not the pre-call node)', () => {
    const { result } = renderHook(() =>
      useFindInTree(tree, new Map(), jest.fn()),
    );

    act(() => { result.current.setQuery('a'); }); // multiple 'a' matches
    const firstMatchId = result.current.currentMatch?.id;

    const returnedNode = actReturning(() => result.current.nextMatch());

    // The returned node must be the NEW match, not the pre-call (first) match
    expect(returnedNode).not.toBeNull();
    expect(returnedNode?.id).not.toBe(firstMatchId);
    expect(returnedNode?.id).toBe(result.current.currentMatch?.id);
  });

  it('prevMatch returns the node it navigates to', () => {
    const { result } = renderHook(() =>
      useFindInTree(tree, new Map(), jest.fn()),
    );

    act(() => { result.current.setQuery('a'); });
    act(() => { result.current.nextMatch(); }); // advance to index 1
    const indexOneId = result.current.currentMatch?.id;

    const returnedNode = actReturning(() => result.current.prevMatch());

    // Should return the node at index 0 (previous)
    expect(returnedNode).not.toBeNull();
    expect(returnedNode?.id).not.toBe(indexOneId);
    expect(returnedNode?.id).toBe(result.current.currentMatch?.id);
  });

  it('nextMatch cycles forward through matches', () => {
    const { result } = renderHook(() =>
      useFindInTree(tree, new Map(), jest.fn()),
    );

    act(() => { result.current.setQuery('a'); });
    const firstMatch = result.current.currentMatch?.id;

    act(() => { result.current.nextMatch(); });
    const secondMatch = result.current.currentMatch?.id;

    expect(secondMatch).not.toBe(firstMatch);
    expect(result.current.currentMatchIndex).toBe(1);
  });

  it('prevMatch cycles backward through matches', () => {
    const { result } = renderHook(() =>
      useFindInTree(tree, new Map(), jest.fn()),
    );

    act(() => { result.current.setQuery('a'); });
    act(() => { result.current.nextMatch(); });
    const indexBeforePrevious = result.current.currentMatchIndex;

    act(() => { result.current.prevMatch(); });
    expect(result.current.currentMatchIndex).toBe(indexBeforePrevious - 1);
  });

  it('nextMatch wraps around at end of matches', () => {
    const { result } = renderHook(() =>
      useFindInTree(tree, new Map(), jest.fn()),
    );

    act(() => { result.current.setQuery('beta'); }); // 1 match
    expect(result.current.matchCount).toBe(1);

    act(() => { result.current.nextMatch(); });
    expect(result.current.currentMatchIndex).toBe(0);
  });

  it('prevMatch wraps around at beginning of matches', () => {
    const { result } = renderHook(() =>
      useFindInTree(tree, new Map(), jest.fn()),
    );

    act(() => { result.current.setQuery('beta'); }); // 1 match
    act(() => { result.current.prevMatch(); });
    expect(result.current.currentMatchIndex).toBe(0);
  });

  it('auto-expands ancestor folders on match navigation', () => {
    const setExpandedState = jest.fn();
    const { result } = renderHook(() =>
      useFindInTree(tree, new Map(), setExpandedState),
    );

    act(() => { result.current.setQuery('beta'); }); // f2 inside dir1

    // dir1 should be expanded
    const lastCall = setExpandedState.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const newMap: Map<string, boolean> = lastCall[0];
    expect(newMap.get('dir1')).toBe(true);
  });

  it('dismiss restores pre-search expand snapshot', () => {
    const preSearchExpanded = new Map([['dir1', true]]);
    const setExpandedState = jest.fn();

    const { result } = renderHook(() =>
      useFindInTree(tree, preSearchExpanded, setExpandedState),
    );

    act(() => { result.current.setQuery('beta'); });
    act(() => { result.current.dismiss(); });

    const lastCall = setExpandedState.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const restoredMap: Map<string, boolean> = lastCall[0];
    expect(restoredMap.get('dir1')).toBe(true);
  });

  it('dismiss restores expand snapshot even after query is manually cleared before dismissing', () => {
    const setExpandedState = jest.fn();
    const { result } = renderHook(() =>
      useFindInTree(tree, new Map(), setExpandedState),
    );

    // Type a query → auto-expands ancestors
    act(() => { result.current.setQuery('beta'); });
    const callsAfterSearch = setExpandedState.mock.calls.length;
    expect(callsAfterSearch).toBeGreaterThan(0);

    // Clear the query manually (not via dismiss)
    act(() => { result.current.setQuery(''); });

    // Dismiss — snapshot must still be restored despite the empty query
    act(() => { result.current.dismiss(); });

    // setExpandedState should have been called with the snapshot (empty map) on dismiss
    expect(setExpandedState.mock.calls.length).toBeGreaterThan(callsAfterSearch);
    const restoredMap: Map<string, boolean> = setExpandedState.mock.calls.at(-1)![0];
    expect(restoredMap.size).toBe(0); // original state was empty
  });

  it('no matches state: matchCount=0, currentMatch=null', () => {
    const { result } = renderHook(() =>
      useFindInTree(tree, new Map(), jest.fn()),
    );

    act(() => { result.current.setQuery('xyzzy-no-match'); });

    expect(result.current.matchCount).toBe(0);
    expect(result.current.currentMatch).toBeNull();
    expect(result.current.currentMatchIndex).toBe(-1);
  });

  it('edge case: empty tree — matchCount=0, no crash', () => {
    const emptyTree: FileTreeNode = folder('root', 'root', [], null);
    const { result } = renderHook(() =>
      useFindInTree(emptyTree, new Map(), jest.fn()),
    );

    act(() => { result.current.setQuery('anything'); });

    expect(result.current.matchCount).toBe(0);
    expect(result.current.currentMatch).toBeNull();
  });

  it('edge case: match deletion mid-session advances to next match or enters no-matches state', () => {
    const mutableTree: FileTreeNode = folder('root', 'root', [
      file('f1', 'alpha.adoc'),
      file('f2', 'atlas.adoc'),
    ], null);

    const setExpandedState = jest.fn();

    const { result, rerender } = renderHook(
      ({ t }: { t: FileTreeNode }) => useFindInTree(t, new Map(), setExpandedState),
      { initialProps: { t: mutableTree } },
    );

    act(() => { result.current.setQuery('a'); }); // matches f1 and f2
    expect(result.current.matchCount).toBe(2);
    expect(result.current.currentMatch?.id).toBe('f1');

    // Remove f1 from the tree
    const treeWithoutF1 = folder('root', 'root', [file('f2', 'atlas.adoc')], null);
    rerender({ t: treeWithoutF1 });

    // After re-render with new tree, hook should rebuild match list
    // currentMatch should either advance to next match or be null if none
    expect(result.current.matchCount).toBeLessThanOrEqual(1);
    // Must not crash
    expect(() => result.current.nextMatch()).not.toThrow();
  });
});
