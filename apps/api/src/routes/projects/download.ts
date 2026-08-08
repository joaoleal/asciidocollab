import type { FastifyInstance } from 'fastify';
import { Readable } from 'stream';
// archiver 8 is ESM-only and this app compiles to CommonJS, so it is reached through a dynamic
// `import()` inside the handler rather than a static one. `module: node16` keeps that a real import
// instead of downlevelling it to a `require()` the ESM package would reject. v8 also replaced the
// `archiver('zip', …)` factory with per-format classes, hence `ZipArchive` below.
import {
  DownloadProjectUseCase,
  PermissionDeniedError,
  ProjectNotFoundError,
  UserId,
  ProjectId,
} from '@asciidocollab/domain';
import { exportFileName } from '@asciidocollab/shared';
import { requireAuth, getAuthenticatedUserId } from '../../plugins/require-auth';
import { requestLogger } from '../../lib/request-logger';
import { buildAttachmentDisposition } from '../../lib/sanitize-filename';
import { flushFastifyHeadersToRaw } from '../../lib/flush-fastify-headers';

/** Streams a ZIP archive of all project files, serving live Yjs text for actively-edited documents. */
export async function projectDownloadRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/download',
    {
      preHandler: [requireAuth],
      config: {
        rateLimit: {
          max: app.config.downloads.zip.rateLimitMax,
          timeWindow: app.config.downloads.zip.rateLimitWindow,
        },
      },
    },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const useCase = new DownloadProjectUseCase(
        request.server.repos.project,
        request.server.repos.fileNode,
        request.server.repos.projectMember,
        request.server.repos.document,
        request.server.repos.collaborationSession,
        request.server.stores.collaborativeContentEditor,
        requestLogger(request),
      );

      const result = await useCase.execute(actorId, projectId);

      if (!result.success) {
        const { error } = result;
        if (error instanceof PermissionDeniedError) {
          return reply.status(403).send({ error: { code: 'FORBIDDEN', message: error.message } });
        }
        if (error instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: error.message } });
        }
        return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } });
      }

      const { projectName, files } = result.value;
      // The same naming rule the client-side exports use (`exportFileName` in @asciidocollab/shared):
      // project-derived, lower case, ASCII, dash-separated, dated. Previously this route emitted the raw
      // project name, so a project called "Café Ürünler" produced a non-ASCII archive name here while
      // its PDF/HTML/zip exports produced `cafe-urunler-…` — the same project, two conventions.
      //
      // The slug is ASCII by construction, so the RFC 5987 UTF-8 name and its ASCII fallback are now the
      // same string. `buildAttachmentDisposition` is kept rather than hand-writing the header so this
      // route stays identical in shape to the other download routes (and keeps their quoting/escaping).
      const archiveName = exportFileName(projectName, 'zip');

      // Loaded BEFORE any header is staged on the raw response. archiver 8 is ESM-only, so it can no
      // longer be required at module scope and a failure to load it moved from process start to here —
      // a per-request rejection. Reaching Fastify's error handler with the ZIP headers already set
      // would serve the 500 JSON body advertised as `Content-Type: application/zip` and named as an
      // attachment. The import is cached after the first request, so the ordering costs nothing.
      const { ZipArchive } = await import('archiver');

      flushFastifyHeadersToRaw(reply);
      reply.raw.setHeader('Content-Type', 'application/zip');
      reply.raw.setHeader('Content-Disposition', buildAttachmentDisposition(archiveName, archiveName));

      const archive = new ZipArchive({ zlib: { level: 6 } });
      // archiveError races against finalize() so an entry-stream error doesn't leave the
      // handler suspended on a hanging finalize() (the ZIP engine waits for 'end' which
      // destroy() never emits, causing finalize() to hang indefinitely).
      const archiveError = new Promise<never>((_, reject) => { archive.once('error', reject); });
      // Pre-attach a no-op catch so that if archive errors before Promise.race is set up
      // (e.g. during concurrent readStream opens in Promise.all), the rejection is already
      // "handled" and Node.js never emits unhandledRejection — which would crash the process.
      archiveError.catch(() => {});
      archive.on('error', (error) => {
        request.log.warn({ projectId: projectId.value, error: error.message }, 'archiver error during ZIP download');
        archive.unpipe(reply.raw);
        if (!reply.raw.writableEnded) reply.raw.end();
      });
      archive.pipe(reply.raw);

      // Open all stored-file streams concurrently to amortise S3/GCS open latency across the
      // entire file list (wall-clock: max(open_latency) vs sequential: N * open_latency).
      type ResolvedEntry =
        | { kind: 'inline'; bytes: Buffer; relativePath: string }
        | { kind: 'stream'; stream: Readable; relativePath: string }
        | { kind: 'null'; path: string }
        | { kind: 'error'; path: string; error: unknown };

      const resolvedEntries = await Promise.all(
        files.map(async ({ fileNode, relativePath, source }): Promise<ResolvedEntry> => {
          if (source.kind === 'inline') {
            return { kind: 'inline', bytes: source.bytes, relativePath };
          }
          try {
            const stream = await request.server.stores.fileStore.readStream(projectId, fileNode.path);
            if (stream === null) {
              return { kind: 'null', path: fileNode.path.value };
            }
            // Attach error listener immediately on acquisition — before archive.append() —
            // so any stream error that fires in the gap doesn't become an unhandled event.
            stream.on('error', (error) => { archive.emit('error', error); });
            return { kind: 'stream', stream, relativePath };
          } catch (error) {
            return { kind: 'error', path: fileNode.path.value, error };
          }
        }),
      );

      let entriesAdded = 0;
      for (const entry of resolvedEntries) {
        switch (entry.kind) {
          case 'inline': {
            archive.append(entry.bytes, { name: entry.relativePath });
            entriesAdded++;
            break;
          }
          case 'stream': {
            archive.append(entry.stream, { name: entry.relativePath });
            entriesAdded++;
            break;
          }
          case 'null': {
            request.log.warn({ projectId: projectId.value, path: entry.path }, 'file missing from store during ZIP; skipping');
            break;
          }
          default: {
            request.log.warn(
              { projectId: projectId.value, path: entry.path, error: entry.error instanceof Error ? entry.error.message : String(entry.error) },
              'readStream threw during ZIP; skipping file',
            );
          }
        }
      }

      if (entriesAdded === 0 && files.length > 0) {
        request.log.warn({ projectId: projectId.value, expected: files.length }, 'ZIP archive is empty — all files were skipped; client receives empty archive');
      }

      let archiveFinishedNormally = false;
      await Promise.race([
        archive.finalize().then(() => { archiveFinishedNormally = true; }),
        archiveError,
      ]).catch(() => {
        // Archive errored: reply.raw was already ended and unpiped in the 'error' handler above.
        // Swallowing prevents Fastify from trying to write a 500 to the already-ended response.
      });

      if (archiveFinishedNormally) {
        return reply;
      }
      // Archive errored path: destroy any open stored-file streams that archiver never consumed
      // so that S3/GCS HTTP connections are released immediately rather than leaking until TCP timeout.
      for (const entry of resolvedEntries) {
        if (entry.kind === 'stream' && !entry.stream.destroyed) {
          entry.stream.destroy();
        }
      }
      // do NOT return reply — reply.raw was already ended in the 'error' handler above.
    },
  );
}
