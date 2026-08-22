import type { EmailSender } from '@asciidocollab/domain';
import { SmtpEmailChangeNotifier } from '../../src/services/smtp-email-change-notifier';

interface MockEmailSender extends EmailSender {
  send: jest.Mock;
}

function createEmailSender(): MockEmailSender {
  return { send: jest.fn().mockResolvedValue(undefined) };
}

const SUBJECT = 'Confirm your new email address';

/** Two placeholders on purpose: the link and the plain-text fallback must both be filled. */
const HTML_TEMPLATE =
  '<p>Confirm your new address.</p>'
  + '<a href="https://app.example.com/auth/confirm-email-change?token={token}">Confirm</a>'
  + '<p>Or paste: https://app.example.com/auth/confirm-email-change?token={token}</p>';

function renderedFor(token: string): string {
  return '<p>Confirm your new address.</p>'
    + `<a href="https://app.example.com/auth/confirm-email-change?token=${token}">Confirm</a>`
    + `<p>Or paste: https://app.example.com/auth/confirm-email-change?token=${token}</p>`;
}

describe('SmtpEmailChangeNotifier', () => {
  describe('sendConfirmationEmail', () => {
    test('sends to the exact recipient with the exact subject and rendered body', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpEmailChangeNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendConfirmationEmail('new-address@example.com', 'chg-tok-123');

      expect(emailSender.send).toHaveBeenCalledTimes(1);
      expect(emailSender.send).toHaveBeenCalledWith(
        'new-address@example.com',
        'Confirm your new email address',
        renderedFor('chg-tok-123'),
      );
    });

    test('passes the recipient through verbatim without normalising it', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpEmailChangeNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendConfirmationEmail('New.Address+tag@Example.COM', 'chg-tok-123');

      expect(emailSender.send.mock.calls[0][0]).toBe('New.Address+tag@Example.COM');
    });

    test('embeds the raw token in the confirm-email-change path', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpEmailChangeNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendConfirmationEmail('new-address@example.com', 'chg-tok-123');

      const html = emailSender.send.mock.calls[0][2] as string;
      expect(html).toContain('https://app.example.com/auth/confirm-email-change?token=chg-tok-123');
      expect(html).not.toContain('{token}');
    });

    test('replaces every token placeholder, not just the first', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpEmailChangeNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendConfirmationEmail('new-address@example.com', 'chg-tok-123');

      const html = emailSender.send.mock.calls[0][2] as string;
      expect(html.split('chg-tok-123')).toHaveLength(3);
    });

    test('leaves a template without a placeholder untouched', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpEmailChangeNotifier(emailSender, SUBJECT, '<p>No link here.</p>');

      await notifier.sendConfirmationEmail('new-address@example.com', 'chg-tok-123');

      expect(emailSender.send.mock.calls[0][2]).toBe('<p>No link here.</p>');
    });

    test('does not consume the template, so a second send uses the second token only', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpEmailChangeNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendConfirmationEmail('first@example.com', 'first-token');
      await notifier.sendConfirmationEmail('second@example.com', 'second-token');

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
      const notifier = new SmtpEmailChangeNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendConfirmationEmail('new-address@example.com', 'a+b/c=d');

      expect(emailSender.send.mock.calls[0][2]).toBe(renderedFor('a+b/c=d'));
    });

    test('resolves once the sender resolves', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpEmailChangeNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await expect(
        notifier.sendConfirmationEmail('new-address@example.com', 'chg-tok-123'),
      ).resolves.toBeUndefined();
    });

    test('propagates sender failures to the caller', async () => {
      const emailSender = createEmailSender();
      emailSender.send.mockRejectedValue(new Error('SMTP connection failed'));
      const notifier = new SmtpEmailChangeNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await expect(
        notifier.sendConfirmationEmail('new-address@example.com', 'chg-tok-123'),
      ).rejects.toThrow('SMTP connection failed');
    });
  });
});
