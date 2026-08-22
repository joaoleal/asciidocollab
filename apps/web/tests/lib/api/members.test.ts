/**
 * Direct unit tests for the project-membership API client (`src/lib/api/members.ts`).
 *
 * The barrel-level suite in `tests/lib/api.test.ts` checks the methods and a substring
 * of each URL. These tests pin the exact URL and the exact JSON payload of every
 * mutating call, plus the error paths.
 */
import { API_BASE_URL } from '@/lib/api/base-url';
import { membersApi } from '@/lib/api/members';

const fetchMock = jest.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const member = {
  userId: 'u1',
  email: 'alice@example.com',
  displayName: 'Alice',
  role: 'viewer' as const,
  joinedAt: '2026-01-01T00:00:00.000Z',
};

/** Queues one successful JSON response. */
function okOnce(body: unknown): void {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
}

/** Queues one non-ok JSON response. */
function failOnce(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({ ok: false, status, json: async () => body });
}

/** The URL of the single fetch performed by the call under test. */
function requestUrl(): string {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return String(fetchMock.mock.calls[0][0]);
}

/** The init of the single fetch performed by the call under test. */
function requestInit(): RequestInit {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return fetchMock.mock.calls[0][1] as RequestInit;
}

/** The request body of the single fetch, parsed back from JSON. */
function requestBody(): unknown {
  return JSON.parse(String(requestInit().body));
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('membersApi.list', () => {
  test('GETs the project members collection with credentials and no body', async () => {
    okOnce({ data: { members: [member] } });

    const result = await membersApi.list('p1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/p1/members`);
    expect(requestInit().method).toBeUndefined();
    expect(requestInit().body).toBeUndefined();
    expect(requestInit().credentials).toBe('include');
    expect(result.data.members).toEqual([member]);
  });

  test('surfaces a forbidden listing', async () => {
    failOnce(403, { error: { code: 'FORBIDDEN', message: 'Not a member of this project' } });

    await expect(membersApi.list('p1')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Not a member of this project',
    });
  });
});

describe('membersApi.invite', () => {
  test('POSTs the invitation payload to the project members collection', async () => {
    okOnce({ data: member });

    await membersApi.invite('p1', { email: 'alice@example.com', role: 'viewer' });

    // The exact collection URL, not just the method: the invite POST and the list GET
    // must address the same endpoint.
    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/p1/members`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().body).toBe(JSON.stringify({ email: 'alice@example.com', role: 'viewer' }));
    expect(requestBody()).toEqual({ email: 'alice@example.com', role: 'viewer' });
    expect((requestInit().headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(requestInit().credentials).toBe('include');
  });

  test('carries the project id into the URL', async () => {
    okOnce({ data: member });

    await membersApi.invite('other-project', { email: 'bob@example.com', role: 'editor' });

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/other-project/members`);
  });

  test('surfaces an unknown-user rejection', async () => {
    failOnce(404, { error: { code: 'USER_NOT_FOUND', message: 'User not found' } });

    await expect(membersApi.invite('p1', { email: 'nobody@example.com', role: 'viewer' })).rejects.toMatchObject({
      status: 404,
      code: 'USER_NOT_FOUND',
      message: 'User not found',
    });
  });
});

describe('membersApi.updateRole', () => {
  test('PATCHes the new role to the member resource', async () => {
    okOnce({ data: { userId: 'u1', role: 'editor' } });

    const result = await membersApi.updateRole('p1', 'u1', 'editor');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/p1/members/u1`);
    expect(requestInit().method).toBe('PATCH');
    expect(requestInit().body).toBe(JSON.stringify({ role: 'editor' }));
    expect(requestBody()).toEqual({ role: 'editor' });
    expect(result.data).toEqual({ userId: 'u1', role: 'editor' });
  });

  test('sends whichever role was requested', async () => {
    okOnce({ data: { userId: 'u2', role: 'viewer' } });

    await membersApi.updateRole('p1', 'u2', 'viewer');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/p1/members/u2`);
    expect(requestBody()).toEqual({ role: 'viewer' });
  });

  test('surfaces a refusal to change the last owner role', async () => {
    failOnce(400, { error: { code: 'LAST_OWNER', message: 'A project must keep at least one owner' } });

    await expect(membersApi.updateRole('p1', 'u1', 'viewer')).rejects.toMatchObject({
      status: 400,
      code: 'LAST_OWNER',
      message: 'A project must keep at least one owner',
    });
  });
});

describe('membersApi.remove', () => {
  test('DELETEs the member resource without a body or content type', async () => {
    okOnce({ data: { message: 'Removed' } });

    const result = await membersApi.remove('p1', 'u1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/api/projects/p1/members/u1`);
    expect(requestInit().method).toBe('DELETE');
    expect(requestInit().body).toBeUndefined();
    expect((requestInit().headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect(result.data.message).toBe('Removed');
  });

  test('surfaces a forbidden removal', async () => {
    failOnce(403, { error: { code: 'FORBIDDEN', message: 'Only an owner can remove members' } });

    await expect(membersApi.remove('p1', 'u1')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Only an owner can remove members',
    });
  });
});
