import convict from 'convict';
import { DEFAULT_ALLOWED_GIT_HOSTS } from '../git/egress-allowlist.js';

/** Validates that `value` is a positive (non-zero) integer — bounds the run loop's timings so none can be misconfigured to 0 (busy-spin) or negative. */
function positiveInt(value: unknown): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('must be a positive integer');
  }
}

/**
 * Convict format for a comma-separated list of strings — environment variables carry a single
 * string, so an array-valued field (here, the git egress host allowlist) needs `coerce` to split
 * `"a.com,b.com"` into `['a.com', 'b.com']`. A programmatic/config-file default is already an
 * array and passes through `coerce` unchanged (it only touches strings). Entries are trimmed;
 * empty entries (an empty string, or a trailing/doubled comma) are dropped.
 */
convict.addFormat({
  name: 'comma-separated-strings',
  coerce: (value: unknown) => {
    if (typeof value !== 'string') return value;
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  },
  validate: (value: unknown) => {
    if (!Array.isArray(value)) throw new TypeError('must be an array of strings');
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new TypeError('must be an array of non-empty strings');
      }
    }
  },
});

/** Typed configuration interface for the git-worker application. */
export interface GitWorkerConfig {
  /**
   * Root directory for per-project file storage, shared with `apps/api` and `apps/collab`. Each
   * project's git working tree lives at `<storageRoot>/<projectId>/`.
   */
  storageRoot: string;

  /**
   * Root directory for the CONTENT-BYTES projection of project files — what a `ProjectFileStore`
   * reads and writes, and what `apps/api`/`apps/collab` serve file content from. This is a
   * DIFFERENT concern from `storageRoot` above (this worker's own git working-tree root): an
   * import writes the cloned bytes through this path, not through the working tree. It MUST
   * resolve to the exact same filesystem location as `apps/api`'s `storage.path`
   * (`apps/api/src/config/schema-storage.ts`), or a worker-imported file lands somewhere the rest
   * of the application can never read it back from — hence it is wired to the same
   * `ASCIIDOCOLLAB_STORAGE_PATH` environment variable that config reads, so the two can never
   * drift apart by default. Deliberately its own config key rather than a reuse of `storageRoot`,
   * so the two concerns stay independently nameable even though they coincide today.
   */
  contentStorageRoot: string;

  /** PostgreSQL connection URL, shared with `apps/api`, `apps/collab`, and `packages/db`. */
  databaseUrl: string;

  /**
   * Base64-encoded 32-byte AES-256-GCM key used to decrypt stored git credential tokens. Must
   * match `apps/api`'s `git.credentialEncryptionKey` — the same ciphertext is written by the API
   * and read back here at job execution time.
   */
  credentialEncryptionKey: string;

  /** How long the run loop sleeps between claim attempts when there is nothing queued to claim. */
  pollIntervalMs: number;

  /** How often a running job refreshes its `GitOperation` heartbeat while it executes. */
  heartbeatIntervalMs: number;

  /**
   * How long a `RUNNING` operation may go without a heartbeat before `claimNextQueued` treats its
   * worker as crashed and reclaims the operation.
   */
  staleHeartbeatAfterMs: number;

  /**
   * Hostnames this worker's git network operations are permitted to reach (`git.egress.allowedHosts`,
   * shared with `apps/api`) — deny-by-default; a remote whose host is not here is rejected before
   * any network attempt. Defaults cover the supported providers (GitHub, GitLab, Bitbucket).
   */
  egressAllowedHosts: string[];

  /**
   * Configuration for reaching the collab server's internal edit endpoint — used by
   * `CommitChangesUseCase` to read (and by a future flush) each staged open document's current
   * collaborative text before recording a commit. Field shapes and env var names copy
   * `apps/api`'s `collab.editUrl`/`editSecret`/`editTls` (`apps/api/src/config/schema-collab.ts`)
   * exactly, so the worker and the API read identical values.
   */
  collab: {
    /** Base URL of the collab server's internal edit endpoint. */
    editUrl: string;
    /** Optional shared secret sent to the collab edit endpoint (must match the collab server's). */
    editSecret: string;
    /** Client mTLS material for the collab edit endpoint. All fields empty disables mTLS (loopback HTTP). */
    editTls: {
      /** Path to the PEM file containing the client certificate presented to the collab edit server. */
      cert: string;
      /** Path to the PEM file containing the client private key. */
      key: string;
      /** Path to the PEM file containing the CA certificate used to verify the collab edit server. */
      ca: string;
    };
  };

  /** Interface the internal git-ops RPC server binds to (loopback by default for safety). */
  internalGitHost: string;
  /** Port for the internal HTTP server the API calls to run git short ops (status, stage, unstage, commit). */
  internalGitPort: number;
  /** Optional shared secret enforced on the internal git-ops endpoint. Empty disables the check (loopback-trust, development only — set this in production). */
  internalGitSecret: string;
  /** Server mTLS material for the internal git-ops endpoint. All fields empty disables mTLS (loopback HTTP). */
  internalGitTls: {
    /** Path to the PEM file containing the server certificate. */
    cert: string;
    /** Path to the PEM file containing the server private key. */
    key: string;
    /** Path to the PEM file containing the CA certificate used to verify the API client certificate. */
    clientCa: string;
  };
}

