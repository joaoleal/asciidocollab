/**
 * A tiny loopback static file server used to host the self-hosted MathJax bundle for the browser-backed
 * math shim. MathJax's SVG bundle loads the AsciiMath input jax as a separate component at startup; that
 * component resolves relative to the bundle's own origin, so the bundle must be served from a real HTTP
 * origin (a `file://`/`about:blank` page cannot fetch it). The server binds to 127.0.0.1 only and serves
 * a fixed directory read-only — no network egress leaves the machine, so the render stays offline.
 */

import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

/** A running static server plus its loopback base URL and a stop handle. */
export interface StaticServer {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

/** Serve `rootDirectory` read-only on a loopback port; resolves once the port is bound. */
export function startStaticServer(rootDirectory: string): Promise<StaticServer> {
  const server: Server = createServer((request, response) => {
    const requestPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
    const resolved = path.normalize(path.join(rootDirectory, requestPath));
    if (!resolved.startsWith(rootDirectory) || !existsSync(resolved) || !statSync(resolved).isFile()) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    response.setHeader('Content-Type', CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream');
    // MathJax 4 runs its speech-rule engine in a Worker created from a `blob:` URL, whose origin is
    // `null`. Every fetch it makes back here — the speech maps under `sre/mathmaps/` — is therefore
    // cross-origin and blocked without this, and a blocked map fetch leaves the conversion promise
    // pending forever rather than failing. The server is loopback-only and read-only, serving files this
    // repo already ships, so allowing any origin costs nothing.
    response.setHeader('Access-Control-Allow-Origin', '*');
    createReadStream(resolved).pipe(response);
  });

  return new Promise<StaticServer>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
