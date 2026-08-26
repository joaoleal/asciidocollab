import type React from 'react';
import { StrictMode } from 'react';
import { render, renderHook, act, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useEditorPreferences, isEditorThemeValue, isPreviewStyleValue } from '@/hooks/use-editor-preferences';

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

/**
 * The slice of `Storage` these specs drive. Named so the double's `getItem` can refer back to its own
 * `store` — an unannotated object literal that references itself is inferred as `any`.
 */
interface MockStorage {
  store: Record<string, string>;
  getItem: jest.Mock<string | null, [key: string]>;
  setItem: jest.Mock<void, [key: string, value: string]>;
  removeItem: jest.Mock<void, [key: string]>;
  clear: jest.Mock<void, []>;
}

const mockLocalStorage: MockStorage = {
  store: {} as Record<string, string>,
  getItem: jest.fn((key: string) => mockLocalStorage.store[key] ?? null),
  setItem: jest.fn((key: string, value: string) => { mockLocalStorage.store[key] = value; }),
  removeItem: jest.fn((key: string) => { delete mockLocalStorage.store[key]; }),
  clear: jest.fn(() => { mockLocalStorage.store = {}; }),
};
Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true });

const LS_KEY = 'asciidocollab:editor-preferences';

beforeEach(() => {
  jest.useFakeTimers();
  mockFetch.mockReset();
  mockLocalStorage.clear();
  // A page session of this tab's own: the record of what the account has not been told (see
  // `readUnsaved`) lives in sessionStorage and outlives a mount on purpose, so each test has to start
  // from a tab that owes nothing rather than from whatever the test before it left armed.
  sessionStorage.clear();
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ fontSize: 14, theme: 'default' }),
  });
});

afterEach(() => {
  jest.useRealTimers();
});

test('uses default prefs when localStorage is empty', () => {
  // No data set in localStorage
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.fontSize).toBe(14);
  expect(result.current.theme).toBe('default');
});

test('uses default prefs when localStorage contains invalid JSON', () => {
  mockLocalStorage.store['asciidocollab:editor-preferences'] = 'not-json!!!';
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.fontSize).toBe(14);
});

test('uses default prefs when localStorage contains non-object value', () => {
  mockLocalStorage.store['asciidocollab:editor-preferences'] = JSON.stringify([1, 2, 3]);
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.fontSize).toBe(14);
});

test('falls back to default fontSize when stored value has wrong type', () => {
  mockLocalStorage.store['asciidocollab:editor-preferences'] = JSON.stringify({ fontSize: 'big', theme: 'default' });
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.fontSize).toBe(14);
});

test('falls back to default theme when stored theme is invalid', () => {
  mockLocalStorage.store['asciidocollab:editor-preferences'] = JSON.stringify({ fontSize: 18, theme: 'not-a-theme' });
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.theme).toBe('default');
  expect(result.current.fontSize).toBe(18); // valid fontSize still used
});

test('applies localStorage value immediately on mount before API response', () => {
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 20, theme: 'high-contrast' });

  const { result } = renderHook(() => useEditorPreferences());
  // Immediately (before async API): localStorage value applied
  expect(result.current.fontSize).toBe(20);
  expect(result.current.theme).toBe('high-contrast');
});

test('overwrites with API response when received', async () => {
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 20, theme: 'high-contrast' });
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ fontSize: 14, theme: 'default' }),
  });

  const { result } = renderHook(() => useEditorPreferences());

  // Wait until state converges to API-authoritative values
  await waitFor(() => {
    expect(result.current.fontSize).toBe(14);
    expect(result.current.theme).toBe('default');
  });
});

test('PUT is debounced 500ms after a preference change', async () => {
  const { result } = renderHook(() => useEditorPreferences());

  act(() => result.current.setFontSize(18));
  expect(mockFetch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'PUT' }));

  await act(async () => {
    jest.advanceTimersByTime(500);
    await Promise.resolve();
  });

  expect(mockFetch).toHaveBeenCalledWith(
    expect.stringContaining('/auth/me/editor-preferences'),
    expect.objectContaining({ method: 'PUT' }),
  );
});

// Issue C7: rapid preference changes must coalesce into ONE PUT, not fire many
test('rapid setFontSize calls coalesce into a single debounced PUT', async () => {
  const { result } = renderHook(() => useEditorPreferences());

  // Fire many rapid changes (simulating slider drag)
  act(() => {
    result.current.setFontSize(10);
    result.current.setFontSize(12);
    result.current.setFontSize(14);
    result.current.setFontSize(16);
  });

  await act(async () => {
    jest.advanceTimersByTime(500);
    await Promise.resolve();
  });

  // Only ONE PUT must have been sent, not four
  const putCalls = mockFetch.mock.calls.filter(
    ([, options]: [unknown, { method?: string }]) => options?.method === 'PUT',
  );
  expect(putCalls).toHaveLength(1);
  // And it must carry the final value
  expect(putCalls[0][1].body).toContain('"fontSize":16');
});

test('localStorage is updated immediately on change before PUT completes', () => {
  const { result } = renderHook(() => useEditorPreferences());
  act(() => result.current.setFontSize(22));
  expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
    LS_KEY,
    expect.stringContaining('"fontSize":22'),
  );
});

test('setTheme updates local state and persists to localStorage', async () => {
  const { result } = renderHook(() => useEditorPreferences());

  act(() => result.current.setTheme('dracula'));

  expect(result.current.theme).toBe('dracula');
  expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
    LS_KEY,
    expect.stringContaining('"theme":"dracula"'),
  );
});

test('fetches prefs from correct URL including http://localhost:4000', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  const url = String(mockFetch.mock.calls[0][0]);
  expect(url).toContain('http://localhost:4000');
  expect(url).toContain('/auth/me/editor-preferences');
  void result;
});

test('PUT is sent to correct URL including http://localhost:4000', async () => {
  const { result } = renderHook(() => useEditorPreferences());

  act(() => result.current.setFontSize(20));

  await act(async () => {
    jest.advanceTimersByTime(500);
    await Promise.resolve();
  });

  const putCall = mockFetch.mock.calls.find(
    ([, options]: [unknown, { method?: string }]) => options?.method === 'PUT',
  );
  expect(putCall).toBeDefined();
  expect(String(putCall[0])).toContain('http://localhost:4000');
  expect(String(putCall[0])).toContain('/auth/me/editor-preferences');
});

test('PUT sends credentials include and Content-Type application/json', async () => {
  const { result } = renderHook(() => useEditorPreferences());

  act(() => result.current.setFontSize(20));

  await act(async () => {
    jest.advanceTimersByTime(500);
    await Promise.resolve();
  });

  const putCall = mockFetch.mock.calls.find(
    ([, options]: [unknown, { method?: string }]) => options?.method === 'PUT',
  );
  expect(putCall[1].credentials).toBe('include');
  expect(putCall[1].headers['Content-Type']).toBe('application/json');
});

