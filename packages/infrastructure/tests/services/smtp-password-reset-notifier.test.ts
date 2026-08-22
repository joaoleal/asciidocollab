import type { EmailSender } from '@asciidocollab/domain';
import { SmtpPasswordResetNotifier } from '../../src/services/smtp-password-reset-notifier';

interface MockEmailSender extends EmailSender {
  send: jest.Mock;
}

function createEmailSender(): MockEmailSender {
  return { send: jest.fn().mockResolvedValue(undefined) };
}

const SUBJECT = 'Reset your password';

/** Two placeholders on purpose: the link and the plain-text fallback must both be filled. */
const HTML_TEMPLATE =
  '<p>Reset your password.</p>'
  + '<a href="https://app.example.com/auth/reset-password?token={token}">Reset</a>'
  + '<p>Or paste: https://app.example.com/auth/reset-password?token={token}</p>';

function renderedFor(token: string): string {
  return '<p>Reset your password.</p>'
    + `<a href="https://app.example.com/auth/reset-password?token=${token}">Reset</a>`
    + `<p>Or paste: https://app.example.com/auth/reset-password?token=${token}</p>`;
}

describe('SmtpPasswordResetNotifier', () => {
  describe('sendResetEmail', () => {
    test('sends to the exact recipient with the exact subject and rendered body', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpPasswordResetNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendResetEmail('user@example.com', 'reset-tok-987');

      expect(emailSender.send).toHaveBeenCalledTimes(1);
      expect(emailSender.send).toHaveBeenCalledWith(
        'user@example.com',
        'Reset your password',
        renderedFor('reset-tok-987'),
      );
    });

    test('passes the recipient through verbatim without normalising it', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpPasswordResetNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendResetEmail('User.Name+tag@Example.COM', 'reset-tok-987');

      expect(emailSender.send.mock.calls[0][0]).toBe('User.Name+tag@Example.COM');
    });

    test('embeds the raw token in the reset-password path', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpPasswordResetNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendResetEmail('user@example.com', 'reset-tok-987');

      const html = emailSender.send.mock.calls[0][2] as string;
      expect(html).toContain('https://app.example.com/auth/reset-password?token=reset-tok-987');
      expect(html).not.toContain('{token}');
    });

    test('replaces every token placeholder, not just the first', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpPasswordResetNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendResetEmail('user@example.com', 'reset-tok-987');

      const html = emailSender.send.mock.calls[0][2] as string;
      expect(html.split('reset-tok-987')).toHaveLength(3);
    });

    test('leaves a template without a placeholder untouched', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpPasswordResetNotifier(emailSender, SUBJECT, '<p>No link here.</p>');

      await notifier.sendResetEmail('user@example.com', 'reset-tok-987');

      expect(emailSender.send.mock.calls[0][2]).toBe('<p>No link here.</p>');
    });

    test('does not consume the template, so a second send uses the second token only', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpPasswordResetNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendResetEmail('first@example.com', 'first-token');
      await notifier.sendResetEmail('second@example.com', 'second-token');

      expect(emailSender.send).toHaveBeenCalledTimes(2);
      expect(emailSender.send.mock.calls[1]).toEqual([
        'second@example.com',
        SUBJECT,
        renderedFor('second-token'),
      ]);
      expect(emailSender.send.mock.calls[1][2]).not.toContain('first-token');
    });

    test('inserts the token literally without escaping it', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpPasswordResetNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendResetEmail('user@example.com', 'a+b/c=d');

      expect(emailSender.send.mock.calls[0][2]).toBe(renderedFor('a+b/c=d'));
    });

    test('resolves once the sender resolves', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpPasswordResetNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await expect(
        notifier.sendResetEmail('user@example.com', 'reset-tok-987'),
      ).resolves.toBeUndefined();
    });

    test('propagates sender failures to the caller', async () => {
      const emailSender = createEmailSender();
      emailSender.send.mockRejectedValue(new Error('SMTP connection failed'));
      const notifier = new SmtpPasswordResetNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await expect(
        notifier.sendResetEmail('user@example.com', 'reset-tok-987'),
      ).rejects.toThrow('SMTP connection failed');
    });
  });
});
