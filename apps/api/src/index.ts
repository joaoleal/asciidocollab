import Fastify from 'fastify';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type {
  SessionEncryption,
  PrismaSessionStore,
} from '@asciidocollab/infrastructure';
import type {
  UserRepository,
  ProjectRepository,
  FileNodeRepository,
  DocumentRepository,
  ProjectMemberRepository,
  GitRepositoryRepository,
  GitOperationRepository,
  GitCredentialStore,
  TemplateRepository,
  AssetRepository,
  AuditLogRepository,
  AuthAttemptTelemetryRepository,
  PasswordResetTokenRepository,
  EmailChangeTokenRepository,
  UserInvitationRepository,
  EmailVerificationTokenRepository,
  SystemSettingRepository,
  SessionRepository,
  KeyBindingRepository,
  EditorPreferencesRepository,
  CollaborationSessionRepository,
  ProjectRenderConfigRepository,
  ProjectDictionaryRepository,
  IgnoredLintRepository,
  ReviewCommentRepository,
  ReviewReactionRepository,
  ProjectFileStore,
  YjsStateStore,
  CollaborativeContentEditor,
  CollaborativeContentReader,
  StructuredCollaborativeEditor,
  RegexEngine,
  PdfExtensionSourcePort,
  PasswordHasher,
  BreachChecker,
  CommonPasswordChecker,
  EmailSender,
  TokenGenerator,
  PasswordResetNotifier,
  EmailChangeNotifier,
  RegistrationInvitationNotifier,
  EmailVerificationNotifier,
  ActiveCloneRegistry,
} from '@asciidocollab/domain';
import { loadConfig, getConfig } from './config';
import { createRepositories } from './di/repositories';
import { createStores } from './di/stores';
import { createServices } from './di/services';
import { registerPlugins } from './di/plugins';
import { registerRoutes } from './di/routes';
import { createInternalServer } from './internal-server';
import { provisionDemoProject } from './bootstrap/demo-project';

/** Dependency container passed to `buildServer` to wire repositories and services. */
export interface AppContainer {
  /** Prisma client instance used to construct repositories. */
  prisma: PrismaClient;
  /** Collection of domain repository implementations. */
  repos: {
    /** Repository for user persistence. */
    user: UserRepository;
    /** Repository for project persistence. */
    project: ProjectRepository;
    /** Repository for file-node persistence. */
    fileNode: FileNodeRepository;
    /** Repository for document persistence. */
    document: DocumentRepository;
    /** Repository for project-member persistence. */
    projectMember: ProjectMemberRepository;
    /** Repository for git-repository persistence. */
    gitRepository: GitRepositoryRepository;
    /** Repository for whole-project git operations: the durable work-list, single-flight guard, and write-lock check. */
    gitOperation: GitOperationRepository;
    /** Repository for template persistence. */
    template: TemplateRepository;
    /** Repository for asset persistence. */
    asset: AssetRepository;
    /** Repository for audit-log persistence. */
    auditLog: AuditLogRepository;
    /** Repository for failed sign-in telemetry persistence. */
    authAttemptTelemetry: AuthAttemptTelemetryRepository;
    /** Repository for password-reset-token persistence. */
    passwordResetToken: PasswordResetTokenRepository;
    /** Repository for email-change-token persistence. */
    emailChangeToken: EmailChangeTokenRepository;
    /** Repository for user-invitation persistence. */
    userInvitation: UserInvitationRepository;
    /** Repository for email-verification-token persistence. */
    emailVerificationToken: EmailVerificationTokenRepository;
    /** Repository for system-setting persistence. */
    systemSetting: SystemSettingRepository;
    /** Repository for session persistence. */
    session: SessionRepository;
    /** Repository for user key bindings. */
    keyBinding: KeyBindingRepository;
    /** Repository for editor preferences. */
    editorPreferences: EditorPreferencesRepository;
    /** Repository for active collaboration sessions. */
    collaborationSession: CollaborationSessionRepository;
    /** Repository for project render-config persistence. */
    projectRenderConfig: ProjectRenderConfigRepository;
    /** Repository for the project's shared grammar dictionary. */
    projectDictionary: ProjectDictionaryRepository;
    /** Repository for per-user, per-document ignored grammar lints. */
    ignoredLint: IgnoredLintRepository;
    /** Repository for review comments/tasks persistence. */
    reviewComment: ReviewCommentRepository;
    /** Repository for review reactions persistence. */
    reviewReaction: ReviewReactionRepository;
  };
  /** Storage adapters for file and Yjs state persistence. */
  stores?: {
    /** Filesystem-backed store for user-visible project files. */
    fileStore: ProjectFileStore;
    /** Filesystem-backed store for Yjs collaborative state. */
    yjsStateStore: YjsStateStore;
    /** Applies content edits to / reads live content from collaborative documents (Yjs source of truth). */
    collaborativeContentEditor: CollaborativeContentEditor & CollaborativeContentReader;
    /** Applies selection-/regex-aware structured replacements to collaborative documents. */
    structuredCollaborativeEditor: StructuredCollaborativeEditor;
    /** Linear-time (RE2) engine for compiling and matching untrusted user regexes. */
    regexEngine: RegexEngine;
    /** Reads administrator-provided PDF converter extensions; the only route to that folder. */
    pdfExtensionSource: PdfExtensionSourcePort;
  };
  /** Collection of domain service implementations. */
  services: {
    /** Service for hashing and verifying passwords. */
    passwordHasher: PasswordHasher;
    /** Service for checking passwords against breach databases. */
    breachChecker: BreachChecker;
    /** Service for checking passwords against a common-password list. */
    commonPasswordChecker: CommonPasswordChecker;
    /** Service for sending transactional emails. */
    emailSender: EmailSender;
    /** Service for generating cryptographic tokens. */
    tokenGenerator: TokenGenerator;
    /** Service for encrypting and decrypting session data. */
    sessionEncryption: SessionEncryption;
    /** Prisma-backed session store for use with the auth plugin. Undefined if SESSION_SECRET is not set. */
    prismaSessionStore: PrismaSessionStore | undefined;
    /** Notifier for password-reset emails. */
    passwordResetNotifier: PasswordResetNotifier;
    /** Notifier for email-change confirmation emails. */
    emailChangeNotifier: EmailChangeNotifier;
    /** Notifier for registration-invitation emails. */
    registrationInvitationNotifier: RegistrationInvitationNotifier;
    /** Notifier for email-verification emails. */
    emailVerificationNotifier: EmailVerificationNotifier;
    /** Bounds each user to one clone in flight; shared by every request this server serves. */
    activeCloneRegistry: ActiveCloneRegistry;
    /**
     * Store for the encrypted per-project git credential, keyed with the dedicated
     * `git.credentialEncryptionKey` (never the session encryption key). Undefined when no
     * Prisma client is configured.
     */
    gitCredentialStore: GitCredentialStore | undefined;
  };
}

