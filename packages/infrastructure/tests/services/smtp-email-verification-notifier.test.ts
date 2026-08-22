import type { EmailSender } from '@asciidocollab/domain';
import { Email } from '@asciidocollab/domain';
import { SmtpEmailVerificationNotifier } from '../../src/services/smtp-email-verification-notifier';

interface MockEmailSender extends EmailSender {
  send: jest.Mock;
}

function createEmailSender(): MockEmailSender {
  return { send: jest.fn().mockResolvedValue(undefined) };
}

const VERIFY_SUBJECT = 'Verify your email address';
const RESEND_SUBJECT = 'Your new verification link';

/** Two placeholders on purpose: the link and the plain-text fallback must both be filled. */
const VERIFY_TEMPLATE =
  '<p>Welcome! Verify your address.</p>'
  + '<a href="https://app.example.com/auth/verify-email?token={token}">Verify</a>'
  + '<p>Or paste: https://app.example.com/auth/verify-email?token={token}</p>';

const RESEND_TEMPLATE =
  '<p>Here is a fresh link.</p>'
  + '<a href="https://app.example.com/auth/verify-email/resend?token={token}">Verify</a>'
  + '<p>Or paste: https://app.example.com/auth/verify-email/resend?token={token}</p>';

function verifyRenderedFor(token: string): string {
  return '<p>Welcome! Verify your address.</p>'
    + `<a href="https://app.example.com/auth/verify-email?token=${token}">Verify</a>`
    + `<p>Or paste: https://app.example.com/auth/verify-email?token=${token}</p>`;
}

function resendRenderedFor(token: string): string {
  return '<p>Here is a fresh link.</p>'
    + `<a href="https://app.example.com/auth/verify-email/resend?token=${token}">Verify</a>`
    + `<p>Or paste: https://app.example.com/auth/verify-email/resend?token=${token}</p>`;
}

function createNotifier(emailSender: EmailSender): SmtpEmailVerificationNotifier {
  return new SmtpEmailVerificationNotifier(
    emailSender,
    VERIFY_SUBJECT,
    VERIFY_TEMPLATE,
    RESEND_SUBJECT,
    RESEND_TEMPLATE,
  );
}

