'use client';
import type { EditorView } from '@codemirror/view';
import type { Awareness } from 'y-protocols/awareness';
import type { EditorThemeValue } from '@/hooks/use-editor-preferences';
import type { TableContext } from '@/lib/codemirror/asciidoc-table-context';
import type { CursorSymbol } from '@/lib/codemirror/asciidoc-symbol-at-cursor';
import { EditorToolbar } from './editor-toolbar';
import { EditorSettingsControl } from './editor-settings-control';
import { EditorTableContextToolbar } from './editor-table-context-toolbar';
import { CollabPresenceBar } from './collab-presence-bar';

interface EditorChromeProperties {
  /** The live CodeMirror view, or null before mount; toolbars read/dispatch through it. */
  view: EditorView | null;
  /** When false the AsciiDoc toolbar and table-context toolbar are hidden (e.g. For plain-text files). */
  isAsciiDoc: boolean;
  /** Effective edit permission after observer/collab-unavailable gating. */
  canEdit: boolean;
  fontSize: number;
  theme: EditorThemeValue;
  softWrap: boolean;
  minimapEnabled: boolean;
  /** Whether the inline blame gutter is shown. Defaults to false for hosts that never blame. */
  blameEnabled?: boolean;
  setFontSize: (size: number) => void;
  setTheme: (theme: EditorThemeValue) => void;
  setSoftWrap: (enabled: boolean) => void;
  setMinimapEnabled: (enabled: boolean) => void;
  // Toggles the inline blame gutter; omitted when blame is unavailable (no repo / no open file).
  setBlameEnabled?: (enabled: boolean) => void;
  /** Active table context, or null when the cursor is not in a table. */
  tableContext: TableContext | null;
  /** Awareness for the collab presence bar; null/undefined on the non-collab path. */
  awareness?: Awareness | null;
  /**
   * Content rendered at the leading edge of the settings row, opposite the settings control.
   *
   * Exists so a host with something to say about the open file — the theme editor names the file it
   * is editing — can put it in the SAME row rather than adding a strip of its own above the editor.
   * Only rendered where the settings row is (non-AsciiDoc files).
   */
  trailing?: React.ReactNode;
  /** Opens the Go to Symbol palette. */
  onGoToSymbol?: () => void;
  // Opens the refactor dialog, seeded with the symbol under the cursor.
  onRefactor?: (initial: CursorSymbol | null) => void;
}

/**
 * The chrome rendered above the editor canvas: the AsciiDoc formatting toolbar, the contextual
 * table toolbar (only inside an editable table), and the collaboration presence bar. Purely
 * presentational — it wires the live view and preference setters into the toolbars.
 */
export function EditorChrome({
  view,
  isAsciiDoc,
  canEdit,
  fontSize,
  theme,
  softWrap,
  minimapEnabled,
  blameEnabled = false,
  setFontSize,
  setTheme,
  setSoftWrap,
  setMinimapEnabled,
  setBlameEnabled,
  tableContext,
  awareness,
  trailing,
  onGoToSymbol,
  onRefactor,
}: EditorChromeProperties) {
  const showTableToolbar = isAsciiDoc && canEdit && tableContext !== null && view !== null;
  return (
    <>
      {isAsciiDoc && (
        <EditorToolbar
          view={view}
          canEdit={canEdit}
          fontSize={fontSize}
          theme={theme}
          softWrap={softWrap}
          minimapEnabled={minimapEnabled}
          blameEnabled={blameEnabled}
          setFontSize={setFontSize}
          setTheme={setTheme}
          setSoftWrap={setSoftWrap}
          setMinimapEnabled={setMinimapEnabled}
          setBlameEnabled={setBlameEnabled}
          onGoToSymbol={onGoToSymbol}
          onRefactor={onRefactor}
        />
      )}
      {showTableToolbar && view !== null && tableContext !== null && (
        <EditorTableContextToolbar
          view={view}
          context={tableContext}
          tableText={view.state.doc.sliceString(tableContext.tableFrom, tableContext.tableTo)}
          tableFrom={tableContext.tableFrom}
        />
      )}
      {/*
        The settings are not AsciiDoc-specific — font size, theme, soft wrap and the minimap apply to
        whatever the editor is showing. When they lived only inside the AsciiDoc toolbar, opening a
        YAML theme left the author with no way to reach their own editor settings.
      */}
      {!isAsciiDoc && (
        <EditorSettingsControl
          leading={trailing}
          fontSize={fontSize}
          theme={theme}
          softWrap={softWrap}
          minimapEnabled={minimapEnabled}
          blameEnabled={blameEnabled}
          setFontSize={setFontSize}
          setTheme={setTheme}
          setSoftWrap={setSoftWrap}
          setMinimapEnabled={setMinimapEnabled}
          setBlameEnabled={setBlameEnabled}
        />
      )}
      {awareness != null && <CollabPresenceBar awareness={awareness} />}
    </>
  );
}
