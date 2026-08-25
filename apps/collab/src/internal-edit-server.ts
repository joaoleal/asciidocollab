import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import type { Logger } from 'pino';
import type { ContentReplacement, YjsStateStore, RegexEngine, ReplaceSelection } from '@asciidocollab/domain';
import {
  applyEditsToDocument,
  applyStructuredReplacementToDocument,
  readDocumentContent,
  replaceDocumentContent,
  type ApplyEditsRequest,
  type ApplyFullContentRequest,
  type ReadContentRequest,
  type StructuredApplyRequest,
} from './apply-edits.js';

/** Path of the internal endpoint the API calls to rewrite references in live documents. */
export const APPLY_EDITS_PATH = '/internal/collab/apply-edits';

/** Path of the internal endpoint the API calls for a selection-/regex-aware replace in live documents. */
export const APPLY_STRUCTURED_REPLACEMENT_PATH = '/internal/collab/apply-structured-replacement';

/** Path of the internal endpoint the API calls to replace a live document's entire content. */
export const APPLY_FULL_CONTENT_PATH = '/internal/collab/apply-full-content';

/** Path of the internal endpoint the API calls to read live document content. */
export const READ_CONTENT_PATH = '/internal/collab/read-content';

/** Header carrying the optional shared secret. */
const SECRET_HEADER = 'x-collab-internal-secret';

/** Hard cap on the request body, large enough for a project's worth of reference rewrites. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Constant-time comparison of the request's secret header against the expected secret. Uses
 * `crypto.timingSafeEqual` so a network attacker cannot recover the secret byte-by-byte from
 * comparison timing — the only auth on these endpoints when mTLS is off. The length pre-check is
 * required by `timingSafeEqual` (it throws on differing lengths) and leaks only the secret's length.
 *
 * @param provided - The raw header value (string, array, or undefined for a missing header).
 * @param expected - The configured shared secret.
 * @returns True when the provided secret matches.
 */
function secretMatches(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}

/**
 * Validates and normalises an apply-edits request body. Returns null on any malformed input —
 * including non-UUID ids, which would otherwise produce a nonsensical room name.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseApplyEditsBody(raw: string): ApplyEditsRequest | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const { projectId, yjsStateId, replacements } = json;
  if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
  if (typeof yjsStateId !== 'string' || !UUID_REGEX.test(yjsStateId)) return null;
  if (!Array.isArray(replacements)) return null;

  const clean: ContentReplacement[] = [];
  for (const entry of replacements) {
    if (!isRecord(entry)) return null;
    const { find, replace } = entry;
    if (typeof find !== 'string' || typeof replace !== 'string') return null;
    clean.push({ find, replace });
  }
  return { projectId, yjsStateId, replacements: clean };
}

/**
 * Validates and normalises a structured-apply request body. Returns null on any malformed input —
 * non-UUID ids, an unknown mode, or a selection missing its ordinal/expectedText. The query carries
 * the domain field name `text` (this endpoint is internal; the API maps the DTO's `query` field to
 * it before calling).
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseStructuredApplyBody(raw: string): StructuredApplyRequest | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const { projectId, yjsStateId, query, replacement, selections } = json;
  if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
  if (typeof yjsStateId !== 'string' || !UUID_REGEX.test(yjsStateId)) return null;
  if (typeof replacement !== 'string') return null;
  if (!isRecord(query)) return null;
  const { text, mode, caseSensitive, wholeWord } = query;
  if (typeof text !== 'string') return null;
  if (mode !== 'literal' && mode !== 'regex') return null;
  if (typeof caseSensitive !== 'boolean' || typeof wholeWord !== 'boolean') return null;
  if (!Array.isArray(selections)) return null;

  const cleanSelections: ReplaceSelection[] = [];
  for (const entry of selections) {
    if (!isRecord(entry)) return null;
    const { ordinal, expectedText } = entry;
    if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0) return null;
    if (typeof expectedText !== 'string') return null;
    cleanSelections.push({ ordinal, expectedText });
  }
  return { projectId, yjsStateId, query: { text, mode, caseSensitive, wholeWord }, replacement, selections: cleanSelections };
}

/**
 * Validates a read-content request body. Returns null on malformed input — including non-UUID ids.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseReadContentBody(raw: string): ReadContentRequest | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const { projectId, yjsStateId } = json;
  if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
  if (typeof yjsStateId !== 'string' || !UUID_REGEX.test(yjsStateId)) return null;
  return { projectId, yjsStateId };
}

/**
 * Validates and normalises an apply-full-content request body. Returns null on any malformed
 * input — including non-UUID ids and a missing/non-string `content`. An empty string IS a valid
 * `content` (it legitimately clears the document), so it is not treated as missing.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseApplyFullContentBody(raw: string): ApplyFullContentRequest | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const { projectId, yjsStateId, content } = json;
  if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
  if (typeof yjsStateId !== 'string' || !UUID_REGEX.test(yjsStateId)) return null;
  if (typeof content !== 'string') return null;
  return { projectId, yjsStateId, content };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering (memory cap) and reject, but do NOT destroy the socket here: the handler
        // still needs to write a clean 413 on the shared response. Pausing the unread request lets
        // Node close the connection after that response (the body is never fully consumed).
        request.removeAllListeners('data');
        request.pause();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** Dependencies for the internal request handler. */
