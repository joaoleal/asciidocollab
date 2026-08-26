import React from 'react';
import { render, screen } from '@testing-library/react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { COLLAB_YTEXT_KEY } from '@/lib/editor-config';
import { ThemeEditor } from '@/components/theme-editor/theme-editor';
import { useThemePreview } from '@/components/theme-editor/use-theme-preview';

// Mocked outright rather than partially: the real module reaches `usePdfPreview` → the PDF worker,
// which uses `import.meta` and cannot be loaded under Jest. Its own behaviour is covered by
// `use-theme-preview.test.tsx`.
jest.mock('@/components/theme-editor/use-theme-preview', () => ({ useThemePreview: jest.fn() }));

// Autosave is mocked so the persistence WIRING can be asserted without a network: what matters is
// that every edit reaches a save, and that it is disabled wherever the collaboration server owns
// persistence instead.
const mockSave = jest.fn();
const mockAutoSave = jest.fn((_options: unknown) => ({ saveState: 'saved' as const, save: mockSave }));
jest.mock('@/hooks/use-auto-save', () => ({ useAutoSave: (options: unknown) => mockAutoSave(options) }));

// Editor preferences sync to the account over `fetch`, which jsdom does not provide. The behaviour
// under test is that this editor READS the shared preferences rather than inventing its own, so a
// stub with recorded setters is the right level of fidelity.
const preferenceSetters = {
  setFontSize: jest.fn(),
  setTheme: jest.fn(),
  setSoftWrap: jest.fn(),
  setMinimapEnabled: jest.fn(),
};
jest.mock('@/hooks/use-editor-preferences', () => ({
  useEditorPreferences: () => ({
    fontSize: 15,
    theme: 'high-contrast',
    softWrap: true,
    minimapEnabled: false,
    spellIgnore: [],
    spellcheckEnabled: true,
    ...preferenceSetters,
  }),
}));

interface PanelProperties {
  pdf: Blob | null;
  isRendering: boolean;
  className?: string;
}

jest.mock('@/components/pdf-preview-panel', () => ({
  PdfPreviewPanel: ({ pdf, isRendering, className }: PanelProperties) => (
    <div
      data-testid="pdf-preview"
      data-has-pdf={pdf !== null}
      data-rendering={isRendering}
      data-classname={className ?? ''}
    />
  ),
}));

const mockPreview = useThemePreview as jest.MockedFunction<typeof useThemePreview>;

beforeEach(() => {
  mockSave.mockReset();
  mockAutoSave.mockClear();
  mockPreview.mockReset();
  mockPreview.mockReturnValue({ isRendering: false, diagnostics: [] });
});

function renderEditor(overrides: Partial<React.ComponentProps<typeof ThemeEditor>> = {}) {
  return render(
    <ThemeEditor
      content={overrides.content ?? 'page:\n  layout: landscape'}
      canEdit={overrides.canEdit ?? true}
      path={overrides.path ?? 'branding/corporate-theme.yml'}
      projectId={overrides.projectId ?? 'p1'}
      fileNodeId={overrides.fileNodeId ?? 'f1'}
      collab={overrides.collab}
      connectionState={overrides.connectionState}
      collabUnavailable={overrides.collabUnavailable}
      onChange={overrides.onChange}
    />,
  );
}

/** The options the editor handed to `useAutoSave` on its most recent render. */
function autoSaveOptions(): { enabled: boolean; projectId: string; fileNodeId: string } {
  return mockAutoSave.mock.calls.at(-1)?.[0] as never;
}

