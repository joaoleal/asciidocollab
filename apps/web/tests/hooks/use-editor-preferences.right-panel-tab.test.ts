/* @jest-environment jsdom */
/**
 * Persistence tests for the `rightPanelTab` client-only preference (which view the editor's right
 * panel shows): it round-trips through localStorage, defaults to Comments, rejects an unrecognised
 * stored value, and never leaks into an account PUT (Constitution VII). Mirrors the comments-panel
 * preference tests, which cover the sibling client-only key.
 */
import { renderHook, act } from '@testing-library/react';
import { useEditorPreferences } from '@/hooks/use-editor-preferences';

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

const mockLocalStorage = {
  store: {} as Record<string, string>,
  getItem: jest.fn((key: string) => mockLocalStorage.store[key] ?? null),
  setItem: jest.fn((key: string, value: string) => { mockLocalStorage.store[key] = value; }),
  removeItem: jest.fn((key: string) => { delete mockLocalStorage.store[key]; }),
  clear: jest.fn(() => { mockLocalStorage.store = {}; }),
};
Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true });

beforeEach(() => {
  jest.useFakeTimers();
  mockFetch.mockReset();
  mockLocalStorage.clear();
  mockFetch.mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  jest.useRealTimers();
});

test('defaults to the Comments view on fresh storage', () => {
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.rightPanelTab).toBe('comments');
});

test('persistence round-trip: setRightPanelTab is read back by a new hook instance', () => {
  const { result: first } = renderHook(() => useEditorPreferences());
  act(() => first.current.setRightPanelTab('writing'));
  expect(first.current.rightPanelTab).toBe('writing');

  const { result: second } = renderHook(() => useEditorPreferences());
  expect(second.current.rightPanelTab).toBe('writing');
});

test('falls back to the default when storage holds an unrecognised view', () => {
  mockLocalStorage.store['asciidocollab:editor-preferences'] = JSON.stringify({ rightPanelTab: 'nope' });
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.rightPanelTab).toBe('comments');
});

test('no account PUT ever carries rightPanelTab (client-only guarantee)', async () => {
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

  const { result } = renderHook(() => useEditorPreferences());
  act(() => result.current.setRightPanelTab('writing'));
  // Trigger a PUT by changing a server-synced preference.
  act(() => result.current.setFontSize(16));

  await act(async () => {
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });

  const putCalls = mockFetch.mock.calls.filter(
    (c: unknown[]) => (c[1] as { method?: string })?.method === 'PUT',
  );
  expect(putCalls.length).toBeGreaterThan(0);
  for (const putCall of putCalls) {
    const body = JSON.parse((putCall[1] as { body: string }).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('rightPanelTab');
  }
});