export interface ApplyEditsHandlerDeps {
  /**
   * Applies the parsed request to the live document.
   *
   * @param request - The validated apply-edits request.
   * @returns The number of occurrences replaced.
   */
  applyEdits: (request: ApplyEditsRequest) => Promise<number>;
  /**
   * Applies a selection-/regex-aware structured replacement to the live document.
   *
   * @param request - The validated structured-apply request.
   * @returns The number of occurrences actually replaced (0 ⇒ live diverged).
   */
  applyStructuredReplacement: (request: StructuredApplyRequest) => Promise<number>;
  /**
   * Replaces the entire content of the live document identified by the request via a minimal diff.
   *
   * @param request - The validated apply-full-content request.
   */
  applyFullContent: (request: ApplyFullContentRequest) => Promise<void>;
  /**
   * Reads the live text of the document identified by the request.
   *
   * @param request - The validated read-content request.
   * @returns The current document text, or null when no live source exists (caller uses the file store).
   */
  readContent: (request: ReadContentRequest) => Promise<string | null>;
  /** Optional shared secret; when set, requests without a matching header are rejected (401). */
  secret?: string;
  /** Logger for failures. */
  logger: Logger;
}

/**
 * Builds the node HTTP request handler for the internal apply-edits and read-content endpoints.
 * Separated from the server so it can be unit-tested with injected functions.
 *
 * @param deps - The apply/read functions, optional secret, and logger.
 * @returns A node `http` request handler.
 */
export function createApplyEditsRequestHandler(
  deps: ApplyEditsHandlerDeps,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const path = (request.url ?? '').split('?')[0];
    if (
      request.method !== 'POST' ||
      (path !== APPLY_EDITS_PATH &&
        path !== APPLY_STRUCTURED_REPLACEMENT_PATH &&
        path !== APPLY_FULL_CONTENT_PATH &&
        path !== READ_CONTENT_PATH)
    ) {
      request.resume(); // drain any body so the keep-alive connection stays healthy
      response.writeHead(404).end();
      return;
    }
    if (deps.secret && !secretMatches(request.headers[SECRET_HEADER], deps.secret)) {
      request.resume();
      response.writeHead(401).end();
      return;
    }

    let raw: string;
    try {
      raw = await readBody(request);
    } catch {
      // Body exceeded the cap (or a read error). The socket is still open (readBody no longer
      // destroys it), so guard against a double-write and respond 413. `connection: close` makes
      // Node close the socket after the response, discarding the unread oversize body rather than
      // leaving it lingering on a reusable keep-alive connection.
      if (!response.headersSent) response.writeHead(413, { connection: 'close' }).end();
      return;
    }

    if (path === READ_CONTENT_PATH) {
      const parsed = parseReadContentBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      try {
        const content = await deps.readContent(parsed);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ content }));
      } catch (error) {
        deps.logger.error({ err: error }, 'read-content failed');
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'read-content failed' }));
      }
      return;
    }

    if (path === APPLY_FULL_CONTENT_PATH) {
      const parsed = parseApplyFullContentBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      try {
        await deps.applyFullContent(parsed);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      } catch (error) {
        deps.logger.error({ err: error }, 'apply-full-content failed');
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'apply-full-content failed' }));
      }
      return;
    }

    if (path === APPLY_STRUCTURED_REPLACEMENT_PATH) {
      const parsed = parseStructuredApplyBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      try {
        const applied = await deps.applyStructuredReplacement(parsed);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ applied }));
      } catch (error) {
        deps.logger.error({ err: error }, 'apply-structured-replacement failed');
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'apply-structured-replacement failed' }));
      }
      return;
    }

    const parsed = parseApplyEditsBody(raw);
    if (!parsed) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
      return;
    }

    try {
      const applied = await deps.applyEdits(parsed);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ applied }));
    } catch (error) {
      deps.logger.error({ err: error }, 'apply-edits failed');
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'apply-edits failed' }));
    }
  };
}

