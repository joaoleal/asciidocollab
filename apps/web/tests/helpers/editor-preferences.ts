import type { useEditorPreferences } from '@/hooks/use-editor-preferences';

/** Everything `useEditorPreferences` hands its callers. */
type EditorPreferencesResult = ReturnType<typeof useEditorPreferences>;

/**
 * A complete `useEditorPreferences` return value, with only the fields a spec cares about overridden.
 *
 * Specs that mock the hook used to return a four-field object literal. The consumer reads more than
 * four — soft wrap, the panel tabs, spellcheck, the outline scope — so those arrived as `undefined`
 * and the component ran against a preferences object no user could ever have. Building from the
 * hook's real defaults keeps the double honest and makes the override the only difference.
 */
export function editorPreferences(
  overrides: Partial<EditorPreferencesResult> = {},
): EditorPreferencesResult {
  return {
    fontSize: 14,
    theme: 'default',
    scrollSyncEnabled: false,
    softWrap: true,
    previewStyle: 'asciidocollab',
    spellIgnore: [],
    spellcheckEnabled: true,
    minimapEnabled: false,
    leftPanelTab: 'files',
    rightPanelTab: 'comments',
    showIncludedFiles: false,
    outlineScope: 'full',
    commentsPanelOpen: false,
    setFontSize: jest.fn(),
    setTheme: jest.fn(),
    setScrollSyncEnabled: jest.fn(),
    setSoftWrap: jest.fn(),
    setPreviewStyle: jest.fn(),
    addSpellIgnore: jest.fn(),
    setSpellcheckEnabled: jest.fn(),
    setMinimapEnabled: jest.fn(),
    setLeftPanelTab: jest.fn(),
    setRightPanelTab: jest.fn(),
    setShowIncludedFiles: jest.fn(),
    setOutlineScope: jest.fn(),
    setCommentsPanelOpen: jest.fn(),
    ...overrides,
  };
}
