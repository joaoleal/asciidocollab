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

// The endpoint the main file is stored through. It is separate from the project PATCH above, so what
// this suite watches is WHEN the page calls it — not on change, only on save.
const mockSetMainFile = jest.fn();
jest.mock('@/lib/api/projects', () => ({
  setProjectMainFile: (projectId: string, mainFileNodeId: string | null) =>
    mockSetMainFile(projectId, mainFileNodeId),
}));

// The render-config sections are covered by their own suite; here the shared draft only needs to
// mount, report a dirty state and record what the page asks of it — enough to exercise the page's
// unsaved-edit protection and the General section's flush of the grammar settings.
//
// Deliberately a mutable object rather than React state: the page reads it inside event handlers, so
// mutating it is how a test says "another section edited the draft" without re-rendering.
const renderConfigDraft = {
  dirty: false,
  loading: false,
  loaded: true,
  saving: false,
  canEdit: true,
  error: null as string | null,
  draft: {} as Record<string, unknown>,
  set: jest.fn(() => {
    renderConfigDraft.dirty = true;
  }),
  // Reports whether the write landed, exactly as the real draft does — a mock that resolved to
  // `undefined` would stand in for a state the provider cannot produce, and read as a failed save.
  save: jest.fn(async () => {
    renderConfigDraft.dirty = false;
    return true;
  }),
  discard: jest.fn(() => {
    renderConfigDraft.dirty = false;
  }),
};

