'use client';

/**
 * @file The theme editor: a YAML editor beside a live PDF of the built-in sample document.
 *
 * The pairing is the whole point. A theme setting's effect is not legible from its value — `194F8A`
 * and `10.5` say nothing about the page they produce — so the editor and the rendered result have to
 * be visible together. Before this, checking a theme change meant exporting a real document.
 *
 * What this component deliberately does NOT own:
 *
 *  - **Access control.** It renders read-only when `canEdit` is false and adds no rule of its own.
 *    A member who may not modify the theme still gets the editor and the preview (FR-026).
 *  - **Collaboration.** The Yjs binding is passed straight through to CodeMirror, so a theme file
 *    co-edits on exactly the terms every other project file does — presence, live cursors, merged
 *    concurrent edits (FR-026a). The preview reads the same shared text, so co-editors see the same
 *    rendered result (FR-026b).
 *
 * Both are inherited rather than implemented; the tests assert the inheritance holds.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { collabExtensions, COLLAB_YTEXT_KEY } from '@/components/editor/editor-collab-extensions';
import { AlertTriangle } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { THEME_SETTINGS, type ThemeSettingDescriptor } from '@asciidocollab/shared';
import { PdfPreviewPanel } from '@/components/pdf-preview-panel';
import { buildThemeEditorExtensions } from '@/lib/codemirror/theme/theme-editor-extensions';
import { minimapExtension } from '@/lib/codemirror/editor-extensions';
import { useThemePreview } from '@/components/theme-editor/use-theme-preview';
import { ExtensionComparisonToggle } from '@/components/theme-editor/extension-comparison-toggle';
import type { EnabledExtension } from '@/hooks/use-theme-settings';
import { usePdfExtensionBundle } from '@/hooks/use-pdf-extension-bundle';
import type { ProjectAssetCache } from '@/hooks/use-project-asset-cache';
import { EditorChrome } from '@/components/editor/editor-chrome';
import { EditorStatusBar } from '@/components/editor/editor-status-bar';
import { useEditorPreferences } from '@/hooks/use-editor-preferences';
import { useAutoSave } from '@/hooks/use-auto-save';

/**
 * Live collaboration binding for the theme file, when it has one.
 *
 * The raw Y.Doc and awareness are taken rather than a prebuilt extension: building the extension at
 * the CALL SITE produces a new identity on every parent render, which the mount effect below reads
 * as a new binding and responds to by destroying and recreating the view. Memoising it here, on the
 * doc/awareness identity, is what makes the mount stable — the same arrangement `AsciiDocEditor`
 * uses.
 */
export interface ThemeEditorCollab {
  /** The shared Yjs document backing this file. */
  readonly doc: Y.Doc;
  /** The awareness channel carrying presence and remote cursors. */
  readonly awareness: Awareness;
}

