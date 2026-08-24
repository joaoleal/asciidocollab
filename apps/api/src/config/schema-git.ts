import type convict from 'convict';

/**
 * Git provider hostnames the egress allowlist covers by default, so a fresh install
 * can reach the three supported providers without any operator configuration.
 */
const DEFAULT_ALLOWED_GIT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];

/** Git repository sync configuration (import/connect/commit/push/pull/branch/etc). */
export interface GitConfig {
  /** Number of warm git-worker sandboxes in the pool that runs git operations. Sized to load, not to project count. */
  workerPoolSize: number;
  /** Network egress controls enforced for git-worker containers. */
  egress: {
    /** Hostnames git-worker containers are permitted to reach at the network layer; a connection's remote host must be one of these. */
    allowedHosts: string[];
  };
  /**
   * Base64-encoded 32-byte AES-256-GCM key used to encrypt stored git credential
   * tokens at rest. A dedicated key, separate from `auth.session.encryptionKey` — it
   * isolates credential blast radius from session data.
   */
  credentialEncryptionKey: string;
  /** Maximum git operation requests per project per window. */
  rateLimitMax: number;
  /** Git operation rate limit window in milliseconds. */
  rateLimitWindow: number;
  /** Maximum repository size (megabytes) permitted for import/connect. */
  maxRepoSizeMB: number;
  /** File size (bytes) at or above which a tracked binary asset is handled as a Git LFS object rather than stored inline. */
  lfsThresholdBytes: number;
}

/** Convict schema fragment for the git repository sync domain. */
export const gitSchema: convict.Schema<GitConfig> = {
  workerPoolSize: {
    doc: 'Number of warm git-worker sandboxes in the pool that runs git operations. Sized to load, not to project count.',
    format: 'positive-int',
    default: 4,
    env: 'ASCIIDOCOLLAB_GIT_WORKER_POOL_SIZE',
  },
  egress: {
    allowedHosts: {
      doc: 'Comma-separated hostnames git-worker containers are permitted to reach at the network layer. Defaults cover the supported providers (GitHub, GitLab, Bitbucket); extend for a self-hosted remote.',
      format: 'comma-separated-strings',
      default: DEFAULT_ALLOWED_GIT_HOSTS,
      env: 'ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS',
    },
  },
  credentialEncryptionKey: {
    doc: 'AES-256-GCM key (base64, 32 bytes) for encrypting stored git credential tokens at rest. Dedicated key, distinct from auth.session.encryptionKey (e.g. openssl rand -base64 32).',
    format: 'base64-32byte-key',
    default: '',
    sensitive: true,
    env: 'ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY',
  },
  rateLimitMax: {
    doc: 'Maximum git operation requests per project per window.',
    format: 'integer',
    default: 30,
    env: 'ASCIIDOCOLLAB_GIT_RATE_LIMIT_MAX',
  },
  rateLimitWindow: {
    doc: 'Git operation rate limit window in milliseconds.',
    format: 'integer',
    default: 60_000,
    env: 'ASCIIDOCOLLAB_GIT_RATE_LIMIT_WINDOW',
  },
  maxRepoSizeMB: {
    doc: 'Maximum repository size (megabytes) permitted for import/connect.',
    format: 'positive-int',
    default: 500,
    env: 'ASCIIDOCOLLAB_GIT_MAX_REPO_SIZE_MB',
  },
  lfsThresholdBytes: {
    doc: 'File size (bytes) at or above which a tracked binary asset is handled as a Git LFS object rather than stored inline.',
    format: 'positive-int',
    default: 10_485_760, // 10 MiB
    env: 'ASCIIDOCOLLAB_GIT_LFS_THRESHOLD_BYTES',
  },
};