/** Inputs needed to start the loopback edit endpoint. */
export interface InternalEditServerOptions {
  /** The Hocuspocus instance that owns the live documents (apply uses direct connections; read uses the documents map). */
  hocuspocus: Pick<Hocuspocus, 'openDirectConnection' | 'documents'>;
  /** Store used by the read endpoint to decode a dormant room's persisted Yjs state without loading it. */
  yjsStateStore: YjsStateStore;
  /** Linear-time (RE2) engine used by the structured-apply endpoint to re-match a regex query. */
  regexEngine: RegexEngine;
  /** Interface to bind to — defaults to loopback for safety. */
  host: string;
  /** Port to listen on. */
  port: number;
  /** Optional shared secret enforced on every request. */
  secret?: string;
  /** Optional server mTLS material; when set, the endpoint requires a valid API client certificate. */
  tls?: { cert: Buffer; key: Buffer; clientCa: Buffer };
  /** Logger. */
  logger: Logger;
}

/**
 * Starts the internal HTTP server that lets the API apply reference rewrites to live collaborative
 * documents (the Yjs source of truth). Binds to loopback by default; pair with a shared secret
 * and/or network policy in production. Returns the server so the caller can close it on shutdown.
 *
 * @param options - Hocuspocus instance, bind address, optional secret/mTLS, logger.
 * @returns A promise resolving to the listening HTTP(S) server, or rejecting if the bind fails.
 */
export function startInternalEditServer(options: InternalEditServerOptions): Promise<http.Server> {
  const handler = createApplyEditsRequestHandler({
    applyEdits: (request) => applyEditsToDocument(options.hocuspocus, request),
    applyStructuredReplacement: (request) =>
      applyStructuredReplacementToDocument(options.hocuspocus, options.regexEngine, request),
    applyFullContent: (request) => replaceDocumentContent(options.hocuspocus, request),
    readContent: (request) => readDocumentContent(options.hocuspocus, options.yjsStateStore, request),
    ...(options.secret ? { secret: options.secret } : {}),
    logger: options.logger,
  });
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    void handler(request, response);
  };
  // When mTLS material is provided, require a client certificate signed by the configured CA so the
  // mutation endpoint authenticates the API even off-loopback; otherwise plain HTTP on the bind host.
  const server = options.tls
    ? https.createServer(
        { requestCert: true, rejectUnauthorized: true, cert: options.tls.cert, key: options.tls.key, ca: options.tls.clientCa },
        listener,
      )
    : http.createServer(listener);

  // Resolve once listening, reject on an early bind error (e.g. EADDRINUSE). Without an 'error'
  // listener the event would be thrown as an uncaught exception and crash the whole collab process
  // — after the WebSocket server already came up — which main()'s catch could not intercept.
  return new Promise<http.Server>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      // After startup, keep logging late errors instead of crashing the process.
      server.on('error', (error) => options.logger.error({ err: error }, 'Collab internal edit server error'));
      options.logger.info({ port: options.port, host: options.host, tls: Boolean(options.tls) }, 'Collab internal edit server listening');
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, options.host);
  });
}