test('falls back to localStorage prefs when GET returns non-ok', async () => {
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 22, theme: 'dracula' });
  mockFetch.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });

  const { result } = renderHook(() => useEditorPreferences());

  // Should keep localStorage values on API error
  await act(async () => { await Promise.resolve(); });
  expect(result.current.fontSize).toBe(22);
  expect(result.current.theme).toBe('dracula');
});

// ── L74: non-ok GET must NOT overwrite state (response.ok=false → reject → catch → no update) ──

test('GET returning non-ok does NOT update fontSize from API response (localStorage value preserved)', async () => {
  // Store different prefs than the API would return so we can detect if API was applied
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 22, theme: 'dracula' });
  // API returns ok=false but with json body that has different values — should be rejected
  mockFetch.mockResolvedValue({
    ok: false,
    json: () => Promise.resolve({ fontSize: 11, theme: 'default' }),
  });

  const { result } = renderHook(() => useEditorPreferences());

  // Flush 3 microtask levels: fetch → .then(ok?) → .then(setState) / .catch()
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  // With L74 mutation (always ok → json called → prefs set to {11, default}),
  // fontSize would become 11. Original code rejects and keeps 22.
  expect(result.current.fontSize).toBe(22);
  expect(result.current.theme).toBe('dracula');
});

test('isStoredPrefs returns false for null (not an object in the sense of the guard)', async () => {
  mockLocalStorage.store[LS_KEY] = JSON.stringify(null);
  const { result } = renderHook(() => useEditorPreferences());
  // null is filtered, so defaults are used
  expect(result.current.fontSize).toBe(14);
});

test('isStoredPrefs returns false for a primitive number', async () => {
  mockLocalStorage.store[LS_KEY] = JSON.stringify(42);
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.fontSize).toBe(14);
});

// ── isEditorThemeValue: validates all valid theme strings (kills L7, L10, L11) ──

test('isEditorThemeValue returns true for all valid themes', () => {
  expect(isEditorThemeValue('default')).toBe(true);
  expect(isEditorThemeValue('high-contrast')).toBe(true);
  expect(isEditorThemeValue('dracula')).toBe(true);
  expect(isEditorThemeValue('tomorrow')).toBe(true);
  expect(isEditorThemeValue('espresso')).toBe(true);
});

test('isEditorThemeValue returns false for an unknown theme', () => {
  expect(isEditorThemeValue('unknown-theme')).toBe(false);
  expect(isEditorThemeValue('')).toBe(false);
});

// ── GET fetch includes credentials (kills L67 ObjectLiteral) ────────────────────

test('GET fetch for prefs includes credentials: include', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  const getCall = mockFetch.mock.calls[0];
  expect(getCall[1]).toMatchObject({ credentials: 'include' });
  void result;
});

// ── GET fetch URL must contain the auth path (kills L67 StringLiteral) ──────────

test('GET fetch URL contains /auth/me/editor-preferences', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  const url = String(mockFetch.mock.calls[0][0]);
  expect(url).toContain('/auth/me/editor-preferences');
  void result;
});

test('theme falls back to default when stored theme string is not a recognized theme value', () => {
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 14, theme: 'INVALID-THEME' });
  // Use a never-resolving fetch so the API response never overwrites the localStorage-derived state
  mockFetch.mockReturnValue(new Promise(() => {}));
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.theme).toBe('default');
});

// ── softWrap ──────────────────────────────────────────────────────────────────

test('softWrap defaults to true', () => {
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.softWrap).toBe(true);
});

test('softWrap included in initial GET response', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ fontSize: 14, theme: 'default', softWrap: false }),
  });
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(result.current.softWrap).toBe(false));
});

test('setSoftWrap updates state and includes softWrap in PUT payload', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
  await act(async () => {
    result.current.setSoftWrap(false);
    jest.advanceTimersByTime(600);
  });
  await waitFor(() => expect(result.current.softWrap).toBe(false));
  const putCall = mockFetch.mock.calls.find((c: unknown[]) => {
    const options = c[1] as { method?: string };
    return options?.method === 'PUT';
  });
  expect(putCall).toBeDefined();
  if (putCall) {
    const body = JSON.parse((putCall[1] as { body: string }).body);
    expect(body).toHaveProperty('softWrap', false);
  }
});

// ── minimapEnabled (text preview) ───────────────────────────────────────────

test('minimapEnabled defaults to false', () => {
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.minimapEnabled).toBe(false);
});

test('minimapEnabled included in initial GET response', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ fontSize: 14, theme: 'default', minimapEnabled: true }),
  });
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(result.current.minimapEnabled).toBe(true));
});

test('setMinimapEnabled updates state and includes minimapEnabled in PUT payload', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
  await act(async () => {
    result.current.setMinimapEnabled(true);
    jest.advanceTimersByTime(600);
  });
  await waitFor(() => expect(result.current.minimapEnabled).toBe(true));
  const putCall = mockFetch.mock.calls.find((c: unknown[]) => {
    const options = c[1] as { method?: string };
    return options?.method === 'PUT';
  });
  expect(putCall).toBeDefined();
  if (putCall) {
    const body = JSON.parse((putCall[1] as { body: string }).body);
    expect(body).toHaveProperty('minimapEnabled', true);
  }
});

// ── privateCommitEmail (privacy-preserving commit email opt-in) ─────────────

test('privateCommitEmail defaults to false', () => {
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.privateCommitEmail).toBe(false);
});

test('privateCommitEmail included in initial GET response', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ fontSize: 14, theme: 'default', privateCommitEmail: true }),
  });
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(result.current.privateCommitEmail).toBe(true));
});

test('setPrivateCommitEmail updates state and includes privateCommitEmail in PUT payload', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
  await act(async () => {
    result.current.setPrivateCommitEmail(true);
    jest.advanceTimersByTime(600);
  });
  await waitFor(() => expect(result.current.privateCommitEmail).toBe(true));
  const putCall = mockFetch.mock.calls.find((c: unknown[]) => {
    const options = c[1] as { method?: string };
    return options?.method === 'PUT';
  });
  expect(putCall).toBeDefined();
  if (putCall) {
    const body = JSON.parse((putCall[1] as { body: string }).body);
    expect(body).toHaveProperty('privateCommitEmail', true);
  }
});

test('localStorage cache updated when softWrap changes', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
  await act(async () => {
    result.current.setSoftWrap(false);
  });
  const stored = JSON.parse(mockLocalStorage.store[LS_KEY] ?? '{}');
  expect(stored.softWrap).toBe(false);
});

