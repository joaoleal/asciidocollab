import { symbolAtCursor } from '@/lib/codemirror/asciidoc-symbol-at-cursor';
import type { EditorView } from '@codemirror/view';

// Minimal single-/multi-line view whose cursor (head) sits at `head`.
function viewAt(content: string, head: number): Pick<EditorView, 'state'> {
  return {
    state: {
      selection: { main: { head } },
      doc: {
        lineAt: (position: number) => {
          const lines = content.split('\n');
          let offset = 0;
          for (const line of lines) {
            if (offset + line.length >= position) {
              return { from: offset, to: offset + line.length, number: 1, text: line };
            }
            offset += line.length + 1;
          }
          const last = lines.at(-1) ?? '';
          return { from: content.length - last.length, to: content.length, number: lines.length, text: last };
        },
      },
    } as unknown as EditorView['state'],
  };
}

describe('symbolAtCursor', () => {
  test('detects an attribute reference {attr} as the attribute kind', () => {
    const content = 'Value is {product} today';
    expect(symbolAtCursor(viewAt(content, content.indexOf('product')))).toEqual({
      kind: 'attribute',
      name: 'product',
    });
  });

  test('detects an attribute definition :name: as the attribute kind', () => {
    const content = ':product: AsciiDoc';
    expect(symbolAtCursor(viewAt(content, 4))).toEqual({ kind: 'attribute', name: 'product' });
  });

  test('detects an unset attribute definition :name!: as the attribute kind', () => {
    const content = ':sectids!:';
    expect(symbolAtCursor(viewAt(content, 3))).toEqual({ kind: 'attribute', name: 'sectids' });
  });

  test('detects a [[block]] anchor as the anchor kind', () => {
    const content = '[[install]]\n== Installing';
    expect(symbolAtCursor(viewAt(content, 4))).toEqual({ kind: 'anchor', name: 'install' });
  });

  test('detects a [#id] anchor as the anchor kind', () => {
    const content = '[#setup]\n== Setup';
    expect(symbolAtCursor(viewAt(content, 3))).toEqual({ kind: 'anchor', name: 'setup' });
  });

  test('detects an angle-bracket xref <<id,label>> as the anchor kind', () => {
    const content = 'See <<install,here>> for details';
    expect(symbolAtCursor(viewAt(content, content.indexOf('install')))).toEqual({
      kind: 'anchor',
      name: 'install',
    });
  });

  test('detects an xref:target[] macro, using the fragment after a path', () => {
    const content = 'See xref:guide.adoc#install[the guide]';
    expect(symbolAtCursor(viewAt(content, content.indexOf('install')))).toEqual({
      kind: 'anchor',
      name: 'install',
    });
  });

  test('detects the inline anchor:id[] macro as the anchor kind', () => {
    const content = 'Start here anchor:setup[] and read on';
    expect(symbolAtCursor(viewAt(content, content.indexOf('setup')))).toEqual({
      kind: 'anchor',
      name: 'setup',
    });
  });

  test('returns null for a cross-reference whose target is only whitespace', () => {
    // `<< >>` parses as a reference but names nothing, and offering a rename of the empty string
    // would pre-fill the refactor dialog with a symbol no file can define.
    const content = 'See << >> for details';
    expect(symbolAtCursor(viewAt(content, content.indexOf('<<') + 2))).toBeNull();
  });

  test('returns null when the cursor is on plain text', () => {
    const content = 'just some prose here';
    expect(symbolAtCursor(viewAt(content, 5))).toBeNull();
  });

  test('is position-aware: ignores a token elsewhere on the line', () => {
    const content = '{first} and {second}';
    expect(symbolAtCursor(viewAt(content, content.indexOf('second')))).toEqual({
      kind: 'attribute',
      name: 'second',
    });
  });
});