interface ThemeEditorProperties {
  /** The project the theme belongs to; with `fileNodeId`, what autosave writes through. */
  projectId?: string;
  /** The theme file's node id. */
  fileNodeId?: string;
  /** ETag from the initial content GET, so external-change polling works from first load. */
  initialEtag?: string | null;
  /**
   * Collaboration connection state, when the file is a collaborative document whose binding is not
   * currently present (connecting, reconnecting). Its presence means the file is on the collab path
   * EVEN THOUGH `collab` is null, which is what stops this component seeding REST content over a
   * document Yjs owns.
   */
  connectionState?: unknown;
  /** True when the file is editable text with no collaborative document at all. */
  collabUnavailable?: boolean;
  /** The theme document's text. On the collab path this seeds the view; Yjs then owns it. */
  content: string;
  /** False when the viewer may not modify this file, or the project is archived. */
  canEdit: boolean;
  /** The theme file's project-relative path, shown so the author knows which file they are editing. */
  path: string;
  /** The collaboration binding, when the file is a collaborative document. */
  collab?: ThemeEditorCollab | null;
  /**
   * The theme settings completion offers, widened by the project's enabled extensions. Defaults to
   * the renderer's built-ins.
   */
  themeSettings?: readonly ThemeSettingDescriptor[];
  /**
   * The converter extensions in force for this project, which the preview loads and the comparison
   * control lets the author hold one out of. Empty means the comparison control is absent.
   */
  enabledExtensions?: readonly EnabledExtension[];
  /**
   * The project's binary-asset cache, so fonts the theme names are fetched and embedded in the
   * preview. Shared with the document preview and the export, so a font is fetched once per project.
   * Omitted for a theme opened outside a project, where the preview uses built-in faces.
   */
  readonly assetCache?: ProjectAssetCache;
  /**
   * The project's resolved render attributes — page size, layout, media and the rest — so the sample
   * is previewed on the page this project's export actually produces rather than on the engine's
   * default one. Must keep a stable identity across renders; the composition root's memo provides it.
   * Omitted for a theme opened outside a project, which has no configuration to apply.
   */
  readonly projectAttributes?: Readonly<Record<string, string>>;
  /**
   * Reports the live theme text up, for callers that persist it on the non-collab path.
   *
   * @param value - The theme document's full text after the edit.
   */
  onChange?: (value: string) => void;
}

/** No extensions enabled. A shared constant so the default prop keeps a stable identity. */
const NO_EXTENSIONS: readonly EnabledExtension[] = [];

/** The shell's inline style, carrying the font size to the stylesheet as a custom property. */
type EditorShellStyle = { '--editor-font-size': string } & React.CSSProperties;

/**
 * The editor shell's CSS custom property, matching the AsciiDoc editor's own `editorStyle`.
 *
 * @param fontSize - The account's editor font size, in pixels.
 * @returns The inline style carrying it to the stylesheet.
 */
function editorShellStyle(fontSize: number): EditorShellStyle {
  return { '--editor-font-size': `${fontSize}px` };
}

