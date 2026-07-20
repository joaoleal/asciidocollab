import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import {
  RenderConfigProvider,
  RenderConfigSection,
  type RenderConfigSectionId,
} from '@/components/render-config-settings';
import { useProjectRenderConfig } from '@/hooks/use-project-render-config';
import { useProjectFolders, type FolderNode } from '@/hooks/use-project-folders';

jest.mock('@/hooks/use-project-render-config', () => ({ useProjectRenderConfig: jest.fn() }));
jest.mock('@/hooks/use-project-folders', () => ({ useProjectFolders: jest.fn() }));

const mockHook = useProjectRenderConfig as jest.MockedFunction<typeof useProjectRenderConfig>;
const mockFolders = useProjectFolders as jest.MockedFunction<typeof useProjectFolders>;

const TREE: FolderNode[] = [
  { path: 'assets', name: 'assets', children: [{ path: 'assets/fonts', name: 'fonts', children: [] }] },
  { path: 'branding', name: 'branding', children: [] },
  { path: 'images', name: 'images', children: [] },
  { path: 'img', name: 'img', children: [] },
];
const FLAT_FOLDERS = ['assets', 'assets/fonts', 'branding', 'images', 'img'];
const FILES = ['branding/corporate-theme.yml', 'docs/intro.adoc', 'refs.bib'];

function stub(overrides: Partial<ReturnType<typeof useProjectRenderConfig>> = {}) {
  const save = overrides.save ?? jest.fn(async () => true);
  mockHook.mockReturnValue({
    config: overrides.config ?? {},
    loading: overrides.loading ?? false,
    // Defaults to a config that WAS read. A test that wants the failed-load case says so explicitly
    // (see "a configuration that could not be read"); defaulting it false would silently turn every
    // other case in this file into an assertion about the error state instead.
    loaded: overrides.loaded ?? true,
    saving: overrides.saving ?? false,
    error: overrides.error ?? null,
    save,
  });
  return save;
}

/** Render one section inside the shared draft provider, as the options page does. */
function renderSection(section: RenderConfigSectionId, canEdit = true) {
  return render(
    <RenderConfigProvider projectId="p1" canEdit={canEdit}>
      <RenderConfigSection section={section} />
    </RenderConfigProvider>,
  );
}

/** Render Rendering and PDF together — the two sections that share one draft. */
function renderBoth(canEdit = true) {
  return render(
    <RenderConfigProvider projectId="p1" canEdit={canEdit}>
      <RenderConfigSection section="rendering" />
      <RenderConfigSection section="pdf" />
    </RenderConfigProvider>,
  );
}

function imagesTree(): HTMLElement {
  // Single-select tree renders as a radiogroup (multi-select as a plain group).
  return screen.getByRole('radiogroup', { name: 'Images directory' });
}
function fontTree(): HTMLElement {
  return screen.getByRole('group', { name: 'Custom font directories' });
}
function saveButtons(): HTMLElement[] {
  return screen.getAllByRole('button', { name: 'Save render options' });
}
function resolvedTheme(): string {
  return screen.getByTestId('resolved-theme').textContent ?? '';
}

