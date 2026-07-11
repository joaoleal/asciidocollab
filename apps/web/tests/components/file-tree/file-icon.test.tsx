import { render } from '@testing-library/react';
import { FileIcon } from '@/components/file-tree/file-icon';

/** The lucide glyph name baked into every icon's `lucide-<name>` class. */
function glyph(name: string): string {
  const { container } = render(<FileIcon name={name} />);
  const cls = container.querySelector('svg')?.getAttribute('class') ?? '';
  return cls.split(/\s+/).find((c) => c.startsWith('lucide-')) ?? '';
}

describe('FileIcon', () => {
  test.each(['guide.adoc', 'README.asciidoc', 'notes.asc', 'x.ad'])(
    'renders the "A" document glyph for AsciiDoc file %s',
    (name) => {
      expect(glyph(name)).toBe('lucide-file-a');
    },
  );

  test.each(['data.csv', 'table.tsv'])('renders the spreadsheet glyph for %s', (name) => {
    expect(glyph(name)).toBe('lucide-file-spreadsheet');
  });

  test.each(['pic.png', 'photo.JPG', 'anim.gif', 'vector.svg', 'shot.webp'])(
    'renders the image glyph for %s',
    (name) => {
      expect(glyph(name)).toBe('lucide-file-image');
    },
  );

  test('renders the text glyph for plain .txt files', () => {
    expect(glyph('notes.txt')).toBe('lucide-file-text');
  });

  test.each(['archive.zip', 'binary', 'unknown.xyz'])(
    'falls back to the generic file glyph for %s',
    (name) => {
      expect(glyph(name)).toBe('lucide-file');
    },
  );
});
