import type { FastifyInstance } from 'fastify';
import { Email, LoginUseCase } from '@asciidocollab/domain';
import { requestContextFrom } from '../../lib/request-context';
import { requestLogger } from '../../lib/request-logger';
import { ensureDemoProjectMembership } from '../../bootstrap/demo-project';
import '../../types/session';
import type { LoginDto, AuthSuccessResponseDto, AuthErrorResponseDto } from '@asciidocollab/shared';

/**
 * Registers the login route.
 *
 * Audit/telemetry is recorded inside `LoginUseCase` (the domain owns both the
 * recording and the constant-time window), so the route only authenticates,
 * sets the session, and responds.
 *
 * @param app - The Fastify instance to register the route on.
 */
export async function loginRoute(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', {
    config: {
      rateLimit: {
        max: app.config.auth.login.rateLimitMax,
        timeWindow: app.config.auth.login.rateLimitWindow,
      },
    },
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request: import('fastify').FastifyRequest<{ Body: LoginDto }>, reply) => {
    const { email, password } = request.body;

    const useCase = new LoginUseCase(
      request.server.repos.user,
      request.server.services.passwordHasher,
      request.server.repos.auditLog,
      request.server.repos.authAttemptTelemetry,
      requestLogger(request),
    );
    const result = await useCase.execute(
      Email.create(email),
      password,
      requestContextFrom(request),
      request.server.config.failedSignIn.coalesceWindowMinutes * 60_000,
    );

    if (!result.success) {
      return reply.status(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      } satisfies AuthErrorResponseDto);
    }

    request.session.userId = result.value.userId;
    request.session.emailVerified = result.value.emailVerified;
    request.session.isAdmin = result.value.isAdmin;

    // Ensure every user can read the bundled demo project. Login is the universal
    // choke point (all users authenticate however they were provisioned), so this
    // covers accounts created since the last start-up backfill. Best-effort — it
    // never throws, so a demo-access hiccup cannot fail an otherwise valid login.
    await ensureDemoProjectMembership(
      { repos: { project: request.server.repos.project, projectMember: request.server.repos.projectMember }, logger: request.log },
      result.value.userId,
    );

    return reply.status(200).send({ message: 'Authenticated' } satisfies AuthSuccessResponseDto);
  });
}
