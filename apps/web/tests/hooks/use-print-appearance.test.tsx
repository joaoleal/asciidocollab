import { renderHook } from '@testing-library/react';
import { defaultAppearance, resolveAppearance } from '@asciidocollab/shared';
import { usePrintAppearance } from '@/hooks/use-print-appearance';

// The real resolver, counted. Counting is the point of two of these tests — the hook's whole job is
// to decide how often resolution happens — and a module namespace cannot be spied on in place.
jest.mock('@asciidocollab/shared', () => {
  const actual = jest.requireActual('@asciidocollab/shared');
  return { ...actual, resolveAppearance: jest.fn(actual.resolveAppearance) };
});

const resolveCalls = jest.mocked(resolveAppearance);

const THEME = 'extends: default\nbase:\n  font_color: 3C763D\n';

beforeEach(() => resolveCalls.mockClear());

describe('resolving the Print style appearance', () => {
  test('a project with no theme gets the export\'s own default appearance', () => {
    const { result } = renderHook(() => usePrintAppearance({ enabled: true }));
    expect(result.current.appearance).toBe(defaultAppearance());
    expect(result.current.diagnostics).toEqual([]);
    expect(result.current.appearance.page.widthPt).toBeGreaterThan(0);
  });

  test('a project theme is applied', () => {
    const { result } = renderHook(() => usePrintAppearance({ enabled: true, themeText: THEME }));
    // The appearance IS the report that the theme was applied; there is no separate flag saying so.
    expect(result.current.appearance).not.toBe(defaultAppearance());
    expect(result.current.appearance.base.fontColor).toBe('3C763D');
  });

  test('a theme that cannot be read costs the theme, not the page', () => {
    const { result } = renderHook(() =>
      usePrintAppearance({ enabled: true, themeText: 'base:\n  - [\n', themePath: 'theme/x.yml' }),
    );
    expect(result.current.appearance).toBe(defaultAppearance());
    expect(result.current.diagnostics).toHaveLength(1);
    expect(result.current.diagnostics[0].code).toBe('theme-unparseable');
    expect(result.current.diagnostics[0].location?.path).toBe('theme/x.yml');
  });

  test('a value that cannot be read costs its own key, and is reported against its line', () => {
    const { result } = renderHook(() =>
      usePrintAppearance({
        enabled: true,
        themeText: 'extends: default\nbase:\n  font_color: not-a-colour\n',
        themePath: 'theme/x.yml',
      }),
    );
    // The theme applied — only that one key was rejected — so the page is the theme's, not the
    // default it would be if the whole document had been refused.
    expect(result.current.appearance).not.toBe(defaultAppearance());
    expect(result.current.diagnostics.map((d) => d.code)).toEqual(['theme-value-rejected']);
    expect(result.current.appearance.base.fontSizePt).toBeGreaterThan(0);
  });
});

describe('what this hook is not allowed to cost', () => {
  test('a re-render with the same theme resolves nothing again', () => {
    // The document being typed re-renders the preview constantly; the theme does not change with it.
    // Resolving per render would put a YAML parse on the keystroke path, which is the whole reason
    // this is memoised on the theme text rather than computed in the component.
    const { rerender } = renderHook((props: { themeText: string }) =>
      usePrintAppearance({ enabled: true, themeText: props.themeText }),
    { initialProps: { themeText: THEME } });

    expect(resolveCalls).toHaveBeenCalledTimes(1);
    for (let render = 0; render < 5; render++) rerender({ themeText: THEME });
    expect(resolveCalls).toHaveBeenCalledTimes(1);

    rerender({ themeText: `${THEME}link:\n  font_color: 0000FF\n` });
    expect(resolveCalls).toHaveBeenCalledTimes(2);
  });

  test('nothing is resolved at all while another preview style is selected', () => {
    const { result } = renderHook(() => usePrintAppearance({ enabled: false, themeText: THEME }));
    expect(resolveCalls).not.toHaveBeenCalled();
    expect(result.current.appearance).toBe(defaultAppearance());
  });
});

