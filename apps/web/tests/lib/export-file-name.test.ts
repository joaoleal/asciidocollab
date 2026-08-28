// The web app's export-naming entry point is a thin re-export of the shared rule. What matters
// here is that every name the web call sites import through this path actually resolves — a
// re-export that silently loses a symbol would only surface at the call site.
import {
  exportFileName,
  exportSlug,
  FALLBACK_SLUG,
  MAX_SLUG_LENGTH,
} from '@/lib/export-file-name';

describe('export-file-name re-exports', () => {
  test('builds a dated file name from a project name and extension', () => {
    // Constructed from local calendar parts: the rule stamps the local day, so a UTC instant would
    // label the file differently either side of the date line.
    expect(exportFileName('My Project', 'pdf', new Date(2026, 2, 4, 10, 0, 0))).toBe(
      'my-project-2026-03-04.pdf',
    );
  });

  test('slugifies a project name for use in a file name', () => {
    expect(exportSlug('My Project')).toBe('my-project');
  });

  test('falls back to the shared placeholder slug when a name has no usable characters', () => {
    expect(exportSlug('///')).toBe(FALLBACK_SLUG);
  });

  test('caps the slug at the shared maximum length', () => {
    expect(exportSlug('a'.repeat(MAX_SLUG_LENGTH + 50))).toHaveLength(MAX_SLUG_LENGTH);
  });
});
