import type { beforeHandleMessagePayload } from '@hocuspocus/server';
import { createRequire } from 'node:module';

// Native ESM: jest.mock() cannot intercept a static import, so `pino` is mocked here and the unit
// under test is imported dynamically below. The mock builds a REAL pino logger — loaded through
// createRequire, which bypasses the mocked registry — writing into a captured buffer, so the
// redaction configured on the module's default logger is asserted against genuine pino output
// rather than against a stub that could not redact anything.
interface CapturedPinoLogger {
  options: unknown;
  lines: string[];
  logger: { info(object: unknown, message: string): void };
}
const mockPinoInstances: CapturedPinoLogger[] = [];
const mockRequireCjs = createRequire(import.meta.url);
const mockRealPino = mockRequireCjs('pino') as (
  options: unknown,
  stream: unknown,
) => CapturedPinoLogger['logger'];

jest.unstable_mockModule('pino', () => ({
  __esModule: true,
  default: (options: unknown) => {
    const lines: string[] = [];
    const logger = mockRealPino(options, {
      write: (chunk: string) => {
        lines.push(chunk);
      },
    });
    mockPinoInstances.push({ options, lines, logger });
    return logger;
  },
}));

const { createMaxPayloadGuard } = await import('../src/server');

function payloadOfSize(bytes: number): beforeHandleMessagePayload {
  return { update: new Uint8Array(bytes) } as unknown as beforeHandleMessagePayload;
}

// An inbound message larger than the limit is rejected
// (closed) without crashing the server; within-limit messages pass.
describe('createMaxPayloadGuard', () => {
  it('rejects a message exceeding the limit with WS code 1009 (Message Too Big)', async () => {
    const guard = createMaxPayloadGuard(1024);
    await expect(guard(payloadOfSize(1025))).rejects.toMatchObject({ code: 1009 });
  });

  it('accepts a message at or under the limit', async () => {
    const guard = createMaxPayloadGuard(1024);
    await expect(guard(payloadOfSize(1024))).resolves.toBeUndefined();
    await expect(guard(payloadOfSize(0))).resolves.toBeUndefined();
  });

  // Hocuspocus turns the thrown value into the WebSocket close frame verbatim, so BOTH fields are
  // wire contract: the RFC 6455 code and the reason phrase the client sees.
  it('throws the exact RFC 6455 close frame, code and reason', async () => {
    const guard = createMaxPayloadGuard(8);
    await expect(guard(payloadOfSize(9))).rejects.toEqual({ code: 1009, reason: 'Message Too Big' });
  });
});

// src/server.ts builds a fallback logger for callers that inject none. Its whole reason to exist is
// the redaction config, which is invisible unless real output is inspected.
describe('the collab server default logger', () => {
  it('redacts a session cookie out of the log output, in both header spellings', () => {
    // src/server.ts makes exactly one module-level pino logger; nothing else in its import graph does.
    expect(mockPinoInstances).toHaveLength(1);
    const { logger, lines } = mockPinoInstances[0];

    logger.info({ req: { headers: { cookie: 'session=super-secret' } } }, 'probe');
    logger.info({ req: { headers: { Cookie: 'session=super-secret' } } }, 'probe');

    expect(lines).toHaveLength(2);
    expect(lines.join('')).not.toContain('super-secret');
    expect((JSON.parse(lines[0]) as { req: { headers: { cookie: string } } }).req.headers.cookie).toBe('[Redacted]');
    expect((JSON.parse(lines[1]) as { req: { headers: { Cookie: string } } }).req.headers.Cookie).toBe('[Redacted]');
  });
});
