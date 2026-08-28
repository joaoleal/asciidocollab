// LoginForm component tests and LoginPage server component redirect behavior.
// Requires: @testing-library/react, @testing-library/jest-dom, jest-environment-jsdom
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LoginForm } from '@/app/(auth)/login/login-form';

jest.mock('@/lib/api', () => ({
  authApi: {
    login: jest.fn(),
    setupStatus: jest.fn().mockResolvedValue({ configured: true }),
    me: jest.fn().mockRejectedValue(new Error('Unauthorized')),
  },
  adminApi: {
    getOpenRegistrationStatus: jest.fn().mockResolvedValue({ openRegistration: false }),
  },
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string, message: string, public retryAfter?: number) {
      super(message);
    }
  },
}));

jest.mock('@/lib/auth', () => ({
  getSession: jest.fn().mockResolvedValue(null),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  redirect: jest.fn(),
}));

describe('LoginForm', () => {
  const { authApi } = require('@/lib/api');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders email and password fields', () => {
    render(<LoginForm redirectTo="/dashboard" />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  test('shows generic error on 401', async () => {
    const { ApiError } = require('@/lib/api');
    authApi.login.mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials'));

    render(<LoginForm redirectTo="/dashboard" />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password1!' } });
    fireEvent.submit(screen.getByRole('form'));

    await waitFor(() => {
      expect(screen.getByText(/invalid email or password/i)).toBeInTheDocument();
    });
  });

  test('disables submit button during submission', async () => {
    authApi.login.mockImplementation(() => new Promise(() => {}));

    render(<LoginForm redirectTo="/dashboard" />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password1!' } });
    fireEvent.submit(screen.getByRole('form'));

    // Button text changes to "Signing in…" while the transition is pending
    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();
  });

  test('?redirect=https://evil.com resolves to /dashboard after login', async () => {
    const router = { push: jest.fn() };
    jest.spyOn(require('next/navigation'), 'useRouter').mockReturnValue(router);
    authApi.login.mockResolvedValue({ message: 'Authenticated' });

    render(<LoginForm redirectTo="https://evil.com" />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password1!' } });
    fireEvent.submit(screen.getByRole('form'));

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/dashboard');
    });
  });

  test('?redirect=//evil.com resolves to /dashboard', async () => {
    const router = { push: jest.fn() };
    jest.spyOn(require('next/navigation'), 'useRouter').mockReturnValue(router);
    authApi.login.mockResolvedValue({ message: 'Authenticated' });

    render(<LoginForm redirectTo="//evil.com" />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password1!' } });
    fireEvent.submit(screen.getByRole('form'));

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/dashboard');
    });
  });
});

describe('LoginForm rate limiting', () => {
  const { authApi, ApiError } = require('@/lib/api');

  test('shows human-readable lockout message on 429 with retryAfter', async () => {
    const error = new ApiError(429, 'RATE_LIMITED', 'Too many requests', 900);
    authApi.login.mockRejectedValue(error);

    render(<LoginForm redirectTo="/dashboard" />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password1!' } });
    fireEvent.submit(screen.getByRole('form'));

    await waitFor(() => {
      expect(screen.getByText(/too many failed attempts/i)).toBeInTheDocument();
      expect(screen.getByText(/15 minutes/i)).toBeInTheDocument();
    });
  });

  test('computes the lockout window from retryAfter when provided', async () => {
    authApi.login.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many requests', 120));

    render(<LoginForm redirectTo="/dashboard" />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password1!' } });
    fireEvent.submit(screen.getByRole('form'));

    await waitFor(() => {
      expect(screen.getByText(/2 minutes/i)).toBeInTheDocument();
    });
  });
});

describe('LoginForm validation and conditional UI', () => {
  const { authApi, adminApi, ApiError } = require('@/lib/api');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('shows field validation errors and does not call login for an invalid form', async () => {
    render(<LoginForm redirectTo="/dashboard" />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'not-an-email' } });
    // leave password empty
    fireEvent.submit(screen.getByRole('form'));

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      expect(alerts.some((a) => /valid email address/i.test(a.textContent ?? ''))).toBe(true);
      expect(alerts.some((a) => /password is required/i.test(a.textContent ?? ''))).toBe(true);
    });
    expect(authApi.login).not.toHaveBeenCalled();
  });

  test('shows only the password error when the email is valid but password is empty', async () => {
    render(<LoginForm redirectTo="/dashboard" />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'valid@example.com' } });
    fireEvent.submit(screen.getByRole('form'));
    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      expect(alerts.some((a) => /password is required/i.test(a.textContent ?? ''))).toBe(true);
      expect(alerts.some((a) => /valid email address/i.test(a.textContent ?? ''))).toBe(false);
    });
  });

  test('defaults the lockout window to 15 minutes when no retryAfter is given', async () => {
    authApi.login.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many requests'));
    render(<LoginForm redirectTo="/dashboard" />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password1!' } });
    fireEvent.submit(screen.getByRole('form'));
    await waitFor(() => expect(screen.getByText(/15 minutes/i)).toBeInTheDocument());
  });

  test('renders the session-expired notice when showExpiredNotice is set', () => {
    render(<LoginForm redirectTo="/dashboard" showExpiredNotice />);
    expect(screen.getByText(/your session has expired/i)).toBeInTheDocument();
  });

  test('shows the create-account link when open registration is enabled', async () => {
    adminApi.getOpenRegistrationStatus.mockResolvedValue({ openRegistration: true });
    render(<LoginForm redirectTo="/dashboard" />);
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /create an account/i })).toBeInTheDocument();
    });
  });

  test('swallows a failed open-registration lookup without showing the link', async () => {
    adminApi.getOpenRegistrationStatus.mockRejectedValue(new Error('network down'));
    render(<LoginForm redirectTo="/dashboard" />);
    await waitFor(() => expect(adminApi.getOpenRegistrationStatus).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /create an account/i })).not.toBeInTheDocument();
  });

  test('shows only the email error when the password is provided but the email is invalid', async () => {
    render(<LoginForm redirectTo="/dashboard" />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'not-an-email' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password1!' } });
    fireEvent.submit(screen.getByRole('form'));

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      expect(alerts.some((a) => /valid email address/i.test(a.textContent ?? ''))).toBe(true);
      expect(alerts.some((a) => /password is required/i.test(a.textContent ?? ''))).toBe(false);
    });
    expect(authApi.login).not.toHaveBeenCalled();
  });

  test('redirects to a safe internal path after a successful login', async () => {
    const router = { push: jest.fn() };
    jest.spyOn(require('next/navigation'), 'useRouter').mockReturnValue(router);
    authApi.login.mockResolvedValue({ message: 'Authenticated' });

    render(<LoginForm redirectTo="/projects/42" />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password1!' } });
    fireEvent.submit(screen.getByRole('form'));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/projects/42'));
  });
});