test('loads valid scrollSync, softWrap, and theme from localStorage', () => {
  // Never-resolving fetch so the server response cannot overwrite localStorage state.
  mockFetch.mockReturnValue(new Promise(() => {}));
  mockLocalStorage.store[LS_KEY] = JSON.stringify({
    fontSize: 16, theme: 'default', scrollSyncEnabled: false, softWrap: false,
  });
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.fontSize).toBe(16);
  expect(result.current.theme).toBe('default');
  expect(result.current.scrollSyncEnabled).toBe(false);
  expect(result.current.softWrap).toBe(false);
});

test('ignores server response fields with the wrong types and keeps previous values', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ fontSize: 'big', theme: 123, scrollSyncEnabled: 'yes', softWrap: 'no' }),
  });
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  // All invalid → falls back to the defaults that were already in state.
  expect(result.current.fontSize).toBe(14);
  expect(result.current.theme).toBe('default');
  expect(typeof result.current.scrollSyncEnabled).toBe('boolean');
  expect(typeof result.current.softWrap).toBe('boolean');
});

// ── previewStyle ────────────────────────────────────────────────────

test('previewStyle defaults to asciidocollab', () => {
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.previewStyle).toBe('asciidocollab');
});

test('previewStyle is seeded from localStorage before the API responds (no flash)', () => {
  // Never-resolving fetch so the API cannot overwrite the localStorage-seeded value.
  mockFetch.mockReturnValue(new Promise(() => {}));
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 14, theme: 'default', previewStyle: 'asciidoctor' });
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.previewStyle).toBe('asciidoctor');
});

test('an invalid stored previewStyle falls back to the default', () => {
  mockFetch.mockReturnValue(new Promise(() => {}));
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 14, theme: 'default', previewStyle: 'Asciidocollab' });
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.previewStyle).toBe('asciidocollab');
});

test('previewStyle included in initial GET response', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ fontSize: 14, theme: 'default', previewStyle: 'asciidoctor' }),
  });
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(result.current.previewStyle).toBe('asciidoctor'));
});

test('setPreviewStyle updates state and includes previewStyle in the PUT payload', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
  await act(async () => {
    result.current.setPreviewStyle('asciidoctor');
    jest.advanceTimersByTime(600);
  });
  await waitFor(() => expect(result.current.previewStyle).toBe('asciidoctor'));
  const putCall = mockFetch.mock.calls.find((c: unknown[]) => (c[1] as { method?: string })?.method === 'PUT');
  expect(putCall).toBeDefined();
  if (putCall) {
    const body = JSON.parse((putCall[1] as { body: string }).body);
    expect(body).toHaveProperty('previewStyle', 'asciidoctor');
  }
});

test('setSpellcheckEnabled toggles the flag and persists it', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  await act(async () => {
    result.current.setSpellcheckEnabled(false);
  });
  await waitFor(() => expect(result.current.spellcheckEnabled).toBe(false));
  expect(JSON.parse(mockLocalStorage.store[LS_KEY] ?? '{}').spellcheckEnabled).toBe(false);
});

test('spellcheckEnabled is seeded from the GET response', async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ spellcheckEnabled: false }) });
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(result.current.spellcheckEnabled).toBe(false));
});

test('localStorage cache updated when previewStyle changes', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
  await act(async () => {
    result.current.setPreviewStyle('asciidoctor');
  });
  const stored = JSON.parse(mockLocalStorage.store[LS_KEY] ?? '{}');
  expect(stored.previewStyle).toBe('asciidoctor');
});

// Offline reconciliation: a transient save failure must not lose the choice; it
// applies for the session and rides the next successful save to the account.
test('previewStyle applies for the session and reconciles on the next successful save when a save fails', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());

  // First save fails transiently (offline).
  mockFetch.mockRejectedValueOnce(new Error('network down'));
  await act(async () => {
    result.current.setPreviewStyle('asciidoctor');
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });
  // Still applied locally for the current session.
  expect(result.current.previewStyle).toBe('asciidoctor');
  expect(JSON.parse(mockLocalStorage.store[LS_KEY] ?? '{}').previewStyle).toBe('asciidoctor');

  // A later change triggers a successful save that still carries the chosen style.
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
  await act(async () => {
    result.current.setFontSize(16);
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });
  const putCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === 'PUT');
  const lastPut = putCalls.at(-1);
  expect(lastPut).toBeDefined();
  if (lastPut) {
    expect(JSON.parse((lastPut[1] as { body: string }).body)).toHaveProperty('previewStyle', 'asciidoctor');
  }
});

test('isPreviewStyleValue validates the supported tokens', () => {
  expect(isPreviewStyleValue('asciidocollab')).toBe(true);
  expect(isPreviewStyleValue('asciidoctor')).toBe(true);
  expect(isPreviewStyleValue('Asciidocollab')).toBe(false);
  expect(isPreviewStyleValue('')).toBe(false);
});

// ── scrollSyncEnabled ───────────────────────────────────────────────────────────

test('setScrollSyncEnabled updates state and persists to localStorage', () => {
  const { result } = renderHook(() => useEditorPreferences());
  act(() => result.current.setScrollSyncEnabled(true));
  expect(result.current.scrollSyncEnabled).toBe(true);
  expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
    LS_KEY,
    expect.stringContaining('"scrollSyncEnabled":true'),
  );
});

test('setScrollSyncEnabled includes scrollSyncEnabled in the debounced PUT payload', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
  await act(async () => {
    result.current.setScrollSyncEnabled(true);
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });
  const putCall = mockFetch.mock.calls.find((c: unknown[]) => {
    const options = c[1] as { method?: string };
    return options?.method === 'PUT';
  });
  expect(putCall).toBeDefined();
  if (putCall) {
    const body = JSON.parse((putCall[1] as { body: string }).body);
    expect(body).toHaveProperty('scrollSyncEnabled', true);
  }
});

test('scrollSyncEnabled included in initial GET response', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ fontSize: 14, theme: 'default', scrollSyncEnabled: true }),
  });
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(result.current.scrollSyncEnabled).toBe(true));
});

// ── addSpellIgnore ──────────────────────────────────────────────────────────────

test('spellIgnore defaults to an empty array', () => {
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.spellIgnore).toEqual([]);
});

test('addSpellIgnore appends the word and persists to localStorage', () => {
  const { result } = renderHook(() => useEditorPreferences());
  act(() => result.current.addSpellIgnore('asciidoc'));
  expect(result.current.spellIgnore).toEqual(['asciidoc']);
  const stored = JSON.parse(mockLocalStorage.store[LS_KEY] ?? '{}');
  expect(stored.spellIgnore).toEqual(['asciidoc']);
});

test('addSpellIgnore is a no-op when the word is already present', () => {
  const { result } = renderHook(() => useEditorPreferences());
  act(() => result.current.addSpellIgnore('asciidoc'));
  mockLocalStorage.setItem.mockClear();
  act(() => result.current.addSpellIgnore('asciidoc'));
  // Still a single entry and no re-persist happened for the duplicate.
  expect(result.current.spellIgnore).toEqual(['asciidoc']);
  expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
});

