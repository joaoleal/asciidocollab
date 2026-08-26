import { EditorPreferences } from '../../src/entities/editor-preferences';
import { EditorPreferencesId } from '../../src/value-objects/ids/editor-preferences-id';
import { EditorTheme } from '../../src/value-objects/editor/editor-theme';
import { PreviewStyle } from '../../src/value-objects/editor/preview-style';
import { UserId } from '../../src/value-objects/ids/user-id';
import { ValidationError } from '../../src/errors/common/validation-error';

const validId = EditorPreferencesId.create('550e8400-e29b-41d4-a716-446655440000');
const validUserId = UserId.create('660e8400-e29b-41d4-a716-446655440001');
const defaultTheme = (EditorTheme.parse('default') as { success: true; value: EditorTheme }).value;

describe('EditorPreferences entity', () => {
  test('constructs with valid fields', () => {
    const prefs = new EditorPreferences(validId, validUserId, 14, defaultTheme);
    expect(prefs.id).toBe(validId);
    expect(prefs.userId).toBe(validUserId);
    expect(prefs.fontSize).toBe(14);
    expect(prefs.theme).toBe(defaultTheme);
  });

  test('fontSize below 8 throws ValidationError', () => {
    expect(() => new EditorPreferences(validId, validUserId, 7, defaultTheme))
      .toThrow(ValidationError);
  });

  test('fontSize above 32 throws ValidationError', () => {
    expect(() => new EditorPreferences(validId, validUserId, 33, defaultTheme))
      .toThrow(ValidationError);
  });

  test('fontSize at minimum (8) is valid', () => {
    expect(() => new EditorPreferences(validId, validUserId, 8, defaultTheme)).not.toThrow();
  });

  test('fontSize at maximum (32) is valid', () => {
    expect(() => new EditorPreferences(validId, validUserId, 32, defaultTheme)).not.toThrow();
  });

  test('previewStyle defaults to the brand style when omitted', () => {
    const prefs = new EditorPreferences(validId, validUserId, 14, defaultTheme);
    expect(prefs.previewStyle.value).toBe('asciidocollab');
  });

  test('previewStyle reflects the provided value', () => {
    const asciidoctor = (PreviewStyle.parse('asciidoctor') as { success: true; value: PreviewStyle }).value;
    const prefs = new EditorPreferences(validId, validUserId, 14, defaultTheme, false, undefined, true, asciidoctor);
    expect(prefs.previewStyle.value).toBe('asciidoctor');
  });

  test('updatedAt reflects construction timestamp', () => {
    const before = new Date();
    const prefs = new EditorPreferences(validId, validUserId, 14, defaultTheme);
    const after = new Date();
    expect(prefs.timestamps.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(prefs.timestamps.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  test('spellcheck defaults to enabled', () => {
    const prefs = new EditorPreferences(validId, validUserId, 14, defaultTheme);
    expect(prefs.spellcheckEnabled).toBe(true);
  });

  test('reflects the provided spellcheck enabled flag', () => {
    const prefs = new EditorPreferences(validId, validUserId, 14, defaultTheme, false, undefined, true, PreviewStyle.default(), false);
    expect(prefs.spellcheckEnabled).toBe(false);
  });

  test('minimap (text preview) defaults to disabled', () => {
    const prefs = new EditorPreferences(validId, validUserId, 14, defaultTheme);
    expect(prefs.minimapEnabled).toBe(false);
  });

  test('reflects the provided minimap enabled flag', () => {
    const prefs = new EditorPreferences(validId, validUserId, 14, defaultTheme, false, undefined, true, PreviewStyle.default(), true, true);
    expect(prefs.minimapEnabled).toBe(true);
  });

  test('privacy-preserving commit email opt-in defaults to disabled', () => {
    const prefs = new EditorPreferences(validId, validUserId, 14, defaultTheme);
    expect(prefs.privateCommitEmail).toBe(false);
  });

  test('reflects the provided privateCommitEmail flag', () => {
    const prefs = new EditorPreferences(validId, validUserId, 14, defaultTheme, false, undefined, true, PreviewStyle.default(), true, true, true);
    expect(prefs.privateCommitEmail).toBe(true);
  });
});