/** Creates a new convict configuration instance for the git-worker application. */
export function createGitWorkerConfig() {
  return convict<GitWorkerConfig>({
    storageRoot: {
      doc: "Root directory for per-project file storage (shared with apps/api and apps/collab). Each project's git working tree lives at `<storageRoot>/<projectId>/`.",
      format: String,
      default: './storage',
      env: 'ASCIIDOCOLLAB_STORAGE_PATH',
    },
    contentStorageRoot: {
      doc: "Root directory for the content-bytes projection of project files (what ProjectFileStore reads/writes). MUST match apps/api's storage.path exactly — wired to the same ASCIIDOCOLLAB_STORAGE_PATH env var so it cannot drift from storageRoot or from apps/api's own configuration.",
      format: String,
      default: './storage',
      env: 'ASCIIDOCOLLAB_STORAGE_PATH',
    },
    databaseUrl: {
      doc: 'PostgreSQL connection URL.',
      format: String,
      default: '',
      sensitive: true,
      env: 'ASCIIDOCOLLAB_DATABASE_URL',
    },
    credentialEncryptionKey: {
      doc: "AES-256-GCM key (base64, 32 bytes) for decrypting stored git credential tokens. Must match apps/api's git.credentialEncryptionKey (e.g. openssl rand -base64 32).",
      format: String,
      default: '',
      sensitive: true,
      env: 'ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY',
    },
    pollIntervalMs: {
      doc: 'Milliseconds the run loop sleeps between claim attempts when there is nothing queued.',
      format: positiveInt,
      default: 2000,
      env: 'ASCIIDOCOLLAB_GIT_WORKER_POLL_INTERVAL_MS',
    },
    heartbeatIntervalMs: {
      doc: 'Milliseconds between heartbeat refreshes for a job currently running.',
      format: positiveInt,
      default: 15_000,
      env: 'ASCIIDOCOLLAB_GIT_WORKER_HEARTBEAT_INTERVAL_MS',
    },
    staleHeartbeatAfterMs: {
      doc: 'Milliseconds a RUNNING operation may go without a heartbeat before it is reclaimed as abandoned.',
      format: positiveInt,
      default: 60_000,
      env: 'ASCIIDOCOLLAB_GIT_WORKER_STALE_HEARTBEAT_AFTER_MS',
    },
    egressAllowedHosts: {
      doc: "Comma-separated hostnames this worker's git network operations may reach. Must match apps/api's git.egress.allowedHosts; defaults cover the supported providers (GitHub, GitLab, Bitbucket).",
      format: 'comma-separated-strings',
      default: [...DEFAULT_ALLOWED_GIT_HOSTS],
      env: 'ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS',
    },
    collab: {
      editUrl: {
        doc: "Base URL of the collab server's internal edit endpoint. Must match apps/api's collab.editUrl.",
        format: String,
        default: 'http://127.0.0.1:4003',
        env: 'ASCIIDOCOLLAB_COLLAB_EDIT_URL',
      },
      editSecret: {
        doc: "Optional shared secret sent to the collab edit endpoint; must match the collab server's ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_SECRET. Empty relies on loopback isolation.",
        format: String,
        default: '',
        sensitive: true,
        env: 'ASCIIDOCOLLAB_COLLAB_EDIT_SECRET',
      },
      editTls: {
        cert: {
          doc: 'Path to PEM file containing the client certificate presented to the collab edit server (mTLS). Empty disables mTLS.',
          format: String,
          default: '',
          env: 'ASCIIDOCOLLAB_COLLAB_EDIT_TLS_CERT',
        },
        key: {
          doc: 'Path to PEM file containing the client private key for the collab edit mTLS connection.',
          format: String,
          default: '',
          env: 'ASCIIDOCOLLAB_COLLAB_EDIT_TLS_KEY',
        },
        ca: {
          doc: 'Path to PEM file containing the CA certificate used to verify the collab edit server certificate.',
          format: String,
          default: '',
          env: 'ASCIIDOCOLLAB_COLLAB_EDIT_TLS_CA',
        },
      },
    },
    internalGitHost: {
      doc: 'Interface the internal git-ops RPC server binds to. Defaults to loopback; do not expose publicly.',
      format: String,
      default: '127.0.0.1',
      env: 'ASCIIDOCOLLAB_GIT_WORKER_INTERNAL_HOST',
    },
    internalGitPort: {
      doc: 'Port for the internal HTTP server the API calls to run git short ops (status, stage, unstage, commit).',
      format: 'port',
      default: 4010,
      env: 'ASCIIDOCOLLAB_GIT_WORKER_INTERNAL_PORT',
    },
    internalGitSecret: {
      doc: 'Optional shared secret enforced on the internal git-ops endpoint. Empty disables the check (loopback-trust, development only — set this in production).',
      format: String,
      default: '',
      sensitive: true,
      env: 'ASCIIDOCOLLAB_GIT_WORKER_INTERNAL_SECRET',
    },
    internalGitTls: {
      cert: {
        doc: 'Path to PEM file containing the server certificate for the internal git-ops mTLS server. Empty disables mTLS (loopback HTTP only).',
        format: String,
        default: '',
        env: 'ASCIIDOCOLLAB_GIT_WORKER_INTERNAL_TLS_CERT',
      },
      key: {
        doc: 'Path to PEM file containing the server private key for the internal git-ops mTLS server.',
        format: String,
        default: '',
        env: 'ASCIIDOCOLLAB_GIT_WORKER_INTERNAL_TLS_KEY',
      },
      clientCa: {
        doc: 'Path to PEM file containing the CA certificate used to verify the API client certificate.',
        format: String,
        default: '',
        env: 'ASCIIDOCOLLAB_GIT_WORKER_INTERNAL_TLS_CLIENT_CA',
      },
    },
  });
}
