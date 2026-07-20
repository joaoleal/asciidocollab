import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsClient } from '@/app/(dashboard)/dashboard/projects/[id]/settings/settings-client';

const mockRouter = {
  refresh: jest.fn(),
  back: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
};
let searchParameters = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => searchParameters,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, ...rest }: React.ComponentProps<'a'>) => <a {...rest}>{children}</a>,
}));

const mockUpdate = jest.fn();
jest.mock('@/lib/api', () => ({
  projectsApi: {
    update: (id: string, body: unknown) => mockUpdate(id, body),
  },
}));

// The render-config sections are covered by their own suite; here they only need to mount and to
// report a dirty draft, so the page's unsaved-edit protection can be exercised.
let renderConfigDirty = false;
/** Spy for the shared draft's discard, so a test can assert the edits really are thrown away. */
const renderConfigDiscard = jest.fn();
jest.mock('@/components/render-config-settings', () => ({
  RenderConfigProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  RenderConfigSection: ({ section }: { section: string }) => (
    <div data-testid="render-config-section" data-section={section} />
  ),
  useRenderConfigDraft: () => ({ dirty: renderConfigDirty, discard: renderConfigDiscard }),
}));

jest.mock('@/components/settings/extensions-section', () => ({
  ExtensionsSection: () => <div data-testid="extensions-section" />,
}));

interface ArchiveButtonProperties {
  onArchive?: () => void;
  onRestore?: () => void;
}

interface DeleteButtonProperties {
  onDeleted: () => void;
}

jest.mock('@/components/archive-button', () => ({
  ArchiveButton: ({ onArchive, onRestore }: ArchiveButtonProperties) => (
    <div data-testid="archive-button">
      <button type="button" onClick={onArchive}>fire-archive</button>
      <button type="button" onClick={onRestore}>fire-restore</button>
    </div>
  ),
}));

jest.mock('@/components/delete-project-button', () => ({
  DeleteProjectButton: ({ onDeleted }: DeleteButtonProperties) => (
    <div data-testid="delete-button">
      <button type="button" onClick={onDeleted}>fire-delete</button>
    </div>
  ),
}));

interface MainFilePickerProperties {
  canEdit: boolean;
  currentMainFileNodeId: string | null;
}

jest.mock('@/components/editor/editor-main-file-picker', () => ({
  EditorMainFilePicker: ({ canEdit, currentMainFileNodeId }: MainFilePickerProperties) =>
    canEdit ? (
      <div data-testid="main-file-picker" data-current={currentMainFileNodeId ?? ''} />
    ) : null,
}));

const PROJECT = {
  id: 'proj-1',
  name: 'My Project',
  description: 'A description',
  owners: [],
  tags: ['docs', 'api'],
  rootFolderId: null,
  mainFileNodeId: null,
  archivedAt: null,
  createdAt: '',
  updatedAt: '',
};

function renderClient(
  overrides: Partial<React.ComponentProps<typeof SettingsClient>> = {},
  section?: string,
) {
  searchParameters = new URLSearchParams(section === undefined ? '' : `section=${section}`);
  const properties = {
    project: PROJECT,
    currentUserRole: 'owner',
    ...overrides,
  };
  return render(<SettingsClient {...properties} />);
}

beforeEach(() => {
  jest.clearAllMocks();
  renderConfigDirty = false;
  mockUpdate.mockResolvedValue(undefined);
});

