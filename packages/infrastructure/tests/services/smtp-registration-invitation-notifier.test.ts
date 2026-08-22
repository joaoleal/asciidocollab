import type { EmailSender } from '@asciidocollab/domain';
import { Email } from '@asciidocollab/domain';
import { SmtpRegistrationInvitationNotifier } from '../../src/services/smtp-registration-invitation-notifier';

interface MockEmailSender extends EmailSender {
  send: jest.Mock;
}

function createEmailSender(): MockEmailSender {
  return { send: jest.fn().mockResolvedValue(undefined) };
}

const SUBJECT = 'You have been invited to AsciiDocollab';

/** Both placeholders appear twice on purpose, so single-replacement is detectable. */
const HTML_TEMPLATE =
  '<p>{invitedBy} invited you.</p>'
  + '<a href="https://app.example.com/auth/accept-invitation?token={token}">Accept</a>'
  + '<p>Or paste: https://app.example.com/auth/accept-invitation?token={token}</p>'
  + '<p>Questions? Reply to {invitedBy}.</p>';

function renderedFor(token: string, invitedBy: string): string {
  return `<p>${invitedBy} invited you.</p>`
    + `<a href="https://app.example.com/auth/accept-invitation?token=${token}">Accept</a>`
    + `<p>Or paste: https://app.example.com/auth/accept-invitation?token=${token}</p>`
    + `<p>Questions? Reply to ${invitedBy}.</p>`;
}

describe('SmtpRegistrationInvitationNotifier', () => {
  describe('sendInvitation', () => {
    test('sends to the address value with the exact subject and rendered body', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpRegistrationInvitationNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendInvitation(Email.create('invitee@example.com'), 'inv-tok-42', 'Ada Lovelace');

      expect(emailSender.send).toHaveBeenCalledTimes(1);
      expect(emailSender.send).toHaveBeenCalledWith(
        'invitee@example.com',
        'You have been invited to AsciiDocollab',
        renderedFor('inv-tok-42', 'Ada Lovelace'),
      );
    });

    test('unwraps the Email value object to its normalised string value', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpRegistrationInvitationNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendInvitation(Email.create('Invitee.Name@Example.COM'), 'inv-tok-42', 'Ada');

      expect(emailSender.send.mock.calls[0][0]).toBe('invitee.name@example.com');
    });

    test('embeds the raw token in the accept-invitation path', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpRegistrationInvitationNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendInvitation(Email.create('invitee@example.com'), 'inv-tok-42', 'Ada');

      const html = emailSender.send.mock.calls[0][2] as string;
      expect(html).toContain('https://app.example.com/auth/accept-invitation?token=inv-tok-42');
      expect(html).not.toContain('{token}');
    });

    test('replaces every token placeholder, not just the first', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpRegistrationInvitationNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendInvitation(Email.create('invitee@example.com'), 'inv-tok-42', 'Ada');

      const html = emailSender.send.mock.calls[0][2] as string;
      expect(html.split('inv-tok-42')).toHaveLength(3);
    });

    test('replaces every invitedBy placeholder, not just the first', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpRegistrationInvitationNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendInvitation(Email.create('invitee@example.com'), 'inv-tok-42', 'Ada Lovelace');

      const html = emailSender.send.mock.calls[0][2] as string;
      expect(html.split('Ada Lovelace')).toHaveLength(3);
      expect(html).not.toContain('{invitedBy}');
    });

    test('does not put the inviter name where the token goes, nor the reverse', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpRegistrationInvitationNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendInvitation(Email.create('invitee@example.com'), 'inv-tok-42', 'Ada Lovelace');

      const html = emailSender.send.mock.calls[0][2] as string;
      expect(html).toContain('?token=inv-tok-42');
      expect(html).not.toContain('?token=Ada Lovelace');
      expect(html).toContain('<p>Ada Lovelace invited you.</p>');
      expect(html).not.toContain('<p>inv-tok-42 invited you.</p>');
    });

    test('substitutes the token before the inviter name, so a placeholder inside the name stays literal', async () => {
      // Pins the substitution ORDER in the source: `{token}` is replaced first, therefore a
      // `{token}` sequence carried in by `invitedBy` is NOT expanded afterwards.
      const emailSender = createEmailSender();
      const notifier = new SmtpRegistrationInvitationNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendInvitation(Email.create('invitee@example.com'), 'inv-tok-42', 'Mallory {token}');

      const html = emailSender.send.mock.calls[0][2] as string;
      expect(html).toContain('<p>Mallory {token} invited you.</p>');
    });

    test('leaves a template without placeholders untouched', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpRegistrationInvitationNotifier(
        emailSender,
        SUBJECT,
        '<p>Static invitation.</p>',
      );

      await notifier.sendInvitation(Email.create('invitee@example.com'), 'inv-tok-42', 'Ada');

      expect(emailSender.send.mock.calls[0][2]).toBe('<p>Static invitation.</p>');
    });

    test('does not consume the template, so a second invitation renders its own values', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpRegistrationInvitationNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await notifier.sendInvitation(Email.create('first@example.com'), 'first-token', 'Ada');
      await notifier.sendInvitation(Email.create('second@example.com'), 'second-token', 'Grace');

      expect(emailSender.send).toHaveBeenCalledTimes(2);
      expect(emailSender.send.mock.calls[1]).toEqual([
        'second@example.com',
        SUBJECT,
        renderedFor('second-token', 'Grace'),
      ]);
      expect(emailSender.send.mock.calls[1][2]).not.toContain('first-token');
      expect(emailSender.send.mock.calls[1][2]).not.toContain('Ada');
    });

    test('resolves once the sender resolves', async () => {
      const emailSender = createEmailSender();
      const notifier = new SmtpRegistrationInvitationNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await expect(
        notifier.sendInvitation(Email.create('invitee@example.com'), 'inv-tok-42', 'Ada'),
      ).resolves.toBeUndefined();
    });

    test('propagates sender failures to the caller', async () => {
      const emailSender = createEmailSender();
      emailSender.send.mockRejectedValue(new Error('SMTP connection failed'));
      const notifier = new SmtpRegistrationInvitationNotifier(emailSender, SUBJECT, HTML_TEMPLATE);

      await expect(
        notifier.sendInvitation(Email.create('invitee@example.com'), 'inv-tok-42', 'Ada'),
      ).rejects.toThrow('SMTP connection failed');
    });
  });
});
