import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectSettingsForm } from '@/components/project-settings-form';
import type { Project } from '@/lib/api';

const mockUpdate = jest.fn();
const mockBack = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ back: mockBack }),
}));

jest.mock('@/lib/api', () => ({
  projectsApi: { update: (...arguments_: unknown[]) => mockUpdate(...arguments_) },
}));

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Existing Project',
  description: 'Existing description',
  owners: [{ userId: 'u1', displayName: 'Owner' }],
  tags: ['alpha', 'beta'],
  rootFolderId: null,
  mainFileNodeId: null,
  language: null,
  archivedAt: null,
  role: 'owner',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const noop = () => undefined;

const submit = () => fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdate.mockResolvedValue({ data: makeProject() });
});

describe('ProjectSettingsForm', () => {
  test('pre-fills the form with the existing project values', () => {
    render(<ProjectSettingsForm project={makeProject()} />);
    expect(screen.getByLabelText(/project name/i)).toHaveValue('Existing Project');
    expect(screen.getByLabelText(/description/i)).toHaveValue('Existing description');
    expect(screen.getByLabelText(/tags/i)).toHaveValue('alpha, beta');
  });

  test('handles a null description by defaulting to an empty field', () => {
    render(<ProjectSettingsForm project={makeProject({ description: null })} />);
    expect(screen.getByLabelText(/description/i)).toHaveValue('');
  });

  test('renders empty name and tags fields when the project has none', () => {
    render(<ProjectSettingsForm project={makeProject({ name: '', tags: [] })} />);
    expect(screen.getByLabelText(/project name/i)).toHaveValue('');
    expect(screen.getByLabelText(/tags/i)).toHaveValue('');
  });

  test('submits updated values and shows a success banner', async () => {
    const onSuccess = jest.fn();
    render(<ProjectSettingsForm project={makeProject()} onSuccess={onSuccess} />);

    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Renamed' } });
    submit();

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('p1', {
        name: 'Renamed',
        description: 'Existing description',
        tags: ['alpha', 'beta'],
      });
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/updated successfully/i)).toBeInTheDocument();
  });

  test('sends undefined when the description is cleared', async () => {
    render(<ProjectSettingsForm project={makeProject()} />);

    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: '' } });
    submit();

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('p1', expect.objectContaining({ description: undefined }));
    });
  });

  test('shows a loading label while saving', async () => {
    let resolveUpdate: (value: unknown) => void = noop;
    mockUpdate.mockImplementation(() => new Promise((resolve) => { resolveUpdate = resolve; }));
    render(<ProjectSettingsForm project={makeProject()} />);

    submit();
    const button = await screen.findByRole('button', { name: /saving/i });
    expect(button).toBeDisabled();

    resolveUpdate({ data: makeProject() });
    await waitFor(() => expect(screen.getByText(/updated successfully/i)).toBeInTheDocument());
  });

  test('shows the API error message on failure', async () => {
    mockUpdate.mockRejectedValue(new Error('Update failed'));
    render(<ProjectSettingsForm project={makeProject()} />);

    submit();
    expect(await screen.findByText('Update failed')).toBeInTheDocument();
    expect(screen.queryByText(/updated successfully/i)).not.toBeInTheDocument();
  });

  test('shows a fallback error when the rejection is not an Error', async () => {
    mockUpdate.mockRejectedValue({ unexpected: true });
    render(<ProjectSettingsForm project={makeProject()} />);

    submit();
    expect(await screen.findByText('Failed to update project')).toBeInTheDocument();
  });

  test('updates the tags from the comma-separated input', async () => {
    render(<ProjectSettingsForm project={makeProject()} />);

    fireEvent.change(screen.getByLabelText(/tags/i), { target: { value: 'one, two , three' } });
    submit();

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('p1', expect.objectContaining({ tags: ['one', 'two', 'three'] }));
    });
  });

  test('Cancel navigates back', () => {
    render(<ProjectSettingsForm project={makeProject()} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