describe('holding the last interpretable appearance', () => {
  // A theme being edited is unreadable for most of the time it is being typed. Falling back to the
  // default on each of those keystrokes throws the page between the author's theme and the
  // renderer's default — moving the page column as the margins change underneath it.
  const BROKEN = 'base:\n  - [\n';

  test('an unreadable theme keeps the page it had, and says what is wrong', () => {
    const { result, rerender } = renderHook(
      (props: { themeText: string }) =>
        usePrintAppearance({ enabled: true, projectId: 'p1', ...props }),
      { initialProps: { themeText: THEME } },
    );
    const applied = result.current.appearance;
    expect(applied.base.fontColor).toBe('3C763D');

    rerender({ themeText: BROKEN });
    expect(result.current.appearance).toBe(applied);
    expect(result.current.diagnostics.map((d) => d.code)).toEqual(['theme-unparseable']);
    // The page holding a theme has to SAY it is holding one, because the resolver's own wording says
    // the default is being shown and the author is looking straight at their own theme. That
    // restated message is now the only report of the hold — the `holdingPreviousTheme` flag that
    // used to duplicate it was read by nothing — so this asserts the sentence a reader gets.
    expect(result.current.diagnostics[0].message).toContain('the last version that could be read');
    expect(result.current.diagnostics[0].severity).toBe('warning');
  });

  test('the held appearance gives way as soon as the theme reads again', () => {
    const { result, rerender } = renderHook(
      (props: { themeText: string }) =>
        usePrintAppearance({ enabled: true, projectId: 'p1', ...props }),
      { initialProps: { themeText: THEME } },
    );
    rerender({ themeText: BROKEN });
    rerender({ themeText: 'extends: default\nbase:\n  font_color: 0000FF\n' });
    expect(result.current.appearance.base.fontColor).toBe('0000FF');
    // Nothing is being held any more, which is visible in there being nothing left to report.
    expect(result.current.diagnostics).toEqual([]);
  });

  test('a value that cannot be read is not a theme that cannot be read', () => {
    // One bad key costs that key. Holding the previous page for it would hide the very change the
    // author is trying to make everywhere else in the file.
    const { result, rerender } = renderHook(
      (props: { themeText: string }) =>
        usePrintAppearance({ enabled: true, projectId: 'p1', ...props }),
      { initialProps: { themeText: THEME } },
    );
    rerender({ themeText: 'extends: default\nbase:\n  font_color: nonsense\n  font_size: 20\n' });
    // The new text is on the page — the previous appearance is not being held — and only the key
    // that could not be read is reported.
    expect(result.current.appearance.base.fontSizePt).toBe(20);
    expect(result.current.diagnostics.map((d) => d.code)).toEqual(['theme-value-rejected']);
  });

  test('a project whose theme is gone returns to the default rather than holding', () => {
    const { result, rerender } = renderHook(
      (props: { themeText?: string }) =>
        usePrintAppearance({ enabled: true, projectId: 'p1', ...props }),
      { initialProps: { themeText: THEME as string | undefined } },
    );
    rerender({ themeText: undefined });
    expect(result.current.appearance).toBe(defaultAppearance());

    // …and nothing is left over to hold for a theme added later and mistyped.
    rerender({ themeText: BROKEN });
    expect(result.current.appearance).toBe(defaultAppearance());
    // A page that is not holding anything reports the resolver's own wording, unrestated.
    expect(result.current.diagnostics[0].message).not.toContain('the last version that could be read');
  });

  test('another project does not inherit the appearance held for this one', () => {
    const { result, rerender } = renderHook(
      (props: { projectId: string; themeText: string }) =>
        usePrintAppearance({ enabled: true, ...props }),
      { initialProps: { projectId: 'p1', themeText: THEME } },
    );
    rerender({ projectId: 'p2', themeText: BROKEN });
    expect(result.current.appearance).toBe(defaultAppearance());
    expect(result.current.diagnostics[0].message).not.toContain('the last version that could be read');
  });
});
