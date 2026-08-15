import type { FastifyInstance } from 'fastify';
import {
  GetEditorPreferencesUseCase,
  SaveEditorPreferencesUseCase,
  UserId,
} from '@asciidocollab/domain';
import { PREVIEW_STYLE_VALUES } from '@asciidocollab/primitives';
import { getAuthenticatedUserId, requireAuth } from '../../../plugins/require-auth';
import type { EditorPreferencesDto } from '@asciidocollab/shared';

const putBodySchema = {
  type: 'object',
  required: ['fontSize', 'theme'],
  properties: {
    fontSize: { type: 'integer', minimum: 8, maximum: 32 },
    theme: { type: 'string', enum: ['default', 'high-contrast', 'dracula', 'tomorrow', 'espresso'] },
    scrollSyncEnabled: { type: 'boolean' },
    softWrap: { type: 'boolean' },
    // Derived from the single definition rather than restated: a hand-kept copy here is how the API
    // comes to reject a style the rest of the application already offers.
    previewStyle: { type: 'string', enum: [...PREVIEW_STYLE_VALUES] },
    spellcheckEnabled: { type: 'boolean' },
    minimapEnabled: { type: 'boolean' },
  },
  additionalProperties: false,
};

/** Registers GET and PUT routes for authenticated user editor preferences. */
export async function editorPreferencesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/auth/me/editor-preferences',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = UserId.create(getAuthenticatedUserId(request));
      const useCase = new GetEditorPreferencesUseCase(request.server.repos.editorPreferences);
      const result = await useCase.execute(userId);

      if (!result.success) {
        return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Could not retrieve preferences' } });
      }

      const dto: EditorPreferencesDto = {
        fontSize: result.value.fontSize,
        theme: result.value.theme.value,
        scrollSyncEnabled: result.value.scrollSyncEnabled,
        softWrap: result.value.softWrap,
        previewStyle: result.value.previewStyle.value,
        spellcheckEnabled: result.value.spellcheckEnabled,
        minimapEnabled: result.value.minimapEnabled,
      };
      return reply.status(200).send(dto);
    }
  );

  app.put<{ Body: { fontSize: number; theme: string; scrollSyncEnabled?: boolean; softWrap?: boolean; previewStyle?: string; spellcheckEnabled?: boolean; minimapEnabled?: boolean } }>(
    '/auth/me/editor-preferences',
    {
      preHandler: requireAuth,
      schema: { body: putBodySchema },
    },
    async (request, reply) => {
      const userId = UserId.create(getAuthenticatedUserId(request));
      const useCase = new SaveEditorPreferencesUseCase(request.server.repos.editorPreferences);
      const result = await useCase.execute(userId, {
        fontSize: request.body.fontSize,
        theme: request.body.theme,
        scrollSyncEnabled: request.body.scrollSyncEnabled,
        softWrap: request.body.softWrap,
        previewStyle: request.body.previewStyle,
        spellcheckEnabled: request.body.spellcheckEnabled,
        minimapEnabled: request.body.minimapEnabled,
      });

      if (!result.success) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: result.error.message } });
      }

      return reply.status(204).send();
    }
  );
}