test('addSpellIgnore keeps the word on this device and asks the account for nothing', async () => {
  // The list used to ride along in every save. The account endpoint does not carry it — it is in no
  // DTO, in no entity, and not in the PUT body schema, which declares `additionalProperties: false`,
  // so the server's validator strips it and the GET it was nominally synced with never answers with
  // it. What was left was the one unbounded field in a payload whose last-chance `pagehide` flush is
  // `keepalive`, and a `keepalive` body over 64 KB is rejected outright: a large enough personal
  // dictionary defeated the flush entirely, for bytes that were going to be discarded on arrival.
  //
  // `spellIgnore` then became a CLIENT_ONLY_KEY and the payload builder started stripping it, but
  // this setter went on asking for a save — so every word an author added spent a round trip to send
  // a body describing every OTHER preference and nothing of the word. There is nothing to send.
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  await act(async () => {
    result.current.addSpellIgnore('codeblock');
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });

  // The word is kept, and kept where it is actually read back from.
  expect(result.current.spellIgnore).toContain('codeblock');
  expect(JSON.parse(mockLocalStorage.store[LS_KEY]).spellIgnore).toContain('codeblock');

  // And no save was made at all — not one carrying the word, and not one carrying everything else.
  const putCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === 'PUT');
  expect(putCalls).toHaveLength(0);

  // Nor is one left armed for the page to flush on its way out.
  act(() => { globalThis.dispatchEvent(new Event('pagehide')); });
  expect(lastPutBody({ keepalive: true })).toBeUndefined();
});

test('the account payload has no field that can grow without bound', async () => {
  // What keeps the `pagehide` flush inside the 64 KB `keepalive` cap is that there is nothing in the
  // payload for an author to make big. Asserted as a property of the payload rather than as a size,
  // so a future preference that IS unbounded is caught here instead of on the day a request is
  // silently refused: every field must be a number, a boolean, or a token from a fixed set.
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  act(() => { for (let word = 0; word < 500; word++) result.current.addSpellIgnore(`word${word}`); });
  // A dictionary that large is only in the payload's way if a save happens while it is held, so the
  // save is provoked by a preference the account DOES carry — which is the only way one happens now.
  act(() => result.current.setFontSize(17));
  await act(async () => {
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });

  const putCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === 'PUT');
  expect(putCalls.length).toBeGreaterThan(0);
  const body = JSON.parse((putCalls.at(-1)![1] as { body: string }).body);
  for (const [name, value] of Object.entries(body)) {
    expect([name, typeof value]).toEqual([name, expect.stringMatching(/^(number|boolean|string)$/)]);
    // A string field is an enum token; nothing here is free text the author composes.
    if (typeof value === 'string') expect(value.length).toBeLessThan(32);
  }
  // 500 words are held locally and none of them reached the wire.
  expect(result.current.spellIgnore).toHaveLength(500);
  expect((putCalls.at(-1)![1] as { body: string }).body.length).toBeLessThan(512);
});

test('an account answer carrying a dictionary does not replace the one on this device', async () => {
  // `spellIgnore` is a CLIENT_ONLY_KEY: it is stripped from every save, the account has never held it,
  // and this browser's localStorage is its only store on either side of the wire. It was nonetheless
  // merged from the GET like an account-synced preference — safe only for as long as the DTO has no
  // such field, and a wipe of the author's personal dictionary on the day it grows one, because what
  // the account would answer with is the empty list it was never sent.
  mockLocalStorage.store[LS_KEY] = JSON.stringify({
    fontSize: 14, theme: 'default', spellIgnore: ['fromcache'],
  });
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ fontSize: 14, theme: 'default', spellIgnore: ['fromserver'] }),
  });
  const { result } = renderHook(() => useEditorPreferences());
  // Seeded immediately from localStorage.
  expect(result.current.spellIgnore).toEqual(['fromcache']);
  // And the answer, whatever it says about a field the account does not carry, leaves it alone.
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(result.current.spellIgnore).toEqual(['fromcache']);
});

test('GET response with a non-array spellIgnore keeps the previous list', async () => {
  mockLocalStorage.store[LS_KEY] = JSON.stringify({
    fontSize: 14, theme: 'default', spellIgnore: ['keepme'],
  });
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ fontSize: 14, theme: 'default', spellIgnore: 'not-an-array' }),
  });
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  expect(result.current.spellIgnore).toEqual(['keepme']);
});

test('a stored spellIgnore list drops non-string entries on load', () => {
  mockFetch.mockReturnValue(new Promise(() => {}));
  mockLocalStorage.store[LS_KEY] = JSON.stringify({
    fontSize: 14, theme: 'default', spellIgnore: ['ok', 7, null, 'fine'],
  });
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.spellIgnore).toEqual(['ok', 'fine']);
});

// ── leftPanelTab (028: client-only, localStorage, never synced to the account) ──

test('leftPanelTab defaults to files', () => {
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.leftPanelTab).toBe('files');
});

test('setLeftPanelTab round-trips through localStorage', async () => {
  mockFetch.mockReturnValue(new Promise(() => {}));
  const { result } = renderHook(() => useEditorPreferences());
  act(() => result.current.setLeftPanelTab('outline'));
  expect(result.current.leftPanelTab).toBe('outline');
  const stored = JSON.parse(mockLocalStorage.store[LS_KEY] ?? '{}');
  expect(stored.leftPanelTab).toBe('outline');
});

test('a stored outline leftPanelTab is seeded on load', () => {
  mockFetch.mockReturnValue(new Promise(() => {}));
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 14, theme: 'default', leftPanelTab: 'outline' });
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.leftPanelTab).toBe('outline');
});

test('an invalid stored leftPanelTab falls back to files', () => {
  mockFetch.mockReturnValue(new Promise(() => {}));
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 14, theme: 'default', leftPanelTab: 'banana' });
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.leftPanelTab).toBe('files');
});

test('leftPanelTab is NOT sent in any PUT body (client-only preference)', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  // Toggle the tab (must not be in any PUT) then change another pref so a PUT fires.
  act(() => result.current.setLeftPanelTab('outline'));
  act(() => result.current.setFontSize(18));
  await act(async () => {
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });
  const putCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === 'PUT');
  expect(putCalls.length).toBeGreaterThan(0);
  for (const putCall of putCalls) {
    const body = JSON.parse((putCall[1] as { body: string }).body);
    expect(body).not.toHaveProperty('leftPanelTab');
  }
});

test('setLeftPanelTab does not trigger any PUT on its own', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockClear();
  await act(async () => {
    result.current.setLeftPanelTab('outline');
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });
  const putCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === 'PUT');
  expect(putCalls).toHaveLength(0);
});

