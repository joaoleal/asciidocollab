import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DisplayNameCard } from '@/app/(dashboard)/dashboard/account/display-name-card';

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const mockUpdateProfile = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/api', () => ({
  authApi: {
    updateProfile: (...arguments_: unknown[]) => mockUpdateProfile(...arguments_),
  },
  ApiError: class ApiError extends Error {},
}));

jest.mock('@/components/avatar', () => ({
  Avatar: ({ avatarKey, displayName }: { avatarKey: string | null; displayName: string }) => (
    <span data-testid={`avatar-${avatarKey ?? 'null'}`}>{displayName}</span>
  ),
}));

jest.mock('@/lib/avatars', () => ({
  DICEBEAR_STYLES: {
    'initials': { style: {}, label: 'Initials' },
    'initial-face': {
      style: {}, label: 'Initial Face',
      variants: [
        { id: 'e1', options: { eyesVariant: 'variant01', backgroundColor: ['#111'] } },
        { id: 'e2', options: { eyesVariant: 'variant02', backgroundColor: ['#222'] } },
        { id: 'e3', options: { eyesVariant: 'variant03', backgroundColor: ['#333'] } },
      ],
    },
    'bottts-neutral': {
      style: {}, label: 'Bottts Neutral',
      variants: [
        { id: 'v1', options: { seed: 'v1' } },
        { id: 'v2', options: { seed: 'v2' } },
        { id: 'v3', options: { seed: 'v3' } },
      ],
    },
    'pixel-art': {
      style: {}, label: 'Pixel Art',
      variants: [{ id: 'v1', options: { seed: 'v1' } }],
    },
  },
  DEFAULT_AVATAR_STYLE: 'initials',
}));

