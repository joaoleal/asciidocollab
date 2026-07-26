import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { ProjectEditorLayout } from '@/app/(dashboard)/dashboard/projects/[id]/project-editor-layout';
import type { ConnectionState } from '@/hooks/use-collab-document';
import type { CollabAuthRole } from '@asciidocollab/shared';

// the offline read-only fallback and mid-session role
// demotion are derived in the layout (research D6, EditorMode). These tests
// drive the collaboration mode by controlling useCollabDocument + the file
// selection, and assert the props the editor receives.

let mockConnectionState: ConnectionState = 'synced';
let mockCollabRole: CollabAuthRole = 'editor';

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

// Stub the live PDF preview hook AND its panel: both pull in the PDF worker/pdf.js, whose
// `import.meta.url` is unloadable under the commonjs jest transform, so the real modules can never
// be imported here (mocked by design).
jest.mock('@/hooks/use-pdf-preview', () => ({
  usePdfPreview: () => ({ pdf: undefined, isRendering: false, diagnostics: [] }),
}));
jest.mock('@/components/pdf-preview-panel', () => ({
  PdfPreviewPanel: () => <div data-testid="pdf-preview-panel-mock" />,
}));

jest.mock('@/hooks/use-file-selection', () => ({
  useFileSelection: () => ({
    selectedFile: { nodeId: 'n1', nodeName: 'doc.adoc', nodeType: 'file', path: '/doc.adoc' },
    contentState: {
      content: null, etag: null, isLoading: false, error: null, isBinary: false, notFound: false,
      collab: { yjsStateId: 'y1', role: mockCollabRole },
    },
    selectFile: jest.fn(),
    clearSelection: jest.fn(),
  }),
}));

jest.mock('@/hooks/use-collab-document', () => ({
  useCollabDocument: () => ({ doc: {}, awareness: {}, connectionState: mockConnectionState }),
}));

const mockGetCollabInfo = jest.fn();
jest.mock('@/lib/api/collab', () => ({ getCollabDocumentInfo: (...a: unknown[]) => mockGetCollabInfo(...a) }));

const mockGetDocumentContent = jest.fn();
jest.mock('@/lib/api/file-content', () => ({
  getDocumentContent: (...a: unknown[]) => mockGetDocumentContent(...a),
  API_BASE_URL: 'http://localhost:4000',
}));

jest.mock('@/hooks/use-editor-preferences', () => ({
  useEditorPreferences: () => ({
    scrollSyncEnabled: false, setScrollSyncEnabled: jest.fn(),
    commentsPanelOpen: false, setCommentsPanelOpen: jest.fn(),
  }),
}));

// Review wiring (feature 038): stub the review hook + members API so a bare mock Y.Doc never
// reaches the real anchor resolution during these collab-focused layout tests.
jest.mock('@/hooks/use-review-items', () => ({
  useReviewItems: () => ({
    threads: [], ranges: [], anchorStates: new Map(),
    loading: false, error: null, refetch: jest.fn(),
    includeResolved: false, setIncludeResolved: jest.fn(),
  }),
}));
jest.mock('@/lib/api/members', () => ({
  membersApi: { list: jest.fn().mockResolvedValue({ data: { members: [] } }) },
}));

jest.mock('@/hooks/use-last-selection', () => ({
  readLastSelection: () => null,
  useLastSelection: () => ({
    readLastSelection: () => null,
    rememberFile: jest.fn(),
    rememberLine: jest.fn(),
    clearLastSelection: jest.fn(),
  }),
}));

jest.mock('@/components/file-tree/file-tree', () => ({ FileTree: () => <div data-testid="file-tree" /> }));
jest.mock('@/components/asciidoc-preview', () => ({
  AsciiDocPreview: () => <div data-testid="preview" />,
  isAsciiDocFile: (name: string) => name.endsWith('.adoc'),
}));
jest.mock('@/components/image-preview', () => ({ ImagePreview: () => <div /> }));
jest.mock('react-resizable-panels', () => ({
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelResizeHandle: () => <div />,
}));

