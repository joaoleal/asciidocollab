import type { AppearanceDiagnostic } from '@asciidocollab/shared';
import {
  toDiagnosticProperties,
  toDiagnosticPropertiesList,
} from '@/lib/print-preview/to-diagnostic-properties';

const REJECTED: AppearanceDiagnostic = {
  severity: 'warning',
  code: 'theme-value-rejected',
  message: "The theme's base.font-color is not a colour, so its default is used instead.",
  themeKey: 'base_font_color',
  resource: 'brand-theme.yml',
  location: { path: 'brand-theme.yml', line: 4 },
};

describe('presenting an appearance problem on the shared surface', () => {
  test('what the author needs is carried across', () => {
    expect(toDiagnosticProperties(REJECTED)).toEqual({
      severity: 'warning',
      message: REJECTED.message,
      resource: 'brand-theme.yml',
      location: { path: 'brand-theme.yml', line: 4 },
    });
  });

  test('what only this code reasons about is left behind', () => {
    // A `code` and a `themeKey` are how the resolver talks to itself. Neither means anything to
    // somebody reading a list of problems, and the surface has no field for either.
    const properties = toDiagnosticProperties(REJECTED) as unknown as Record<string, unknown>;
    expect(properties['code']).toBeUndefined();
    expect(properties['themeKey']).toBeUndefined();
  });

  test('a problem with no place in a document carries no location at all', () => {
    // Absent, not a location pointing at nothing: the surface offers "reveal in the editor" for a
    // diagnostic that has one, and an empty path would offer to reveal a file that does not exist.
    const properties = toDiagnosticProperties({
      severity: 'warning',
      code: 'theme-font-unavailable',
      message: 'This font could not be loaded, so an approximation is shown.',
      resource: 'Bespoke',
    });
    expect('location' in properties).toBe(false);
  });

  test('a located problem with no line keeps the file and omits the line', () => {
    const properties = toDiagnosticProperties({
      severity: 'error',
      code: 'theme-unparseable',
      message: 'The theme document could not be read.',
      resource: 'brand-theme.yml',
      location: { path: 'brand-theme.yml' },
    });
    expect(properties.location).toEqual({ path: 'brand-theme.yml' });
  });

  test('a list keeps its order, so the surface decides what leads', () => {
    // Errors before warnings is the surface's own rule; re-sorting here would be a second opinion.
    const list = toDiagnosticPropertiesList([
      REJECTED,
      { severity: 'error', code: 'theme-unparseable', message: 'unreadable', resource: 'x.yml' },
    ]);
    expect(list.map((item) => item.severity)).toEqual(['warning', 'error']);
  });

  test('nothing wrong produces nothing to show', () => {
    expect(toDiagnosticPropertiesList([])).toEqual([]);
  });
});
