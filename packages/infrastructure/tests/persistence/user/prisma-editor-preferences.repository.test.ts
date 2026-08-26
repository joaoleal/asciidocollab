import { PrismaClient } from '@prisma/client';
import { PrismaEditorPreferencesRepository } from '../../../src/persistence/user/prisma-editor-preferences.repository';
import { PrismaUserRepository } from '../../../src/persistence/user/prisma-user.repository';
import { startTestContainer, stopTestContainer, TestContainer } from '../../helpers/prisma-test-container';
import { createTestUser } from '../../helpers/test-data';
import { UserId } from '@asciidocollab/domain';
import { EditorPreferencesId } from '@asciidocollab/domain';
import { EditorPreferences } from '@asciidocollab/domain';
import { EditorTheme } from '@asciidocollab/domain';
import { PreviewStyle } from '@asciidocollab/domain';

function makeTheme(v: string) {
  const r = EditorTheme.parse(v);
  if (!r.success) throw r.error;
  return r.value;
}

function makePreviewStyle(v: string) {
  const r = PreviewStyle.parse(v);
  if (!r.success) throw r.error;
  return r.value;
}

describe('PrismaEditorPreferencesRepository', () => {
  let container: TestContainer;
  let client: PrismaClient;
  let repo: PrismaEditorPreferencesRepository;
  let userRepo: PrismaUserRepository;
  let userId: UserId;

  beforeAll(async () => {
    container = await startTestContainer();
    client = container.client;
    repo = new PrismaEditorPreferencesRepository(client);
    userRepo = new PrismaUserRepository(client);
  });

  afterAll(async () => {
    await stopTestContainer(container);
  });

  beforeEach(async () => {
    await client.editorPreferences.deleteMany();
    await client.user.deleteMany();

    const user = createTestUser();
    await userRepo.save(user);
    userId = user.id;
  });

  it('findByUserId returns null when no record exists', async () => {
    const result = await repo.findByUserId(userId);
    expect(result).toBeNull();
  });

  it('save creates a new record', async () => {
    const prefs = new EditorPreferences(
      EditorPreferencesId.create('550e8400-e29b-41d4-a716-446655440000'),
      userId,
      16,
      makeTheme('high-contrast'),
    );
    await repo.save(prefs);
    const retrieved = await repo.findByUserId(userId);
    expect(retrieved).not.toBeNull();
  });

  it('findByUserId returns the saved record', async () => {
    const prefs = new EditorPreferences(
      EditorPreferencesId.create('550e8400-e29b-41d4-a716-446655440000'),
      userId,
      18,
      makeTheme('high-contrast'),
    );
    await repo.save(prefs);
    const retrieved = await repo.findByUserId(userId);
    expect(retrieved?.fontSize).toBe(18);
    expect(retrieved?.theme.value).toBe('high-contrast');
  });

  it('calling save again for the same user updates the existing record (upsert)', async () => {
    const prefsV1 = new EditorPreferences(
      EditorPreferencesId.create('550e8400-e29b-41d4-a716-446655440000'),
      userId,
      12,
      makeTheme('default'),
    );
    await repo.save(prefsV1);

    const prefsV2 = new EditorPreferences(
      EditorPreferencesId.create('550e8400-e29b-41d4-a716-446655440000'),
      userId,
      20,
      makeTheme('high-contrast'),
    );
    await repo.save(prefsV2);

    const count = await client.editorPreferences.count({ where: { userId: userId.value } });
    expect(count).toBe(1);

    const retrieved = await repo.findByUserId(userId);
    expect(retrieved?.fontSize).toBe(20);
  });

  // Issue 7: corrupted theme in DB must throw rather than silently fall back to
  // 'default', otherwise data corruption is invisible in production.
  it('throws when the DB row contains an unrecognised theme value', async () => {
    await client.editorPreferences.create({
      data: {
        id: '550e8400-e29b-41d4-a716-446655440099',
        userId: userId.value,
        fontSize: 14,
        theme: 'totally-invalid-theme',
      },
    });

    await expect(repo.findByUserId(userId)).rejects.toThrow();
  });

  it('round-trips the previewStyle value', async () => {
    const prefs = new EditorPreferences(
      EditorPreferencesId.create('550e8400-e29b-41d4-a716-446655440000'),
      userId,
      14,
      makeTheme('default'),
      false,
      undefined,
      true,
      makePreviewStyle('asciidoctor'),
    );
    await repo.save(prefs);
    const retrieved = await repo.findByUserId(userId);
    expect(retrieved?.previewStyle.value).toBe('asciidoctor');
  });

  it('defaults previewStyle to the brand style when the column holds its default', async () => {
    const prefs = new EditorPreferences(
      EditorPreferencesId.create('550e8400-e29b-41d4-a716-446655440000'),
      userId,
      14,
      makeTheme('default'),
    );
    await repo.save(prefs);
    const retrieved = await repo.findByUserId(userId);
    expect(retrieved?.previewStyle.value).toBe('asciidocollab');
  });

  // Unlike `theme`, a corrupt previewStyle must fall back to the default rather than throw,
  // so the preview keeps rendering.
  it('falls back to the default when the DB row contains an unrecognised previewStyle', async () => {
    await client.editorPreferences.create({
      data: {
        id: '550e8400-e29b-41d4-a716-446655440098',
        userId: userId.value,
        fontSize: 14,
        theme: 'default',
        previewStyle: 'totally-invalid-style',
      },
    });

    const retrieved = await repo.findByUserId(userId);
    expect(retrieved?.previewStyle.value).toBe('asciidocollab');
  });

  it('privateCommitEmail defaults to false when the column holds its default', async () => {
    const prefs = new EditorPreferences(
      EditorPreferencesId.create('550e8400-e29b-41d4-a716-446655440000'),
      userId,
      14,
      makeTheme('default'),
    );
    await repo.save(prefs);
    const retrieved = await repo.findByUserId(userId);
    expect(retrieved?.privateCommitEmail).toBe(false);
  });

  it('round-trips an enabled privateCommitEmail opt-in', async () => {
    const prefs = new EditorPreferences(
      EditorPreferencesId.create('550e8400-e29b-41d4-a716-446655440000'),
      userId,
      14,
      makeTheme('default'),
      false,
      undefined,
      true,
      makePreviewStyle('asciidocollab'),
      true,
      false,
      true,
    );
    await repo.save(prefs);
    const retrieved = await repo.findByUserId(userId);
    expect(retrieved?.privateCommitEmail).toBe(true);
  });
});
