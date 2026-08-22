import { logCollabConnectionDenial } from '../src/audit-log-denial';
import type { Logger } from 'pino';

/** The audit shape the Security Constitution §Audit requires for a rejected collab connection. */
interface RecordingLogger {
  warn: jest.Mock;
  error: jest.Mock;
  info: jest.Mock;
}

function makeRecordingLogger(): RecordingLogger {
  return { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
}

function asLogger(logger: RecordingLogger): Logger {
  return logger as unknown as Logger;
}

describe('logCollabConnectionDenial', () => {
  it('warns with the full actor/resource/reason payload under the exact audit message', () => {
    const logger = makeRecordingLogger();

    logCollabConnectionDenial(asLogger(logger), {
      actor: '550e8400-e29b-41d4-a716-446655440000',
      resource: '550e8400-e29b-41d4-a716-446655440001/550e8400-e29b-41d4-a716-446655440002',
      reason: 'max_connections_exceeded',
    });

    // The whole call is asserted: a dropped field or a changed message is a changed audit record.
    expect(logger.warn.mock.calls).toEqual([
      [
        {
          actor: '550e8400-e29b-41d4-a716-446655440000',
          resource: '550e8400-e29b-41d4-a716-446655440001/550e8400-e29b-41d4-a716-446655440002',
          reason: 'max_connections_exceeded',
        },
        'collab connection rejected',
      ],
    ]);
    // A denial is a warning, never an error or an info line.
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('still emits every audit key (actor undefined) for a pre-authentication denial', () => {
    const logger = makeRecordingLogger();

    logCollabConnectionDenial(asLogger(logger), {
      resource: 'presence/550e8400-e29b-41d4-a716-446655440001',
      reason: 'origin_not_allowed',
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload, message] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    // `toEqual` ignores undefined-valued keys, so assert the key set explicitly: the audit record
    // must carry all three fields, and the message must be exactly the agreed audit string.
    expect(Object.keys(payload)).toEqual(['actor', 'resource', 'reason']);
    expect(payload.actor).toBeUndefined();
    expect(payload.resource).toBe('presence/550e8400-e29b-41d4-a716-446655440001');
    expect(payload.reason).toBe('origin_not_allowed');
    expect(message).toBe('collab connection rejected');
  });
});
