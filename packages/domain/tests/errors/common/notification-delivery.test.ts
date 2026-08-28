import { NotificationDeliveryError } from '../../../src/errors/common/notification-delivery';
import { DomainError } from '../../../src/errors/domain-error';

describe('NotificationDeliveryError', () => {
  it('reports a delivery failure without a cause when none is supplied', () => {
    const error = new NotificationDeliveryError();

    expect(error.name).toBe('NotificationDeliveryError');
    expect(error.message).toBe('Notification delivery failed');
    expect(error.cause).toBeUndefined();
  });

  it('wraps the underlying transport failure as its cause', () => {
    const cause = new Error('SMTP 421');
    const error = new NotificationDeliveryError(cause);

    expect(error.message).toBe('Notification delivery failed');
    expect(error.cause).toBe(cause);
  });

  it('is a domain error that survives instanceof checks', () => {
    expect(new NotificationDeliveryError()).toBeInstanceOf(DomainError);
    expect(new NotificationDeliveryError()).toBeInstanceOf(NotificationDeliveryError);
  });
});
