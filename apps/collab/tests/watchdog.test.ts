import type { DocumentRepository } from '@asciidocollab/domain';
import { createRequire } from 'node:module';

// Native ESM: jest.mock() cannot intercept a static import, so `pino` is mocked here and the unit
// under test is imported dynamically below. The mock builds a REAL pino logger — loaded through
// createRequire, which bypasses the mocked registry — writing into a captured buffer, so both the
// watchdog's log records AND the redaction configured on its logger are asserted against genuine
// pino output rather than against a stubbed logger that could not redact anything.
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

const { startOrphanedRoomWatchdog } = await import('../src/watchdog');

const projectId = '550e8400-e29b-41d4-a716-446655440001';
const yjsStateId = '550e8400-e29b-41d4-a716-446655440002';
const roomName = `${projectId}/${yjsStateId}`;

/** A parsed pino record, as written by the module-level logger of the unit under test. */
interface LogRecord {
  level?: number;
  msg?: string;
  roomName?: string;
  err?: { message?: string; type?: string };
}

/** Every line written by any logger the loaded module graph built, parsed, in write order. */
function capturedLogRecords(): LogRecord[] {
  return mockPinoInstances.flatMap((instance) => instance.lines).map((line) => JSON.parse(line) as LogRecord);
}

function clearCapturedLogLines(): void {
  for (const instance of mockPinoInstances) instance.lines.length = 0;
}

/** Lets the watchdog's async body (parse, await lookup, log) run to completion under fake timers. */
async function drainWatchdogTick(): Promise<void> {
  jest.advanceTimersByTime(150);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('startOrphanedRoomWatchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('destroys room when document no longer exists in DocumentRepository', async () => {
    const mockDestroy = jest.fn();
    const server = {
      documents: new Map([[roomName, { destroy: mockDestroy }]]),
    };

    const documentRepo = {
      findByYjsStateId: jest.fn().mockResolvedValue(null),
    } as unknown as DocumentRepository;

    const interval = startOrphanedRoomWatchdog(server, documentRepo, 100);

    jest.advanceTimersByTime(150);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    clearInterval(interval);

    expect(documentRepo.findByYjsStateId).toHaveBeenCalledWith(
      expect.objectContaining({ value: yjsStateId }),
    );
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('skips room silently when room name has no slash (invalid format)', async () => {
    const mockDestroy = jest.fn();
    const server = {
      documents: new Map([['invalidRoomName', { destroy: mockDestroy }]]),
    };

    const documentRepo = {
      findByYjsStateId: jest.fn().mockResolvedValue(null),
    } as unknown as DocumentRepository;

    const interval = startOrphanedRoomWatchdog(server, documentRepo, 100);

    jest.advanceTimersByTime(150);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    clearInterval(interval);

    // Invalid room name is skipped before DB lookup — no destroy, no DB call.
    expect(documentRepo.findByYjsStateId).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('does not destroy room and logs error when DB lookup throws', async () => {
    const mockDestroy = jest.fn();
    const server = {
      documents: new Map([[roomName, { destroy: mockDestroy }]]),
    };
    const databaseError = new Error('connection timeout');
    const documentRepo = {
      findByYjsStateId: jest.fn().mockRejectedValue(databaseError),
    } as unknown as DocumentRepository;

    const interval = startOrphanedRoomWatchdog(server, documentRepo, 100);

    jest.advanceTimersByTime(150);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    clearInterval(interval);

    // Room must not be destroyed on a transient DB error.
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('does not destroy room when document still exists', async () => {
    const mockDestroy = jest.fn();
    const server = {
      documents: new Map([[roomName, { destroy: mockDestroy }]]),
    };

    const documentRepo = {
      findByYjsStateId: jest.fn().mockResolvedValue({ id: { value: 'some-id' } }),
    } as unknown as DocumentRepository;

    const interval = startOrphanedRoomWatchdog(server, documentRepo, 100);

    jest.advanceTimersByTime(150);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    clearInterval(interval);

    expect(mockDestroy).not.toHaveBeenCalled();
  });
});

// The watchdog swallows a lookup failure so one bad room cannot stop the sweep — the ONLY trace it
// leaves is the log record, so the record itself is the contract: it must name the offending room
// and carry the underlying error, under a message an operator can grep for.
describe('startOrphanedRoomWatchdog error logging', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clearCapturedLogLines();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('logs the offending room name, the underlying error and the exact message when the lookup throws', async () => {
    const server = { documents: new Map([[roomName, { destroy: jest.fn() }]]) };
    const documentRepo = {
      findByYjsStateId: jest.fn().mockRejectedValue(new Error('connection timeout')),
    } as unknown as DocumentRepository;

    const interval = startOrphanedRoomWatchdog(server, documentRepo, 100);
    await drainWatchdogTick();
    clearInterval(interval);

    const records = capturedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0].msg).toBe('Watchdog: error checking document existence');
    expect(records[0].roomName).toBe(roomName);
    expect(records[0].err?.message).toBe('connection timeout');
    expect(records[0].level).toBe(50); // pino "error"
  });

  it('logs nothing when the lookup succeeds', async () => {
    const server = { documents: new Map([[roomName, { destroy: jest.fn() }]]) };
    const documentRepo = {
      findByYjsStateId: jest.fn().mockResolvedValue({ id: { value: 'some-id' } }),
    } as unknown as DocumentRepository;

    const interval = startOrphanedRoomWatchdog(server, documentRepo, 100);
    await drainWatchdogTick();
    clearInterval(interval);

    expect(capturedLogRecords()).toEqual([]);
  });

  it('logs nothing when an orphaned room is destroyed', async () => {
    const mockDestroy = jest.fn();
    const server = { documents: new Map([[roomName, { destroy: mockDestroy }]]) };
    const documentRepo = {
      findByYjsStateId: jest.fn().mockResolvedValue(null),
    } as unknown as DocumentRepository;

    const interval = startOrphanedRoomWatchdog(server, documentRepo, 100);
    await drainWatchdogTick();
    clearInterval(interval);

    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(capturedLogRecords()).toEqual([]);
  });

  it('builds its logger with cookie redaction, so a session cookie never reaches the log output', async () => {
    // Identify the watchdog's own logger by the record it just wrote, then feed that very instance a
    // request-shaped payload: the redaction must be real, not merely configured.
    const server = { documents: new Map([[roomName, { destroy: jest.fn() }]]) };
    const documentRepo = {
      findByYjsStateId: jest.fn().mockRejectedValue(new Error('connection timeout')),
    } as unknown as DocumentRepository;

    const interval = startOrphanedRoomWatchdog(server, documentRepo, 100);
    await drainWatchdogTick();
    clearInterval(interval);

    const own = mockPinoInstances.find((instance) => instance.lines.length > 0);
    expect(own).toBeDefined();

    own!.logger.info({ req: { headers: { cookie: 'session=super-secret' } } }, 'probe');
    own!.logger.info({ req: { headers: { Cookie: 'session=super-secret' } } }, 'probe');

    const probes = own!.lines.slice(-2);
    expect(probes).toHaveLength(2);
    expect(probes.join('')).not.toContain('super-secret');
    expect((JSON.parse(probes[0]) as { req: { headers: { cookie: string } } }).req.headers.cookie).toBe('[Redacted]');
    expect((JSON.parse(probes[1]) as { req: { headers: { Cookie: string } } }).req.headers.Cookie).toBe('[Redacted]');
  });
});