test('a GET response carrying leftPanelTab does not overwrite the local value', async () => {
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 14, theme: 'default', leftPanelTab: 'outline' });
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ fontSize: 14, theme: 'default', leftPanelTab: 'files' }),
  });
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(result.current.leftPanelTab).toBe('outline');
});

// ── showIncludedFiles (029: client-only, localStorage, never synced to the account) ──

test('showIncludedFiles defaults to false when localStorage is empty', () => {
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.showIncludedFiles).toBe(false);
});

test('setShowIncludedFiles(true) writes to localStorage', () => {
  mockFetch.mockReturnValue(new Promise(() => {}));
  const { result } = renderHook(() => useEditorPreferences());
  act(() => result.current.setShowIncludedFiles(true));
  expect(result.current.showIncludedFiles).toBe(true);
  const stored = JSON.parse(mockLocalStorage.store[LS_KEY] ?? '{}');
  expect(stored.showIncludedFiles).toBe(true);
});

test('showIncludedFiles is NOT sent in any PUT body (client-only preference)', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  // Toggle showIncludedFiles (must not be in any PUT) then change another pref so a PUT fires.
  act(() => result.current.setShowIncludedFiles(true));
  act(() => result.current.setFontSize(18));
  await act(async () => {
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });
  const putCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === 'PUT');
  expect(putCalls.length).toBeGreaterThan(0);
  for (const putCall of putCalls) {
    const body = JSON.parse((putCall[1] as { body: string }).body);
    expect(body).not.toHaveProperty('showIncludedFiles');
  }
});

test('a GET response that does not include showIncludedFiles keeps the local value', async () => {
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 14, theme: 'default', showIncludedFiles: true });
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ fontSize: 14, theme: 'default' }),
  });
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(result.current.showIncludedFiles).toBe(true);
});

test('showIncludedFiles round-trips a boolean true from localStorage', () => {
  mockFetch.mockReturnValue(new Promise(() => {}));
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 14, theme: 'default', showIncludedFiles: true });
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.showIncludedFiles).toBe(true);
});

// ── outlineScope (032: client-only, localStorage, never synced to the account) ──

test('outlineScope defaults to full', () => {
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.outlineScope).toBe('full');
});

test('setOutlineScope round-trips through localStorage', () => {
  mockFetch.mockReturnValue(new Promise(() => {}));
  const { result } = renderHook(() => useEditorPreferences());
  act(() => result.current.setOutlineScope('current'));
  expect(result.current.outlineScope).toBe('current');
  const stored = JSON.parse(mockLocalStorage.store[LS_KEY] ?? '{}');
  expect(stored.outlineScope).toBe('current');
});

test('a stored outlineScope is seeded on load', () => {
  mockFetch.mockReturnValue(new Promise(() => {}));
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 14, theme: 'default', outlineScope: 'current' });
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.outlineScope).toBe('current');
});

test('an invalid stored outlineScope falls back to full', () => {
  mockFetch.mockReturnValue(new Promise(() => {}));
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 14, theme: 'default', outlineScope: 'both' });
  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.outlineScope).toBe('full');
});

test('outlineScope is NOT sent in any PUT body (client-only preference)', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  act(() => result.current.setOutlineScope('current'));
  act(() => result.current.setFontSize(18));
  await act(async () => {
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });
  const putCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === 'PUT');
  expect(putCalls.length).toBeGreaterThan(0);
  for (const putCall of putCalls) {
    const body = JSON.parse((putCall[1] as { body: string }).body);
    expect(body).not.toHaveProperty('outlineScope');
  }
});

test('a GET response carrying outlineScope does not overwrite the local value', async () => {
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 14, theme: 'default', outlineScope: 'current' });
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ fontSize: 14, theme: 'default', outlineScope: 'full' }),
  });
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(result.current.outlineScope).toBe('current');
});

test('a page going away before the debounce elapses still sends the change', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockClear();
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

  // Change a preference and take the page away at once — no timer is advanced, so the debounced save
  // has not fired and never will: this is the reload/close that used to lose the change silently.
  act(() => result.current.setPreviewStyle('asciidoctor'));
  act(() => { globalThis.dispatchEvent(new Event('pagehide')); });

  const putCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === 'PUT');
  expect(putCalls.length).toBe(1);
  const request = putCalls[0][1] as { body: string; keepalive?: boolean };
  expect(JSON.parse(request.body).previewStyle).toBe('asciidoctor');
  // Without this the request is cancelled along with the document it was started from.
  expect(request.keepalive).toBe(true);
});

test('the flush does not repeat a save the debounce already sent', async () => {
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockClear();
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

  act(() => result.current.setFontSize(18));
  await act(async () => {
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });
  act(() => { globalThis.dispatchEvent(new Event('pagehide')); });

  const putCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === 'PUT');
  expect(putCalls.length).toBe(1);
});

test('a page going away while the debounced save is in flight still sends the change', async () => {
  // The window the flush did not cover. The debounce fires, the (non-`keepalive`) request leaves, and
  // the tab is closed twenty milliseconds later: the request dies with the document. The pending
  // payload had already been cleared — before the fetch was even started — so `pagehide` found
  // nothing to send, and the next load's account fetch wrote the stale server value back over
  // localStorage. That is the very loss the flush was added to prevent, through a narrower window.
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockClear();
  // A request that never answers is a request still in flight, which is the whole of the case.
  mockFetch.mockReturnValue(new Promise(() => {}));

  act(() => result.current.setFontSize(21));
  await act(async () => {
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });
  const beforeHide = mockFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === 'PUT');
  expect(beforeHide).toHaveLength(1);
  expect((beforeHide[0][1] as { keepalive?: boolean }).keepalive).toBeUndefined();

  act(() => { globalThis.dispatchEvent(new Event('pagehide')); });

  const putCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === 'PUT');
  expect(putCalls).toHaveLength(2);
  const request = putCalls[1][1] as { body: string; keepalive?: boolean };
  expect(JSON.parse(request.body).fontSize).toBe(21);
  // And in the only form that outlives the document.
  expect(request.keepalive).toBe(true);
});

test('a change made while a save is in flight is the one the flush takes with it', async () => {
  // The pending payload is cleared by identity rather than simply nulled. A response arriving after
  // a newer change had replaced the pending payload would otherwise clear the newer one — dropping
  // the change that has NOT been saved in order to record one that has.
  let settleFirst: ((value: unknown) => void) | null = null;
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockClear();
  mockFetch.mockReturnValueOnce(new Promise((resolve) => { settleFirst = resolve; }));

  act(() => result.current.setFontSize(21));
  await act(async () => {
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });

  // A second change, still inside the debounce, while the first request is unanswered.
  mockFetch.mockReturnValue(new Promise(() => {}));
  act(() => result.current.setFontSize(22));
  await act(async () => {
    settleFirst?.({ ok: true, json: () => Promise.resolve({}) });
    await Promise.resolve();
  });

  act(() => { globalThis.dispatchEvent(new Event('pagehide')); });
  const putCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[1] as { method?: string })?.method === 'PUT');
  const flushed = putCalls.find((c: unknown[]) => (c[1] as { keepalive?: boolean }).keepalive === true);
  expect(flushed).toBeDefined();
  expect(JSON.parse((flushed![1] as { body: string }).body).fontSize).toBe(22);
});