jest.mock('@/components/render-config-settings', () => ({
  RenderConfigProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  RenderConfigSection: ({ section }: { section: string }) => (
    <div data-testid="render-config-section" data-section={section} />
  ),
  useRenderConfigDraft: () => renderConfigDraft,
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

interface MainFileFieldProperties {
  value: string | null;
  disabled: boolean;
  onChange: (next: string | null) => void;
}

// Where the field's options come from — the project file tree, fetched asynchronously — is its own
// suite's business. Here it stands in as the same labelled, controlled select, so the page's staging
// and saving are exercised without dragging a network round-trip into every unrelated test.
jest.mock('@/components/settings/main-file-field', () => ({
  MainFileField: ({ value, disabled, onChange }: MainFileFieldProperties) => (
    <label>
      Main file
      <select
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">Not set</option>
        <option value="guide">guide.adoc</option>
        <option value="readme">readme.adoc</option>
      </select>
    </label>
  ),
}));

const PROJECT = {
  id: 'proj-1',
  name: 'My Project',
  description: 'A description',
  owners: [],
  tags: ['docs', 'api'],
  rootFolderId: null,
  mainFileNodeId: null,
  language: 'en',
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

/** Render the General section and choose `nodeId` in the main-file field, without saving. */
function stageMainFile(nodeId: string, overrides: Partial<React.ComponentProps<typeof SettingsClient>> = {}) {
  renderClient(overrides);
  fireEvent.change(screen.getByLabelText('Main file'), { target: { value: nodeId } });
}

beforeEach(() => {
  jest.clearAllMocks();
  renderConfigDraft.dirty = false;
  renderConfigDraft.loading = false;
  renderConfigDraft.loaded = true;
  renderConfigDraft.saving = false;
  renderConfigDraft.canEdit = true;
  renderConfigDraft.error = null;
  renderConfigDraft.draft = {};
  mockUpdate.mockResolvedValue(undefined);
  mockSetMainFile.mockResolvedValue({ id: 'proj-1' });
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

  test('asks before leaving the render-config sections for one that cannot save the draft', () => {
    renderConfigDraft.dirty = true;
    renderClient({}, 'rendering');
    fireEvent.click(screen.getByRole('link', { name: 'Danger Zone' }));
    expect(screen.getByText(/discard unsaved changes/i)).toBeInTheDocument();
  });

  test('actually throws the render-config edits away when discarding', () => {
    // The prompt said the changes would be discarded, and nothing discarded them: the draft lives in
    // a provider ABOVE the section switch, so no unmount clears it. The edits survived and were
    // written by the next save from any section — the opposite of what the viewer was told.
    renderConfigDraft.dirty = true;
    renderClient({}, 'rendering');
    fireEvent.click(screen.getByRole('link', { name: 'Danger Zone' }));
    fireEvent.click(screen.getByRole('button', { name: /discard and leave/i }));
    expect(renderConfigDraft.discard).toHaveBeenCalled();
  });

  test('asks before leaving Extensions with unsaved toggles', () => {
    // Extensions writes to the SAME shared draft, but was left out of the check — so a viewer left
    // it unwarned while the unsaved toggles rode along on the next save from elsewhere.
    renderConfigDraft.dirty = true;
    renderClient({}, 'extensions');
    fireEvent.click(screen.getByRole('link', { name: 'Danger Zone' }));
    expect(screen.getByText(/discard unsaved changes/i)).toBeInTheDocument();
  });

  test('does not ask when moving between Extensions and the other render-config sections', () => {
    renderConfigDraft.dirty = true;
    renderClient({}, 'extensions');
    fireEvent.click(screen.getByRole('link', { name: 'PDF Layout & Theme' }));
    expect(screen.queryByText(/discard unsaved changes/i)).not.toBeInTheDocument();
  });

  test('does not ask when moving between Rendering and PDF, which share one draft', () => {
    // The draft outlives the section change, so nothing is discarded and a prompt would be a lie.
    renderConfigDraft.dirty = true;
    renderClient({}, 'rendering');
    fireEvent.click(screen.getByRole('link', { name: 'PDF Layout & Theme' }));
    expect(screen.queryByText(/discard unsaved changes/i)).not.toBeInTheDocument();
    expect(mockRouter.replace).toHaveBeenCalledWith(
      '/dashboard/projects/proj-1/settings?section=pdf',
      { scroll: false },
    );
  });

  test('asks before leaving General with unsaved grammar edits for a section that cannot save them', () => {
    // The grammar controls write the shared draft, so General now holds render-config edits too;
    // leaving for the one section without a save control loses them.
    renderClient();
    fireEvent.click(screen.getByRole('checkbox', { name: /enable grammar checking/i }));
    fireEvent.click(screen.getByRole('link', { name: 'Danger Zone' }));
    expect(screen.getByText(/discard unsaved changes/i)).toBeInTheDocument();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('does not ask when unsaved grammar edits move to a section that can still save them', () => {
    // General is part of the shared-draft group: the edit survives the move and the AsciiDoc
    // section's save sends the merged whole, so a prompt — which discards — would destroy an edit
    // that was never at risk.
    renderClient();
    fireEvent.click(screen.getByRole('checkbox', { name: /enable grammar checking/i }));
    fireEvent.click(screen.getByRole('link', { name: 'AsciiDoc' }));
    expect(screen.queryByText(/discard unsaved changes/i)).not.toBeInTheDocument();
    expect(renderConfigDraft.discard).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith(
      '/dashboard/projects/proj-1/settings?section=rendering',
      { scroll: false },
    );
  });

  test('discarding General form edits keeps the shared draft when the destination can save it', () => {
    // The prompt was raised by the name field. Throwing the render-config draft away as well would
    // silently delete sibling sections' edits the viewer never chose to discard.
    renderClient();
    renderConfigDraft.dirty = true;
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('link', { name: 'PDF Layout & Theme' }));
    fireEvent.click(screen.getByRole('button', { name: /discard and leave/i }));
    expect(renderConfigDraft.discard).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalled();
  });

  test('discarding General form edits does throw the draft away when leaving the group', () => {
    renderClient();
    renderConfigDraft.dirty = true;
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('link', { name: 'Danger Zone' }));
    fireEvent.click(screen.getByRole('button', { name: /discard and leave/i }));
    expect(renderConfigDraft.discard).toHaveBeenCalled();
  });
});

describe('SettingsClient — grammar checking sits with Language', () => {
  test('renders the grammar controls in the General section, beside the language select', () => {
    renderClient();
    const languageForm = screen.getByLabelText('Language').closest('form');
    expect(languageForm).not.toBeNull();
    // Same form as Language, so the two are read and changed together — the point of the placement.
    expect(languageForm).toContainElement(
      screen.getByRole('checkbox', { name: /enable grammar checking/i }),
    );
    expect(languageForm).toContainElement(screen.getByLabelText('English dialect'));
  });

  test('no longer renders them in the AsciiDoc section', () => {
    renderClient({}, 'rendering');
    expect(screen.queryByText(/grammar & spelling checking/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('English dialect')).not.toBeInTheDocument();
  });

  test('follows the language selected in the form, not only the stored one', () => {
    // The coupling is the reason for the move: switching away from English has to show, there and
    // then, that grammar checking no longer applies.
    renderClient();
    expect(screen.getByRole('checkbox', { name: /enable grammar checking/i })).not.toBeDisabled();

    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'fr' } });
    expect(screen.getByRole('checkbox', { name: /enable grammar checking/i })).toBeDisabled();
    // The whole group goes inert, not only the inputs, so it does not read as an active setting.
    expect(screen.getByRole('group', { name: 'Grammar checking' })).toBeDisabled();
    expect(screen.getByText(/set the project language to english/i)).toBeInTheDocument();
  });

  test('seeds the controls from the shared draft', () => {
    renderConfigDraft.draft = { grammarCheckEnabled: false, grammarDialect: 'en-US' };
    renderClient();
    expect(screen.getByRole('checkbox', { name: /enable grammar checking/i })).not.toBeChecked();
    expect(screen.getByLabelText('English dialect')).toHaveValue('en-US');
  });

  test('writes changes to the shared draft rather than the project form', () => {
    renderClient();
    fireEvent.click(screen.getByRole('checkbox', { name: /enable grammar checking/i }));
    expect(renderConfigDraft.set).toHaveBeenCalledWith('grammarCheckEnabled', false);

    fireEvent.change(screen.getByLabelText('English dialect'), { target: { value: 'en-US' } });
    expect(renderConfigDraft.set).toHaveBeenCalledWith('grammarDialect', 'en-US');
  });

  test('withholds the controls when the stored render options could not be read', () => {
    // Saving is a whole-document replace, so a toggle made against the empty default would erase
    // every other option the project has.
    renderConfigDraft.loaded = false;
    renderConfigDraft.error = 'Failed to load render configuration.';
    renderClient();
    expect(screen.queryByRole('checkbox', { name: /enable grammar checking/i })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/failed to load render configuration/i);
  });

  test('says so while the stored render options are still loading', () => {
    renderConfigDraft.loading = true;
    renderClient();
    expect(screen.getByText(/loading grammar options/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /enable grammar checking/i })).not.toBeInTheDocument();
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

  test('pre-fills the main file from the project', () => {
    renderClient({ project: { ...PROJECT, mainFileNodeId: 'readme' } });
    expect(screen.getByLabelText('Main file')).toHaveValue('readme');
  });

  test('shows the main file inside the same form as the other project fields', () => {
    renderClient();
    // Being in the form is what makes it a staged field saved by "Save Changes" rather than a
    // control of its own that writes the moment it changes.
    expect(screen.getByLabelText(/project name/i).closest('form')).toContainElement(
      screen.getByLabelText('Main file'),
    );
  });

  test('shows the main file read-only for archived projects, like the rest of the form', () => {
    renderClient({ project: { ...PROJECT, archivedAt: '2024-01-01T00:00:00Z' } });
    expect(screen.getByLabelText('Main file')).toBeDisabled();
  });
});

describe('SettingsClient — the main file is saved with the form', () => {
  test('choosing a file stores nothing until the form is saved', () => {
    // It used to be persisted on change: there was no way to change your mind, and the Cancel button
    // beside it discarded every other field while keeping this one.
    stageMainFile('guide');
    expect(mockSetMainFile).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Main file')).toHaveValue('guide');
  });

  test('saving persists the staged main file', async () => {
    stageMainFile('guide');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mockSetMainFile).toHaveBeenCalledWith('proj-1', 'guide'));
    expect(await screen.findByText(/project settings updated successfully/i)).toBeInTheDocument();
  });

  test('saving a cleared main file sends null', async () => {
    stageMainFile('', { project: { ...PROJECT, mainFileNodeId: 'guide' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mockSetMainFile).toHaveBeenCalledWith('proj-1', null));
  });

  test('leaves the stored main file alone when the field was not touched', async () => {
    // Setting the main file re-scopes every open document and is audited; a save that only renamed
    // the project has no business announcing a main file nobody chose.
    renderClient();
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockSetMainFile).not.toHaveBeenCalled();
  });

  test('discards the staged main file when the viewer leaves the section', () => {
    stageMainFile('guide');
    fireEvent.click(screen.getByRole('link', { name: 'PDF Layout & Theme' }));
    // The change counts as an unsaved edit, so leaving asks first — and discarding writes nothing.
    expect(screen.getByText(/discard unsaved changes/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /discard and leave/i }));
    expect(mockSetMainFile).not.toHaveBeenCalled();
  });

  test('cancel navigates away without storing the staged main file', () => {
    stageMainFile('guide');
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(mockRouter.back).toHaveBeenCalled();
    expect(mockSetMainFile).not.toHaveBeenCalled();
  });

  test('reports a rejected main-file save instead of claiming success', async () => {
    mockSetMainFile.mockRejectedValue(new Error('Permission denied'));
    stageMainFile('guide');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/permission denied/i)).toBeInTheDocument();
    expect(screen.queryByText(/project settings updated successfully/i)).not.toBeInTheDocument();
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

  test('flushes the shared render-config draft so the grammar settings are saved too', async () => {
    // Grammar checking lives on the render config, behind its own endpoint. Without this, toggling
    // it and pressing the section's only Save button looked like a save and stored nothing.
    renderClient();
    fireEvent.click(screen.getByRole('checkbox', { name: /enable grammar checking/i }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(renderConfigDraft.save).toHaveBeenCalled();
  });

  test('leaves the stored render config alone when nothing edited the draft', async () => {
    // `PUT /render-config` is a full replace; a viewer who only renamed the project has no business
    // rewriting the options document.
    renderClient();
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(renderConfigDraft.save).not.toHaveBeenCalled();
  });

  test('does not ask about unsaved changes once the grammar edit has been saved', async () => {
    renderClient();
    fireEvent.click(screen.getByRole('checkbox', { name: /enable grammar checking/i }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(renderConfigDraft.save).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('link', { name: 'Danger Zone' }));
    expect(screen.queryByText(/discard unsaved changes/i)).not.toBeInTheDocument();
  });

  test('shows a failed render-config save beside the grammar controls rather than swallowing it', () => {
    // `renderConfig.save()` reports failure on the draft instead of throwing, so the project form's
    // own success banner cannot speak for it. The message has to appear where the setting is.
    renderConfigDraft.error = 'Render options rejected.';
    renderClient();
    expect(screen.getByRole('checkbox', { name: /enable grammar checking/i })).toBeInTheDocument();
    expect(screen.getByText(/render options rejected/i)).toBeInTheDocument();
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

  test('reports a rejected grammar/render-config save instead of claiming success', async () => {
    // The two halves of this one Save go to different endpoints. The config half does not throw — it
    // reports false — so half a save was being announced as a whole one, with the viewer's grammar
    // toggle silently dropped.
    renderConfigDraft.dirty = true;
    renderConfigDraft.error = 'Failed to save render configuration.';
    renderConfigDraft.save.mockImplementationOnce(async () => false);
    renderClient();
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/failed to save render configuration/i)).toBeInTheDocument();
    expect(screen.queryByText(/project settings updated successfully/i)).not.toBeInTheDocument();
  });

  test('a half-failed save leaves the section dirty so the edits are not lost on navigation', async () => {
    renderConfigDraft.dirty = true;
    renderConfigDraft.save.mockImplementationOnce(async () => false);
    renderClient();
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(renderConfigDraft.save).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('link', { name: 'PDF Layout & Theme' }));
    expect(screen.getByText(/discard unsaved changes/i)).toBeInTheDocument();
  });

});
