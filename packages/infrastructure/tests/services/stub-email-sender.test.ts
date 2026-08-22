import { StubEmailSender } from '../../src/services/stub-email-sender';

// Mock pino so the module-scope logger is observable without writing to stdout.
jest.mock('pino', () => {
  const info = jest.fn();
  const factory = jest.fn(() => ({ info }));
  return { __esModule: true, default: factory, __info: info, __factory: factory };
});

const pinoMock = jest.requireMock('pino');
const infoLog = pinoMock.__info as jest.Mock;
const pinoFactory = pinoMock.__factory as jest.Mock;

// Captured before any beforeEach clears the mocks: the logger is built once, at module load.
const loggerConstructionCalls = pinoFactory.mock.calls.map((call: unknown[]) => call[0]);

describe('StubEmailSender', () => {
  beforeEach(() => {
    infoLog.mockClear();
  });

  describe('logger construction', () => {
    test('builds exactly one module-scope logger at info level', () => {
      expect(loggerConstructionCalls).toEqual([{ level: 'info' }]);
    });

    test('constructing senders does not build additional loggers', () => {
      const before = pinoFactory.mock.calls.length;

      new StubEmailSender();
      new StubEmailSender();

      expect(pinoFactory.mock.calls.length).toBe(before);
    });
  });

  describe('send', () => {
    test('logs the recipient and subject with the stub marker message', async () => {
      const sender = new StubEmailSender();

      await sender.send('recipient@example.com', 'Test Subject', '<p>Test Body</p>');

      expect(infoLog).toHaveBeenCalledTimes(1);
      expect(infoLog).toHaveBeenCalledWith(
        { to: 'recipient@example.com', subject: 'Test Subject' },
        '[STUB] Email sent',
      );
    });

    test('does not log the html body', async () => {
      const sender = new StubEmailSender();

      await sender.send('recipient@example.com', 'Test Subject', '<p>secret-body-marker</p>');

      const payload = infoLog.mock.calls[0][0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('html');
      expect(JSON.stringify(infoLog.mock.calls[0])).not.toContain('secret-body-marker');
    });

    test('keeps the recipient and subject in their own fields, unswapped', async () => {
      const sender = new StubEmailSender();

      await sender.send('to-field@example.com', 'subject-field', '<p>Body</p>');

      const payload = infoLog.mock.calls[0][0] as { to: string; subject: string };
      expect(payload.to).toBe('to-field@example.com');
      expect(payload.subject).toBe('subject-field');
    });

    test('logs once per send, with each message', async () => {
      const sender = new StubEmailSender();

      await sender.send('first@example.com', 'First', '<p>1</p>');
      await sender.send('second@example.com', 'Second', '<p>2</p>');

      expect(infoLog).toHaveBeenCalledTimes(2);
      expect(infoLog.mock.calls[0]).toEqual([
        { to: 'first@example.com', subject: 'First' },
        '[STUB] Email sent',
      ]);
      expect(infoLog.mock.calls[1]).toEqual([
        { to: 'second@example.com', subject: 'Second' },
        '[STUB] Email sent',
      ]);
    });

    test('resolves to undefined and never rejects', async () => {
      const sender = new StubEmailSender();

      await expect(sender.send('recipient@example.com', 'Subject', '<p>Body</p>'))
        .resolves.toBeUndefined();
    });

    test('logs empty strings verbatim rather than substituting defaults', async () => {
      const sender = new StubEmailSender();

      await sender.send('', '', '');

      expect(infoLog).toHaveBeenCalledWith({ to: '', subject: '' }, '[STUB] Email sent');
    });
  });
});