test('a final save that cannot be sent is reported rather than swallowed', async () => {
  // The flush is the last attempt the change gets, so a rejection here IS the change being lost.
  // Swallowed in silence it was indistinguishable from a save that worked — which is how a body over
  // the `keepalive` cap could defeat the whole mechanism without leaving a trace anywhere.
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { result } = renderHook(() => useEditorPreferences());
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    mockFetch.mockClear();
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    act(() => result.current.setFontSize(19));
    act(() => { globalThis.dispatchEvent(new Event('pagehide')); });
    await act(async () => { await Promise.resolve(); });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('editor-preferences save'),
      expect.any(TypeError),
    );
  } finally {
    warn.mockRestore();
  }
});

test('a page going away with nothing pending sends nothing', async () => {
  renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockFetch.mockClear();

  act(() => { globalThis.dispatchEvent(new Event('pagehide')); });

  expect(mockFetch).not.toHaveBeenCalled();
});

// ── What the account answers, and who answers for the whole page ─────────────────────────────────

/**
 * The body of the last PUT the mock was given, parsed.
 *
 * @param options - Set `keepalive` to look only at the last-chance flush's request.
 * @returns The parsed body, or undefined when no such request was made.
 */
function lastPutBody(options: { readonly keepalive?: boolean } = {}): Partial<Record<string, unknown>> | undefined {
  const calls = mockFetch.mock.calls.filter(
    ([, init]: [unknown, { method?: string; keepalive?: boolean } | undefined]) =>
      init?.method === 'PUT' && (options.keepalive === undefined || init.keepalive === options.keepalive),
  ) as [unknown, { body: string }][];
  const last = calls.at(-1);
  return last === undefined ? undefined : (JSON.parse(last[1].body) as Record<string, unknown>);
}

/** Let the debounce elapse and the request it sends settle. */
async function flushDebouncedPut(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

test('a save the server refuses with a transient status is still owed, and the flush sends it', async () => {
  // `fetch` rejects only when a request gets no answer at all, so a 503 arrives in the SUCCESS
  // branch, where the pending payload was cleared as though the preference had been written. It had
  // not been. The `.catch` below it says the change "stays pending so a `pagehide` gets one more
  // attempt" — which was true for an unreachable network and for nothing else.
  const { result } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());

  mockFetch.mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) });
  act(() => result.current.setPreviewStyle('print'));
  await flushDebouncedPut();
  expect(lastPutBody()).toMatchObject({ previewStyle: 'print' });

  mockFetch.mockClear();
  act(() => { globalThis.dispatchEvent(new Event('pagehide')); });
  expect(lastPutBody({ keepalive: true })).toMatchObject({ previewStyle: 'print' });
});

test('a save the account refuses outright is reported rather than counted as saved', async () => {
  // The scenario: a session cookie expires, the author switches to Print, the PUT comes back 401,
  // and the identity check clears the pending payload exactly as a 204 would. `pagehide` then finds
  // nothing, and the next sign-in's GET returns the stale style and writes it over localStorage.
  // Silently, from end to end.
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { result } = renderHook(() => useEditorPreferences());
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    mockFetch.mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) });
    act(() => result.current.setPreviewStyle('print'));
    await flushDebouncedPut();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('401'));
    // And it is dropped rather than queued forever: retrying a refusal that is about this session or
    // this body cannot change the answer, and an endless retry of a permanent 400 is its own defect.
    mockFetch.mockClear();
    act(() => { globalThis.dispatchEvent(new Event('pagehide')); });
    expect(lastPutBody({ keepalive: true })).toBeUndefined();
  } finally {
    warn.mockRestore();
  }
});

test('two mounted editors keep one state, so a change through either survives the other', async () => {
  // `project-editor-layout.tsx` and `asciidoc-editor.tsx` both call this hook, at the same time. Each
  // instance used to hold its own copy of every preference and PUT a full snapshot of it, so the
  // second instance's save carried the FIRST instance's changes as it had last seen them — which was
  // before they happened. Reproduced exactly here: the PUT body read `"previewStyle":"asciidocollab"`
  // and localStorage reverted with it.
  const layout = renderHook(() => useEditorPreferences());
  const editor = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());

  act(() => layout.result.current.setPreviewStyle('print'));
  // Not merely persisted — the other editor is looking at the same value, rather than at a copy of
  // what it was when it mounted.
  expect(editor.result.current.previewStyle).toBe('print');

  act(() => editor.result.current.setFontSize(18));
  await flushDebouncedPut();

  expect(lastPutBody()).toMatchObject({ previewStyle: 'print', fontSize: 18 });
  expect(JSON.parse(mockLocalStorage.store[LS_KEY]) as Record<string, unknown>).toMatchObject({
    previewStyle: 'print',
    fontSize: 18,
  });
});

test('the account is asked once for the page, not once per mounted editor', () => {
  // A consequence of the shared store worth pinning: two instances used to make two identical GETs
  // and race each other's merges into two separate states.
  renderHook(() => useEditorPreferences());
  renderHook(() => useEditorPreferences());
  const gets = mockFetch.mock.calls.filter(
    ([, init]: [unknown, { method?: string } | undefined]) => init?.method === undefined,
  );
  expect(gets).toHaveLength(1);
});

test('a change made while a refused save is in flight is not thrown away with it', async () => {
  // The pending payload is compared by identity before being cleared, and that has to hold on the
  // refusal path too: a preference changed while the rejected request was in flight has already
  // replaced it with a newer one, and clearing that would discard the change that has NOT been sent
  // instead of the one that has.
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { result } = renderHook(() => useEditorPreferences());
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    let refuse: (value: unknown) => void = () => {};
    mockFetch.mockReturnValue(new Promise((resolve) => { refuse = resolve; }));
    act(() => result.current.setPreviewStyle('print'));
    act(() => { jest.advanceTimersByTime(500); });

    // A second change lands before the first request is answered, and the answer is a refusal.
    act(() => result.current.setFontSize(21));
    await act(async () => {
      refuse({ ok: false, status: 400, json: () => Promise.resolve({}) });
      await Promise.resolve();
      await Promise.resolve();
    });

    mockFetch.mockClear();
    act(() => { globalThis.dispatchEvent(new Event('pagehide')); });
    expect(lastPutBody({ keepalive: true })).toMatchObject({ fontSize: 21, previewStyle: 'print' });
  } finally {
    warn.mockRestore();
  }
});

