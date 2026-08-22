import { ChangeNotifierExtension } from '../../src/extensions/change-notifier';
import type { onChangePayload } from '@hocuspocus/server';

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440001';
const YJS_STATE_ID = '550e8400-e29b-41d4-a716-446655440002';
const DOCUMENT_NAME = `${PROJECT_ID}/${YJS_STATE_ID}`;
const NOTIFY_PATH = '/internal/collab/content-changed';
const API_URL = 'http://127.0.0.1:4001';
const NOTIFY_URL = `${API_URL}${NOTIFY_PATH}`;

const mockLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };

function makeExtension(fetchFunction: jest.Mock, debounceMs = 100) {
  return new ChangeNotifierExtension({
    apiInternalUrl: API_URL,
    notifyPath: NOTIFY_PATH,
    debounceMs,
    logger: mockLogger as never,
    fetch: fetchFunction as unknown as typeof globalThis.fetch,
  });
}

function okFetch() {
  return jest.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
}

function changePayload(documentName = DOCUMENT_NAME): onChangePayload {
  return { documentName } as unknown as onChangePayload;
}

describe('ChangeNotifierExtension', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('POSTs the room ids to the notify URL after the debounce window elapses', async () => {
    const fetchFunction = okFetch();
    const extension = makeExtension(fetchFunction);

    await extension.onChange(changePayload());
    expect(fetchFunction).not.toHaveBeenCalled(); // debounced — nothing yet

    jest.advanceTimersByTime(100);
    await Promise.resolve();

    expect(fetchFunction).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFunction.mock.calls[0];
    expect(url).toBe(NOTIFY_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID });
  });

  it('coalesces a burst of changes into a single notify per room', async () => {
    const fetchFunction = okFetch();
    const extension = makeExtension(fetchFunction);

    await extension.onChange(changePayload());
    await extension.onChange(changePayload());
    await extension.onChange(changePayload());
    jest.advanceTimersByTime(100);
    await Promise.resolve();

    expect(fetchFunction).toHaveBeenCalledTimes(1);
  });

  it('does not expose a beforeHandleMessage hook (avoids firing on awareness/sync traffic)', () => {
    const extension = makeExtension(okFetch());
    expect((extension as unknown as { beforeHandleMessage?: unknown }).beforeHandleMessage).toBeUndefined();
  });

  it('skips presence rooms (no notify)', async () => {
    const fetchFunction = okFetch();
    const extension = makeExtension(fetchFunction);

    await extension.onChange(changePayload(`presence/${PROJECT_ID}`));
    jest.advanceTimersByTime(100);
    await Promise.resolve();

    expect(fetchFunction).not.toHaveBeenCalled();
  });

  it('tolerates a rejected fetch (best-effort) and logs a warning', async () => {
    const fetchFunction = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const extension = makeExtension(fetchFunction);

    await extension.onChange(changePayload());
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('logs a warning on a non-2xx response but does not throw', async () => {
    const fetchFunction = jest.fn().mockResolvedValue({ ok: false, status: 503 } as Response);
    const extension = makeExtension(fetchFunction);

    await extension.onChange(changePayload());
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('sends the exact request init the API expects and logs nothing on a 2xx', async () => {
    const fetchFunction = okFetch();
    const extension = makeExtension(fetchFunction);

    await extension.onChange(changePayload());
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const [, init] = fetchFunction.mock.calls[0];
    // The whole init, not just `method`: a dropped header or body would otherwise go unnoticed.
    expect(init).toEqual({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT_ID, yjsStateId: YJS_STATE_ID }),
    });
    // A 2xx is the silent path — warning on it would spam the log for every healthy edit.
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('logs the exact status payload and message on a non-2xx response', async () => {
    const fetchFunction = jest.fn().mockResolvedValue({ ok: false, status: 503 } as Response);
    const extension = makeExtension(fetchFunction);

    await extension.onChange(changePayload());
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      { status: 503, projectId: PROJECT_ID },
      'content-changed notify returned non-2xx (best-effort)',
    );
  });

  it('logs the exact error payload and message when the fetch itself rejects', async () => {
    const failure = new Error('ECONNREFUSED');
    const fetchFunction = jest.fn().mockRejectedValue(failure);
    const extension = makeExtension(fetchFunction);

    await extension.onChange(changePayload());
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      { err: failure, projectId: PROJECT_ID },
      'content-changed notify failed (best-effort)',
    );
  });

  it('ignores a malformed room name that is neither a presence nor a content room', async () => {
    const fetchFunction = okFetch();
    const extension = makeExtension(fetchFunction);

    // No slash → parseContentRoom returns null. Scheduling a timer for it would blow up on
    // `room.projectId` when the timer fires, so the early return has to happen.
    await extension.onChange(changePayload('malformed-room-name'));
    jest.advanceTimersByTime(100);
    await Promise.resolve();

    expect(fetchFunction).not.toHaveBeenCalled();
  });

  it('clears the pending timer only when one already exists for the room', async () => {
    const clearSpy = jest.spyOn(globalThis, 'clearTimeout');
    try {
      const extension = makeExtension(okFetch());

      await extension.onChange(changePayload());
      expect(clearSpy).not.toHaveBeenCalled(); // nothing pending yet

      await extension.onChange(changePayload());
      expect(clearSpy).toHaveBeenCalledTimes(1); // the first timer, replaced
    } finally {
      clearSpy.mockRestore();
    }
  });

  it('tolerates a timer handle that has no unref (optional call)', async () => {
    // Node's Timeout has unref(); a handle without it (a browser-style numeric id, or a shimmed
    // timer) must not crash the change hook.
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockReturnValue({} as never);
    try {
      const extension = makeExtension(okFetch());
      await expect(extension.onChange(changePayload())).resolves.toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('onDestroy cancels a pending notify', async () => {
    const fetchFunction = okFetch();
    const extension = makeExtension(fetchFunction);

    await extension.onChange(changePayload());
    await extension.onDestroy();
    jest.advanceTimersByTime(100);
    await Promise.resolve();

    expect(fetchFunction).not.toHaveBeenCalled();
  });
});
