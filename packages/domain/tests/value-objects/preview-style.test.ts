import { PreviewStyle } from '../../src/value-objects/editor/preview-style';
import { ValidationError } from '../../src/errors/common/validation-error';

describe('PreviewStyle', () => {
  test('parse("asciidocollab") succeeds', () => {
    const result = PreviewStyle.parse('asciidocollab');
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.value).toBe('asciidocollab');
  });

  test('parse("asciidoctor") succeeds', () => {
    const result = PreviewStyle.parse('asciidoctor');
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.value).toBe('asciidoctor');
  });

  test('parse("print") succeeds', () => {
    const result = PreviewStyle.parse('print');
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.value).toBe('print');
  });

  test('the default for a user who has never chosen is unchanged by the third style', () => {
    expect(PreviewStyle.default().value).toBe('asciidocollab');
    expect(PreviewStyle.parseOrDefault(undefined).value).toBe('asciidocollab');
    expect(PreviewStyle.parseOrDefault(null).value).toBe('asciidocollab');
  });

  test('parseOrDefault still falls back for an unrecognised stored value', () => {
    // A user who picked Print and then had the feature rolled back holds a token the older code
    // would not know; that path is this one, and it must stay a fallback rather than a failure.
    expect(PreviewStyle.parseOrDefault('markdown').value).toBe('asciidocollab');
    expect(PreviewStyle.parseOrDefault('').value).toBe('asciidocollab');
  });

  test('a stored value naming an existing style still resolves to that style', () => {
    expect(PreviewStyle.parseOrDefault('asciidoctor').value).toBe('asciidoctor');
    expect(PreviewStyle.parseOrDefault('asciidocollab').value).toBe('asciidocollab');
    expect(PreviewStyle.parseOrDefault('print').value).toBe('print');
  });

  test('parse rejects the brand-cased display label (tokens are lowercase)', () => {
    const result = PreviewStyle.parse('Asciidocollab');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
  });

  test('parse("unknown") returns ValidationError', () => {
    const result = PreviewStyle.parse('unknown');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