describe('RenderConfigSection', () => {
  beforeEach(() => {
    mockHook.mockReset();
    mockFolders.mockReset();
    mockFolders.mockReturnValue({
      tree: TREE,
      folders: FLAT_FOLDERS,
      files: FILES,
      loading: false,
      error: null,
    });
  });

  it('shows a loading state', () => {
    stub({ loading: true });
    renderSection('rendering');
    expect(screen.getByText('Loading render options…')).toBeInTheDocument();
  });

  it('shows only the selected section’s controls', () => {
    stub({ config: {} });
    renderSection('rendering');
    expect(screen.getByLabelText('Document type')).toBeInTheDocument();
    expect(screen.queryByLabelText('Page size')).not.toBeInTheDocument();

    stub({ config: {} });
    renderSection('pdf');
    expect(screen.getAllByLabelText('Page size').length).toBeGreaterThan(0);
  });

  it('seeds the controls from the stored config', () => {
    stub({ config: { doctype: 'book', toc: true, imagesdir: 'images', extraFontDirs: ['assets/fonts'] } });
    renderBoth();
    expect(screen.getByLabelText('Document type')).toHaveValue('book');
    expect(screen.getByLabelText('Table of contents')).toBeChecked();
    expect(within(imagesTree()).getByLabelText('images')).toBeChecked();
    expect(within(fontTree()).getByLabelText('assets/fonts')).toBeChecked();
  });

  it('saves a payload assembled from every edited control', async () => {
    const save = stub({ config: {} });
    renderBoth();

    fireEvent.change(screen.getByLabelText('Document type'), { target: { value: 'book' } });
    fireEvent.change(screen.getByLabelText('Admonition icons'), { target: { value: 'font' } });
    fireEvent.click(within(imagesTree()).getByLabelText('img'));
    fireEvent.click(screen.getByLabelText('Table of contents'));
    fireEvent.click(screen.getByLabelText('Number sections'));
    fireEvent.click(screen.getByLabelText('Experimental macros'));
    fireEvent.click(screen.getByLabelText('Hard line breaks'));
    fireEvent.change(screen.getByLabelText('PDF theme file'), {
      target: { value: 'branding/corporate-theme.yml' },
    });
    fireEvent.change(screen.getByLabelText('Output target'), { target: { value: 'print' } });
    fireEvent.change(screen.getByLabelText('Page size'), { target: { value: 'A4' } });
    fireEvent.change(screen.getByLabelText('Orientation'), { target: { value: 'landscape' } });
    fireEvent.click(screen.getByLabelText('Hyphenation'));
    fireEvent.click(screen.getByLabelText('Auto-fit wide blocks'));
    fireEvent.click(within(fontTree()).getByRole('button', { name: 'Expand assets' }));
    fireEvent.click(within(fontTree()).getByLabelText('assets/fonts'));
    fireEvent.click(within(fontTree()).getByLabelText('branding'));
    fireEvent.change(screen.getByLabelText('Attribute name 1'), { target: { value: 'company' } });
    fireEvent.change(screen.getByLabelText('Attribute value 1'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add attribute' }));
    fireEvent.change(screen.getByLabelText('Attribute value 2'), { target: { value: 'orphan' } });

    fireEvent.click(saveButtons()[0]);

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({
      doctype: 'book',
      icons: 'font',
      imagesdir: 'img',
      toc: true,
      sectnums: true,
      experimental: true,
      hardbreaks: true,
      pdfTheme: 'branding/corporate-theme.yml',
      media: 'print',
      pdfPageSize: 'A4',
      pdfPageLayout: 'landscape',
      hyphens: true,
      autofit: true,
      extraFontDirs: ['assets/fonts', 'branding'],
      customAttributes: { company: 'Acme' },
    });
    expect(await screen.findAllByText('Render options saved.')).not.toHaveLength(0);
  });

  it('sends the merged whole from either section, so saving one never wipes the other', async () => {
    // `PUT /render-config` is a full replace: a section that sent only its own fields would erase
    // every sibling section's settings. This is the regression that protects against it.
    const save = stub({ config: {} });
    renderBoth();

    fireEvent.change(screen.getByLabelText('Document type'), { target: { value: 'book' } });
    fireEvent.change(screen.getByLabelText('Page size'), { target: { value: 'A4' } });

    // Saving from the PDF Layout & Theme section still carries the AsciiDoc section's edit…
    fireEvent.click(saveButtons()[1]);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ doctype: 'book', pdfPageSize: 'A4' }));

    // …and vice versa.
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ doctype: 'book', pdfPageSize: 'A4' }));
  });

  it('re-seeds every section from the saved response', async () => {
    stub({ config: { doctype: 'book', pdfPageSize: 'A4' } });
    const { rerender } = renderBoth();
    expect(screen.getByLabelText('Document type')).toHaveValue('book');

    // The hook swaps `config` for the server's response after a save; both sections must follow it.
    stub({ config: { doctype: 'article' } });
    rerender(
      <RenderConfigProvider projectId="p1" canEdit>
        <RenderConfigSection section="rendering" />
        <RenderConfigSection section="pdf" />
      </RenderConfigProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText('Document type')).toHaveValue('article'));
    expect(screen.getByLabelText('Page size')).toHaveValue('');
  });

  it('resets the images directory to the project root', async () => {
    const save = stub({ config: { imagesdir: 'images' } });
    renderSection('rendering');
    fireEvent.click(screen.getByLabelText('Project root (no images directory)'));
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(save).toHaveBeenCalledWith({}));
  });

  it('unchecking a font directory in the tree drops it from the payload', async () => {
    const save = stub({ config: { extraFontDirs: ['branding', 'images'] } });
    renderSection('pdf');
    fireEvent.click(within(fontTree()).getByLabelText('branding'));
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ extraFontDirs: ['images'] }));
  });

  it('preserves and can remove a stored font directory whose folder no longer exists', async () => {
    const save = stub({ config: { extraFontDirs: ['legacy/fonts'] } });
    renderSection('pdf');
    expect(screen.getByText('legacy/fonts')).toBeInTheDocument();
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ extraFontDirs: ['legacy/fonts'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove font directory legacy/fonts' }));
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({}));
  });

  it('deletes a custom attribute row so it is dropped from the payload', async () => {
    const save = stub({ config: { customAttributes: { company: 'Acme', region: 'EU' } } });
    renderSection('rendering');
    fireEvent.click(screen.getByRole('button', { name: 'Remove attribute 1' }));
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ customAttributes: { region: 'EU' } }));
  });

  it('does not render its own language control (the project Language setting drives render lang)', () => {
    stub({ config: {} });
    renderBoth();
    expect(screen.queryByLabelText('Language')).not.toBeInTheDocument();
  });

  it('unchecking a box removes the flag from the draft', async () => {
    const save = stub({ config: { toc: true } });
    renderSection('rendering');
    fireEvent.click(screen.getByLabelText('Table of contents'));
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(save).toHaveBeenCalledWith({}));
  });

  it('omits empty font dirs and custom attributes from the payload', async () => {
    const save = stub({ config: { doctype: 'article' } });
    renderBoth();
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ doctype: 'article' }));
  });

  it('clearing a select removes the option from the draft', async () => {
    const save = stub({ config: { doctype: 'book' } });
    renderSection('rendering');
    fireEvent.change(screen.getByLabelText('Document type'), { target: { value: '' } });
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(save).toHaveBeenCalledWith({}));
  });

  it('hides the save button and disables inputs when canEdit is false', () => {
    stub({ config: {} });
    renderSection('rendering', false);
    expect(screen.queryByRole('button', { name: 'Save render options' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Document type')).toBeDisabled();
  });

  it('shows a loading state for the folder pickers while folders load', () => {
    stub({ config: {} });
    mockFolders.mockReturnValue({ tree: [], folders: [], files: [], loading: true, error: null });
    renderBoth();
    expect(screen.getAllByText('Loading folders…').length).toBeGreaterThanOrEqual(1);
  });

  it('notes a stored images directory whose folder no longer exists', () => {
    stub({ config: { imagesdir: 'gone' } });
    renderSection('rendering');
    expect(screen.getByText(/folder not found/i)).toBeInTheDocument();
  });

  it('surfaces a hook error', () => {
    stub({ config: {}, error: 'boom' });
    renderSection('rendering');
    expect(screen.getByText('boom')).toBeInTheDocument();
  });
});

describe('RenderConfigSection — bibliography controls', () => {
  beforeEach(() => {
    mockHook.mockReset();
    mockFolders.mockReset();
    mockFolders.mockReturnValue({
      tree: TREE,
      folders: FLAT_FOLDERS,
      files: FILES,
      loading: false,
      error: null,
    });
  });

  it('seeds and saves the bibliography settings the schema has always accepted', async () => {
    // These three existed in the schema and the resolver but had no UI at all before this feature.
    const save = stub({ config: { bibtexFile: 'refs.bib' } });
    renderSection('rendering');
    expect(screen.getByLabelText('Bibliography file')).toHaveValue('refs.bib');

    fireEvent.change(screen.getByLabelText('Citation style'), { target: { value: 'ieee' } });
    fireEvent.change(screen.getByLabelText('Reference order'), { target: { value: 'alphabetical' } });
    fireEvent.click(saveButtons()[0]);

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        bibtexFile: 'refs.bib',
        bibtexStyle: 'ieee',
        bibtexOrder: 'alphabetical',
      }),
    );
  });
});

