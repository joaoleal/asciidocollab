import { readFileSync } from 'node:fs';
import {
  FilesystemPdfExtensionSource,
  FilesystemProjectFileStore,
  FilesystemYjsStateStore,
  HttpCollaborativeContentEditor,
  HttpStructuredCollaborativeEditor,
  Re2RegexEngine,
} from '@asciidocollab/infrastructure';
import type { getConfig } from '../config';
import type { FastifyInstance } from 'fastify';

/**
 * Instantiates the filesystem-backed storage adapters for project files and
 * Yjs collaborative state.
 *
 * @param appConfig - The application configuration providing the storage path.
 * @returns The stores container decorated onto the Fastify instance.
 */
export function createStores(
  appConfig: ReturnType<typeof getConfig>,
): FastifyInstance['stores'] {
  const storagePath = appConfig.storage.path;
  const editTls = appConfig.collab.editTls;
  const useEditMtls = Boolean(editTls.cert && editTls.key && editTls.ca);
  // The find/replace apply and the rename apply share one collab endpoint, secret, and mTLS material.
  const collabConfig = {
    baseUrl: appConfig.collab.editUrl,
    ...(appConfig.collab.editSecret ? { secret: appConfig.collab.editSecret } : {}),
    ...(useEditMtls
      ? { tls: { cert: readFileSync(editTls.cert), key: readFileSync(editTls.key), ca: readFileSync(editTls.ca) } }
      : {}),
  };
  return {
    fileStore: new FilesystemProjectFileStore(storagePath),
    yjsStateStore: new FilesystemYjsStateStore(storagePath),
    collaborativeContentEditor: new HttpCollaborativeContentEditor(collabConfig),
    structuredCollaborativeEditor: new HttpStructuredCollaborativeEditor(collabConfig),
    regexEngine: new Re2RegexEngine(),
    // The ONLY route to the administrator's extension drop folder. Its bounds come from config, so
    // no call site can decide for itself how much work a catalogue read may cost.
    pdfExtensionSource: new FilesystemPdfExtensionSource({
      path: appConfig.project.pdfExtensions.path,
      maxExtensions: appConfig.project.pdfExtensions.maxExtensions,
      maxSourceBytes: appConfig.project.pdfExtensions.maxSourceBytes,
      scanCacheTtl: appConfig.project.pdfExtensions.scanCacheTtl,
    }),
  };
}
