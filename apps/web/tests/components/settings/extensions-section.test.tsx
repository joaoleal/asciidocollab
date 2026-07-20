import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ExtensionsSection } from '@/components/settings/extensions-section';
import { RenderConfigProvider } from '@/components/render-config-settings';
import { useProjectRenderConfig } from '@/hooks/use-project-render-config';
import { useProjectFolders } from '@/hooks/use-project-folders';
import { usePdfExtensions } from '@/hooks/use-pdf-extensions';
import type { PdfExtensionCatalogue } from '@/lib/api/pdf-extensions';
import type { PdfExtensionCatalogueEntry } from '@asciidocollab/shared';

jest.mock('@/hooks/use-project-render-config', () => ({ useProjectRenderConfig: jest.fn() }));
jest.mock('@/hooks/use-project-folders', () => ({ useProjectFolders: jest.fn() }));
jest.mock('@/hooks/use-pdf-extensions', () => ({ usePdfExtensions: jest.fn() }));

const mockConfig = useProjectRenderConfig as jest.MockedFunction<typeof useProjectRenderConfig>;
const mockFolders = useProjectFolders as jest.MockedFunction<typeof useProjectFolders>;
const mockExtensions = usePdfExtensions as jest.MockedFunction<typeof usePdfExtensions>;

/** A catalogue entry for `id`. */
function entry(
  id: string,
  overrides: Partial<PdfExtensionCatalogueEntry['manifest']> = {},
  origin: 'shipped' | 'administrator-provided' = 'shipped',
  available = true,
): PdfExtensionCatalogueEntry {
  return {
    manifest: {
      id,
      displayName: `The ${id} extension`,
      description: `What ${id} changes about the output.`,
      targeting: '',
      themeKeys: [],
      sampleContent: '',
      ...overrides,
    },
    origin,
    available,
  };
}

/** Stub the catalogue the server assembled. */
function catalogue(overrides: Partial<PdfExtensionCatalogue> = {}): void {
  mockExtensions.mockReturnValue({
    catalogue: {
      entries: overrides.entries ?? [entry('paragraph-numbering')],
      staleSelections: overrides.staleSelections ?? [],
      excluded: overrides.excluded ?? [],
      conflicts: overrides.conflicts ?? [],
    },
    loading: false,
    error: null,
  });
}

/** Stub the stored render config, returning the save spy. */
function config(enabled?: string[]) {
  const save = jest.fn(async () => true);
  mockConfig.mockReturnValue({
    config: enabled === undefined ? {} : { extensions: { enabled } },
    loading: false,
    // The config WAS read. Left false, this section withholds the whole form — see the
    // failed-load case below, which is the only place that is the intended state.
    loaded: true,
    saving: false,
    error: null,
    save,
  });
  return save;
}

function renderSection(canEdit = true) {
  return render(
    <RenderConfigProvider projectId="p1" canEdit={canEdit}>
      <ExtensionsSection />
    </RenderConfigProvider>,
  );
}

beforeEach(() => {
  mockConfig.mockReset();
  mockExtensions.mockReset();
  mockFolders.mockReset();
  mockFolders.mockReturnValue({ tree: [], folders: [], files: [], loading: false, error: null });
  config();
  catalogue();
});

describe('ExtensionsSection — showing what is on offer', () => {
  it('lists the catalogue the server assembled', () => {
    // The section previously rendered a hardcoded "none available" placeholder and never called the
    // API, so a deployment that shipped extensions still showed none.
    renderSection();
    expect(screen.getByText('The paragraph-numbering extension')).toBeInTheDocument();
    expect(screen.getByText(/What paragraph-numbering changes/)).toBeInTheDocument();
  });

  it('distinguishes shipped entries from administrator-provided ones', () => {
    catalogue({
      entries: [entry('built-in'), entry('house-style', {}, 'administrator-provided')],
    });
    renderSection();
    expect(screen.getByText('Built in')).toBeInTheDocument();
    expect(screen.getByText('Administrator')).toBeInTheDocument();
  });

  it('shows the markup an author must write to direct an extension', () => {
    // Without it, enabling an extension that only acts on marked content looks like it did nothing.
    catalogue({ entries: [entry('multi-column', { targeting: '[.multi-column]' })] });
    renderSection();
    expect(screen.getByText(/\[\.multi-column]/)).toBeInTheDocument();
  });

  it('says plainly when a deployment offers none', () => {
    catalogue({ entries: [] });
    renderSection();
    expect(screen.getByText(/offers no converter extensions/i)).toBeInTheDocument();
  });

  it('shows a loading state while the catalogue is fetched', () => {
    mockExtensions.mockReturnValue({ catalogue: null, loading: true, error: null });
    renderSection();
    expect(screen.getByText('Loading extensions…')).toBeInTheDocument();
  });

  it('surfaces a catalogue load failure', () => {
    mockExtensions.mockReturnValue({ catalogue: null, loading: false, error: 'boom' });
    renderSection();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });
});

