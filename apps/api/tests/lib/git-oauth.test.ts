import { createHash } from 'crypto';
import { createServer, type Server } from 'http';
import {
  buildAuthorizeUrl,
  deriveCodeChallenge,
  exchangeCodeForToken,
  generateCodeVerifier,
} from '../../src/lib/git-oauth';

describe('buildAuthorizeUrl', () => {
  const BASE_INPUT = {
    clientId: 'client-123',
    redirectUri: 'https://app.example.com/api/git/oauth/github/callback',
    scope: 'repo',
    state: 'opaque-encrypted-state',
    codeChallenge: 'challenge-value',
  };

  it('builds a URL against the given authorize endpoint', () => {
    const url = new URL(buildAuthorizeUrl({ authorizeUrl: 'https://github.com/login/oauth/authorize', ...BASE_INPUT }));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
  });

  it('builds a URL against a different provider endpoint (gitlab)', () => {
    const url = new URL(buildAuthorizeUrl({ authorizeUrl: 'https://gitlab.com/oauth/authorize', ...BASE_INPUT }));
    expect(url.origin + url.pathname).toBe('https://gitlab.com/oauth/authorize');
  });

  it('builds a URL against a different provider endpoint (bitbucket)', () => {
    const url = new URL(
      buildAuthorizeUrl({ authorizeUrl: 'https://bitbucket.org/site/oauth2/authorize', ...BASE_INPUT }),
    );
    expect(url.origin + url.pathname).toBe('https://bitbucket.org/site/oauth2/authorize');
  });

  it('carries every required OAuth query parameter, unmodified', () => {
    const url = new URL(buildAuthorizeUrl({ authorizeUrl: 'https://github.com/login/oauth/authorize', ...BASE_INPUT }));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/git/oauth/github/callback');
    expect(url.searchParams.get('scope')).toBe('repo');
    expect(url.searchParams.get('state')).toBe('opaque-encrypted-state');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('URL-encodes a state value containing reserved characters', () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        ...BASE_INPUT,
        state: 'iv:tag:cipher&text',
      }),
    );
    expect(url.searchParams.get('state')).toBe('iv:tag:cipher&text');
    expect(url.toString()).not.toContain('&text'); // raw '&' must be encoded, not a stray extra param
  });
});

