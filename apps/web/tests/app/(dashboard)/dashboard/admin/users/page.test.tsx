import React from 'react';
import { render, screen } from '@testing-library/react';

const mockRedirect = jest.fn((_path: string) => {
  throw new Error('REDIRECT');
});
jest.mock('next/navigation', () => ({ redirect: (path: string) => mockRedirect(path) }));

const mockGetProfile = jest.fn();
jest.mock('@/lib/auth', () => ({ getProfile: () => mockGetProfile() }));

jest.mock('@/app/(dashboard)/dashboard/admin/users/users-client', () => ({
  UsersClient: () => <div data-testid="users-client" />,
}));

import AdminUsersPage from '@/app/(dashboard)/dashboard/admin/users/page';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AdminUsersPage', () => {
  test('renders the users client for an admin profile', async () => {
    mockGetProfile.mockResolvedValue({ isAdmin: true });
    render(await AdminUsersPage());
    expect(screen.getByTestId('users-client')).toBeInTheDocument();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  test('redirects a non-admin user to the dashboard', async () => {
    mockGetProfile.mockResolvedValue({ isAdmin: false });
    await expect(AdminUsersPage()).rejects.toThrow('REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
  });

  test('redirects when there is no profile at all', async () => {
    mockGetProfile.mockResolvedValue(null);
    await expect(AdminUsersPage()).rejects.toThrow('REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
  });
});
