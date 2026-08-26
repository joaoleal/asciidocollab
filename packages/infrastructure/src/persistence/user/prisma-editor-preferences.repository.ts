import type { PrismaClient } from '@prisma/client';
import {
  EditorPreferences,
  EditorPreferencesId,
  EditorTheme,
  PreviewStyle,
  UserId,
  Timestamps,
} from '@asciidocollab/domain';
import type { EditorPreferencesRepository } from '@asciidocollab/domain';

/** Prisma-backed implementation of EditorPreferencesRepository. */
export class PrismaEditorPreferencesRepository implements EditorPreferencesRepository {
  /** @param prisma - The Prisma client instance. */
  constructor(private readonly prisma: PrismaClient) {}

  /** @inheritdoc */
  async findByUserId(userId: UserId): Promise<EditorPreferences | null> {
    const row = await this.prisma.editorPreferences.findUnique({
      where: { userId: userId.value },
    });
    if (!row) return null;
    return this.toDomain(row);
  }

  /** @inheritdoc */
  async save(prefs: EditorPreferences): Promise<void> {
    await this.prisma.editorPreferences.upsert({
      where: { userId: prefs.userId.value },
      update: { fontSize: prefs.fontSize, theme: prefs.theme.value, scrollSyncEnabled: prefs.scrollSyncEnabled, softWrap: prefs.softWrap, previewStyle: prefs.previewStyle.value, spellcheckEnabled: prefs.spellcheckEnabled, minimapEnabled: prefs.minimapEnabled, privateCommitEmail: prefs.privateCommitEmail },
      create: {
        id: prefs.id.value,
        userId: prefs.userId.value,
        fontSize: prefs.fontSize,
        theme: prefs.theme.value,
        scrollSyncEnabled: prefs.scrollSyncEnabled,
        softWrap: prefs.softWrap,
        previewStyle: prefs.previewStyle.value,
        spellcheckEnabled: prefs.spellcheckEnabled,
        minimapEnabled: prefs.minimapEnabled,
        privateCommitEmail: prefs.privateCommitEmail,
      },
    });
  }

  private toDomain(row: {
    id: string;
    userId: string;
    fontSize: number;
    theme: string;
    scrollSyncEnabled: boolean;
    softWrap: boolean;
    previewStyle: string;
    spellcheckEnabled: boolean;
    minimapEnabled: boolean;
    privateCommitEmail: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): EditorPreferences {
    const themeResult = EditorTheme.parse(row.theme);
    if (!themeResult.success) {
      throw new Error(`EditorPreferences row ${row.id} has unrecognised theme "${row.theme}": ${themeResult.error.message}`);
    }
    // A corrupt/unknown stored preview style must not break rendering — fall back to the
    // default rather than throwing, unlike the stricter handling of `theme`.
    const previewStyle = PreviewStyle.parseOrDefault(row.previewStyle);
    return new EditorPreferences(
      EditorPreferencesId.create(row.id),
      UserId.create(row.userId),
      row.fontSize,
      themeResult.value,
      row.scrollSyncEnabled,
      new Timestamps(row.createdAt, row.updatedAt),
      row.softWrap,
      previewStyle,
      row.spellcheckEnabled,
      row.minimapEnabled,
      row.privateCommitEmail,
    );
  }
}
