import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaCollaborationSessionRepository,
  FilesystemYjsStateStore,
  FilesystemProjectFileStore,
  PrismaSystemSettingRepository,
  PrismaDocumentRepository,
  PrismaFileNodeRepository,
  PrismaReviewCommentRepository,
  Re2RegexEngine,
} from '@asciidocollab/infrastructure';
import { OpenCollaborationSessionUseCase, CloseCollaborationSessionUseCase } from '@asciidocollab/domain';
import { PersistenceExtension } from './extensions/persistence.js';
import { AuthHookExtension } from './extensions/auth-hook.js';
import { ConnectionLimitExtension } from './extensions/connection-limit.js';
import { ChangeNotifierExtension } from './extensions/change-notifier.js';
import { ReviewAnchorHintExtension } from './extensions/review-anchor-hints.js';
import { createMtlsFetch } from './extensions/mtls-fetch.js';
import { createCollabServer } from './server.js';
import { createCollabConfig } from './config/collab-config.js';
import pino from 'pino';

/** Wires up all dependencies and returns the configured server and its supporting objects. */
export async function compositionRoot() {
  const config = createCollabConfig();
  config.validate({ allowed: 'strict' });

  const prisma = new PrismaClient({ adapter: new PrismaPg(config.get('databaseUrl')) });

  const storagePath = config.get('storagePath');

  const collaborationSessionRepo = new PrismaCollaborationSessionRepository(prisma);
  const yjsStateStore = new FilesystemYjsStateStore(storagePath);
  const projectFileStore = new FilesystemProjectFileStore(storagePath);
  const systemSettingRepo = new PrismaSystemSettingRepository(prisma);
  const documentRepository = new PrismaDocumentRepository(prisma);
  const fileNodeRepository = new PrismaFileNodeRepository(prisma);
  const reviewCommentRepository = new PrismaReviewCommentRepository(prisma);

  const openCollaborationSessionUseCase = new OpenCollaborationSessionUseCase();
  const closeCollaborationSessionUseCase = new CloseCollaborationSessionUseCase();

  // Linear-time (RE2) engine shared by the structured find/replace apply so it
  // re-matches live content with exactly the same semantics as the API search.
  const regexEngine = new Re2RegexEngine();

  const logger = pino({ redact: ['req.headers.cookie', 'req.headers.Cookie'] });

  const tlsCert = config.get('apiInternalTls.cert');
  const tlsKey = config.get('apiInternalTls.key');
  const tlsCa = config.get('apiInternalTls.ca');
  const mtlsFetch = tlsCert && tlsKey && tlsCa
    ? createMtlsFetch(readFileSync(tlsCert), readFileSync(tlsKey), readFileSync(tlsCa))
    : undefined;

  const allowedOrigins = config
    .get('allowedOrigins')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const authHookExtension = new AuthHookExtension({
    apiInternalUrl: config.get('apiInternalUrl'),
    authTimeoutMs: config.get('authTimeoutMs'),
    logger,
    allowedOrigins,
    ...(mtlsFetch && { fetch: mtlsFetch }),
  });

  // Runs after the auth hook (which sets context.userId) and before persistence.
  const connectionLimitExtension = new ConnectionLimitExtension({
    maxConnectionsPerUser: config.get('maxConnectionsPerUser'),
    maxRoomsPerUser: config.get('maxRoomsPerUser'),
    connectRatePerMin: config.get('connectRatePerMin'),
    logger,
  });

  const persistenceExtension = new PersistenceExtension(
    yjsStateStore,
    projectFileStore,
    documentRepository,
    fileNodeRepository,
  );

  // Re-measures each review anchor's stored line hint on write-back, so the cross-file comments &
  // tasks panel (which has no loaded Y.Doc for the files it lists) orders by where anchors ARE rather
  // than where they were when the comment was written. Best-effort and registered AFTER persistence
  // so the authoritative content writes always land first.
  const reviewAnchorHintExtension = new ReviewAnchorHintExtension({
    reviewCommentRepo: reviewCommentRepository,
    documentRepo: documentRepository,
    logger,
  });

  // Notifies the API of live edits so open dependent documents recompute. Best-effort, off the
  // Yjs hot path; reuses the same mTLS transport as the auth hook when configured.
  const changeNotifierExtension = new ChangeNotifierExtension({
    apiInternalUrl: config.get('apiInternalUrl'),
    notifyPath: config.get('contentChangedNotifyPath'),
    debounceMs: config.get('contentChangedDebounceMs'),
    logger,
    ...(mtlsFetch && { fetch: mtlsFetch }),
  });

  const server = await createCollabServer(
    { port: config.get('port'), maxPayloadBytes: config.get('maxPayloadBytes'), logger },
    [
      authHookExtension,
      connectionLimitExtension,
      persistenceExtension,
      reviewAnchorHintExtension,
      changeNotifierExtension,
    ],
    systemSettingRepo,
    {
      onRoomOpen: (projectId, documentId) =>
        openCollaborationSessionUseCase.execute(projectId, documentId, collaborationSessionRepo),
      onRoomClose: (projectId, documentId) =>
        closeCollaborationSessionUseCase.execute(projectId, documentId, collaborationSessionRepo),
    },
    documentRepository,
  );

  return {
    server,
    prisma,
    collaborationSessionRepo,
    documentRepository,
    // Exposed so the internal edit server's read endpoint can decode a dormant room's persisted state.
    yjsStateStore,
    // Exposed so the internal structured-apply endpoint re-matches with the same engine as search.
    regexEngine,
    openCollaborationSessionUseCase,
    closeCollaborationSessionUseCase,
    config,
    // Exposed so startup can verify shared storage with the API over the same (optionally mTLS) channel.
    mtlsFetch,
  };
}