// Capture the props the editor receives.
jest.mock('@/components/editor/asciidoc-editor', () => ({
  AsciiDocEditor: ({ content, canEdit, collab, connectionState }: {
    content: string; canEdit: boolean; collab?: { role: string } | null; connectionState?: string;
  }) => (
    <div
      data-testid="editor"
      data-can-edit={String(canEdit)}
      data-collab-role={collab?.role ?? 'none'}
      data-connection={connectionState ?? 'none'}
    >
      {content}
    </div>
  ),
}));

const defaultProps = {
  projectId: 'p1',
  projectName: 'Proj',
  projectDescription: null,
  mainFileNodeId: null,
  canManage: false,
  canEdit: true,
  canModifyFiles: true,
  canManageDictionary: true,
  userId: 'u-test',
};

beforeEach(() => {
  mockConnectionState = 'synced';
  mockCollabRole = 'editor';
  mockGetCollabInfo.mockReset();
  mockGetDocumentContent.mockReset();
  // The cross-file symbol index fetches reachable file content (including the open file, which the
  // assembled outline keeps cached); default to a resolved value so it never reads `.then` of
  // undefined. Individual tests override this when they assert on the fetched content.
  mockGetDocumentContent.mockResolvedValue('');
});

describe('ProjectEditorLayout — offline read-only fallback', () => {
  test('when offline, the editor is read-only, seeded from GET /content, with the offline state', async () => {
    mockConnectionState = 'offline';
    mockGetDocumentContent.mockResolvedValue('= Offline Content');

    render(<ProjectEditorLayout {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('editor')).toHaveTextContent('= Offline Content');
    });
    const editor = screen.getByTestId('editor');
    expect(editor).toHaveAttribute('data-can-edit', 'false');
    expect(editor).toHaveAttribute('data-connection', 'offline');
    // The (empty) Yjs binding is dropped offline so the editor renders the REST content.
    expect(editor).toHaveAttribute('data-collab-role', 'none');
    expect(mockGetDocumentContent).toHaveBeenCalledWith('p1', 'n1');
  });
});

describe('ProjectEditorLayout — observer role (integration)', () => {
  test('an observer gets a read-only collab editor', () => {
    mockCollabRole = 'observer';
    mockConnectionState = 'synced';

    render(<ProjectEditorLayout {...defaultProps} />);

    const editor = screen.getByTestId('editor');
    expect(editor).toHaveAttribute('data-collab-role', 'observer');
    expect(editor).toHaveAttribute('data-connection', 'synced');
  });
});

describe('ProjectEditorLayout — mid-session role demotion', () => {
  test('a reconnect that re-checks the role to observer flips the editor read-only', async () => {
    mockConnectionState = 'synced';
    mockCollabRole = 'editor';
    mockGetCollabInfo.mockResolvedValue({ yjsStateId: 'y1', role: 'observer' });

    const { rerender } = render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByTestId('editor')).toHaveAttribute('data-collab-role', 'editor');

    // Simulate a drop then restore: reconnecting → synced triggers the role re-check.
    mockConnectionState = 'reconnecting';
    rerender(<ProjectEditorLayout {...defaultProps} />);
    mockConnectionState = 'synced';
    rerender(<ProjectEditorLayout {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('editor')).toHaveAttribute('data-collab-role', 'observer');
    });
    expect(mockGetCollabInfo).toHaveBeenCalledWith('p1', 'n1');
  });

  test('a failed role re-check on reconnect keeps the current role (server still rejects observer writes)', async () => {
    mockConnectionState = 'synced';
    mockCollabRole = 'editor';
    mockGetCollabInfo.mockRejectedValue(new Error('network'));

    const { rerender } = render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByTestId('editor')).toHaveAttribute('data-collab-role', 'editor');

    mockConnectionState = 'reconnecting';
    rerender(<ProjectEditorLayout {...defaultProps} />);
    mockConnectionState = 'synced';
    rerender(<ProjectEditorLayout {...defaultProps} />);

    await waitFor(() => expect(mockGetCollabInfo).toHaveBeenCalledWith('p1', 'n1'));
    // The re-check rejected, so the role is unchanged (the editor stays editable).
    expect(screen.getByTestId('editor')).toHaveAttribute('data-collab-role', 'editor');
  });
});