describe('SettingsClient — sections', () => {
  test('shows the General section by default', () => {
    renderClient();
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByLabelText(/project name/i)).toBeInTheDocument();
  });

  test('opens the section named in the URL', () => {
    renderClient({}, 'pdf');
    expect(screen.getByTestId('render-config-section')).toHaveAttribute('data-section', 'pdf');
    // Only the selected section's settings are shown (FR-001).
    expect(screen.queryByLabelText(/project name/i)).not.toBeInTheDocument();
  });

  test('falls back to the default section for an unknown id', () => {
    renderClient({}, 'nonsense');
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
  });

  test('falls back to the default section when a non-owner links to the danger zone', () => {
    renderClient({ currentUserRole: 'editor' }, 'danger');
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
  });

  test('renders the extensions section', () => {
    renderClient({}, 'extensions');
    expect(screen.getByTestId('extensions-section')).toBeInTheDocument();
  });

  test('navigates by rewriting the section query parameter', () => {
    renderClient();
    fireEvent.click(screen.getByRole('link', { name: 'AsciiDoc' }));
    expect(mockRouter.replace).toHaveBeenCalledWith(
      '/dashboard/projects/proj-1/settings?section=rendering',
      { scroll: false },
    );
  });

  test('offers every section to an owner', () => {
    renderClient();
    for (const label of ['General', 'AsciiDoc', 'PDF Layout & Theme', 'PDF Extensions', 'Danger Zone']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  test('hides the danger zone from non-owners', () => {
    renderClient({ currentUserRole: 'editor' });
    expect(screen.queryByRole('link', { name: 'Danger Zone' })).not.toBeInTheDocument();
  });
});

describe('SettingsClient — unsaved edit protection', () => {
  test('asks before leaving a section with unsaved general edits', () => {
    renderClient();
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('link', { name: 'PDF Layout & Theme' }));

    expect(screen.getByText(/discard unsaved changes/i)).toBeInTheDocument();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('staying keeps the section and the edit', () => {
    renderClient();
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('link', { name: 'PDF Layout & Theme' }));
    fireEvent.click(screen.getByRole('button', { name: /stay here/i }));

    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/project name/i)).toHaveValue('Renamed');
  });

  test('discarding proceeds to the requested section', () => {
    renderClient();
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('link', { name: 'PDF Layout & Theme' }));
    fireEvent.click(screen.getByRole('button', { name: /discard and leave/i }));

    expect(mockRouter.replace).toHaveBeenCalledWith(
      '/dashboard/projects/proj-1/settings?section=pdf',
      { scroll: false },
    );
  });

  test('does not ask when the section is unedited', () => {
    renderClient();
    fireEvent.click(screen.getByRole('link', { name: 'PDF Layout & Theme' }));
    expect(screen.queryByText(/discard unsaved changes/i)).not.toBeInTheDocument();
    expect(mockRouter.replace).toHaveBeenCalled();
  });

  test('does not ask when saving cleared the edits', async () => {
    renderClient();
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('link', { name: 'PDF Layout & Theme' }));
    expect(screen.queryByText(/discard unsaved changes/i)).not.toBeInTheDocument();
    expect(mockRouter.replace).toHaveBeenCalled();
  });

  test('asks before leaving the render-config sections for an unrelated one', () => {
    renderConfigDirty = true;
    renderClient({}, 'rendering');
    fireEvent.click(screen.getByRole('link', { name: 'General' }));
    expect(screen.getByText(/discard unsaved changes/i)).toBeInTheDocument();
  });

  test('actually throws the render-config edits away when discarding', () => {
    // The prompt said the changes would be discarded, and nothing discarded them: the draft lives in
    // a provider ABOVE the section switch, so no unmount clears it. The edits survived and were
    // written by the next save from any section — the opposite of what the viewer was told.
    renderConfigDirty = true;
    renderClient({}, 'rendering');
    fireEvent.click(screen.getByRole('link', { name: 'General' }));
    fireEvent.click(screen.getByRole('button', { name: /discard and leave/i }));
    expect(renderConfigDiscard).toHaveBeenCalled();
  });

  test('asks before leaving Extensions with unsaved toggles', () => {
    // Extensions writes to the SAME shared draft, but was left out of the check — so a viewer left
    // it unwarned while the unsaved toggles rode along on the next save from elsewhere.
    renderConfigDirty = true;
    renderClient({}, 'extensions');
    fireEvent.click(screen.getByRole('link', { name: 'General' }));
    expect(screen.getByText(/discard unsaved changes/i)).toBeInTheDocument();
  });

  test('does not ask when moving between Extensions and the other render-config sections', () => {
    renderConfigDirty = true;
    renderClient({}, 'extensions');
    fireEvent.click(screen.getByRole('link', { name: 'PDF Layout & Theme' }));
    expect(screen.queryByText(/discard unsaved changes/i)).not.toBeInTheDocument();
  });

  test('does not ask when moving between Rendering and PDF, which share one draft', () => {
    // The draft outlives the section change, so nothing is discarded and a prompt would be a lie.
    renderConfigDirty = true;
    renderClient({}, 'rendering');
    fireEvent.click(screen.getByRole('link', { name: 'PDF Layout & Theme' }));
    expect(screen.queryByText(/discard unsaved changes/i)).not.toBeInTheDocument();
    expect(mockRouter.replace).toHaveBeenCalledWith(
      '/dashboard/projects/proj-1/settings?section=pdf',
      { scroll: false },
    );
  });
});