/**
 * Builds and configures the Fastify server instance.
 *
 * @param overrides - Optional dependency overrides for testing.
 * @returns A configured Fastify instance ready to listen.
 */
export async function buildServer(overrides?: Partial<AppContainer>) {
  const appConfig = getConfig();

  const app = Fastify({
    // Behind a TLS-terminating reverse proxy this MUST be on, and it must be set
    // here rather than only read by individual plugins: Fastify derives
    // `request.protocol` and `request.ip` from X-Forwarded-* only when it is.
    //
    // Two things break silently without it:
    //   * @fastify/session refuses to issue a cookie marked `secure` unless
    //     `request.protocol === 'https'`, so login returns 200 with no
    //     Set-Cookie and the user can never authenticate;
    //   * every request appears to come from the proxy's address, so per-IP rate
    //     limits collapse into one shared bucket for all users.
    trustProxy: appConfig.api.trustProxy,
    logger: {
      level: 'info',
      redact: ['req.headers.cookie', 'req.body.password', 'req.body.currentPassword', 'req.body.newPassword', 'req.body.token', 'req.body.email'],
    },
  });

  app.decorate('config', appConfig);

  if (overrides?.prisma) {
    app.decorate('prisma', overrides.prisma);
  }

  if (overrides?.repos) {
    app.decorate('repos', overrides.repos);
  } else if (app.prisma) {
    app.decorate('repos', createRepositories(app.prisma));
  }

  if (overrides?.stores) {
    app.decorate('stores', overrides.stores);
  } else {
    app.decorate('stores', createStores(appConfig));
  }

  if (overrides?.services) {
    app.decorate('services', overrides.services);
  } else {
    app.decorate(
      'services',
      createServices({
        appConfig,
        prisma: app.prisma,
        commonPasswordsPath: path.join(__dirname, '..', 'data', 'common-passwords.txt'),
      }),
    );
  }

  await registerPlugins(app);

  return app;
}

