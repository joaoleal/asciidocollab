import { themeDiagnostics } from '@/lib/codemirror/theme/theme-diagnostics';

/** The messages a document produces, for assertions that do not care about ranges. */
function messages(text: string): string[] {
  return themeDiagnostics(text).map((diagnostic) => diagnostic.message);
}

describe('themeDiagnostics — unknown settings', () => {
  it('accepts a document of real settings without complaint', () => {
    expect(
      themeDiagnostics(['page:', '  layout: landscape', 'base:', '  font-color: 333333'].join('\n')),
    ).toEqual([]);
  });

  it('warns about a setting the renderer will not read', () => {
    const diagnostics = themeDiagnostics('page:\n  colour-scheme: dark');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].message).toMatch(/page\.colour-scheme/);
    expect(diagnostics[0].message).toMatch(/no effect/);
  });

  it('warns rather than errors, because a newer renderer may know the key', () => {
    // The catalogue is derived from one gem version. Refusing to render an unrecognised key would be
    // worse than saying this build does not know it.
    expect(themeDiagnostics('made-up: 1')[0].severity).toBe('warning');
  });

  it('underlines the key, not the whole line', () => {
    const text = 'page:\n  colour-scheme: dark';
    const [diagnostic] = themeDiagnostics(text);
    expect(text.slice(diagnostic.from, diagnostic.to)).toBe('colour-scheme');
  });

  it('accepts a setting written in any of the spellings the renderer flattens together', () => {
    expect(themeDiagnostics('heading:\n  h1:\n    font-size: 24')).toEqual([]);
    expect(themeDiagnostics('heading:\n  h1-font-size: 24')).toEqual([]);
    expect(themeDiagnostics('heading_h1_font_size: 24')).toEqual([]);
  });

  it('does not report a container line as an unknown setting', () => {
    // `heading:` assigns nothing; flagging it would put a warning on every nested theme.
    expect(themeDiagnostics('heading:\n  font-color: 333333')).toEqual([]);
  });
});

describe('themeDiagnostics — themes from the Asciidoctor-PDF documentation', () => {
  // Every key here is legitimate and none is set by the two theme files the catalogue is derived
  // from. Reporting them warned an author that a documented, working theme was broken — which
  // teaches them to ignore the validation altogether.
  const DOCUMENTED_THEME = [
    'extends: base',
    'page:',
    '  layout: portrait',
    '  margin: [0.75in, 1in, 0.75in, 1in]',
    '  size: Letter',
    'base:',
    '  font-color: #333333',
    '  font-family: Times-Roman',
    '  font-size: 12',
    '  line-height-length: 17',
    '  line-height: $base-line-height-length / $base-font-size',
    'role:',
    '  removed:',
    '    font-style: italic',
    '    text-decoration: line-through',
    '    text-decoration-color: #FF0000',
    'heading:',
    '  font-color: #262626',
    '  font-size: 17',
    '  font-style: bold',
    '  line-height: 1.2',
    '  margin-bottom: 10',
  ].join('\n');

  it('accepts a documented theme without a single complaint', () => {
    expect(themeDiagnostics(DOCUMENTED_THEME)).toEqual([]);
  });

  it('accepts `extends`, which no shipped theme file sets', () => {
    expect(themeDiagnostics('extends: default')).toEqual([]);
  });

  it('accepts settings on a role the author invented', () => {
    // `role` is an open namespace: `removed` is a custom role applied with `[.removed]#…#`, and the
    // catalogue can only ever hold the few roles the default theme happens to define.
    expect(themeDiagnostics('role:\n  whatever-i-like:\n    font-color: FF0000')).toEqual([]);
  });

  it('accepts a valid composition the example themes never used', () => {
    expect(themeDiagnostics('heading:\n  font-size: 17')).toEqual([]);
    expect(themeDiagnostics('quote:\n  text-decoration-color: FF0000')).toEqual([]);
  });

  it('still catches a genuine typo', () => {
    // The vocabulary test is weaker than catalogue membership, but not vacuous: a leaf ending in a
    // word no theme property ends in is still reported.
    expect(messages('page:\n  colour-scheme: dark')).toHaveLength(1);
    expect(messages('base:\n  font-familly: Times')).toHaveLength(1);
  });
});

