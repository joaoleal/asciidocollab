import convict from 'convict';
import './formats';
import { apiSchema } from './schema-server';
import type { ServerApiConfig } from './schema-server';
import { authSchema } from './schema-auth';
import type { AuthConfig } from './schema-auth';
import { storageSchema, downloadsSchema } from './schema-storage';
import type { StorageConfig, DownloadsConfig } from './schema-storage';
import { projectSchema } from './schema-project';
import type { ProjectConfig } from './schema-project';
import { adminSchema, failedSignInSchema } from './schema-admin';
import type { AdminConfig, FailedSignInConfig } from './schema-admin';
import { collabSchema } from './schema-collab';
import type { CollabConfig } from './schema-collab';
import { gitSchema } from './schema-git';
import type { GitConfig } from './schema-git';

/**
 * Convict schema definition for AsciiDoCollab API server.
 *
 * Single source of truth for all configuration fields. The schema is composed
 * from per-domain fragments (server, auth, storage, project, admin, collab, git),
 * each living in its own module. Each field maps to an environment variable for
 * override. Fields marked `sensitive: true` are redacted in logs/output.
 */
/**
 * Creates a new convict configuration instance.
 *
 * Must be called after environment variables are set, because convict
 * reads env vars at construction time.
 *
 * @returns A new convict configuration instance.
 */
export function createConfig() {
  return convict<Config>({
    env: {
      doc: 'The application environment.',
      format: ['production', 'development', 'test'],
      default: 'production',
      env: 'NODE_ENV',
    },
    api: apiSchema,
    auth: authSchema,
    storage: storageSchema,
    project: projectSchema,
    admin: adminSchema,
    failedSignIn: failedSignInSchema,
    downloads: downloadsSchema,
    collab: collabSchema,
    git: gitSchema,
  });
}

/** Typed configuration interface for the application. */
export interface Config {
  /** The application environment. */
  env: string;
  /** API server configuration. */
  api: ServerApiConfig;
  /** Authentication configuration. */
  auth: AuthConfig;
  /** Storage configuration. */
  storage: StorageConfig;
  /** Project-scoped rate limiting configuration. */
  project: ProjectConfig;
  /** Admin configuration. */
  admin: AdminConfig;
  /** Failed sign-in telemetry configuration. */
  failedSignIn: FailedSignInConfig;
  /** Downloads configuration. */
  downloads: DownloadsConfig;
  /** Collaboration server configuration. */
  collab: CollabConfig;
  /** Git repository sync configuration. */
  git: GitConfig;
}