/**
 * Registers all application routes on a fully-built server instance.
 * Called from `start()` in production; separate to allow tests to register
 * routes individually without conflicts.
 */
export async function registerAllRoutes(app: Awaited<ReturnType<typeof buildServer>>): Promise<void> {
  await registerRoutes(app);
}

async function start() {
  const configDirectory = path.join(__dirname, '..', 'config');
  loadConfig(configDirectory);

  const appConfig = getConfig();
  const databaseUrl = process.env.ASCIIDOCOLLAB_DATABASE_URL ?? 'postgresql://localhost:5432/dev';
  const prisma = new PrismaClient({ adapter: new PrismaPg(databaseUrl) });
  const app = await buildServer({ prisma });
  await registerAllRoutes(app);

  // Seed (once) and reconcile the bundled read-only demo project, and grant read
  // access to existing users. Runs before we start listening so the tour is in
  // place the first time anyone loads the dashboard after an upgrade. It never
  // throws — a demo must not be able to block the API from booting.
  if (app.stores) {
    await provisionDemoProject({
      repos: {
        project: app.repos.project,
        projectMember: app.repos.projectMember,
        fileNode: app.repos.fileNode,
        document: app.repos.document,
        asset: app.repos.asset,
        projectRenderConfig: app.repos.projectRenderConfig,
        projectDictionary: app.repos.projectDictionary,
        systemSetting: app.repos.systemSetting,
      },
      fileStore: app.stores.fileStore,
      prisma,
      dataDir: path.join(__dirname, '..', 'data', 'demo-project'),
      logger: app.log,
    });
  }

  await app.listen({ port: appConfig.api.port, host: appConfig.api.host });

  const internalServer = await createInternalServer({
    prisma,
    repos: app.repos,
    services: app.services,
    config: appConfig,
    fileTreeEventBus: app.fileTreeEventBus,
  });

  await internalServer.listen({
    port: appConfig.collab.internalPort,
    host: appConfig.collab.internalHost,
  });

  const shutdown = async () => {
    await internalServer.close();
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (require.main === module) {
  start().catch((error) => {
    process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    config: ReturnType<typeof getConfig>;
    prisma: PrismaClient;
    repos: {
      user: UserRepository;
      project: ProjectRepository;
      fileNode: FileNodeRepository;
      document: DocumentRepository;
      projectMember: ProjectMemberRepository;
      gitRepository: GitRepositoryRepository;
      gitOperation: GitOperationRepository;
      template: TemplateRepository;
      asset: AssetRepository;
      auditLog: AuditLogRepository;
      authAttemptTelemetry: AuthAttemptTelemetryRepository;
      passwordResetToken: PasswordResetTokenRepository;
      emailChangeToken: EmailChangeTokenRepository;
      userInvitation: UserInvitationRepository;
      emailVerificationToken: EmailVerificationTokenRepository;
      systemSetting: SystemSettingRepository;
      session: SessionRepository;
      keyBinding: KeyBindingRepository;
      editorPreferences: EditorPreferencesRepository;
      collaborationSession: CollaborationSessionRepository;
      reviewComment: ReviewCommentRepository;
      reviewReaction: ReviewReactionRepository;
      projectRenderConfig: ProjectRenderConfigRepository;
      projectDictionary: ProjectDictionaryRepository;
      ignoredLint: IgnoredLintRepository;
    };
    stores: {
      fileStore: ProjectFileStore;
      yjsStateStore: YjsStateStore;
      collaborativeContentEditor: CollaborativeContentEditor & CollaborativeContentReader;
      structuredCollaborativeEditor: StructuredCollaborativeEditor;
      regexEngine: RegexEngine;
    /** Reads administrator-provided PDF converter extensions; the only route to that folder. */
    pdfExtensionSource: PdfExtensionSourcePort;
    };
    services: {
      passwordHasher: PasswordHasher;
      breachChecker: BreachChecker;
      commonPasswordChecker: CommonPasswordChecker;
      emailSender: EmailSender;
      tokenGenerator: TokenGenerator;
      sessionEncryption: SessionEncryption;
      prismaSessionStore: PrismaSessionStore | undefined;
      passwordResetNotifier: PasswordResetNotifier;
      emailChangeNotifier: EmailChangeNotifier;
      registrationInvitationNotifier: RegistrationInvitationNotifier;
      emailVerificationNotifier: EmailVerificationNotifier;
      activeCloneRegistry: ActiveCloneRegistry;
      gitCredentialStore: GitCredentialStore | undefined;
    };
  }
}
