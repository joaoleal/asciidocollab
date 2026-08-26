import type { PrismaClient } from '@prisma/client';
import {
  Argon2PasswordHasher,
  HIBPBreachChecker,
  CommonPasswordFileChecker,
  StubEmailSender,
  NodemailerEmailSender,
  CryptoTokenGenerator,
  SessionEncryption,
  PrismaSessionStore,
  SmtpPasswordResetNotifier,
  SmtpEmailChangeNotifier,
  SmtpRegistrationInvitationNotifier,
  SmtpEmailVerificationNotifier,
  InMemoryActiveCloneRegistry,
  PrismaGitCredentialStore,
} from '@asciidocollab/infrastructure';
import type { EmailSender } from '@asciidocollab/domain';
import type { getConfig } from '../config';
import type { AppContainer } from '..';

/** Inputs required to construct the domain service container. */
export interface CreateServicesInput {
  /** The application configuration. */
  appConfig: ReturnType<typeof getConfig>;
  /** Prisma client used to construct the session store, or undefined when absent. */
  prisma: PrismaClient | undefined;
  /** Absolute path to the common-password list file. */
  commonPasswordsPath: string;
}

/**
 * Instantiates the full set of domain services (password hashing, breach
 * checking, email sending, token generation, session encryption and notifiers).
 *
 * @param input - The configuration, Prisma client and data-file path.
 * @returns The services container decorated onto the Fastify instance.
 */
export function createServices(input: CreateServicesInput): AppContainer['services'] {
  const { appConfig, prisma, commonPasswordsPath } = input;

  const passwordHasher = new Argon2PasswordHasher({
    memoryCost: appConfig.auth.password.hashMemory,
    timeCost: appConfig.auth.password.hashTime,
    parallelism: appConfig.auth.password.hashParallelism,
  });

  const breachChecker = new HIBPBreachChecker({
    hibpApiUrl: appConfig.auth.breachCheck.hibpApiUrl,
  });

  const commonPasswordChecker = new CommonPasswordFileChecker(commonPasswordsPath);

  let emailSender: EmailSender;
  if (appConfig.auth.email.enabled) {
    if (!appConfig.auth.email.from) {
      throw new Error('ASCIIDOCOLLAB_AUTH_EMAIL_FROM is required when email is enabled');
    }
    emailSender = new NodemailerEmailSender({
      enabled: appConfig.auth.email.enabled,
      host: appConfig.auth.email.smtpHost,
      port: appConfig.auth.email.smtpPort,
      user: appConfig.auth.email.smtpUser,
      password: appConfig.auth.email.smtpPassword,
      from: appConfig.auth.email.from,
    });
  } else {
    emailSender = new StubEmailSender();
  }

  const tokenGenerator = new CryptoTokenGenerator({
    tokenByteLength: appConfig.auth.passwordReset.tokenByteLength,
    tokenExpiry: appConfig.auth.passwordReset.tokenExpiry,
  });

  const sessionEncryption = new SessionEncryption({
    encryptionKey: appConfig.auth.session.encryptionKey,
  });

  const prismaSessionStore = prisma
    ? new PrismaSessionStore(prisma, sessionEncryption)
    : undefined;

  // A dedicated encryption instance, keyed with the dedicated git.credentialEncryptionKey
  // (never the session key above): isolates a leaked session key from also decrypting stored
  // git access tokens.
  const gitCredentialEncryption = new SessionEncryption({
    encryptionKey: appConfig.git.credentialEncryptionKey,
  });

  const gitCredentialStore = prisma
    ? new PrismaGitCredentialStore(prisma, gitCredentialEncryption)
    : undefined;

  // Another dedicated instance, keyed with git.oauth.stateEncryptionKey — encrypts/decrypts the
  // OAuth guided-connect flow's stateless `state` parameter (never the session or credential key).
  // Config loading (`assertGitOAuthConfigConsistent`) already guarantees this key is set whenever
  // any provider's OAuth is actually configured, so an empty key here only ever occurs when OAuth is
  // unavailable everywhere and this instance is never exercised.
  const gitOAuthStateEncryption = new SessionEncryption({
    encryptionKey: appConfig.git.oauth.stateEncryptionKey,
  });

  const passwordResetNotifier = new SmtpPasswordResetNotifier(
    emailSender,
    appConfig.auth.email.templates.resetRequest.subject,
    appConfig.auth.email.templates.resetRequest.html.replaceAll('{frontendUrl}', appConfig.api.frontendUrl),
  );

  const emailChangeNotifier = new SmtpEmailChangeNotifier(
    emailSender,
    appConfig.auth.email.templates.emailChangeRequest.subject,
    appConfig.auth.email.templates.emailChangeRequest.html.replaceAll('{frontendUrl}', appConfig.api.frontendUrl),
  );

  const registrationInvitationNotifier = new SmtpRegistrationInvitationNotifier(
    emailSender,
    appConfig.auth.invitation.subject,
    appConfig.auth.invitation.htmlTemplate.replaceAll('{frontendUrl}', appConfig.api.frontendUrl),
  );

  const emailVerificationNotifier = new SmtpEmailVerificationNotifier(
    emailSender,
    appConfig.auth.emailVerification.subject,
    appConfig.auth.emailVerification.htmlTemplate.replaceAll('{frontendUrl}', appConfig.api.frontendUrl),
    appConfig.auth.emailVerification.resendSubject,
    appConfig.auth.emailVerification.resendHtmlTemplate.replaceAll('{frontendUrl}', appConfig.api.frontendUrl),
  );

  // Built here and nowhere else: the clone use case is constructed per request,
  // so the one-clone-per-user guard only holds if the registry outlives the use
  // case. The composition root owns that lifetime — a module-level instance would
  // be a static singleton shared by every server in the process instead.
  const activeCloneRegistry = new InMemoryActiveCloneRegistry();

  return {
    passwordHasher,
    breachChecker,
    commonPasswordChecker,
    emailSender,
    tokenGenerator,
    sessionEncryption,
    prismaSessionStore,
    passwordResetNotifier,
    emailChangeNotifier,
    registrationInvitationNotifier,
    emailVerificationNotifier,
    activeCloneRegistry,
    gitCredentialStore,
    gitOAuthStateEncryption,
  };
}