describe('themeDiagnostics — keyword values', () => {
  it('rejects a word outside the permitted set and lists the alternatives', () => {
    const diagnostics = themeDiagnostics('page:\n  layout: sideways');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('error');
    expect(diagnostics[0].message).toMatch(/portrait, landscape/);
  });

  it('underlines only the offending value', () => {
    const text = 'page:\n  layout: sideways';
    const [diagnostic] = themeDiagnostics(text);
    expect(text.slice(diagnostic.from, diagnostic.to)).toBe('sideways');
  });

  it('accepts a permitted word, quoted or bare', () => {
    expect(themeDiagnostics('page:\n  layout: landscape')).toEqual([]);
    expect(themeDiagnostics("page:\n  layout: 'landscape'")).toEqual([]);
  });
});

describe('themeDiagnostics — colour values', () => {
  it('accepts every colour form the renderer takes', () => {
    const text = [
      'base:',
      '  font-color: 333333',
      'link:',
      '  font-color: #428BCA',
      'page:',
      '  background-color: transparent',
    ].join('\n');
    expect(themeDiagnostics(text)).toEqual([]);
  });

  it('rejects a value that is not a colour', () => {
    const diagnostics = themeDiagnostics('base:\n  font-color: dark-blue');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('error');
    expect(diagnostics[0].message).toMatch(/expects a colour/);
  });

  it('accepts the short form without a #, which the renderer expands', () => {
    // `HexColorEntryRx` makes the `#` optional on the SHORT form too, and `to_color` expands the
    // shorthand — so `f00` renders red. Requiring the `#` there reported a working theme as broken.
    expect(themeDiagnostics('base:\n  font-color: f00')).toEqual([]);
    expect(themeDiagnostics('base:\n  font-color: #f00')).toEqual([]);
  });

  it('rejects a hex value of the wrong length', () => {
    // Three and six are the meaningful widths; five is a typo whichever way it is read.
    expect(messages('base:\n  font-color: 33333')).toHaveLength(1);
  });
});

describe('themeDiagnostics — values it deliberately does not judge', () => {
  it('leaves a $variable reference alone', () => {
    // The renderer resolves these; this module does not evaluate them, so judging them would reject
    // valid themes.
    expect(themeDiagnostics('heading:\n  font-color: $base-font-color')).toEqual([]);
  });

  it('leaves a computed expression alone', () => {
    expect(themeDiagnostics('base:\n  font-size-large: round($base-font-size * 1.25)')).toEqual([]);
  });

  it('says nothing about a value whose setting has no closed form', () => {
    expect(themeDiagnostics('base:\n  font-family: Whatever Sans')).toEqual([]);
  });
});

describe('themeDiagnostics — structure', () => {
  it('reports a tab in the indentation plainly', () => {
    // Reported on its own because the alternative is a cascade of "unknown setting" warnings for
    // every key below it, none of which names the actual problem.
    const diagnostics = themeDiagnostics('page:\n\tlayout: landscape');
    expect(diagnostics[0].message).toMatch(/spaces, not tabs/);
    expect(diagnostics[0].severity).toBe('error');
  });

  it('reports diagnostics in document order', () => {
    const text = ['base:', '  font-color: nope', 'page:', '  layout: sideways'].join('\n');
    const diagnostics = themeDiagnostics(text);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].from).toBeLessThan(diagnostics[1].from);
  });

  it('says nothing about an empty document', () => {
    expect(themeDiagnostics('')).toEqual([]);
    expect(themeDiagnostics('# only a comment\n')).toEqual([]);
  });
});
