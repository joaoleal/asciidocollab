import type { FastifyInstance } from 'fastify';
import { Email, RegisterUseCase, RegistrationClosedError } from '@asciidocollab/domain';
import { buildPasswordPolicy } from '../../services/password-policy';
import { requestContextFrom } from '../../lib/request-context';
import { requestLogger } from '../../lib/request-logger';
import { ensureDemoProjectMembership } from '../../bootstrap/demo-project';
import '../../types/session';
import type { RegisterDto, AuthSuccessResponseDto, AuthErrorResponseDto } from '@asciidocollab/shared';

/** Registers the user registration route on the Fastify instance. */
export async function registerRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RegisterDto }>('/auth/register', {
    config: {
      rateLimit: {
        max: app.config.auth.registration.rateLimitMax,
        timeWindow: app.config.auth.registration.rateLimitWindow,
      },
    },
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password', 'displayName'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 254 },
          password: { type: 'string', minLength: 1 },
          displayName: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const { email, password, displayName } = request.body;

    const useCase = new RegisterUseCase(
      request.server.repos.user,
      request.server.repos.systemSetting,
      request.server.repos.emailVerificationToken,
      buildPasswordPolicy(),
      request.server.services.commonPasswordChecker,
      request.server.services.breachChecker,
      request.server.services.passwordHasher,
      request.server.services.tokenGenerator,
      request.server.services.emailVerificationNotifier,
      request.server.repos.auditLog,
      requestLogger(request),
    );

    const result = await useCase.execute(Email.create(email), displayName, password, requestContextFrom(request));

    if (!result.success) {
      if (result.error instanceof RegistrationClosedError) {
        return reply.status(403).send({
          error: { code: 'REGISTRATION_CLOSED', message: 'Registration is closed' },
        } satisfies AuthErrorResponseDto);
      }
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: result.error.message },
      } satisfies AuthErrorResponseDto);
    }

    if (result.value.isFirstUser) {
      // First admin: auto-verify and auto-login
      request.session.userId = result.value.userId.value;
      request.session.emailVerified = true;
      request.session.isAdmin = true;
      // The first admin is auto-logged-in without hitting /auth/login, so grant
      // demo read access here too. Later self-registered users pass through
      // /auth/login after verifying their email, where the same hook runs.
      await ensureDemoProjectMembership(
        { repos: { project: request.server.repos.project, projectMember: request.server.repos.projectMember }, logger: request.log },
        result.value.userId.value,
      );
      return reply.status(201).send({ message: 'Account created' } satisfies AuthSuccessResponseDto);
    }

    if (result.value.emailSent) {
      // New self-registered user: verification email was dispatched
      return reply.status(202).send({ message: 'Check your email to verify your account', requiresEmailVerification: true });
    }

    // Anti-enumeration: duplicate email — no email sent; do not tell the frontend
    // to "check your email" for a message that will never arrive.
    return reply.status(202).send({ message: 'If this address is not yet registered, you will receive a verification link.' });
  });
}