describe('RenderConfigSection — resolved theme', () => {
  beforeEach(() => {
    mockHook.mockReset();
    mockFolders.mockReset();
    mockFolders.mockReturnValue({
      tree: TREE,
      folders: FLAT_FOLDERS,
      files: FILES,
      loading: false,
      error: null,
    });
  });

  it('offers the project’s theme files as the selection', () => {
    stub({ config: {} });
    renderSection('pdf');
    const select = screen.getByLabelText('PDF theme file');
    expect(within(select).getByRole('option', { name: 'branding/corporate-theme.yml' })).toBeInTheDocument();
    // Non-theme files are not offered — the renderer would not accept them.
    expect(within(select).queryByRole('option', { name: 'docs/intro.adoc' })).not.toBeInTheDocument();
  });

  it('names the theme the project falls back to when nothing is selected', () => {
    stub({ config: {} });
    renderSection('pdf');
    expect(resolvedTheme()).toContain('branding/corporate-theme.yml');
  });

  it('names the explicitly selected theme', () => {
    mockFolders.mockReturnValue({
      tree: TREE,
      folders: FLAT_FOLDERS,
      files: ['a-theme.yml', 'z-theme.yml'],
      loading: false,
      error: null,
    });
    stub({ config: { pdfTheme: 'z-theme.yml' } });
    renderSection('pdf');
    expect(resolvedTheme()).toContain('z-theme.yml');
  });

  it('reports that the project has no theme file at all', () => {
    mockFolders.mockReturnValue({
      tree: TREE,
      folders: FLAT_FOLDERS,
      files: ['docs/intro.adoc'],
      loading: false,
      error: null,
    });
    stub({ config: {} });
    renderSection('pdf');
    expect(screen.getByText(/no theme file/i)).toBeInTheDocument();
    expect(resolvedTheme()).toMatch(/built-in default theme/i);
  });

  it('keeps a stored selection whose file is gone, and says the export will not use it', async () => {
    const save = stub({ config: { pdfTheme: 'deleted-theme.yml' } });
    renderSection('pdf');
    expect(screen.getByLabelText('PDF theme file')).toHaveValue('deleted-theme.yml');
    expect(resolvedTheme()).toMatch(/not in this project/i);
    // Preserved, not silently reset — the owner decides what to do about it.
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ pdfTheme: 'deleted-theme.yml' }));
  });
});