describe('DisplayNameCard with avatar picker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders all DiceBear styles as selectable options', () => {
    render(<DisplayNameCard displayName="Alice" avatarKey={null} />);
    for (const label of ['Initials', 'Initial Face', 'Bottts Neutral', 'Pixel Art']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  test('highlights the active style', () => {
    render(<DisplayNameCard displayName="Alice" avatarKey="bottts-neutral" />);
    const activeButton = screen.getByRole('button', { name: /bottts neutral/i });
    expect(activeButton).toHaveAttribute('aria-pressed', 'true');
  });

  test('submit PATCH includes selected avatarKey', async () => {
    render(<DisplayNameCard displayName="Alice" avatarKey={null} />);
    fireEvent.click(screen.getByRole('button', { name: /bottts neutral/i }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Alice Updated' } });
    fireEvent.submit(screen.getByRole('form', { name: /update display name/i }));
    await waitFor(() => {
      expect(mockUpdateProfile).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Alice Updated', avatarKey: 'bottts-neutral' }),
      );
    });
  });

  test('refreshes the route after saving so the top-right menu updates immediately', async () => {
    render(<DisplayNameCard displayName="Alice" avatarKey={null} />);
    fireEvent.click(screen.getByRole('button', { name: /bottts neutral/i }));
    fireEvent.submit(screen.getByRole('form', { name: /update display name/i }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  test('does not refresh when the save fails', async () => {
    mockUpdateProfile.mockRejectedValueOnce(new Error('nope'));
    render(<DisplayNameCard displayName="Alice" avatarKey={null} />);
    fireEvent.click(screen.getByRole('button', { name: /bottts neutral/i }));
    fireEvent.submit(screen.getByRole('form', { name: /update display name/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  test('variant picker appears for styles with variants, including Initial Face eyes', () => {
    render(<DisplayNameCard displayName="Alice" avatarKey={null} />);
    // Plain Initials has no variants.
    expect(screen.queryByText('Variant')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /bottts neutral/i }));
    expect(screen.getByText('Variant')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Variant 1' })).toBeInTheDocument();
    // Initial Face exposes its eyes as variants while keeping the name's initials.
    fireEvent.click(screen.getByRole('button', { name: /initial face/i }));
    expect(screen.getByText('Variant')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Variant 3' })).toBeInTheDocument();
    // Back to plain Initials — no variants.
    fireEvent.click(screen.getByRole('button', { name: /initials/i }));
    expect(screen.queryByText('Variant')).not.toBeInTheDocument();
  });

  test('selecting an Initial Face eyes variant saves style:variant', async () => {
    render(<DisplayNameCard displayName="Alice" avatarKey={null} />);
    fireEvent.click(screen.getByRole('button', { name: /initial face/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Variant 2' }));
    fireEvent.submit(screen.getByRole('form', { name: /update display name/i }));
    await waitFor(() => {
      expect(mockUpdateProfile).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Alice', avatarKey: 'initial-face:e2' }),
      );
    });
  });

  test('selecting a variant saves style:seed', async () => {
    render(<DisplayNameCard displayName="Alice" avatarKey={null} />);
    fireEvent.click(screen.getByRole('button', { name: /bottts neutral/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Variant 1' }));
    fireEvent.submit(screen.getByRole('form', { name: /update display name/i }));
    await waitFor(() => {
      expect(mockUpdateProfile).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Alice', avatarKey: 'bottts-neutral:v1' }),
      );
    });
  });

  test('active variant button is aria-pressed', () => {
    render(<DisplayNameCard displayName="Alice" avatarKey="bottts-neutral:v2" />);
    expect(screen.getByRole('button', { name: 'Variant 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Variant 1' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('clicking the already-selected style button clears the variant selection', () => {
    render(<DisplayNameCard displayName="Alice" avatarKey="bottts-neutral" />);
    // Pick a variant
    fireEvent.click(screen.getByRole('button', { name: 'Variant 1' }));
    expect(screen.getByRole('button', { name: 'Variant 1' })).toHaveAttribute('aria-pressed', 'true');
    // Click the style button again — should clear the variant
    fireEvent.click(screen.getByRole('button', { name: /bottts neutral/i }));
    expect(screen.getByRole('button', { name: 'Variant 1' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('shows no error when a touched display-name field is still valid', () => {
    render(<DisplayNameCard displayName="Alice" avatarKey={null} />);
    fireEvent.blur(screen.getByRole('textbox')); // touched, but value is valid
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('defaults the avatar style when avatarKey prop is omitted', () => {
    render(<DisplayNameCard displayName="Alice" />);
    expect(screen.getByRole('button', { name: /initials/i })).toHaveAttribute('aria-pressed', 'true');
  });

  test('shows a validation error and falls back to the initial name when cleared', async () => {
    render(<DisplayNameCard displayName="Alice" avatarKey={null} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/display name cannot be empty/i);
    });
    // displayName is empty, so the avatar preview falls back to the initial name.
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
  });

  test('submitting with no changes does not call the API', async () => {
    render(<DisplayNameCard displayName="Alice" avatarKey={null} />);
    fireEvent.submit(screen.getByRole('form', { name: /update display name/i }));
    await waitFor(() => {
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });
  });

  test('shows the API error message when the update fails with an ApiError', async () => {
    const { ApiError } = require('@/lib/api');
    mockUpdateProfile.mockRejectedValueOnce(new ApiError('Display name already taken'));
    render(<DisplayNameCard displayName="Alice" avatarKey={null} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Alice 2' } });
    fireEvent.submit(screen.getByRole('form', { name: /update display name/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/display name already taken/i);
    });
  });

  test('clears the previous success timer on a second save', async () => {
    render(<DisplayNameCard displayName="Alice" avatarKey={null} />);
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: 'Alice 2' } });
    fireEvent.submit(screen.getByRole('form', { name: /update display name/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/saved/i));

    fireEvent.change(input, { target: { value: 'Alice 3' } });
    fireEvent.submit(screen.getByRole('form', { name: /update display name/i }));
    await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalledTimes(2));
  });
});