test('the server render is the defaults, never whatever another render left in the store', async () => {
  // The store is a module singleton, and on the server a module is shared by every request. So the
  // snapshot the server renders from is the DEFAULTS by construction rather than by luck — reading
  // the live store there would serve one reader's font size to the next, and would put a persisted
  // value into the HTML the client then hydrates against (React #418).
  const { result } = renderHook(() => useEditorPreferences());
  act(() => result.current.setFontSize(28));
  expect(result.current.fontSize).toBe(28);

  const Probe = (): React.ReactElement => <span>{useEditorPreferences().fontSize}</span>;
  expect(renderToStaticMarkup(<Probe />)).toBe('<span>14</span>');
});

test('every stored preference is read back, not only the ones with a default worth keeping', () => {
  // One document holding a value for every field, because the fallbacks are what the other cases
  // exercise: a stored `spellcheckEnabled`, `minimapEnabled`, `rightPanelTab` or `commentsPanelOpen`
  // was never once read back by a test, so nothing would have noticed the reader dropping it.
  mockLocalStorage.store[LS_KEY] = JSON.stringify({
    fontSize: 19,
    theme: 'dracula',
    scrollSyncEnabled: true,
    softWrap: false,
    previewStyle: 'print',
    spellIgnore: ['codeblock'],
    spellcheckEnabled: false,
    minimapEnabled: true,
    privateCommitEmail: true,
    leftPanelTab: 'outline',
    rightPanelTab: 'writing',
    showIncludedFiles: true,
    outlineScope: 'current',
    commentsPanelOpen: true,
  });

  const { result } = renderHook(() => useEditorPreferences());
  expect({
    fontSize: result.current.fontSize,
    theme: result.current.theme,
    scrollSyncEnabled: result.current.scrollSyncEnabled,
    softWrap: result.current.softWrap,
    previewStyle: result.current.previewStyle,
    spellIgnore: result.current.spellIgnore,
    spellcheckEnabled: result.current.spellcheckEnabled,
    minimapEnabled: result.current.minimapEnabled,
    privateCommitEmail: result.current.privateCommitEmail,
    leftPanelTab: result.current.leftPanelTab,
    rightPanelTab: result.current.rightPanelTab,
    showIncludedFiles: result.current.showIncludedFiles,
    outlineScope: result.current.outlineScope,
    commentsPanelOpen: result.current.commentsPanelOpen,
  }).toEqual({
    fontSize: 19,
    theme: 'dracula',
    scrollSyncEnabled: true,
    softWrap: false,
    previewStyle: 'print',
    spellIgnore: ['codeblock'],
    spellcheckEnabled: false,
    minimapEnabled: true,
    privateCommitEmail: true,
    leftPanelTab: 'outline',
    rightPanelTab: 'writing',
    showIncludedFiles: true,
    outlineScope: 'current',
    commentsPanelOpen: true,
  });
});

// ── what the store keeps when nothing is mounted ──────────────────────────────────────────────────
//
// The store is a module singleton and the hook is mounted more than once at a time, so "the last
// instance went away" is a moment the store has to survive rather than a moment to empty it. These
// four pin what happens across it, because emptying it there destroyed exactly the preferences the
// account cannot restore.

/** A stored document with a value for every preference an author can lose. */
const EVERY_PREFERENCE = {
  fontSize: 22,
  theme: 'dracula',
  previewStyle: 'print',
  leftPanelTab: 'outline',
  outlineScope: 'current',
  commentsPanelOpen: true,
  spellIgnore: ['asciidoctor', 'prawn'],
};

test('a preference set after the last editor unmounted is applied to the saved state, not to the defaults', async () => {
  // Emptying the store when its last subscriber went left every setter building its next snapshot on
  // the DEFAULTS — and every setter writes that whole snapshot to localStorage. So one call after the
  // last unmount reset every preference the author had and deleted their personal dictionary with it.
  //
  // The account cannot put any of it back. It can answer for a font size and a theme; the six
  // CLIENT_ONLY_KEYS are the keys it does not carry, by design, and `spellIgnore` is one of them.
  mockLocalStorage.store[LS_KEY] = JSON.stringify(EVERY_PREFERENCE);
  // The account is left unanswered so that what survives here is what the STORE kept, rather than
  // what a GET happened to put back. Which is also the point: of the seven preferences below, the
  // account could have answered for three.
  mockFetch.mockReturnValue(new Promise(() => {}));
  const { result, unmount } = renderHook(() => useEditorPreferences());
  expect(result.current.fontSize).toBe(22);

  unmount();
  // Past the point where the store lets go of its read marks, so this is the settled state and not a
  // window before it.
  await act(async () => { await Promise.resolve(); });

  act(() => result.current.addSpellIgnore('quire'));

  expect(JSON.parse(mockLocalStorage.store[LS_KEY]) as Record<string, unknown>).toMatchObject({
    ...EVERY_PREFERENCE,
    spellIgnore: ['asciidoctor', 'prawn', 'quire'],
  });
});

test('a keyed subtree that unmounts and remounts in one commit keeps the preferences it was showing', async () => {
  // The path no other test could reach. React runs the NEW fiber's layout effects before the OLD
  // fiber's passive cleanup, so the mount that would have re-read localStorage found the "already
  // loaded" mark still set and returned — and only then did the unsubscribe empty the store under it.
  // Nothing was left to fill it again: the page showed the defaults until it was reloaded.
  //
  // Today's tree escapes it only because `project-editor-layout.tsx` happens to hold an instance that
  // outlives its keyed children. That is mount order, not a guarantee, and nothing declared it.
  mockLocalStorage.store[LS_KEY] = JSON.stringify(EVERY_PREFERENCE);
  const Probe = (): React.ReactElement => {
    const prefs = useEditorPreferences();
    return (
      <span data-testid="prefs">
        {`${prefs.fontSize}|${prefs.theme}|${prefs.leftPanelTab}|${prefs.outlineScope}|${prefs.spellIgnore.join('+')}`}
      </span>
    );
  };

  const { rerender, getByTestId } = render(<Probe key="a" />);
  const shown = '22|dracula|outline|current|asciidoctor+prawn';
  expect(getByTestId('prefs').textContent).toBe(shown);
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());

  // One commit: the keyed child is deleted and a fresh one mounted, exactly as a subtree swap does it.
  rerender(<Probe key="b" />);
  expect(getByTestId('prefs').textContent).toBe(shown);

  // And the store did not treat the momentarily empty listener set as the page being finished with
  // it: the marks are intact, so the account is not asked a second time for the same page.
  const gets = mockFetch.mock.calls.filter(
    ([, init]: [unknown, { method?: string } | undefined]) => init?.method === undefined,
  );
  expect(gets).toHaveLength(1);
});