describe('ExtensionsSection — the selection', () => {
  it('reflects what the project has enabled', () => {
    config(['paragraph-numbering']);
    renderSection();
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('saves the merged whole config, so sibling sections are not wiped', () => {
    // `PUT /render-config` is a full replace. The selection lives in the SHARED draft precisely so
    // this section cannot send only its own field.
    const save = jest.fn(async () => true);
    mockConfig.mockReturnValue({
      config: { doctype: 'book', pdfPageSize: 'A4' },
      loading: false,
      loaded: true,
      saving: false,
      error: null,
      save,
    });
    renderSection();

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Save extensions' }));

    return waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        doctype: 'book',
        pdfPageSize: 'A4',
        extensions: { enabled: ['paragraph-numbering'] },
      }),
    );
  });

  it('stores the selection in a deterministic order', async () => {
    // Load order follows the stored selection, so the order it is written in must not depend on the
    // order the author happened to tick the boxes.
    catalogue({ entries: [entry('zebra'), entry('alpha')] });
    const save = config();
    renderSection();

    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Save extensions' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ extensions: { enabled: ['alpha', 'zebra'] } }),
    );
  });

  it('drops the key entirely when nothing is enabled', async () => {
    // A project that never enabled anything should carry nothing in its config.
    config(['paragraph-numbering']);
    const save = jest.fn(async () => true);
    mockConfig.mockReturnValue({
      config: { extensions: { enabled: ['paragraph-numbering'] } },
      loading: false,
      loaded: true,
      saving: false,
      error: null,
      save,
    });
    renderSection();

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Save extensions' }));

    await waitFor(() => expect(save).toHaveBeenCalledWith({}));
  });

  it('is read-only for a viewer who may not edit', () => {
    renderSection(false);
    expect(screen.queryByRole('button', { name: 'Save extensions' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });
});

describe('ExtensionsSection — states an author or administrator must be told about', () => {
  it('warns about an enabled extension the deployment no longer offers (FR-030)', () => {
    // An administrator can remove an extension a project still uses. Silently dropping it would
    // change the project's output with no indication why.
    catalogue({ staleSelections: ['retired'] });
    renderSection();
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(/no longer offers/i);
    expect(notice).toHaveTextContent('retired');
  });

  it('does not offer an unavailable entry as a choice', () => {
    catalogue({
      entries: [entry('paragraph-numbering'), entry('retired', {}, 'administrator-provided', false)],
      staleSelections: ['retired'],
    });
    renderSection();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });

  it('lets the author actually remove a stale selection', async () => {
    // The notice used to say "turn them off below" while the list below filtered unavailable
    // entries out, so there was nothing to turn off — and `{...draft}` re-sent the id on every
    // save, making the warning permanent. The control belongs beside the name it refers to.
    catalogue({ staleSelections: ['retired'] });
    const save = config(['paragraph-numbering', 'retired']);
    renderSection();

    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save extensions' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ extensions: { enabled: ['paragraph-numbering'] } }),
    );
  });

  it('offers no remove control to a viewer who may not edit', () => {
    catalogue({ staleSelections: ['retired'] });
    config(['retired']);
    renderSection(false);
    expect(
      within(screen.getByRole('status')).queryByRole('button', { name: 'Remove' }),
    ).not.toBeInTheDocument();
  });

  it('withholds the whole section when the stored config could not be read', () => {
    // This Save sends the WHOLE config, so offering it over a draft that was never read would
    // erase the project's doctype, theme and font directories along with the selection.
    mockConfig.mockReturnValue({
      config: {},
      loading: false,
      loaded: false,
      saving: false,
      error: 'Failed to load render configuration.',
      save: jest.fn(async () => true),
    });
    renderSection();
    expect(screen.getByRole('alert')).toHaveTextContent(/overwrite the settings already stored/i);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save extensions' })).not.toBeInTheDocument();
  });

  it('reports a manifest the server refused (FR-033d)', () => {
    catalogue({ excluded: [{ source: 'broken', reason: 'manifest.json is not valid JSON.' }] });
    renderSection();
    expect(screen.getByText(/manifest.json is not valid JSON/)).toBeInTheDocument();
  });

  it('reports two sources claiming the same id (FR-033e)', () => {
    catalogue({ conflicts: [{ id: 'paragraph-numbering', reason: 'the shipped extension is used.' }] });
    renderSection();
    expect(screen.getByText(/the shipped extension is used/)).toBeInTheDocument();
  });
});
