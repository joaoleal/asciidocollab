import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { sourceLanguageCompletionSource } from '@/lib/codemirror/asciidoc-completions';

// Minimal CompletionContext stub exercising matchBefore against a line prefix.
function contextFor(textBeforeCursor: string): CompletionContext {
  return {
    matchBefore(re: RegExp) {
      const match = new RegExp(re.source + '$').exec(textBeforeCursor);
      if (!match) return null;
      const from = textBeforeCursor.length - match[0].length;
      return { from, to: textBeforeCursor.length, text: match[0] };
    },
  } as unknown as CompletionContext;
}

/** The synchronous result these specs exercise; the source may also return a promise. */
function syncResult(
  result: ReturnType<typeof sourceLanguageCompletionSource>,
): CompletionResult {
  if (result === null || result instanceof Promise) {
    throw new Error('expected a synchronous completion result');
  }
  return result;
}

describe('sourceLanguageCompletionSource', () => {
  test('offers languages inside [source,<here>]', () => {
    const result = sourceLanguageCompletionSource(contextFor('[source,'));
    expect(result).not.toBeNull();
    const labels = syncResult(result).options.map((option) => option.label);
    expect(labels).toContain('js');
    expect(labels).toContain('python');
  });

  test('filters by the typed prefix', () => {
    const result = sourceLanguageCompletionSource(contextFor('[source,ru'));
    const labels = syncResult(result).options.map((option) => option.label);
    expect(labels).toContain('ruby');
    expect(labels).toContain('rust');
    expect(labels).not.toContain('python');
  });

  test('returns null outside a source declaration', () => {
    expect(sourceLanguageCompletionSource(contextFor('just text'))).toBeNull();
    expect(sourceLanguageCompletionSource(contextFor('[cols='))).toBeNull();
  });
});