test('a StrictMode mount asks the account once, not once per effect pass', () => {
  // StrictMode mounts, unmounts and mounts again inside one commit. Releasing the store's marks on
  // the unmount meant the second pass believed nobody had asked yet — two identical GETs on every
  // development mount, racing each other's merges.
  renderHook(() => useEditorPreferences(), { wrapper: StrictMode });
  const gets = mockFetch.mock.calls.filter(
    ([, init]: [unknown, { method?: string } | undefined]) => init?.method === undefined,
  );
  expect(gets).toHaveLength(1);
});

test('once nothing is mounted the next editor reads localStorage and the account again', async () => {
  // The other half of the sentence above, and the reason the values can be kept: localStorage is the
  // authority, and a mount that follows a genuine teardown re-reads it and re-asks the account. What
  // the store holds in between is never given the last word over either.
  const first = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  act(() => first.result.current.setFontSize(18));

  first.unmount();
  await act(async () => { await Promise.resolve(); });

  // Another tab wrote these while no editor was mounted here.
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 30, theme: 'espresso' });
  mockFetch.mockClear();
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ fontSize: 30, theme: 'espresso' }) });

  const second = renderHook(() => useEditorPreferences());
  expect(second.result.current.fontSize).toBe(30);
  expect(second.result.current.theme).toBe('espresso');
  const gets = mockFetch.mock.calls.filter(
    ([, init]: [unknown, { method?: string } | undefined]) => init?.method === undefined,
  );
  expect(gets).toHaveLength(1);
});

test('a preference changed while the account is being asked is not overwritten by the answer', async () => {
  // The GET's merge took the server's value for every account-synced key alike, so a change made
  // while it was in flight lost to a number that was already out of date when it was sent. The save
  // for that change was armed and went out, so the ACCOUNT ended up right and the screen ended up
  // wrong — the author watched the value revert and it stayed reverted until they reloaded.
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 22, theme: 'dracula' });
  let answer: ((value: unknown) => void) | undefined;
  mockFetch.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));

  const { result } = renderHook(() => useEditorPreferences());
  expect(result.current.fontSize).toBe(22);
  expect(answer).toBeDefined();

  act(() => result.current.setFontSize(30));
  await act(async () => {
    // The account answers with a theme this device has never held, so the assertion below has two
    // outcomes to tell apart. Answering `dracula` — what localStorage already said — was a claim
    // about the merge that both branches of it satisfied: invert the rule to "always keep the local
    // value" and the test went on passing.
    answer?.({ ok: true, json: () => Promise.resolve({ fontSize: 22, theme: 'espresso' }) });
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(result.current.fontSize).toBe(30);
  expect((JSON.parse(mockLocalStorage.store[LS_KEY]) as { fontSize: number }).fontSize).toBe(30);
  // A preference the author did NOT touch still settles on the account's answer — this is a rule
  // about the one that raced the request, not a rule that the server stops being authoritative.
  expect(result.current.theme).toBe('espresso');

  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  await flushDebouncedPut();
  expect(lastPutBody()).toMatchObject({ fontSize: 30 });
});

test('a change armed by one editor is not overwritten by the account when the next editor mounts', async () => {
  // The merge protected the changes made while its own request was open, and a change armed half a
  // second before an editor went away is not one of those. Opening another project inside the debounce
  // window tears the store down — the release drops what the save is holding — and the next mount then
  // reads the new value out of localStorage BEFORE capturing its comparison point, so the key looks
  // untouched and the account's older answer is written straight over it.
  //
  // The armed PUT still lands, so this ends with the account holding 30, localStorage holding 30, and
  // the screen showing 14: the same shape the comparison above was added to fix, one mount boundary
  // over, and it lasts until the editor is mounted again.
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 14, theme: 'default' });
  const first = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());

  act(() => first.result.current.setFontSize(30));
  expect((JSON.parse(mockLocalStorage.store[LS_KEY]) as { fontSize: number }).fontSize).toBe(30);

  // Another project is opened, well inside the 500 ms the save is debounced by.
  first.unmount();
  await act(async () => { await Promise.resolve(); });

  mockFetch.mockClear();
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ fontSize: 14, theme: 'default' }) });
  const second = renderHook(() => useEditorPreferences());
  expect(second.result.current.fontSize).toBe(30);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  // The account answered with the value it held before the change that is still on its way to it.
  expect(second.result.current.fontSize).toBe(30);
  expect((JSON.parse(mockLocalStorage.store[LS_KEY]) as { fontSize: number }).fontSize).toBe(30);

  // And the save the first editor armed still carries the change, so all three agree.
  await flushDebouncedPut();
  expect(lastPutBody()).toMatchObject({ fontSize: 30 });
  expect(second.result.current.fontSize).toBe(30);
});

test('a change the account never received is sent again the next time it is asked', async () => {
  // What keeps "hold this against the account" from becoming permanent. A save that failed with no
  // answer at all is still owed, and the editor that owed it has gone: nothing is armed, nothing is
  // pending, and the merge would otherwise refuse the account's answer for that preference for the
  // rest of the tab's life while never telling it anything different.
  mockLocalStorage.store[LS_KEY] = JSON.stringify({ fontSize: 14, theme: 'default' });
  const first = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());

  // The network is down when the debounce fires, so the change is applied here and nowhere else.
  mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));
  act(() => first.result.current.setFontSize(30));
  await flushDebouncedPut();

  first.unmount();
  await act(async () => { await Promise.resolve(); });

  // A new editor, and an account that still answers with what it was never told to change.
  mockFetch.mockClear();
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ fontSize: 14, theme: 'default' }) });
  const second = renderHook(() => useEditorPreferences());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(second.result.current.fontSize).toBe(30);

  // And this time it is told: the save nothing was carrying any more is on its way again.
  await flushDebouncedPut();
  expect(lastPutBody()).toMatchObject({ fontSize: 30 });
});

test('the account is authoritative again once it has answered for the change it was missing', async () => {
  // The other side of the rule above, and what stops it becoming "the server never wins": a key is
  // held against the account only while the account is not known to hold it. Once a save carrying that
  // value is answered, the next answer is the authority again — including one that disagrees, which is
  // how a preference changed on another device reaches this one.
  const { result, unmount } = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  act(() => result.current.setFontSize(30));
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  await flushDebouncedPut();
  expect(lastPutBody()).toMatchObject({ fontSize: 30 });

  unmount();
  await act(async () => { await Promise.resolve(); });

  mockFetch.mockClear();
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ fontSize: 17, theme: 'default' }) });
  const next = renderHook(() => useEditorPreferences());
  await waitFor(() => expect(next.result.current.fontSize).toBe(17));
});