describe('a configuration that could not be read', () => {
  beforeEach(() => {
    mockHook.mockReset();
    mockFolders.mockReset();
    mockFolders.mockReturnValue({
      tree: TREE,
      folders: FLAT_FOLDERS,
      files: FILES,
      loading: false,
      error: null,
    });
  });

  // Saving is a whole-document replace. A failed GET leaves the draft empty but indistinguishable
  // from a project that stores nothing, so an editable form over it turns one failed request plus
  // one edit into permanent loss of the doctype, theme, font directories and attributes.
  it('offers no form and no save button', () => {
    stub({ loaded: false, error: 'Failed to load render configuration.' });
    renderSection('pdf');
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load render configuration.');
    // `queryAllBy`, not the `saveButtons()` helper: that one uses `getAllBy`, which throws rather
    // than returning an empty list, so it cannot express "there is no save button".
    expect(screen.queryAllByRole('button', { name: 'Save render options' })).toHaveLength(0);
    expect(screen.queryByLabelText('PDF theme file')).not.toBeInTheDocument();
  });

  it('says why the settings are withheld, not merely that something failed', () => {
    // The reader can see their stored options are missing from the page; without this they would
    // reasonably conclude the project has none, and re-enter them — which is the destructive path.
    stub({ loaded: false, error: 'Network error.' });
    renderSection('rendering');
    expect(screen.getByRole('alert')).toHaveTextContent(/overwrite the settings already stored/i);
  });

  it('still allows editing when it was the SAVE that failed', () => {
    // `error` is set by a failed save too, and that draft is real: the viewer must be able to fix
    // and retry. Gating on `error` rather than on `loaded` would strand them.
    stub({ loaded: true, error: 'Failed to save render configuration.' });
    renderSection('pdf');
    expect(saveButtons().length).toBeGreaterThan(0);
    expect(screen.getByLabelText('PDF theme file')).toBeInTheDocument();
  });
});

describe('a project whose files could not be listed', () => {
  beforeEach(() => {
    mockHook.mockReset();
    mockFolders.mockReset();
    // The tree fetch failed: no folders, no files, and an error saying so.
    mockFolders.mockReturnValue({
      tree: [],
      folders: [],
      files: [],
      loading: false,
      error: 'Failed to load project files.',
    });
  });

  it('does not claim the stored theme is missing', () => {
    // An unreadable tree looks exactly like an empty project. Reported as "missing", the page told
    // the owner in red that their theme is not in the project and the default is used instead —
    // while the export applies that theme correctly. Not knowing is not the same as knowing it is
    // gone, and only one of those should ever be stated.
    stub({ config: { pdfTheme: 'branding/corporate-theme.yml' } });
    renderSection('pdf');
    expect(resolvedTheme()).not.toMatch(/not in this project/i);
    expect(screen.getByText(/could not be listed/i)).toBeInTheDocument();
  });

  it('does not offer to remove font directories it cannot see', () => {
    // Each came with a Remove button, so acting on the false report deleted real settings.
    stub({ config: { extraFontDirs: ['assets/fonts'] } });
    renderSection('pdf');
    expect(screen.queryByText(/folder not found/i)).not.toBeInTheDocument();
  });

  it('still reports a genuinely missing theme when the files ARE known', () => {
    // The warning must survive for the case it was written for.
    mockFolders.mockReturnValue({
      tree: TREE,
      folders: FLAT_FOLDERS,
      files: FILES,
      loading: false,
      error: null,
    });
    stub({ config: { pdfTheme: 'deleted-theme.yml' } });
    renderSection('pdf');
    expect(resolvedTheme()).toMatch(/not in this project/i);
  });
});
