import { GetEditorPreferencesUseCase } from '../../../src/use-cases/settings/get-editor-preferences';
import { InMemoryEditorPreferencesRepository } from '../../ports/user/in-memory-editor-preferences.repository';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { EditorPreferencesId } from '../../../src/value-objects/ids/editor-preferences-id';
import { EditorPreferences } from '../../../src/entities/editor-preferences';
import { EditorTheme } from '../../../src/value-objects/editor/editor-theme';
import { PreviewStyle } from '../../../src/value-objects/editor/preview-style';
import { ValidationError } from '../../../src/errors/common/validation-error';
import { DEFAULT_FONT_SIZE, DEFAULT_THEME, DEFAULT_PREVIEW_STYLE } from '../../../src/constants/editor-preferences';

const userId = UserId.create('550e8400-e29b-41d4-a716-446655440000');

function makeTheme(v: string) {
  const result = EditorTheme.parse(v);
  if (!result.success) throw result.error;
  return result.value;
}

describe('GetEditorPreferencesUseCase', () => {
  test('returns existing record when found', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const id = EditorPreferencesId.create('660e8400-e29b-41d4-a716-446655440001');
    const existing = new EditorPreferences(id, userId, 16, makeTheme('high-contrast'));
    await repo.save(existing);

    const useCase = new GetEditorPreferencesUseCase(repo);
    const result = await useCase.execute(userId);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.fontSize).toBe(16);
      expect(result.value.theme.value).toBe('high-contrast');
    }
  });

  test('returns default preferences when no record found', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const useCase = new GetEditorPreferencesUseCase(repo);
    const result = await useCase.execute(userId);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.fontSize).toBe(DEFAULT_FONT_SIZE);
      expect(result.value.theme.value).toBe(DEFAULT_THEME);
      expect(result.value.previewStyle.value).toBe(DEFAULT_PREVIEW_STYLE);
    }
  });

  test('returns existing record previewStyle when set', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const id = EditorPreferencesId.create('660e8400-e29b-41d4-a716-446655440001');
    const asciidoctor = PreviewStyle.parse('asciidoctor');
    if (!asciidoctor.success) throw asciidoctor.error;
    const existing = new EditorPreferences(id, userId, 16, makeTheme('default'), false, undefined, true, asciidoctor.value);
    await repo.save(existing);

    const result = await new GetEditorPreferencesUseCase(repo).execute(userId);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.previewStyle.value).toBe('asciidoctor');
    }
  });

  test('never returns an error', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const useCase = new GetEditorPreferencesUseCase(repo);
    const result = await useCase.execute(userId);
    expect(result.success).toBe(true);
  });

  test('returns softWrap field', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const useCase = new GetEditorPreferencesUseCase(repo);
    const result = await useCase.execute(userId);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.value.softWrap).toBe('boolean');
    }
  });

  test('fails loudly rather than returning junk defaults when the configured default theme is unusable', async () => {
    const parse = jest.spyOn(EditorTheme, 'parse').mockReturnValue({
      success: false,
      error: new ValidationError('theme no longer supported'),
    });
    try {
      const repo = new InMemoryEditorPreferencesRepository();
      const useCase = new GetEditorPreferencesUseCase(repo);

      await expect(useCase.execute(userId)).rejects.toThrow(
        /Failed to parse default theme .*theme no longer supported/,
      );
    } finally {
      parse.mockRestore();
    }
  });
});
