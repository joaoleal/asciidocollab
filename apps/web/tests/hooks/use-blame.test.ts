/* @jest-environment jsdom */
import { renderHook, waitFor } from '@testing-library/react';
import { useBlame, describeBlameFailure } from '@/hooks/use-blame';
import { getBlame } from '@/lib/api/git';
import { membersApi, type ProjectMember } from '@/lib/api/members';
import { ApiError } from '@/lib/api/transport';
import type { BlameDto } from '@asciidocollab/shared';

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  getBlame: jest.fn(),
}));
jest.mock('@/lib/api/members', () => ({ membersApi: { list: jest.fn() } }));

const mockGetBlame = getBlame as jest.MockedFunction<typeof getBlame>;
const mockMembersList = membersApi.list as jest.MockedFunction<typeof membersApi.list>;

function member(overrides: Partial<ProjectMember> = {}): ProjectMember {
  return {
    userId: 'user-1',
    email: 'a@example.com',
    displayName: 'Ada Lovelace',
    role: 'editor',
    joinedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const BLAME: BlameDto = {
  lines: [
    {
      lineNumber: 1,
      hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      message: 'Add the intro',
      authorUserId: 'user-1',
      authoredAt: '2026-08-24T10:00:00.000Z',
      content: 'first line',
    },
    {
      lineNumber: 2,
      hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      message: 'Blank line',
      authoredAt: '2026-01-02T00:00:00.000Z',
      content: 'second line',
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockMembersList.mockResolvedValue({ data: { members: [member()] } });
});

describe('useBlame', () => {
  test('does not fetch while disabled and yields a null map', () => {
    const { result } = renderHook(() => useBlame({ projectId: 'proj1', path: 'doc.adoc', enabled: false }));
    expect(mockGetBlame).not.toHaveBeenCalled();
    expect(result.current.blameLines).toBeNull();
  });

  test('does not fetch when no path is open', () => {
    renderHook(() => useBlame({ projectId: 'proj1', path: null, enabled: true }));
    expect(mockGetBlame).not.toHaveBeenCalled();
  });

  test('resolves each line to author label, date, and a tooltip carrying the commit message', async () => {
    mockGetBlame.mockResolvedValue(BLAME);
    const { result } = renderHook(() => useBlame({ projectId: 'proj1', path: 'doc.adoc', enabled: true }));

    await waitFor(() => expect(result.current.blameLines).not.toBeNull());
    expect(mockGetBlame).toHaveBeenCalledWith('proj1', 'doc.adoc');

    const map = result.current.blameLines!;
    expect(map.get(1)).toMatchObject({
      authorLabel: 'Ada Lovelace',
      hasAuthor: true,
      dateLabel: '2026-08-24',
      message: 'Add the intro',
      tooltip: 'Ada Lovelace · 2026-08-24 · aaaaaaa · Add the intro',
    });
    // Line 2 maps to no member → the neutral fallback label, not a member name.
    expect(map.get(2)).toMatchObject({ authorLabel: 'Unknown author', hasAuthor: false, message: 'Blank line' });
  });

  test('falls back to the placeholder author for every line when the member lookup fails', async () => {
    mockGetBlame.mockResolvedValue(BLAME);
    mockMembersList.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useBlame({ projectId: 'proj1', path: 'doc.adoc', enabled: true }));

    await waitFor(() => expect(result.current.blameLines).not.toBeNull());
    const map = result.current.blameLines!;
    expect([...map.values()].every((info) => info.authorLabel === 'Unknown author')).toBe(true);
    expect(result.current.error).toBeNull();
  });

  test('refetches when the open file path changes', async () => {
    mockGetBlame.mockResolvedValue(BLAME);
    const { rerender } = renderHook((properties: { path: string }) => useBlame({ projectId: 'proj1', path: properties.path, enabled: true }), {
      initialProps: { path: 'a.adoc' },
    });
    await waitFor(() => expect(mockGetBlame).toHaveBeenCalledWith('proj1', 'a.adoc'));

    rerender({ path: 'b.adoc' });
    await waitFor(() => expect(mockGetBlame).toHaveBeenCalledWith('proj1', 'b.adoc'));
  });

  test('clears the map when blame is toggled off', async () => {
    mockGetBlame.mockResolvedValue(BLAME);
    const { result, rerender } = renderHook((properties: { enabled: boolean }) => useBlame({ projectId: 'proj1', path: 'doc.adoc', enabled: properties.enabled }), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.blameLines).not.toBeNull());

    rerender({ enabled: false });
    await waitFor(() => expect(result.current.blameLines).toBeNull());
  });

  test('surfaces a typed message and clears the map on a refused blame read', async () => {
    mockGetBlame.mockRejectedValue(new ApiError(404, 'repository_not_connected', 'nope'));
    const { result } = renderHook(() => useBlame({ projectId: 'proj1', path: 'doc.adoc', enabled: true }));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toMatch(/no connected git repository/i);
    expect(result.current.blameLines).toBeNull();
  });
});

describe('describeBlameFailure', () => {
  test('maps the not-connected code to a specific sentence', () => {
    expect(describeBlameFailure(new ApiError(404, 'repository_not_connected', 'x'))).toMatch(/no connected git repository/i);
  });

  test('falls back to a generic sentence for an unrecognized code or a non-ApiError', () => {
    expect(describeBlameFailure(new ApiError(400, 'some_new_code', 'x'))).toMatch(/couldn't load blame/i);
    expect(describeBlameFailure(new Error('network'))).toMatch(/couldn't load blame/i);
  });
});
