import { CheckSystemSetupUseCase } from '../../../src/use-cases/settings/check-system-setup';
import { InMemoryUserRepository } from '../../ports/user/in-memory-user.repository';
import { User } from '../../../src/entities/user';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Email } from '../../../src/value-objects/identity/email';
import { Timestamps } from '../../../src/value-objects/common/timestamps';
import { randomUUID } from 'crypto';

describe('CheckSystemSetupUseCase', () => {
  let repo: InMemoryUserRepository;
  let useCase: CheckSystemSetupUseCase;

  beforeEach(() => {
    repo = new InMemoryUserRepository();
    useCase = new CheckSystemSetupUseCase(repo);
  });

  test('returns configured: false when no users exist', async () => {
    const result = await useCase.execute();
    expect(result.configured).toBe(false);
  });

  test('returns configured: true when at least one user exists', async () => {
    const user = new User(
      UserId.create(randomUUID()),
      Email.create('admin@example.com'),
      'Admin',
      'hashed-password',
      [],
      null,
      null,
      false,
      new Timestamps(),
    );
    await repo.save(user);

    const result = await useCase.execute();
    expect(result.configured).toBe(true);
  });
});