describe('PKCE code verifier/challenge', () => {
  it('generates a verifier within the RFC 7636 43-128 character range, from the unreserved alphabet', () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('generates a different verifier each call', () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });

  it('derives the S256 challenge as base64url(SHA-256(verifier))', () => {
    const verifier = generateCodeVerifier();
    const expected = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    expect(deriveCodeChallenge(verifier)).toBe(expected);
  });

  it('derives the same challenge for a fixed, known verifier (regression pin)', () => {
    // RFC 7636 Appendix B's worked example.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(deriveCodeChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('exchangeCodeForToken', () => {
  let server: Server;
  let baseUrl: string;
  let lastRequestBody: string | undefined;
  let lastAcceptHeader: string | undefined;
  let respond: (request: import('http').IncomingMessage, response: import('http').ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        lastRequestBody = raw;
        lastAcceptHeader = request.headers.accept;
        respond(request, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('unexpected server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const INPUT = {
    code: 'the-authorization-code',
    codeVerifier: 'the-code-verifier',
    clientId: 'client-123',
    clientSecret: 'super-secret-client-secret',
    redirectUri: 'https://app.example.com/api/git/oauth/github/callback',
  };

  it('returns the access token on a successful JSON response', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'gho_the-access-token', token_type: 'bearer', scope: 'repo' }));
    };

    const result = await exchangeCodeForToken({ tokenUrl: `${baseUrl}/token`, ...INPUT });

    expect(result).toEqual({ success: true, value: { accessToken: 'gho_the-access-token' } });
  });

  it('sends the code, verifier, client credentials, redirect_uri, and grant_type in the request body', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'tok' }));
    };

    await exchangeCodeForToken({ tokenUrl: `${baseUrl}/token`, ...INPUT });

    const sent = new URLSearchParams(lastRequestBody);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe(INPUT.code);
    expect(sent.get('code_verifier')).toBe(INPUT.codeVerifier);
    expect(sent.get('client_id')).toBe(INPUT.clientId);
    expect(sent.get('client_secret')).toBe(INPUT.clientSecret);
    expect(sent.get('redirect_uri')).toBe(INPUT.redirectUri);
  });

  it('sends Accept: application/json so a GitHub-style default form-encoded response is avoided', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'tok' }));
    };

    await exchangeCodeForToken({ tokenUrl: `${baseUrl}/token`, ...INPUT });

    expect(lastAcceptHeader).toBe('application/json');
  });

  it('returns a typed OAuthExchangeError, with no secret leaked, on a non-2xx provider response', async () => {
    respond = (_request, response) => {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid_grant', error_description: 'The code has expired' }));
    };

    const result = await exchangeCodeForToken({ tokenUrl: `${baseUrl}/token`, ...INPUT });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toEqual({ name: 'OAuthExchangeError', reason: 'provider_rejected' });
      expect(JSON.stringify(result.error)).not.toContain(INPUT.clientSecret);
      expect(JSON.stringify(result.error)).not.toContain(INPUT.codeVerifier);
    }
  });

  it('returns a typed OAuthExchangeError when the 2xx body carries an error field instead of a token', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'bad_verification_code' }));
    };

    const result = await exchangeCodeForToken({ tokenUrl: `${baseUrl}/token`, ...INPUT });

    expect(result).toEqual({ success: false, error: { name: 'OAuthExchangeError', reason: 'provider_rejected' } });
  });

  it('returns invalid_response when the 2xx body carries no access_token field', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ token_type: 'bearer', scope: 'repo' }));
    };

    const result = await exchangeCodeForToken({ tokenUrl: `${baseUrl}/token`, ...INPUT });

    expect(result).toEqual({ success: false, error: { name: 'OAuthExchangeError', reason: 'invalid_response' } });
  });

  it('returns invalid_response when the 2xx body carries an empty access_token', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ access_token: '', token_type: 'bearer' }));
    };

    const result = await exchangeCodeForToken({ tokenUrl: `${baseUrl}/token`, ...INPUT });

    expect(result).toEqual({ success: false, error: { name: 'OAuthExchangeError', reason: 'invalid_response' } });
  });

  it('returns a typed OAuthExchangeError when the response is not valid JSON', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<html>not json</html>');
    };

    const result = await exchangeCodeForToken({ tokenUrl: `${baseUrl}/token`, ...INPUT });

    expect(result).toEqual({ success: false, error: { name: 'OAuthExchangeError', reason: 'invalid_response' } });
  });

  it('returns a typed OAuthExchangeError when the 2xx JSON body parses to a non-object value', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(null));
    };

    const result = await exchangeCodeForToken({ tokenUrl: `${baseUrl}/token`, ...INPUT });

    expect(result).toEqual({ success: false, error: { name: 'OAuthExchangeError', reason: 'invalid_response' } });
  });

  it('returns a typed OAuthExchangeError when the token endpoint cannot be reached at all', async () => {
    const result = await exchangeCodeForToken({ tokenUrl: 'http://127.0.0.1:1', ...INPUT });

    expect(result).toEqual({ success: false, error: { name: 'OAuthExchangeError', reason: 'network_error' } });
  });

  it('returns a typed OAuthExchangeError (not a throw) when the request times out and aborts', async () => {
    const originalFetch = globalThis.fetch;
    // A request whose bounding AbortSignal.timeout trips rejects with a TimeoutError DOMException.
    globalThis.fetch = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
    try {
      const result = await exchangeCodeForToken({ tokenUrl: `${baseUrl}/token`, ...INPUT });

      expect(result).toEqual({ success: false, error: { name: 'OAuthExchangeError', reason: 'network_error' } });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
