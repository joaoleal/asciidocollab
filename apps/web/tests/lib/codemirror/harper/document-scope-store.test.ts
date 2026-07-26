import {
  getDocumentScopeSnapshot,
  resetDocumentScope,
  setDocumentScope,
  subscribeDocumentScope,
} from '@/lib/codemirror/harper/document-scope-store';
import type { IncludedFileIssue } from '@/lib/codemirror/harper/included-file-lint';

const issue: IncludedFileIssue = {
  fileId: 'id:chapters/intro.adoc',
  path: 'chapters/intro.adoc',
  line: 5,
  category: 'spelling',
  message: '“wrold” may be misspelled',
};

describe('document scope store', () => {
  afterEach(() => {
    resetDocumentScope();
  });

  test('rests inactive with nothing to report', () => {
    expect(getDocumentScopeSnapshot()).toEqual({
      state: 'inactive',
      fileCount: 0,
      issues: [],
      reveal: null,
    });
  });

  test('publishes a snapshot to every subscriber', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeDocumentScope(() => seen.push(getDocumentScopeSnapshot().state));

    setDocumentScope({ state: 'scanning', fileCount: 2, issues: [], reveal: null });
    setDocumentScope({ state: 'checked', fileCount: 2, issues: [issue], reveal: null });

    expect(seen).toEqual(['scanning', 'checked']);
    expect(getDocumentScopeSnapshot().issues).toEqual([issue]);
    unsubscribe();
  });

  test('stops notifying an unsubscribed listener', () => {
    let calls = 0;
    const unsubscribe = subscribeDocumentScope(() => {
      calls += 1;
    });
    unsubscribe();

    setDocumentScope({ state: 'alone', fileCount: 0, issues: [], reveal: null });

    expect(calls).toBe(0);
  });

  test('returns the same snapshot object until something is published', () => {
    const first = getDocumentScopeSnapshot();
    expect(getDocumentScopeSnapshot()).toBe(first);

    setDocumentScope({ state: 'checked', fileCount: 1, issues: [issue], reveal: null });
    expect(getDocumentScopeSnapshot()).not.toBe(first);
  });

  test('resetting is a no-op once already at rest, so it cannot churn subscribers', () => {
    let calls = 0;
    const unsubscribe = subscribeDocumentScope(() => {
      calls += 1;
    });

    setDocumentScope({ state: 'checked', fileCount: 1, issues: [issue], reveal: null });
    resetDocumentScope();
    resetDocumentScope();

    expect(calls).toBe(2);
    expect(getDocumentScopeSnapshot().state).toBe('inactive');
    unsubscribe();
  });
});