describe('SettingsClient — form rendering', () => {
  test('pre-fills the name, description, and tags', () => {
    renderClient();
    expect(screen.getByLabelText(/project name/i)).toHaveValue('My Project');
    expect(screen.getByLabelText(/description/i)).toHaveValue('A description');
    expect(screen.getByLabelText(/tags/i)).toHaveValue('docs, api');
  });

  test('renders empty fields when description and tags are absent', () => {
    renderClient({ project: { ...PROJECT, description: null, tags: [] } });
    expect(screen.getByLabelText(/description/i)).toHaveValue('');
    expect(screen.getByLabelText(/tags/i)).toHaveValue('');
  });

  test('renders the main-file picker seeded with the project main file', () => {
    renderClient({ project: { ...PROJECT, mainFileNodeId: 'node-9' } });
    expect(screen.getByRole('heading', { name: /main file/i })).toBeInTheDocument();
    expect(screen.getByTestId('main-file-picker')).toHaveAttribute('data-current', 'node-9');
  });

  test('hides the main-file picker for archived projects', () => {
    renderClient({ project: { ...PROJECT, archivedAt: '2024-01-01T00:00:00Z' } });
    expect(screen.queryByTestId('main-file-picker')).not.toBeInTheDocument();
  });
});

describe('SettingsClient — saving', () => {
  test('updates the project and shows a success banner', async () => {
    renderClient();
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(screen.getByText(/project settings updated successfully/i)).toBeInTheDocument();
    });
    expect(mockUpdate).toHaveBeenCalledWith('proj-1', expect.objectContaining({ name: 'Renamed' }));
    expect(mockRouter.refresh).toHaveBeenCalled();
  });

  test('clears the description when emptied so it is sent as undefined', async () => {
    renderClient();
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].description).toBeUndefined();
  });

  test('rewrites the tags from the comma-separated input', async () => {
    renderClient();
    fireEvent.change(screen.getByLabelText(/tags/i), { target: { value: 'one, two ,, three' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].tags).toEqual(['one', 'two', 'three']);
  });

  test('shows the API error message when the update fails', async () => {
    mockUpdate.mockRejectedValue(new Error('server exploded'));
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(screen.getByText(/server exploded/i)).toBeInTheDocument());
  });

  test('shows a generic error when the rejection is not an Error', async () => {
    mockUpdate.mockRejectedValue('boom string');
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(screen.getByText(/failed to update project/i)).toBeInTheDocument());
  });

  test('shows a validation error for an empty name without calling the API', async () => {
    renderClient();
    const nameInput = screen.getByLabelText(/project name/i);
    nameInput.removeAttribute('required');
    fireEvent.change(nameInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      const banner = document.querySelector('.text-destructive');
      expect(banner).toBeInTheDocument();
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('cancel navigates back', () => {
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(mockRouter.back).toHaveBeenCalled();
  });
});

describe('SettingsClient — archived state', () => {
  test('shows the read-only banner and hides the save controls', () => {
    renderClient({ project: { ...PROJECT, archivedAt: '2024-01-01T00:00:00Z' } });
    expect(screen.getByText(/settings are read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/project name/i)).toBeDisabled();
  });
});

describe('SettingsClient — danger zone gating', () => {
  test('shows archive and delete controls for owners', () => {
    renderClient({ currentUserRole: 'owner' }, 'danger');
    expect(screen.getByRole('heading', { name: /danger zone/i })).toBeInTheDocument();
    expect(screen.getByTestId('archive-button')).toBeInTheDocument();
    expect(screen.getByTestId('delete-button')).toBeInTheDocument();
  });

  test('hides the danger zone for non-owners', () => {
    renderClient({ currentUserRole: 'editor' }, 'danger');
    expect(screen.queryByTestId('archive-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delete-button')).not.toBeInTheDocument();
  });

  test('archiving navigates to the dashboard', () => {
    renderClient({}, 'danger');
    fireEvent.click(screen.getByRole('button', { name: /fire-archive/i }));
    expect(mockRouter.push).toHaveBeenCalledWith('/dashboard');
  });

  test('restoring refreshes the page', () => {
    renderClient({}, 'danger');
    fireEvent.click(screen.getByRole('button', { name: /fire-restore/i }));
    expect(mockRouter.refresh).toHaveBeenCalled();
  });

  test('deleting navigates to the dashboard with the deleted flag', () => {
    renderClient({}, 'danger');
    fireEvent.click(screen.getByRole('button', { name: /fire-delete/i }));
    expect(mockRouter.push).toHaveBeenCalledWith('/dashboard?deleted=1');
  });
});