describe('LoginPage redirect behavior', () => {
  const { authApi } = require('@/lib/api');
  const { getSession } = require('@/lib/auth');
  const { redirect } = require('next/navigation');
  const { default: LoginPage } = require('@/app/(auth)/login/page');

  beforeEach(() => {
    jest.clearAllMocks();
    getSession.mockResolvedValue(null);
    authApi.setupStatus.mockResolvedValue({ configured: true });
  });

  test('sends a signed-in visitor to the dashboard', async () => {
    getSession.mockResolvedValue({ userId: 'u1' });

    await LoginPage({ searchParams: Promise.resolve({}) });

    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });

  test('sends an anonymous visitor to first-run setup when the install is unconfigured', async () => {
    authApi.setupStatus.mockResolvedValue({ configured: false });

    await LoginPage({ searchParams: Promise.resolve({}) });

    expect(redirect).toHaveBeenCalledWith('/register');
  });

  test('renders the form defaulting to the dashboard when no redirect is requested', async () => {
    const element = await LoginPage({ searchParams: Promise.resolve({}) });

    expect(redirect).not.toHaveBeenCalled();
    expect(element.props.redirectTo).toBe('/dashboard');
    expect(element.props.showExpiredNotice).toBe(false);
  });

  test('passes the requested redirect target through to the form', async () => {
    const element = await LoginPage({ searchParams: Promise.resolve({ redirect: '/projects/42' }) });

    expect(element.props.redirectTo).toBe('/projects/42');
  });

  test('asks the form to explain an expired session when that is the reason given', async () => {
    const element = await LoginPage({ searchParams: Promise.resolve({ reason: 'expired' }) });

    expect(element.props.showExpiredNotice).toBe(true);
  });

  test('does not claim an expired session for any other reason', async () => {
    const element = await LoginPage({ searchParams: Promise.resolve({ reason: 'signed-out' }) });

    expect(element.props.showExpiredNotice).toBe(false);
  });
});
