import { SaveEditorPreferencesUseCase } from '../../../src/use-cases/settings/save-editor-preferences';
import { GetEditorPreferencesUseCase } from '../../../src/use-cases/settings/get-editor-preferences';
import { InMemoryEditorPreferencesRepository } from '../../ports/user/in-memory-editor-preferences.repository';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ValidationError } from '../../../src/errors/common/validation-error';

const userId = UserId.create('550e8400-e29b-41d4-a716-446655440000');

describe('SaveEditorPreferencesUseCase', () => {
  test('valid inputs persist and can be retrieved', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const saveUseCase = new SaveEditorPreferencesUseCase(repo);
    const getUseCase = new GetEditorPreferencesUseCase(repo);

    const saveResult = await saveUseCase.execute(userId, { fontSize: 18, theme: 'high-contrast' });
    expect(saveResult.success).toBe(true);

    const getResult = await getUseCase.execute(userId);
    expect(getResult.success).toBe(true);
    if (getResult.success) {
      expect(getResult.value.fontSize).toBe(18);
      expect(getResult.value.theme.value).toBe('high-contrast');
    }
  });

  test('fontSize: 7 returns ValidationError', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const useCase = new SaveEditorPreferencesUseCase(repo);
    const result = await useCase.execute(userId, { fontSize: 7, theme: 'default' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
  });

  test('fontSize: 33 returns ValidationError', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const useCase = new SaveEditorPreferencesUseCase(repo);
    const result = await useCase.execute(userId, { fontSize: 33, theme: 'default' });
    expect(result.success).toBe(false);
  });

  test('theme: "neon" returns ValidationError', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const useCase = new SaveEditorPreferencesUseCase(repo);
    const result = await useCase.execute(userId, { fontSize: 14, theme: 'neon' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
  });

  test('second save for same user upserts (no duplicate record)', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const saveUseCase = new SaveEditorPreferencesUseCase(repo);
    const getUseCase = new GetEditorPreferencesUseCase(repo);

    await saveUseCase.execute(userId, { fontSize: 12, theme: 'default' });
    await saveUseCase.execute(userId, { fontSize: 20, theme: 'high-contrast' });

    const result = await getUseCase.execute(userId);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.fontSize).toBe(20);
    }
  });

  test('softWrap field accepted and persisted', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const saveUseCase = new SaveEditorPreferencesUseCase(repo);
    const getUseCase = new GetEditorPreferencesUseCase(repo);

    const saveResult = await saveUseCase.execute(userId, { fontSize: 14, theme: 'default', softWrap: false });
    expect(saveResult.success).toBe(true);

    const getResult = await getUseCase.execute(userId);
    expect(getResult.success).toBe(true);
    if (getResult.success) {
      expect(getResult.value.softWrap).toBe(false);
    }
  });

  test('previewStyle field accepted and persisted', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const saveUseCase = new SaveEditorPreferencesUseCase(repo);
    const getUseCase = new GetEditorPreferencesUseCase(repo);

    const saveResult = await saveUseCase.execute(userId, { fontSize: 14, theme: 'default', previewStyle: 'asciidoctor' });
    expect(saveResult.success).toBe(true);

    const getResult = await getUseCase.execute(userId);
    expect(getResult.success).toBe(true);
    if (getResult.success) {
      expect(getResult.value.previewStyle.value).toBe('asciidoctor');
    }
  });

  test('previewStyle defaults to the brand style when omitted', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const saveUseCase = new SaveEditorPreferencesUseCase(repo);
    const getUseCase = new GetEditorPreferencesUseCase(repo);

    await saveUseCase.execute(userId, { fontSize: 14, theme: 'default' });

    const getResult = await getUseCase.execute(userId);
    expect(getResult.success).toBe(true);
    if (getResult.success) {
      expect(getResult.value.previewStyle.value).toBe('asciidocollab');
    }
  });

  test('an omitted previewStyle preserves the previously saved value', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const saveUseCase = new SaveEditorPreferencesUseCase(repo);
    const getUseCase = new GetEditorPreferencesUseCase(repo);

    await saveUseCase.execute(userId, { fontSize: 14, theme: 'default', previewStyle: 'asciidoctor' });
    await saveUseCase.execute(userId, { fontSize: 16, theme: 'default' });

    const getResult = await getUseCase.execute(userId);
    expect(getResult.success).toBe(true);
    if (getResult.success) {
      expect(getResult.value.previewStyle.value).toBe('asciidoctor');
    }
  });

  test('invalid previewStyle returns ValidationError', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const useCase = new SaveEditorPreferencesUseCase(repo);
    const result = await useCase.execute(userId, { fontSize: 14, theme: 'default', previewStyle: 'neon' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
  });

  test('persists the spellcheck enabled flag', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const saveUseCase = new SaveEditorPreferencesUseCase(repo);
    const getUseCase = new GetEditorPreferencesUseCase(repo);

    await saveUseCase.execute(userId, { fontSize: 14, theme: 'default', spellcheckEnabled: false });

    const getResult = await getUseCase.execute(userId);
    expect(getResult.success).toBe(true);
    if (getResult.success) {
      expect(getResult.value.spellcheckEnabled).toBe(false);
    }
  });

  test('an omitted spellcheck enabled flag preserves the previously saved value', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const saveUseCase = new SaveEditorPreferencesUseCase(repo);
    const getUseCase = new GetEditorPreferencesUseCase(repo);

    await saveUseCase.execute(userId, { fontSize: 14, theme: 'default', spellcheckEnabled: false });
    await saveUseCase.execute(userId, { fontSize: 16, theme: 'default' });

    const getResult = await getUseCase.execute(userId);
    if (getResult.success) expect(getResult.value.spellcheckEnabled).toBe(false);
  });

  test('persists the minimap (text preview) enabled flag', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const saveUseCase = new SaveEditorPreferencesUseCase(repo);
    const getUseCase = new GetEditorPreferencesUseCase(repo);

    await saveUseCase.execute(userId, { fontSize: 14, theme: 'default', minimapEnabled: true });

    const getResult = await getUseCase.execute(userId);
    expect(getResult.success).toBe(true);
    if (getResult.success) {
      expect(getResult.value.minimapEnabled).toBe(true);
    }
  });

  test('an omitted minimap enabled flag preserves the previously saved value', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const saveUseCase = new SaveEditorPreferencesUseCase(repo);
    const getUseCase = new GetEditorPreferencesUseCase(repo);

    await saveUseCase.execute(userId, { fontSize: 14, theme: 'default', minimapEnabled: true });
    await saveUseCase.execute(userId, { fontSize: 16, theme: 'default' });

    const getResult = await getUseCase.execute(userId);
    if (getResult.success) expect(getResult.value.minimapEnabled).toBe(true);
  });

  test('privateCommitEmail defaults to false when never set', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const getUseCase = new GetEditorPreferencesUseCase(repo);

    const getResult = await getUseCase.execute(userId);
    expect(getResult.success).toBe(true);
    if (getResult.success) {
      expect(getResult.value.privateCommitEmail).toBe(false);
    }
  });

  test('persists the privacy-preserving commit email opt-in', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const saveUseCase = new SaveEditorPreferencesUseCase(repo);
    const getUseCase = new GetEditorPreferencesUseCase(repo);

    await saveUseCase.execute(userId, { fontSize: 14, theme: 'default', privateCommitEmail: true });

    const getResult = await getUseCase.execute(userId);
    expect(getResult.success).toBe(true);
    if (getResult.success) {
      expect(getResult.value.privateCommitEmail).toBe(true);
    }
  });

  test('an omitted privateCommitEmail flag preserves the previously saved value', async () => {
    const repo = new InMemoryEditorPreferencesRepository();
    const saveUseCase = new SaveEditorPreferencesUseCase(repo);
    const getUseCase = new GetEditorPreferencesUseCase(repo);

    await saveUseCase.execute(userId, { fontSize: 14, theme: 'default', privateCommitEmail: true });
    await saveUseCase.execute(userId, { fontSize: 16, theme: 'default' });

    const getResult = await getUseCase.execute(userId);
    if (getResult.success) expect(getResult.value.privateCommitEmail).toBe(true);
  });
});