describe('ThemeEditor', () => {
  it('shows the editor and the sample preview together', () => {
    // The pairing is the point: a theme value is not legible without the page it produces.
    renderEditor();
    expect(screen.getByTestId('theme-editor-source')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-preview')).toBeInTheDocument();
  });

  it('names the file being edited', () => {
    renderEditor({ path: 'branding/corporate-theme.yml' });
    expect(screen.getByText('branding/corporate-theme.yml')).toBeInTheDocument();
  });

  it('mounts a CodeMirror view over the theme content', () => {
    const { container } = renderEditor({ content: 'base:\n  font-color: 333333' });
    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(container.textContent).toContain('font-color');
  });

  it('feeds the preview the theme text', () => {
    renderEditor({ content: 'page:\n  layout: landscape' });
    // The trailing arguments are the extension selection, the code backing it, the theme's own path
    // (which its font references resolve against), the project's asset cache and the project's render
    // attributes (so the sample previews on the page the export produces). With no project extensions
    // enabled the first two are empty, and `renderEditor` supplies neither a cache nor attributes.
    expect(mockPreview).toHaveBeenCalledWith(
      'page:\n  layout: landscape',
      true,
      [],
      { catalogue: [], sources: [] },
      expect.any(String),
      undefined,
      undefined,
    );
  });
});

describe('ThemeEditor — the editor chrome is reused, not reinvented', () => {
  it('renders the shared editor chrome', () => {
    // A theme is edited in the same sitting as the documents it styles. A bespoke bar here means the
    // author's editor settings live in one place for documents and nowhere for themes.
    renderEditor();
    expect(screen.getByRole('button', { name: /editor settings/i })).toBeInTheDocument();
  });

  it('applies the account’s font size and editor theme, as the document editor does', () => {
    const { container } = renderEditor();
    const shell = container.querySelector('.asciidoc-editor');
    expect(shell).toHaveAttribute('data-theme', 'high-contrast');
    expect((shell as HTMLElement).style.getPropertyValue('--editor-font-size')).toBe('15px');
  });

  it('splits source and preview into resizable panels', () => {
    renderEditor();
    // The document editor's preview split is draggable; a theme's preview is worth as much width.
    expect(screen.getByTestId('theme-editor-source')).toBeInTheDocument();
    expect(screen.getByTestId('theme-preview-panel')).toBeInTheDocument();
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('cancels the preview panel’s standalone card styling, as the document editor does', () => {
    // `PdfPreviewPanel` defaults to a rounded, bordered card for standalone use. Inside a resize
    // split that border doubles up with the drag handle's edge and the rounding leaves corner gaps,
    // so the document editor cancels both — the two previews must sit identically in the same window.
    renderEditor();
    expect(screen.getByTestId('pdf-preview')).toHaveAttribute(
      'data-classname',
      'h-full rounded-none border-0',
    );
  });

  it('shows the shared status bar, including save state', () => {
    // Without a save indicator, losing an edit goes unnoticed — which is how the missing persistence
    // stayed invisible.
    renderEditor();
    expect(screen.getByText(/saved/i)).toBeInTheDocument();
  });
});

describe('ThemeEditor — permissions are inherited, not reinvented', () => {
  it('lets a member without write access read the theme and see the preview', () => {
    // FR-026: the theme editor must not introduce an access rule of its own.
    const { container } = renderEditor({ canEdit: false, content: 'base:\n  font-color: 333333' });
    expect(container.textContent).toContain('font-color');
    expect(screen.getByTestId('pdf-preview')).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });

  it('marks the view read-only when the viewer may not write', () => {
    const { container } = renderEditor({ canEdit: false });
    const content = container.querySelector('.cm-content');
    expect(content?.getAttribute('contenteditable')).not.toBe('true');
  });

  it('leaves the view editable when the viewer may write', () => {
    const { container } = renderEditor({ canEdit: true });
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true');
  });
});

/** A live Yjs binding whose shared text already holds `text`. */
function binding(text: string) {
  const doc = new Y.Doc();
  // The same shared text key `collabExtensions` binds to, so yCollab actually populates the view.
  if (text !== '') doc.getText(COLLAB_YTEXT_KEY).insert(0, text);
  return { doc, awareness: new Awareness(doc) };
}

describe('ThemeEditor — collaboration is passed through', () => {
  it('installs the collaboration binding when the file has one', () => {
    // Research found the collab layer is file-type agnostic, so this verifies the inheritance holds
    // rather than testing a mechanism this component builds (FR-026a).
    const { container } = renderEditor({ collab: binding('') });
    expect(container.querySelector('.cm-editor')).not.toBeNull();
  });

  it('renders without a binding on the non-collaborative path', () => {
    const { container } = renderEditor({ collab: null });
    expect(container.querySelector('.cm-editor')).not.toBeNull();
  });

  it('does not seed the REST content on the collab path, where Yjs owns the text', () => {
    // Regression: seeding it here as well APPENDS it to whatever Yjs delivers, so the author opens a
    // theme containing two copies of itself. Yjs does not sync synchronously under jsdom, so the
    // invariant is asserted at its source — the initial document must be empty — rather than by
    // counting occurrences, which would pass vacuously.
    const collab = binding('');
    const { container } = renderEditor({ collab, content: 'page:\n  layout: landscape\n' });
    expect(container.querySelector('.cm-content')?.textContent ?? '').toBe('');
  });

  it('does seed the content off the collab path, where nothing else will supply it', () => {
    const { container } = renderEditor({ collab: null, content: 'page:\n  layout: landscape\n' });
    expect(container.querySelector('.cm-content')?.textContent ?? '').toContain('layout');
  });

  it('does not remount the view when the parent re-renders', () => {
    // Regression: building the collab extension at the call site gave it a new identity per render,
    // which the mount effect read as a new binding — destroying and recreating the view continuously.
    const collab = binding('');
    const { container, rerender } = render(
      <ThemeEditor content="" canEdit path="t-theme.yml" collab={collab} />,
    );
    const first = container.querySelector('.cm-editor');
    rerender(<ThemeEditor content="" canEdit path="t-theme.yml" collab={collab} />);
    expect(container.querySelector('.cm-editor')).toBe(first);
  });
});

describe('ThemeEditor — external content changes', () => {
  it('pulls a changed content prop into the view off the collab path', () => {
    const { container, rerender } = render(
      <ThemeEditor content="page:" canEdit path="t-theme.yml" collab={null} />,
    );
    rerender(<ThemeEditor content="base:" canEdit path="t-theme.yml" collab={null} />);
    expect(container.querySelector('.cm-content')?.textContent).toContain('base:');
  });

  it('never replaces real content with an empty prop', () => {
    // `content` is `contentState.content ?? ''`, so it goes momentarily empty whenever the parent is
    // between loads. Applying that emptied the editor under the author. A genuine "clear the file"
    // arrives as a save, not as a transient prop.
    const { container, rerender } = render(
      <ThemeEditor content="page:\n  layout: landscape" canEdit path="t-theme.yml" collab={null} />,
    );
    rerender(<ThemeEditor content="" canEdit path="t-theme.yml" collab={null} />);
    expect(container.querySelector('.cm-content')?.textContent).toContain('layout');
  });
});

describe('ThemeEditor — edits are persisted', () => {
  it('writes through REST autosave off the collab path', () => {
    // THE disappearing-content bug: this editor accepted edits, reported them upward and wrote
    // nothing. A refetch — the project-wide `content-changed` bus fires on any save — then pulled the
    // server's copy back over the author's work, and a reload lost it entirely.
    renderEditor({ collab: null });
    expect(autoSaveOptions().enabled).toBe(true);
    expect(autoSaveOptions().projectId).toBe('p1');
    expect(autoSaveOptions().fileNodeId).toBe('f1');
  });

  it('disables autosave wherever the collaboration server owns persistence', () => {
    // Two writers for one document would fight over it.
    renderEditor({ collab: binding('') });
    expect(autoSaveOptions().enabled).toBe(false);

    mockAutoSave.mockClear();
    renderEditor({ collab: null, connectionState: 'connecting' });
    expect(autoSaveOptions().enabled).toBe(false);

    mockAutoSave.mockClear();
    renderEditor({ collab: null, collabUnavailable: true });
    expect(autoSaveOptions().enabled).toBe(false);
  });

  it('disables autosave when it has no file to write to', () => {
    mockAutoSave.mockClear();
    render(<ThemeEditor content="page:" canEdit path="t-theme.yml" collab={null} />);
    expect(autoSaveOptions().enabled).toBe(false);
  });
});

describe('ThemeEditor — content survives the collab lifecycle', () => {
  it('does not seed REST content while the document is on the collab path with no binding yet', () => {
    // A reconnecting document has no binding for that moment. Treating it as non-collaborative seeds
    // the REST copy over content Yjs owns, which then merges into a duplicate.
    const { container } = render(
      <ThemeEditor
        content="page:\n  layout: landscape"
        canEdit
        path="t-theme.yml"
        collab={null}
        connectionState="connecting"
      />,
    );
    expect(container.querySelector('.cm-content')?.textContent ?? '').toBe('');
  });

  it('does not rebuild the view when a reconnect supplies a new binding for the same document', () => {
    // THE disappearing-content bug: a reconnect handed down a new binding object, the mount effect
    // read that as a new document, and rebuilt the view with an empty doc — leaving the author
    // looking at a blank editor until the new binding finished syncing.
    const doc = new Y.Doc();
    doc.getText(COLLAB_YTEXT_KEY).insert(0, 'page:\n  layout: landscape\n');
    const first = { doc, awareness: new Awareness(doc) };
    const { container, rerender } = render(
      <ThemeEditor content="" canEdit path="t-theme.yml" collab={first} />,
    );
    const view = container.querySelector('.cm-editor');

    // Same Y.Doc, fresh awareness — exactly what a reconnect produces.
    rerender(
      <ThemeEditor
        content=""
        canEdit
        path="t-theme.yml"
        collab={{ doc, awareness: new Awareness(doc) }}
      />,
    );
    expect(container.querySelector('.cm-editor')).toBe(view);
  });

  it('restores the room text when the binding is dropped and restored (sync-timeout recovery)', () => {
    // The sync handshake exceeding COLLAB_SYNC_TIMEOUT_MS drops the binding to null and serves the file
    // read-only; the later `synced` restores it. Because this component's mount effect keys on
    // `collab?.doc`, that round trip recreates the view against an ALREADY-populated room — and ySync
    // applies only incremental deltas, so a view created empty then stays empty forever while the
    // author's first keystroke splices into the middle of the real text. Seeding from the live Y.Text
    // (which cannot duplicate — it IS what Yjs holds) makes the recreation lossless.
    const doc = new Y.Doc();
    doc.getText(COLLAB_YTEXT_KEY).insert(0, 'page:\n  layout: landscape\n');
    const collab = { doc, awareness: new Awareness(doc) };

    const { container, rerender } = render(
      <ThemeEditor content="" canEdit path="t-theme.yml" collab={collab} connectionState="synced" />,
    );
    // The binding drops on the sync timeout.
    rerender(<ThemeEditor content="" canEdit path="t-theme.yml" collab={null} connectionState="offline" />);
    // ...and returns when the provider finally syncs.
    rerender(
      <ThemeEditor content="" canEdit path="t-theme.yml" collab={collab} connectionState="synced" />,
    );

    expect(container.querySelector('.cm-content')?.textContent ?? '').toContain('layout');
  });

  it('treats a document with no collaborative backing as the non-collab path', () => {
    const { container } = render(
      <ThemeEditor
        content="page:\n  layout: landscape"
        canEdit
        path="t-theme.yml"
        collab={null}
        collabUnavailable
      />,
    );
    // collabUnavailable means no Yjs will ever populate it, so nothing may overwrite it either.
    expect(container.querySelector('.cm-content')?.textContent ?? '').toBe('');
  });
});

describe('ThemeEditor — a broken theme keeps the preview on screen', () => {
  it('says the preview is behind the editor, and still shows it', () => {
    // FR-015: an invalid theme reports an actionable error while the previous preview stays visible.
    mockPreview.mockReturnValue({
      pdf: new Blob(['%PDF']),
      isRendering: false,
      diagnostics: [],
      parseProblem: { message: 'Unexpected end of input', line: 4 },
    });
    renderEditor();

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/last version that could be read/i);
    expect(status).toHaveTextContent(/Line 4/);
    expect(status).toHaveTextContent(/Unexpected end of input/);
    // The preview is still there — the error replaces nothing.
    expect(screen.getByTestId('pdf-preview')).toHaveAttribute('data-has-pdf', 'true');
  });

  it('omits the line when the parser could not locate one', () => {
    mockPreview.mockReturnValue({
      isRendering: false,
      diagnostics: [],
      parseProblem: { message: 'A theme must be a set of settings, not a list.' },
    });
    renderEditor();
    expect(screen.getByRole('status')).toHaveTextContent(/not a list/);
    expect(screen.getByRole('status')).not.toHaveTextContent(/Line/);
  });

  it('says nothing when the theme parses', () => {
    renderEditor();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('reports a render failure separately from a parse failure', () => {
    // A theme that parses but cannot be rendered is a different problem, and gets a different banner.
    mockPreview.mockReturnValue({
      isRendering: false,
      diagnostics: [],
      error: { message: 'theme font not found' } as never,
    });
    renderEditor();
    expect(screen.getByRole('alert')).toHaveTextContent(/theme font not found/);
  });
});
