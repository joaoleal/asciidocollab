import React, { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import { ProjectEditorLayout } from '@/app/(dashboard)/dashboard/projects/[id]/project-editor-layout';

// Regression for the "editor stuck on Loading… forever" bug. It only manifests under React's
// StrictMode / mount→unmount→remount cycle (which dev `next dev` enables): the first restore's
// content fetch is aborted by useFileSelection's unmount cleanup, and a persistent restore guard
// would then suppress the re-fetch on remount, leaving `isLoading` true forever.
//
// This test uses the REAL useFileSelection (not mocked) so the abort path is exercised, with a
// fetch that honours the abort signal exactly like the browser.

// This test exercises the legacy REST restore path; the file is not a collaborative
// document, so collab discovery returns null and the GET /content fetch runs.
jest.mock('@/lib/api/collab', () => ({
  getCollabDocumentInfo: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/contexts/current-user-context', () => ({
  useCurrentUser: () => ({ userId: 'u-test', displayName: 'Test User', email: 't@example.com', avatarKey: null }),
}));

// Stub the PDF export hook: its worker factory uses `import.meta.url`, which is unloadable under the
// commonjs jest transform, so the real module can never be imported here (mocked by design).
jest.mock('@/hooks/use-pdf-export', () => ({
  usePdfExport: () => ({ exportPdf: jest.fn(), isExporting: false, diagnostics: [] }),
}));
jest.mock('@/hooks/use-html-export', () => ({
  useHtmlExport: () => ({ exportHtml: jest.fn(), isExporting: false, failures: [] }),
}));
jest.mock('@/hooks/use-project-render-config', () => ({
  useProjectRenderConfig: () => ({ config: {}, loading: false, saving: false, error: null, save: jest.fn() }),
}));

// The connection status bar isn't under test here; this suite's fetch always resolves with
// content-fetch shapes, not a valid GitStatusDto, so stub the hook to stay not-connected.
jest.mock('@/hooks/use-git-status', () => ({
  useGitStatus: () => ({ status: null, connected: false, loading: false, error: null, refetch: jest.fn() }),
}));

// Stub the live PDF preview hook AND its panel: both pull in the PDF worker/pdf.js, whose
// `import.meta.url` is unloadable under the commonjs jest transform, so the real modules can never
// be imported here (mocked by design).
jest.mock('@/hooks/use-pdf-preview', () => ({
  usePdfPreview: () => ({ pdf: undefined, isRendering: false, diagnostics: [] }),
}));
jest.mock('@/components/pdf-preview-panel', () => ({
  PdfPreviewPanel: () => <div data-testid="pdf-preview-panel-mock" />,
}));

// Stub the file tree so it doesn't fetch on its own.
jest.mock('@/components/file-tree/file-tree', () => ({
  FileTree: () => <div data-testid="file-tree-stub" />,
}));

// Render the editor as a simple element that shows the content it receives.
jest.mock('@/components/editor/asciidoc-editor', () => ({
  AsciiDocEditor: ({ content }: { content: string }) => <div data-testid="asciidoc-editor">{content}</div>,
}));

jest.mock('@/components/asciidoc-preview', () => ({
  AsciiDocPreview: () => <div data-testid="asciidoc-preview" />,
  isAsciiDocFile: (name: string) => name.endsWith('.adoc'),
}));

jest.mock('@/hooks/use-editor-preferences', () => ({
  useEditorPreferences: () => ({
    fontSize: 14, theme: 'default', scrollSyncEnabled: false,
    setFontSize: jest.fn(), setTheme: jest.fn(), setScrollSyncEnabled: jest.fn(),
  }),
}));

const mockClearLastSelection = jest.fn();
jest.mock('@/hooks/use-last-selection', () => ({
  // Standalone export used by the layout's first-open flag; a stored selection ⇒ not a first open.
  readLastSelection: () => ({ nodeId: 'f1', nodeName: 'doc.adoc', nodeType: 'file', path: '/doc.adoc' }),
  useLastSelection: () => ({
    readLastSelection: () => ({ nodeId: 'f1', nodeName: 'doc.adoc', nodeType: 'file', path: '/doc.adoc' }),
    rememberFile: jest.fn(),
    rememberLine: jest.fn(),
    clearLastSelection: mockClearLastSelection,
    rememberCursorLine: jest.fn(),
    readCursorLine: () => undefined,
    pruneCursor: jest.fn(),
  }),
}));

const defaultProps = {
  projectId: 'p1',
  projectName: 'My Project',
  projectDescription: null,
  projectLanguage: null,
  mainFileNodeId: null,
  canManage: true,
  canEdit: true,
  canModifyFiles: true,
  canManageDictionary: true,
  userId: 'user-1',
};

describe('ProjectEditorLayout restore under StrictMode', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('loads the restored file content even when the first fetch is aborted by a remount (no stuck loading)', async () => {
    // A fetch that honours the abort signal (rejects with AbortError) — like the real browser fetch.
    // The content body resolves on a macrotask so the synchronous StrictMode cleanup can abort the
    // first request before it settles.
    globalThis.fetch = jest.fn((_url: string, options?: { signal?: AbortSignal }) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        setTimeout(() => resolve({
          ok: true,
          headers: new Headers({ 'Content-Type': 'text/plain', ETag: 'etag-1' }),
          text: () => Promise.resolve('RESTORED FILE CONTENT'),
          json: () => Promise.resolve({}),
        } as unknown as Response), 0);
      });
    }) as unknown as typeof fetch;

    render(
      <StrictMode>
        <ProjectEditorLayout {...defaultProps} />
      </StrictMode>,
    );

    // The restored content must appear — with the buggy persistent guard, the aborted first fetch
    // is never re-issued and this never resolves (stuck on the loading skeleton).
    expect(await screen.findByText('RESTORED FILE CONTENT', undefined, { timeout: 4000 })).toBeInTheDocument();
  });
});
