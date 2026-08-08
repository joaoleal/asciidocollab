import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { UsersClient } from '@/app/(dashboard)/dashboard/admin/users/users-client';
import { ApiError } from '@/lib/api';

const mockGetAdminUsers = jest.fn();
const mockGetAdminSettings = jest.fn();
const mockInviteUser = jest.fn();
const mockSetAdminStatus = jest.fn();
const mockGetUserRemovalPreview = jest.fn();
const mockRemoveUser = jest.fn();
const mockUpdateAdminSettings = jest.fn();

jest.mock('@/lib/api', () => {
  // Mirrors the real ApiError's constructor (status, code, message, retryAfter) so the fixtures the
  // specs build are the shape production actually throws. A `(code, message)` stand-in type-checks
  // against nothing and silently shifts every argument one slot left.
  class MockApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
      readonly retryAfter?: number,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }
  return {
    ApiError: MockApiError,
    adminApi: {
    getAdminUsers: () => mockGetAdminUsers(),
    getAdminSettings: () => mockGetAdminSettings(),
    inviteUser: (email: string) => mockInviteUser(email),
    setAdminStatus: (id: string, value: boolean) => mockSetAdminStatus(id, value),
    getUserRemovalPreview: (id: string) => mockGetUserRemovalPreview(id),
    removeUser: (id: string) => mockRemoveUser(id),
    updateAdminSettings: (input: unknown) => mockUpdateAdminSettings(input),
    },
  };
});

const USER_ALICE = {
  id: 'uid-alice',
  email: 'alice@example.com',
  displayName: 'Alice',
  isAdmin: false,
  emailVerified: true,
  registrationMethod: 'SELF_REGISTERED',
  createdAt: '',
};

const USER_BOB = {
  id: 'uid-bob',
  email: 'bob@example.com',
  displayName: 'Bob',
  isAdmin: true,
  emailVerified: false,
  registrationMethod: 'INVITED',
  createdAt: '',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAdminUsers.mockResolvedValue({ users: [USER_ALICE, USER_BOB] });
  mockGetAdminSettings.mockResolvedValue({ openRegistration: false });
  mockInviteUser.mockResolvedValue(undefined);
  mockSetAdminStatus.mockResolvedValue(undefined);
  mockGetUserRemovalPreview.mockResolvedValue({ projectsToTransfer: [] });
  mockRemoveUser.mockResolvedValue(undefined);
  mockUpdateAdminSettings.mockResolvedValue({ openRegistration: true });
});

describe('UsersClient — list rendering', () => {
  test('renders a row for each loaded user', async () => {
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  test('shows Admin/Verified/Unverified badges per user', async () => {
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument());
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('Unverified')).toBeInTheDocument();
  });

  test('renders no data rows when there are no users', async () => {
    mockGetAdminUsers.mockResolvedValue({ users: [] });
    render(<UsersClient />);
    await waitFor(() => expect(mockGetAdminUsers).toHaveBeenCalled());
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  test('survives a failed users fetch without crashing', async () => {
    mockGetAdminUsers.mockRejectedValue(new Error('nope'));
    render(<UsersClient />);
    await waitFor(() => expect(mockGetAdminUsers).toHaveBeenCalled());
    expect(screen.getByRole('heading', { name: /user management/i })).toBeInTheDocument();
  });
});

describe('UsersClient — open registration toggle', () => {
  test('reflects the loaded open-registration state as disabled', async () => {
    render(<UsersClient />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /disabled — click to enable/i })).toBeInTheDocument();
    });
  });

  test('enabling open registration updates the label', async () => {
    render(<UsersClient />);
    const toggle = await screen.findByRole('button', { name: /disabled — click to enable/i });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /enabled — click to disable/i })).toBeInTheDocument();
    });
    expect(mockUpdateAdminSettings).toHaveBeenCalledWith({ openRegistration: true });
  });

  test('leaves the label unchanged when the update fails', async () => {
    mockUpdateAdminSettings.mockRejectedValue(new Error('fail'));
    render(<UsersClient />);
    const toggle = await screen.findByRole('button', { name: /disabled — click to enable/i });
    fireEvent.click(toggle);
    await waitFor(() => expect(mockUpdateAdminSettings).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /disabled — click to enable/i })).toBeInTheDocument();
  });
});

