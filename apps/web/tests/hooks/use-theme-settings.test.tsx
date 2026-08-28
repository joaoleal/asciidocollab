import { renderHook } from '@testing-library/react';
import { THEME_SETTINGS, type PdfExtensionCatalogueEntry, type RenderConfig } from '@asciidocollab/shared';
import { useThemeSettings } from '@/hooks/use-theme-settings';

const mockUsePdfExtensions = jest.fn();
const mockUseProjectRenderConfig = jest.fn();

jest.mock('@/hooks/use-pdf-extensions', () => ({
  usePdfExtensions: (projectId: string) => mockUsePdfExtensions(projectId),
}));
jest.mock('@/hooks/use-project-render-config', () => ({
  useProjectRenderConfig: (projectId: string) => mockUseProjectRenderConfig(projectId),
}));

function entry(id: string, available: boolean, keys: readonly string[]): PdfExtensionCatalogueEntry {
  return {
    manifest: {
      id,
      displayName: `${id} extension`,
      description: 'does a thing',
      targeting: '',
      themeKeys: keys.map((key) => ({
        key,
        valueKind: 'colour' as const,
        description: `the ${key}`,
        default: '#000000',
      })),
      sampleContent: '',
    },
    origin: 'shipped',
    available,
  };
}

function setCatalogue(entries: readonly PdfExtensionCatalogueEntry[] | undefined): void {
  mockUsePdfExtensions.mockReturnValue({
    catalogue: entries === undefined ? null : { entries, staleSelections: [], excluded: [], conflicts: [] },
    loading: false,
    error: null,
  });
}

function setEnabled(enabled: readonly string[] | undefined): void {
  const config: RenderConfig = enabled === undefined ? {} : { extensions: { enabled: [...enabled] } };
  mockUseProjectRenderConfig.mockReturnValue({
    config,
    loading: false,
    loaded: true,
    saving: false,
    error: null,
    save: jest.fn(),
  });
}

beforeEach(() => {
  mockUsePdfExtensions.mockReset();
  mockUseProjectRenderConfig.mockReset();
  setCatalogue([]);
  setEnabled([]);
});

describe('useThemeSettings', () => {
  test('offers only the built-in settings when no project is in scope', () => {
    const { result } = renderHook(() => useThemeSettings());
    expect(result.current.settings).toBe(THEME_SETTINGS);
    expect(result.current.enabledExtensions).toEqual([]);
    // Both sources are queried with an empty id so neither fetches for a project that is not there.
    expect(mockUsePdfExtensions).toHaveBeenCalledWith('');
    expect(mockUseProjectRenderConfig).toHaveBeenCalledWith('');
  });

  test('offers only the built-in settings while the catalogue is still loading', () => {
    setCatalogue(undefined);
    const { result } = renderHook(() => useThemeSettings('p1'));
    expect(result.current.settings).toBe(THEME_SETTINGS);
    expect(result.current.enabledExtensions).toEqual([]);
  });

  test('offers only the built-in settings while the render config has no selection yet', () => {
    setCatalogue([entry('narrow-contents', true, ['narrow-contents.left'])]);
    setEnabled(undefined);
    const { result } = renderHook(() => useThemeSettings('p1'));
    expect(result.current.settings).toBe(THEME_SETTINGS);
    expect(result.current.enabledExtensions).toEqual([]);
  });

  test('reports no enabled extensions when the project has switched none on', () => {
    setCatalogue([entry('narrow-contents', true, ['narrow-contents.left'])]);
    setEnabled([]);
    const { result } = renderHook(() => useThemeSettings('p1'));
    expect(result.current.enabledExtensions).toEqual([]);
    expect(result.current.settings).toBe(THEME_SETTINGS);
  });

  test('adds the settings contributed by an enabled extension', () => {
    setCatalogue([entry('narrow-contents', true, ['narrow-contents.left'])]);
    setEnabled(['narrow-contents']);
    const { result } = renderHook(() => useThemeSettings('p1'));
    expect(result.current.enabledExtensions).toEqual([
      { id: 'narrow-contents', displayName: 'narrow-contents extension' },
    ]);
    expect(result.current.settings.some((setting) => setting.key === 'narrow-contents.left')).toBe(true);
    expect(result.current.settings.length).toBeGreaterThan(THEME_SETTINGS.length);
  });

  test('leaves out an extension the project names that nothing offers any more', () => {
    setCatalogue([entry('gone', false, ['gone.key'])]);
    setEnabled(['gone']);
    const { result } = renderHook(() => useThemeSettings('p1'));
    expect(result.current.enabledExtensions).toEqual([]);
    expect(result.current.settings.some((setting) => setting.key === 'gone.key')).toBe(false);
  });

  test('leaves out an available extension the project has not switched on', () => {
    setCatalogue([entry('offered', true, ['offered.key']), entry('chosen', true, ['chosen.key'])]);
    setEnabled(['chosen']);
    const { result } = renderHook(() => useThemeSettings('p1'));
    expect(result.current.enabledExtensions).toEqual([
      { id: 'chosen', displayName: 'chosen extension' },
    ]);
    expect(result.current.settings.some((setting) => setting.key === 'offered.key')).toBe(false);
    expect(result.current.settings.some((setting) => setting.key === 'chosen.key')).toBe(true);
  });
});