describe('SmtpEmailVerificationNotifier', () => {
  describe('sendVerificationEmail', () => {
    test('sends to the address value with the verify subject and verify body', async () => {
      const emailSender = createEmailSender();
      const notifier = createNotifier(emailSender);

      await notifier.sendVerificationEmail(Email.create('user@example.com'), 'verify-tok-1');

      expect(emailSender.send).toHaveBeenCalledTimes(1);
      expect(emailSender.send).toHaveBeenCalledWith(
        'user@example.com',
        'Verify your email address',
        verifyRenderedFor('verify-tok-1'),
      );
    });

    test('unwraps the Email value object to its normalised string value', async () => {
      const emailSender = createEmailSender();
      const notifier = createNotifier(emailSender);

      await notifier.sendVerificationEmail(Email.create('User.Name@Example.COM'), 'verify-tok-1');

      // Email normalises to lowercase; the notifier must pass `.value`, not the object.
      expect(emailSender.send.mock.calls[0][0]).toBe('user.name@example.com');
    });

    test('embeds the raw token in the verify-email path', async () => {
      const emailSender = createEmailSender();
      const notifier = createNotifier(emailSender);

      await notifier.sendVerificationEmail(Email.create('user@example.com'), 'verify-tok-1');

      const html = emailSender.send.mock.calls[0][2] as string;
      expect(html).toContain('https://app.example.com/auth/verify-email?token=verify-tok-1');
      expect(html).not.toContain('/auth/verify-email/resend');
      expect(html).not.toContain('{token}');
    });

    test('replaces every token placeholder, not just the first', async () => {
      const emailSender = createEmailSender();
      const notifier = createNotifier(emailSender);

      await notifier.sendVerificationEmail(Email.create('user@example.com'), 'verify-tok-1');

      const html = emailSender.send.mock.calls[0][2] as string;
      expect(html.split('verify-tok-1')).toHaveLength(3);
    });

    test('never uses the resend subject or the resend template', async () => {
      const emailSender = createEmailSender();
      const notifier = createNotifier(emailSender);

      await notifier.sendVerificationEmail(Email.create('user@example.com'), 'verify-tok-1');

      expect(emailSender.send.mock.calls[0][1]).not.toBe(RESEND_SUBJECT);
      expect(emailSender.send.mock.calls[0][2]).not.toBe(resendRenderedFor('verify-tok-1'));
    });

    test('propagates sender failures to the caller', async () => {
      const emailSender = createEmailSender();
      emailSender.send.mockRejectedValue(new Error('SMTP connection failed'));
      const notifier = createNotifier(emailSender);

      await expect(
        notifier.sendVerificationEmail(Email.create('user@example.com'), 'verify-tok-1'),
      ).rejects.toThrow('SMTP connection failed');
    });

    test('resolves once the sender resolves', async () => {
      const emailSender = createEmailSender();
      const notifier = createNotifier(emailSender);

      await expect(
        notifier.sendVerificationEmail(Email.create('user@example.com'), 'verify-tok-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendResendVerificationEmail', () => {
    test('sends to the address value with the resend subject and resend body', async () => {
      const emailSender = createEmailSender();
      const notifier = createNotifier(emailSender);

      await notifier.sendResendVerificationEmail(Email.create('user@example.com'), 'resend-tok-2');

      expect(emailSender.send).toHaveBeenCalledTimes(1);
      expect(emailSender.send).toHaveBeenCalledWith(
        'user@example.com',
        'Your new verification link',
        resendRenderedFor('resend-tok-2'),
      );
    });

    test('unwraps the Email value object to its normalised string value', async () => {
      const emailSender = createEmailSender();
      const notifier = createNotifier(emailSender);

      await notifier.sendResendVerificationEmail(
        Email.create('User.Name@Example.COM'),
        'resend-tok-2',
      );

      expect(emailSender.send.mock.calls[0][0]).toBe('user.name@example.com');
    });

    test('embeds the raw token in the resend path', async () => {
      const emailSender = createEmailSender();
      const notifier = createNotifier(emailSender);

      await notifier.sendResendVerificationEmail(Email.create('user@example.com'), 'resend-tok-2');

      const html = emailSender.send.mock.calls[0][2] as string;
      expect(html).toContain('https://app.example.com/auth/verify-email/resend?token=resend-tok-2');
      expect(html).not.toContain('{token}');
    });

    test('replaces every token placeholder, not just the first', async () => {
      const emailSender = createEmailSender();
      const notifier = createNotifier(emailSender);

      await notifier.sendResendVerificationEmail(Email.create('user@example.com'), 'resend-tok-2');

      const html = emailSender.send.mock.calls[0][2] as string;
      expect(html.split('resend-tok-2')).toHaveLength(3);
    });

    test('never uses the initial verify subject or the verify template', async () => {
      const emailSender = createEmailSender();
      const notifier = createNotifier(emailSender);

      await notifier.sendResendVerificationEmail(Email.create('user@example.com'), 'resend-tok-2');

      expect(emailSender.send.mock.calls[0][1]).not.toBe(VERIFY_SUBJECT);
      expect(emailSender.send.mock.calls[0][2]).not.toBe(verifyRenderedFor('resend-tok-2'));
    });

    test('propagates sender failures to the caller', async () => {
      const emailSender = createEmailSender();
      emailSender.send.mockRejectedValue(new Error('SMTP connection failed'));
      const notifier = createNotifier(emailSender);

      await expect(
        notifier.sendResendVerificationEmail(Email.create('user@example.com'), 'resend-tok-2'),
      ).rejects.toThrow('SMTP connection failed');
    });

    test('resolves once the sender resolves', async () => {
      const emailSender = createEmailSender();
      const notifier = createNotifier(emailSender);

      await expect(
        notifier.sendResendVerificationEmail(Email.create('user@example.com'), 'resend-tok-2'),
      ).resolves.toBeUndefined();
    });
  });

  describe('the two flows stay distinct', () => {
    test('the same instance renders different subjects and paths for verify and resend', async () => {
      const emailSender = createEmailSender();
      const notifier = createNotifier(emailSender);
      const address = Email.create('user@example.com');

      await notifier.sendVerificationEmail(address, 'same-token');
      await notifier.sendResendVerificationEmail(address, 'same-token');

      expect(emailSender.send.mock.calls[0]).toEqual([
        'user@example.com',
        VERIFY_SUBJECT,
        verifyRenderedFor('same-token'),
      ]);
      expect(emailSender.send.mock.calls[1]).toEqual([
        'user@example.com',
        RESEND_SUBJECT,
        resendRenderedFor('same-token'),
      ]);
    });

    test('templates without placeholders pass through unchanged and unswapped', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpEmailVerificationNotifier(
        emailSender,
        VERIFY_SUBJECT,
        '<p>verify body</p>',
        RESEND_SUBJECT,
        '<p>resend body</p>',
      );
      const address = Email.create('user@example.com');

      await notifier.sendVerificationEmail(address, 'tok');
      await notifier.sendResendVerificationEmail(address, 'tok');

      expect(emailSender.send.mock.calls[0][2]).toBe('<p>verify body</p>');
      expect(emailSender.send.mock.calls[1][2]).toBe('<p>resend body</p>');
    });
  });
});
