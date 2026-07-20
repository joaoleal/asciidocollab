import { EditorState } from '@codemirror/state';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { THEME_SETTINGS, type ThemeSettingDescriptor } from '@asciidocollab/shared';
import { createThemeKeyCompletionSource } from '@/lib/codemirror/completions/theme-key';

const source = createThemeKeyCompletionSource(() => THEME_SETTINGS);

/** Run the completion source with the cursor at the end of `text`. */
function complete(text: string, explicit = false): CompletionResult | null {
  const state = EditorState.create({ doc: text, selection: { anchor: text.length } });
  const context = { state, pos: text.length, explicit } as unknown as CompletionContext;
  return source(context) as CompletionResult | null;
}

/** The labels a completion offers. */
function labels(text: string, explicit = false): string[] {
  return complete(text, explicit)?.options.map((option) => option.label) ?? [];
}

describe('theme key completion — keys', () => {
  it('offers top-level categories', () => {
    const offered = labels('pag');
    expect(offered).toContain('page');
  });

  it('offers settings relative to the cursor’s nesting, not their full path', () => {
    // Offering `heading.font-color` inside `heading:` would insert a key that reads as
    // `heading.heading.font-color` once the indentation is accounted for.
    const offered = labels('heading:\n  font-c');
    expect(offered).toContain('font-color');
    expect(offered).not.toContain('heading.font-color');
  });

  it('offers a deeper container as a nesting step', () => {
    const offered = labels('title-page:\n  ti');
    expect(offered).toContain('title');
  });

  it('filters by what has been typed', () => {
    const offered = labels('base:\n  font-fa');
    expect(offered).toEqual(['font-family']);
  });

  it('filters case-insensitively', () => {
    expect(labels('base:\n  FONT-FA')).toEqual(['font-family']);
  });

  it('replaces the typed text rather than appending to it', () => {
    const text = 'base:\n  font-fa';
    const result = complete(text);
    expect(text.slice(result!.from)).toBe('font-fa');
  });

  it('describes a setting and states its default', () => {
    const result = complete('page:\n  lay');
    const layout = result?.options.find((option) => option.label === 'layout');
    expect(layout?.detail).toBe('default: portrait');
    expect(layout?.info).toMatch(/orientation/i);
  });

  it('stays quiet on an untouched line until asked', () => {
    // Offering all 181 settings on every newline makes the editor feel like it is fighting the author.
    expect(complete('page:\n  ')).toBeNull();
    expect(labels('page:\n  ', true).length).toBeGreaterThan(0);
  });

  it('offers nothing when the typed prefix matches no setting', () => {
    expect(complete('zzzz')).toBeNull();
  });

  it('offers nothing inside a comment', () => {
    expect(complete('# page.lay')).toBeNull();
  });

  it('returns options sorted, so the order never depends on catalogue order', () => {
    const offered = labels('base:\n  f');
    expect(offered).toEqual([...offered].toSorted((a, b) => a.localeCompare(b)));
  });
});

describe('theme key completion — values', () => {
  it('offers the permitted words of a keyword setting', () => {
    expect(labels('page:\n  layout: ', true)).toEqual(['portrait', 'landscape']);
  });

  it('offers value completions once the author starts typing', () => {
    expect(labels('page:\n  layout: land')).toEqual(['portrait', 'landscape']);
  });

  it('replaces the typed value rather than appending to it', () => {
    const text = 'page:\n  layout: land';
    const result = complete(text);
    expect(text.slice(result!.from)).toBe('land');
  });

  it('offers nothing for a setting with no closed set of values', () => {
    // A colour or a length has no list, and inventing one would present a guess as authority.
    expect(complete('base:\n  font-color: ', true)).toBeNull();
    expect(complete('base:\n  font-size: 1', true)).toBeNull();
  });

  it('offers nothing for a key the renderer does not recognise', () => {
    expect(complete('made-up: val', true)).toBeNull();
  });
});

describe('theme key completion — extension-contributed settings', () => {
  const CONTRIBUTED: ThemeSettingDescriptor = {
    key: 'paragraph-numbering.font-color',
    category: 'paragraph-numbering',
    valueKind: 'colour',
    description: 'Colour of the generated paragraph number.',
    contributedBy: 'paragraph-numbering',
  };

  /** Complete against a catalogue widened by an enabled extension. */
  function completeWith(
    settings: readonly ThemeSettingDescriptor[],
    text: string,
  ): string[] {
    const widened = createThemeKeyCompletionSource(() => settings);
    const state = EditorState.create({ doc: text, selection: { anchor: text.length } });
    const context = { state, pos: text.length, explicit: false } as unknown as CompletionContext;
    const result = widened(context) as CompletionResult | null;
    return result?.options.map((option) => option.label) ?? [];
  }

  it('does not offer an extension’s settings while it is disabled', () => {
    // Completing a key nothing will read is worse than not offering it: the author gets no feedback
    // that their setting is inert.
    expect(labels('paragraph-num')).toEqual([]);
  });

  it('offers them once the extension is enabled', () => {
    expect(completeWith([...THEME_SETTINGS, CONTRIBUTED], 'paragraph-num')).toContain(
      'paragraph-numbering',
    );
  });

  it('reads the catalogue lazily, so enabling an extension needs no remount', () => {
    let settings: readonly ThemeSettingDescriptor[] = THEME_SETTINGS;
    const lazy = createThemeKeyCompletionSource(() => settings);
    const run = (text: string): string[] => {
      const state = EditorState.create({ doc: text, selection: { anchor: text.length } });
      const context = { state, pos: text.length, explicit: false } as unknown as CompletionContext;
      return ((lazy(context) as CompletionResult | null)?.options ?? []).map((o) => o.label);
    };
    expect(run('paragraph-num')).toEqual([]);
    settings = [...THEME_SETTINGS, CONTRIBUTED];
    expect(run('paragraph-num')).toContain('paragraph-numbering');
  });
});
