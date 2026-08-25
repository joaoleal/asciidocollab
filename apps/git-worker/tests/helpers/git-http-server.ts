import http, { type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

/**
 * Test-only helper: a minimal git smart-HTTP server, bridging real HTTP requests to the actual
 * `git http-backend` CGI binary against a bare repository directory. Used to exercise
 * `runGitCommand`'s credential/redirect handling against a REAL authenticated git remote (rather
 * than mocking git's network behavior), without any real external host.
 *
 * When `requireAuth` is set, every request must carry HTTP Basic credentials matching it or the
 * server answers 401 with `WWW-Authenticate: Basic` — exactly what triggers git's `GIT_ASKPASS`
 * flow. When `redirectTo` is set, the server answers every request with a 302 to that URL instead
 * of reaching the CGI backend at all — used to exercise the cross-host-redirect defense.
 */
export interface GitHttpServerOptions {
  /** Directory containing the bare repository (its parent is used as `GIT_PROJECT_ROOT`). */
  readonly projectRoot: string;
  /** If set, requests must present these HTTP Basic credentials. */
  readonly requireAuth?: { readonly username: string; readonly password: string };
  /** If set, every request is answered with a 302 redirect to this URL instead of being served. */
  readonly redirectTo?: string;
}

/** A running instance of the test git-HTTP server. */
export interface GitHttpServer {
  /** The base URL of the server, e.g. `http://127.0.0.1:54321`. */
  readonly url: string;
  /** Every `Authorization` header value this server has observed, in request order. */
  readonly authorizationHeadersSeen: string[];
  /**
   * Stops the server and releases its port.
   *
   * @returns A promise that resolves once the server has fully closed.
   */
  close(): Promise<void>;
}

/**
 * Starts the test git-HTTP server on an ephemeral loopback port.
 *
 * @param options - What repository to serve and which auth/redirect behavior to simulate.
 * @returns The running server.
 */
export async function startGitHttpServer(options: GitHttpServerOptions): Promise<GitHttpServer> {
  const authorizationHeadersSeen: string[] = [];

  const server: Server = http.createServer((request, response) => {
    const authorizationHeader = request.headers.authorization;
    if (authorizationHeader) authorizationHeadersSeen.push(authorizationHeader);

    if (options.redirectTo) {
      response.writeHead(302, { Location: options.redirectTo });
      response.end();
      return;
    }

    if (options.requireAuth) {
      const expected = `Basic ${Buffer.from(`${options.requireAuth.username}:${options.requireAuth.password}`).toString('base64')}`;
      if (authorizationHeader !== expected) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git-worker-test"' });
        response.end();
        return;
      }
    }

    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const child = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: options.projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: requestUrl.pathname,
          QUERY_STRING: requestUrl.search.replace(/^\?/, ''),
          REQUEST_METHOD: request.method ?? 'GET',
          GATEWAY_INTERFACE: 'CGI/1.1',
          SERVER_PROTOCOL: 'HTTP/1.1',
          CONTENT_TYPE: request.headers['content-type'] ?? '',
          CONTENT_LENGTH: String(body.length),
        },
      });
      const outChunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
      child.on('close', () => {
        const out = Buffer.concat(outChunks);
        const separatorIndex = out.indexOf('\r\n\r\n');
        const headerText = out.subarray(0, separatorIndex).toString('utf8');
        const responseBody = out.subarray(separatorIndex + 4);

        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of headerText.split('\r\n')) {
          const colonIndex = line.indexOf(':');
          if (colonIndex === -1) continue;
          const key = line.slice(0, colonIndex).trim();
          const value = line.slice(colonIndex + 1).trim();
          if (key.toLowerCase() === 'status') {
            status = Number.parseInt(value, 10);
          } else {
            headers[key] = value;
          }
        }
        response.writeHead(status, headers);
        response.end(responseBody);
      });
      child.stdin.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    authorizationHeadersSeen,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
