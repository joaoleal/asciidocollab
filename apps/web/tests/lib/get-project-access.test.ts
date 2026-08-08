// Tests for the server-side project access helper in src/lib/get-project-access.ts.

const mockRedirect = jest.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
jest.mock('next/navigation', () => ({
  redirect: (url: string) => mockRedirect(url),
}));

const mockGetAll = jest.fn();
jest.mock('next/headers', () => ({
  cookies: jest.fn().mockResolvedValue({ getAll: () => mockGetAll() }),
}));

import { getProjectAccess } from '@/lib/get-project-access';

const PROJECT_ID = 'proj-1';

/** The slice of `Response` the unit under test reads. */
type FakeResponse = Pick<Response, 'ok' | 'status' | 'json'>;

/** Builds a fake fetch Response with a JSON body and a status (ok derived from status). */
function jsonResponse(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

/** Queues the three parallel fetches (me, project, members) in call order. */
function queueResponses(me: FakeResponse, project: FakeResponse, members: FakeResponse): void {
  fetchMock
    .mockResolvedValueOnce(me)
    .mockResolvedValueOnce(project)
    .mockResolvedValueOnce(members);
}

const ME = { userId: 'user-1', displayName: 'Alice', email: 'a@e.com', isAdmin: false };
const PROJECT = { id: PROJECT_ID, name: 'Docs' };

/** Builds a members-list response body with a single member at the given role. */
function membersBody(userId: string, role: string): unknown {
  return { data: { members: [{ userId, role, displayName: 'Alice' }] } };
}

let fetchMock: jest.Mock;

describe('getProjectAccess', () => {
  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    mockGetAll.mockReturnValue([{ name: 'sessionId', value: 'abc' }]);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns access context when the caller is a member meeting the default minRole', async () => {
    queueResponses(
      jsonResponse(ME),
      jsonResponse({ data: PROJECT }),
      jsonResponse(membersBody('user-1', 'viewer')),
    );

    const access = await getProjectAccess(PROJECT_ID);

    expect(access.project).toEqual(PROJECT);
    expect(access.currentUserId).toBe('user-1');
    expect(access.currentUserRole).toBe('viewer');
    expect(access.isAdmin).toBe(false);
    expect(access.members).toHaveLength(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  test('forwards the session cookies to all three API calls', async () => {
    mockGetAll.mockReturnValue([
      { name: 'sessionId', value: 'abc' },
      { name: '_csrf', value: 'xyz' },
    ]);
    queueResponses(
      jsonResponse(ME),
      jsonResponse({ data: PROJECT }),
      jsonResponse(membersBody('user-1', 'viewer')),
    );

    await getProjectAccess(PROJECT_ID);

    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({ Cookie: 'sessionId=abc; _csrf=xyz' }),
          cache: 'no-store',
        }),
      );
    }
  });

  test('isAdmin reflects the profile flag', async () => {
    queueResponses(
      jsonResponse({ ...ME, isAdmin: true }),
      jsonResponse({ data: PROJECT }),
      jsonResponse(membersBody('user-1', 'owner')),
    );

    const access = await getProjectAccess(PROJECT_ID);

    expect(access.isAdmin).toBe(true);
    expect(access.currentUserRole).toBe('owner');
  });

  test('defaults isAdmin to false when the profile omits the flag', async () => {
    const meWithoutFlag = { userId: 'user-1', displayName: 'Alice', email: 'a@e.com' };
    queueResponses(
      jsonResponse(meWithoutFlag),
      jsonResponse({ data: PROJECT }),
      jsonResponse(membersBody('user-1', 'editor')),
    );

    const access = await getProjectAccess(PROJECT_ID);

    expect(access.isAdmin).toBe(false);
  });

  test('grants access when an editor meets a viewer minRole', async () => {
    queueResponses(
      jsonResponse(ME),
      jsonResponse({ data: PROJECT }),
      jsonResponse(membersBody('user-1', 'editor')),
    );

    const access = await getProjectAccess(PROJECT_ID, 'viewer');

    expect(access.currentUserRole).toBe('editor');
  });

  test('redirects to /login?reason=expired when /auth/me returns 401', async () => {
    queueResponses(
      jsonResponse(null, 401),
      jsonResponse({ data: PROJECT }),
      jsonResponse(membersBody('user-1', 'viewer')),
    );

    await expect(getProjectAccess(PROJECT_ID)).rejects.toThrow('REDIRECT:/login?reason=expired');
    expect(mockRedirect).toHaveBeenCalledWith('/login?reason=expired');
  });

  test('redirects to /404 when the project is not found', async () => {
    queueResponses(
      jsonResponse(ME),
      jsonResponse(null, 404),
      jsonResponse(membersBody('user-1', 'viewer')),
    );

    await expect(getProjectAccess(PROJECT_ID)).rejects.toThrow('REDIRECT:/404');
    expect(mockRedirect).toHaveBeenCalledWith('/404');
  });

  test('redirects to /403 when the members request fails', async () => {
    queueResponses(
      jsonResponse(ME),
      jsonResponse({ data: PROJECT }),
      jsonResponse(null, 500),
    );

    await expect(getProjectAccess(PROJECT_ID)).rejects.toThrow('REDIRECT:/403');
    expect(mockRedirect).toHaveBeenCalledWith('/403');
  });

  test('redirects to /403 when the caller is not a member of the project', async () => {
    queueResponses(
      jsonResponse(ME),
      jsonResponse({ data: PROJECT }),
      jsonResponse(membersBody('someone-else', 'owner')),
    );

    await expect(getProjectAccess(PROJECT_ID)).rejects.toThrow('REDIRECT:/403');
    expect(mockRedirect).toHaveBeenCalledWith('/403');
  });

  test('redirects to /403 when the caller role is below the required minRole', async () => {
    queueResponses(
      jsonResponse(ME),
      jsonResponse({ data: PROJECT }),
      jsonResponse(membersBody('user-1', 'viewer')),
    );

    await expect(getProjectAccess(PROJECT_ID, 'owner')).rejects.toThrow('REDIRECT:/403');
    expect(mockRedirect).toHaveBeenCalledWith('/403');
  });
});

describe('getProjectAccess API base URL', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    mockGetAll.mockReturnValue([]);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('uses NEXT_PUBLIC_API_URL when it is set', async () => {
    process.env = { ...ORIGINAL_ENV, NEXT_PUBLIC_API_URL: 'https://api.test' };
    jest.resetModules();
    queueResponses(
      jsonResponse(ME),
      jsonResponse({ data: PROJECT }),
      jsonResponse(membersBody('user-1', 'viewer')),
    );

    const { getProjectAccess: fresh } = require('@/lib/get-project-access');
    await fresh(PROJECT_ID);

    expect(fetchMock).toHaveBeenCalledWith('https://api.test/auth/me', expect.anything());
  });

  test('falls back to the localhost default when NEXT_PUBLIC_API_URL is unset', async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.NEXT_PUBLIC_API_URL;
    jest.resetModules();
    queueResponses(
      jsonResponse(ME),
      jsonResponse({ data: PROJECT }),
      jsonResponse(membersBody('user-1', 'viewer')),
    );

    const { getProjectAccess: fresh } = require('@/lib/get-project-access');
    await fresh(PROJECT_ID);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4000/auth/me', expect.anything());
  });
});