/** A YAML theme editor beside a live preview of the built-in sample document. */
export function ThemeEditor({
  content,
  canEdit,
  path,
  projectId,
  fileNodeId,
  initialEtag,
  collab,
  connectionState,
  collabUnavailable = false,
  themeSettings = THEME_SETTINGS,
  enabledExtensions = NO_EXTENSIONS,
  assetCache,
  projectAttributes,
  onChange,
}: ThemeEditorProperties): React.JSX.Element {
  // The collab path is broader than "a binding is present right now". A document that is
  // reconnecting has no binding for that moment, and treating it as non-collaborative would seed the
  // REST copy over content Yjs owns. This mirrors `AsciiDocEditor`'s `onCollabPath` exactly; when the
  // two disagreed, a reconnect wiped the editor.
  const onCollabPath = collab != null || connectionState != null || collabUnavailable;

  // The SAME account-synced preferences the AsciiDoc editor reads. A theme is edited in the same
  // sitting as the documents it styles, so an author who set their font size once should not find it
  // reset — and should not have to discover a second, parallel set of editor settings.
  const {
    fontSize,
    theme: editorTheme,
    softWrap: preferredSoftWrap,
    minimapEnabled: preferredMinimap,
    setFontSize,
    setTheme,
    setSoftWrap,
    setMinimapEnabled,
  } = useEditorPreferences();

  // A theme is an ordinary project file, and off the collab path an ordinary project file is
  // persisted by REST autosave. Without this the editor accepted edits, reported them upward, and
  // wrote nothing — so a refetch (the project-wide `content-changed` bus fires on any save) pulled
  // the server's copy back over the author's unsaved work, and a reload lost it entirely.
  //
  // Enabled only OFF the collab path, exactly as `AsciiDocEditor` does it: where a binding exists the
  // collaboration server owns persistence, and a second writer would fight it.
  const { saveState, save } = useAutoSave({
    projectId: projectId ?? '',
    fileNodeId: fileNodeId ?? '',
    initialEtag: initialEtag ?? undefined,
    enabled: !onCollabPath && projectId !== undefined && fileNodeId !== undefined,
  });

  // Held in a ref so the mount effect's update listener always calls the CURRENT save function
  // without taking it as a dependency — depending on it would remount the view on every save-state
  // change and drop the cursor.
  const saveReference = useRef(save);
  saveReference.current = save;

  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Re-render once the view exists, so the chrome's toolbars receive a live view rather than null.
  const [mountedView, setMountedView] = useState<EditorView | null>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1, totalLines: 1 });
  // The live text drives the preview. Held in state (not a ref) because the preview must re-derive
  // when it changes — including when the change arrived from a collaborator rather than this keyboard.
  const [themeText, setThemeText] = useState(content);

  // Which extension is held OUT of the preview, for comparison. Preview-only: nothing here writes to
  // the project's selection, so what the project renders is unaffected (FR-031b1).
  const [withheldExtensionId, setWithheldExtensionId] = useState<string | null>(null);

  // The load list for the preview: everything enabled, minus the one held out. Derived rather than
  // stored, so a change to the project's selection cannot leave a stale list behind.
  const previewExtensionIds = useMemo(
    () =>
      enabledExtensions
        .filter((extension) => extension.id !== withheldExtensionId)
        .map((extension) => extension.id),
    [enabledExtensions, withheldExtensionId],
  );

  // The Ruby the preview loads for those ids. Fetched here rather than passed down, so the editor's
  // "with"/"without" comparison and the code it compares are derived from the same list.
  // The preview needs no readiness gate: it re-renders when the sources arrive, so a first render
  // without them corrects itself. Only a one-shot export has to wait (see the export button).
  const { bundle: extensionBundle } = usePdfExtensionBundle(projectId ?? '', previewExtensionIds);

  const preview = useThemePreview(
    themeText,
    true,
    previewExtensionIds,
    extensionBundle,
    path,
    assetCache,
    projectAttributes,
  );

  // Read lazily by the completion source, so enabling an extension widens completion without a
  // remount. The ref is what keeps the extension array stable across a settings change.
  const settingsReference = useRef(themeSettings);
  settingsReference.current = themeSettings;

  const compartments = useMemo(
    () => ({ readOnly: new Compartment(), lineWrap: new Compartment(), minimap: new Compartment() }),
    [],
  );

  // Memoised on the doc/awareness identity so a parent re-render does not remount the view.
  const collabExtension = useMemo(
    () => (collab ? collabExtensions(collab.doc, collab.awareness) : undefined),
    [collab?.doc, collab?.awareness],
  );

  // Mount ONCE per Y.Doc, not per binding object.
  //
  // A reconnect hands down a new binding for the same document. Treating that as a new mount
  // destroys the view and recreates it with an empty doc (Yjs owns the text), so until the new
  // binding finishes syncing the author is looking at a blank editor — and if they type into it,
  // they are typing into a document that is about to be replaced. Keying on the Y.Doc means a
  // reconnect reuses the existing view and the text never leaves the screen.
  useEffect(() => {
    if (container.current === null) return;

    const reportChanges = EditorView.updateListener.of((update) => {
      if (update.docChanged || update.selectionSet) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        setCursor({
          line: line.number,
          col: head - line.from + 1,
          totalLines: update.state.doc.lines,
        });
      }
      if (!update.docChanged) return;
      const next = update.state.doc.toString();
      setThemeText(next);
      onChange?.(next);
      // `save` debounces internally and is inert when disabled, so calling it per edit is correct on
      // both paths rather than something to gate here.
      saveReference.current(next);
    });

    const instance = new EditorView({
      state: EditorState.create({
        // Seed from the LIVE Y.Text when a binding exists, matching `use-editor-mount`. Seeding the
        // REST copy would append it to whatever Yjs delivers (a file containing two of itself), but
        // seeding the shared type cannot duplicate anything — it IS what Yjs holds. That matters
        // because this effect keys on `collab?.doc`, so the offline→synced round trip (the binding
        // drops on a sync timeout and returns on recovery) recreates the view against an
        // already-populated room: with a hardcoded '' the view stays blank forever, since ySync only
        // applies incremental deltas, and the author's first keystroke then splices into the middle of
        // the real text. Still '' with no binding, so the parent's `collabPending` skeleton is unaffected.
        doc: collab ? collab.doc.getText(COLLAB_YTEXT_KEY).toString() : (onCollabPath ? '' : content),
        extensions: buildThemeEditorExtensions({
          compartments,
          canEdit,
          softWrap: preferredSoftWrap,
          minimapEnabled: preferredMinimap,
          getThemeSettings: () => settingsReference.current,
          collabActive: collab != null,
          collabExtension,
          hookExtensions: [reportChanges],
        }),
      }),
      parent: container.current,
    });
    view.current = instance;
    setMountedView(instance);
    setThemeText(instance.state.doc.toString());

    return () => {
      instance.destroy();
      view.current = null;
      setMountedView(null);
    };
    // `content` and the callbacks are intentionally absent: `content` seeds the initial document
    // only (later changes arrive through the editor or Yjs), so depending on it would remount the
    // view — and drop the cursor — on every keystroke.
  }, [collab?.doc, compartments]);

  // Pull external content changes into the view — a revert, a history restore, an offline
  // reconciliation. Skipped anywhere on the collab path, where Yjs is the only writer.
  useEffect(() => {
    const instance = view.current;
    if (instance === null || onCollabPath) return;
    const current = instance.state.doc.toString();
    if (current === content) return;
    // Never replace real content with nothing. `content` is `contentState.content ?? ''`, so it goes
    // momentarily empty whenever the parent is between loads — and applying that emptied the editor
    // under the author. A genuine "clear the file" arrives as a save, not as a transient prop.
    if (content === '' && current !== '') return;
    instance.dispatch({ changes: { from: 0, to: current.length, insert: content } });
    setThemeText(content);
  }, [content, onCollabPath]);

  // Preference changes reconfigure the live view rather than remounting it, so toggling soft wrap or
  // the minimap keeps the cursor, the scroll position and — on the collab path — the binding.
  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.lineWrap.reconfigure(preferredSoftWrap ? [EditorView.lineWrapping] : []),
    });
  }, [preferredSoftWrap, compartments]);

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.minimap.reconfigure(preferredMinimap ? minimapExtension() : []),
    });
  }, [preferredMinimap, compartments]);

  // Write access can change without a remount (a role change, an archive) — reconfigure in place so
  // the cursor and any pending collaborative state survive it.
  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.readOnly.reconfigure([
        EditorState.readOnly.of(!canEdit),
        EditorView.editable.of(canEdit),
      ]),
    });
  }, [canEdit, compartments]);

  return (
    // The same shell the AsciiDoc editor uses: the font-size CSS variable and the `data-theme`
    // attribute its stylesheet keys off, so a theme file honours the author's editor theme and font
    // size exactly as their documents do.
    <div
      className="asciidoc-editor flex h-full min-h-0 flex-col"
      style={editorShellStyle(fontSize)}
      data-theme={editorTheme}
    >
      {/*
        The split is the OUTERMOST element, exactly as in the document editor: the toolbar and status
        bar belong to the editor column, not to the window. Spanning them across both columns put the
        settings control above the preview, which reads as page chrome rather than as this editor's,
        and left the preview with two stacked headers.
      */}
      <PanelGroup direction="horizontal" className="flex-1 overflow-hidden">
        <Panel
          id="theme-source"
          order={1}
          defaultSize={50}
          minSize={20}
          className="flex flex-col overflow-hidden"
        >
          <div className="flex h-full min-h-0 flex-col">
            {/*
              The shared chrome. `isAsciiDoc={false}` drops the AsciiDoc formatting and table
              toolbars, which would do nothing to YAML, while keeping the editor-settings control and
              the collaboration presence bar — so the settings an author reaches for (font size,
              editor theme, soft wrap, minimap) are in the same place here as everywhere else.
            */}
            <EditorChrome
              view={mountedView}
              isAsciiDoc={false}
              canEdit={canEdit}
              fontSize={fontSize}
              theme={editorTheme}
              softWrap={preferredSoftWrap}
              minimapEnabled={preferredMinimap}
              setFontSize={setFontSize}
              setTheme={setTheme}
              setSoftWrap={setSoftWrap}
              setMinimapEnabled={setMinimapEnabled}
              tableContext={null}
              awareness={collab?.awareness}
              trailing={
                // The comparison control rides in the toolbar beside the path rather than in a bar
                // of its own, which is one fewer line of chrome in a panel that exists to show the
                // rendered sample. The path yields space first (`truncate`, `min-w-0`): it is
                // reference information and carries a `title`, while the control has to stay usable.
                <span className="flex min-w-0 flex-1 items-center justify-end gap-3">
                  <ExtensionComparisonToggle
                    extensions={enabledExtensions}
                    withheldId={withheldExtensionId}
                    onWithhold={setWithheldExtensionId}
                  />
                  <span className="min-w-0 truncate text-xs text-muted-foreground" title={path}>
                    <code>{path}</code>
                    {!canEdit && <span className="ml-2">Read-only</span>}
                  </span>
                </span>
              }
            />

            {preview.error !== undefined && (
              <div role="alert" className="border-b px-3 py-2 text-sm text-destructive bg-destructive/10">
                The sample could not be rendered with this theme: {preview.error.message}
              </div>
            )}

            {preview.parseProblem !== undefined && (
              <div
                role="status"
                className="flex items-start gap-2 border-b px-3 py-2 text-sm border-[hsl(var(--warning-border))] bg-[hsl(var(--warning-bg))] text-[hsl(var(--warning))]"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  The preview below is the last version that could be read.{' '}
                  {preview.parseProblem.line === undefined
                    ? preview.parseProblem.message
                    : `Line ${preview.parseProblem.line}: ${preview.parseProblem.message}`}
                </span>
              </div>
            )}

            <div
              ref={container}
              data-testid="theme-editor-source"
              className="min-h-0 flex-1 overflow-auto"
            />

            {/*
              The same status bar the document editor carries. Save state is the part that matters
              here: this editor previously showed no indication of whether a theme had been written,
              which is precisely the condition under which losing an edit goes unnoticed.
            */}
            <EditorStatusBar
              line={cursor.line}
              col={cursor.col}
              totalLines={cursor.totalLines}
              saveState={saveState}
              onRetry={() => saveReference.current(themeText)}
            />
          </div>
        </Panel>

        <PanelResizeHandle className="group relative z-10 -mx-[3px] flex w-[7px] shrink-0 cursor-col-resize items-stretch justify-center outline-none">
          <span className="w-px bg-border transition-colors group-hover:bg-primary/60 group-data-[resize-handle-state=drag]:bg-primary" />
        </PanelResizeHandle>

        <Panel
          id="theme-preview"
          order={2}
          defaultSize={50}
          minSize={20}
          className="overflow-hidden"
          data-testid="theme-preview-panel"
        >
          <PdfPreviewPanel
            pdf={preview.pdf ?? null}
            isRendering={preview.isRendering}
            diagnostics={preview.diagnostics}
            // The panel defaults to a rounded, bordered card for standalone use. Inside a resize
            // split that border doubles up with the drag handle's own edge and the rounding leaves a
            // gap at the corners — so the document editor cancels both, and this must match it or
            // the two previews sit differently in the same window.
            className="h-full rounded-none border-0"
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