describe('UsersClient — invite user', () => {
  test('sends an invitation and shows a success message', async () => {
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send invitation/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/invitation sent to new@example.com/i);
    });
    expect(mockInviteUser).toHaveBeenCalledWith('new@example.com');
  });

  test('maps a DUPLICATE_EMAIL error code to a friendly message', async () => {
    mockInviteUser.mockRejectedValue(new ApiError(409, 'DUPLICATE_EMAIL', 'dup'));
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'dup@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send invitation/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/email already registered/i));
  });

  test('maps an INVITATION_ALREADY_PENDING error code to a friendly message', async () => {
    mockInviteUser.mockRejectedValue(new ApiError(409, 'INVITATION_ALREADY_PENDING', 'pending'));
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'p@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send invitation/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/pending invitation exists/i));
  });

  test('uses the ApiError message for other API error codes', async () => {
    mockInviteUser.mockRejectedValue(new ApiError(400, 'SOME_OTHER', 'specific reason'));
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'x@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send invitation/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/specific reason/i));
  });

  test('falls back to a generic message for non-ApiError failures', async () => {
    mockInviteUser.mockRejectedValue(new Error('plain'));
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'y@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send invitation/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/failed to send invitation/i));
  });
});

describe('UsersClient — admin status toggle', () => {
  test('promotes a non-admin user to admin', async () => {
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    const aliceRow = screen.getByText('Alice').closest('tr');
    fireEvent.click(within(aliceRow!).getByRole('button', { name: /make admin/i }));
    await waitFor(() => expect(mockSetAdminStatus).toHaveBeenCalledWith('uid-alice', true));
    await waitFor(() => expect(within(aliceRow!).getByRole('button', { name: /remove admin/i })).toBeInTheDocument());
  });

  test('alerts when toggling admin status fails', async () => {
    const alertSpy = jest.spyOn(globalThis, 'alert').mockImplementation(() => { /* noop */ });
    mockSetAdminStatus.mockRejectedValue(new ApiError(400, 'BAD', 'cannot change'));
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    const aliceRow = screen.getByText('Alice').closest('tr');
    fireEvent.click(within(aliceRow!).getByRole('button', { name: /make admin/i }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('cannot change'));
    alertSpy.mockRestore();
  });

  test('uses a generic alert for non-ApiError toggle failures', async () => {
    const alertSpy = jest.spyOn(globalThis, 'alert').mockImplementation(() => { /* noop */ });
    mockSetAdminStatus.mockRejectedValue(new Error('plain'));
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    const aliceRow = screen.getByText('Alice').closest('tr');
    fireEvent.click(within(aliceRow!).getByRole('button', { name: /make admin/i }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Failed to update admin status'));
    alertSpy.mockRestore();
  });
});

describe('UsersClient — remove user', () => {
  test('opens the confirmation dialog with the user name', async () => {
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    const aliceRow = screen.getByText('Alice').closest('tr');
    fireEvent.click(within(aliceRow!).getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /remove alice\?/i })).toBeInTheDocument());
  });

  test('lists projects to be transferred in the dialog', async () => {
    mockGetUserRemovalPreview.mockResolvedValue({
      projectsToTransfer: [{ id: 'p1', name: 'Project One' }],
    });
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    const aliceRow = screen.getByText('Alice').closest('tr');
    fireEvent.click(within(aliceRow!).getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(screen.getByText('Project One')).toBeInTheDocument());
  });

  test('cancelling closes the dialog without removing', async () => {
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    const aliceRow = screen.getByText('Alice').closest('tr');
    fireEvent.click(within(aliceRow!).getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /remove alice\?/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /remove alice\?/i })).not.toBeInTheDocument());
    expect(mockRemoveUser).not.toHaveBeenCalled();
  });

  test('confirming removes the user from the list', async () => {
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    const aliceRow = screen.getByText('Alice').closest('tr');
    fireEvent.click(within(aliceRow!).getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /remove alice\?/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(mockRemoveUser).toHaveBeenCalledWith('uid-alice'));
    await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument());
  });

  test('alerts and keeps the user when removal fails', async () => {
    const alertSpy = jest.spyOn(globalThis, 'alert').mockImplementation(() => { /* noop */ });
    mockRemoveUser.mockRejectedValue(new ApiError(409, 'LOCKED', 'still here'));
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    const aliceRow = screen.getByText('Alice').closest('tr');
    fireEvent.click(within(aliceRow!).getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /remove alice\?/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('still here'));
    expect(screen.getByText('Alice')).toBeInTheDocument();
    alertSpy.mockRestore();
  });

  test('uses a generic alert for non-ApiError removal failures', async () => {
    const alertSpy = jest.spyOn(globalThis, 'alert').mockImplementation(() => { /* noop */ });
    mockRemoveUser.mockRejectedValue(new Error('plain'));
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    const aliceRow = screen.getByText('Alice').closest('tr');
    fireEvent.click(within(aliceRow!).getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /remove alice\?/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Failed to remove user'));
    alertSpy.mockRestore();
  });

  test('falls back to an empty preview when the preview lookup fails', async () => {
    mockGetUserRemovalPreview.mockRejectedValue(new Error('no preview'));
    render(<UsersClient />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    const aliceRow = screen.getByText('Alice').closest('tr');
    fireEvent.click(within(aliceRow!).getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /remove alice\?/i })).toBeInTheDocument());
    expect(screen.queryByText(/will be transferred/i)).not.toBeInTheDocument();
  });
});
