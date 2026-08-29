'use client';
import { useState, type ComponentType } from 'react';
import {
  Bold, Italic, Code, Highlighter, Subscript, Superscript,
  Heading1, Heading2, Heading3, Heading4, Heading5,
  ListOrdered, List, ListChecks, ListTree,
  SquareCode, Box, PanelRight, Quote,
  Info, Lightbulb, TriangleAlert, AlertCircle, Flame, Sigma, MessageSquare,
  Table, Captions, Link, ArrowRightLeft, Asterisk, Image, Replace,
} from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { EditorView } from '@codemirror/view';
import { EditorToolbarButton } from './editor-toolbar-button';
import { EditorSettingsButton, EditorSettingsSurface } from './editor-settings-control';
import type { EditorThemeValue } from '@/hooks/use-editor-preferences';
import { TABLE_SKELETON } from '@/lib/codemirror/asciidoc-completions';
import { symbolAtCursor, type CursorSymbol } from '@/lib/codemirror/asciidoc-symbol-at-cursor';

interface EditorToolbarProperties {
  view: EditorView | null;
  canEdit?: boolean;
  fontSize?: number;
  theme?: EditorThemeValue;
  softWrap?: boolean;
  minimapEnabled?: boolean;
  /** Whether the inline blame gutter is shown. */
  blameEnabled?: boolean;
  setFontSize?: (size: number) => void;
  setTheme?: (theme: EditorThemeValue) => void;
  setSoftWrap?: (enabled: boolean) => void;
  setMinimapEnabled?: (enabled: boolean) => void;
  // Toggles the inline blame gutter; omitted when blame is unavailable (no repo / no open file).
  setBlameEnabled?: (enabled: boolean) => void;
  /** Opens the Go to Symbol palette; omitted hides the button. */
  onGoToSymbol?: () => void;
  // Opens the refactor dialog, seeded with the symbol under the cursor (or null when the
  // cursor is not on one); omitted hides the button.
  onRefactor?: (initial: CursorSymbol | null) => void;
}

// Wrap selected text or insert at cursor
function wrapOrInsert(view: EditorView, before: string, after: string, placeholder = '') {
  const { from, to, empty } = view.state.selection.main;
  const selected = empty ? placeholder : view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: `${before}${selected}${after}` },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
  });
  view.focus();
}

// Insert a snippet at cursor
function insertSnippet(view: EditorView, snippet: string) {
  const { from } = view.state.selection.main;
  view.dispatch({
    changes: { from, to: from, insert: snippet },
    selection: { anchor: from + snippet.length },
  });
  view.focus();
}

// Insert a snippet at cursor with cursor positioned at a specific offset within the snippet
function insertSnippetAt(view: EditorView, snippet: string, cursorOffset: number) {
  const { from } = view.state.selection.main;
  view.dispatch({
    changes: { from, to: from, insert: snippet },
    selection: { anchor: from + cursorOffset },
  });
  view.focus();
}

// Insert a source-code block declaration with the language placeholder selected:
// `[source,<lang>]` + listing delimiters, cursor on the language
// so the author types it immediately; the body sits between the `----` fences.
function insertSourceBlock(view: EditorView) {
  const { from } = view.state.selection.main;
  const before = '[source,';
  const languagePlaceholder = 'language';
  const insert = `${before}${languagePlaceholder}]\n----\n\n----\n`;
  view.dispatch({
    changes: { from, to: from, insert },
    selection: { anchor: from + before.length, head: from + before.length + languagePlaceholder.length },
  });
  view.focus();
}

// Insert a caption on the line immediately before the current cursor line
function insertCaption(view: EditorView) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const captionText = '.Block title';
  view.dispatch({
    changes: { from: line.from, to: line.from, insert: `${captionText}\n` },
    selection: { anchor: line.from + 1, head: line.from + captionText.length },
  });
  view.focus();
}

// Insert a line-start prefix
function insertLinePrefix(view: EditorView, prefix: string) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  view.dispatch({
    changes: { from: line.from, to: line.from, insert: prefix },
  });
  view.focus();
}

interface ToolbarAction {
  label: string;
  shortcut: string;
  icon: ComponentType<{ className?: string }>;
  action: (view: EditorView) => void;
}

const TEXT_FORMATTING: ToolbarAction[] = [
  { label: 'Bold',        shortcut: 'Ctrl+B', icon: Bold,        action: (v) => wrapOrInsert(v, '*', '*', 'bold') },
  { label: 'Italic',      shortcut: 'Ctrl+I', icon: Italic,      action: (v) => wrapOrInsert(v, '_', '_', 'italic') },
  { label: 'Monospace',   shortcut: 'Ctrl+`', icon: Code,        action: (v) => wrapOrInsert(v, '`', '`', 'code') },
  { label: 'Highlight',   shortcut: '',       icon: Highlighter, action: (v) => wrapOrInsert(v, '#', '#', 'highlight') },
  { label: 'Subscript',   shortcut: '',       icon: Subscript,   action: (v) => wrapOrInsert(v, '~', '~', 'sub') },
  { label: 'Superscript', shortcut: '',       icon: Superscript, action: (v) => wrapOrInsert(v, '^', '^', 'sup') },
];

const STRUCTURE: ToolbarAction[] = [
  { label: 'Heading 1', shortcut: '', icon: Heading1, action: (v) => insertLinePrefix(v, '= ') },
  { label: 'Heading 2', shortcut: '', icon: Heading2, action: (v) => insertLinePrefix(v, '== ') },
  { label: 'Heading 3', shortcut: '', icon: Heading3, action: (v) => insertLinePrefix(v, '=== ') },
  { label: 'Heading 4', shortcut: '', icon: Heading4, action: (v) => insertLinePrefix(v, '==== ') },
  { label: 'Heading 5', shortcut: '', icon: Heading5, action: (v) => insertLinePrefix(v, '===== ') },
  { label: 'Ordered List',   shortcut: '', icon: ListOrdered, action: (v) => insertLinePrefix(v, '. ') },
  { label: 'Unordered List', shortcut: '', icon: List,        action: (v) => insertLinePrefix(v, '* ') },
  { label: 'Checklist',      shortcut: '', icon: ListChecks,  action: (v) => insertLinePrefix(v, '* [ ] ') },
  { label: 'Description List', shortcut: '', icon: ListTree,  action: (v) => insertLinePrefix(v, ':: ') },
];

const BLOCKS: ToolbarAction[] = [
  { label: 'Code Block',    shortcut: '', icon: SquareCode, action: (v) => insertSourceBlock(v) },
  { label: 'Example Block', shortcut: '', icon: Box,        action: (v) => insertSnippet(v, '====\n\n====\n') },
  { label: 'Sidebar',       shortcut: '', icon: PanelRight, action: (v) => insertSnippet(v, '****\n\n****\n') },
  { label: 'Blockquote',    shortcut: '', icon: Quote,      action: (v) => insertSnippet(v, '____\n\n____\n') },
  { label: 'NOTE',       shortcut: '', icon: Info,          action: (v) => insertSnippet(v, '[NOTE]\n====\n\n====\n') },
  { label: 'TIP',        shortcut: '', icon: Lightbulb,     action: (v) => insertSnippet(v, '[TIP]\n====\n\n====\n') },
  { label: 'WARNING',    shortcut: '', icon: TriangleAlert, action: (v) => insertSnippet(v, '[WARNING]\n====\n\n====\n') },
  { label: 'IMPORTANT',  shortcut: '', icon: AlertCircle,   action: (v) => insertSnippet(v, '[IMPORTANT]\n====\n\n====\n') },
  { label: 'CAUTION',    shortcut: '', icon: Flame,         action: (v) => insertSnippet(v, '[CAUTION]\n====\n\n====\n') },
  { label: 'STEM Block', shortcut: '', icon: Sigma,         action: (v) => insertSnippet(v, '[stem]\n++++\n\n++++\n') },
  { label: 'Comment Block', shortcut: '', icon: MessageSquare, action: (v) => insertSnippet(v, '////\n\n////\n') },
  {
    label: 'Table',
    shortcut: '',
    icon: Table,
    action: (v) => insertSnippetAt(v, TABLE_SKELETON, '|===\n|'.length),
  },
  {
    label: 'Caption',
    shortcut: '',
    icon: Captions,
    action: (v) => insertCaption(v),
  },
];

const INLINE_REFS: ToolbarAction[] = [
  { label: 'Link',            shortcut: '', icon: Link,           action: (v) => insertSnippet(v, 'link:https://[label]') },
  { label: 'Cross-reference', shortcut: '', icon: ArrowRightLeft, action: (v) => insertSnippet(v, '<<>>') },
  { label: 'Footnote',        shortcut: '', icon: Asterisk,       action: (v) => insertSnippet(v, 'footnote:[text]') },
  { label: 'Image',           shortcut: '', icon: Image,          action: (v) => insertSnippet(v, 'image::path[alt]') },
];

function ToolbarGroup({
  label, actions, view,
}: { label: string; actions: ToolbarAction[]; view: EditorView | null }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-0.5 border-r pr-1 mr-1 last:border-r-0"
    >
      {actions.map((action) => (
        <EditorToolbarButton
          key={action.label}
          icon={<action.icon className="h-4 w-4" />}
          label={action.label}
          shortcut={action.shortcut}
          onClick={() => view && action.action(view)}
          disabled={view === null}
        />
      ))}
    </div>
  );
}

/** Toolbar with formatting actions and editor settings. */
export function EditorToolbar({
  view,
  canEdit = true,
  fontSize = 14,
  theme = 'default',
  softWrap,
  minimapEnabled,
  blameEnabled,
  setFontSize = () => {},
  setTheme = () => {},
  setSoftWrap,
  setMinimapEnabled,
  setBlameEnabled,
  onGoToSymbol,
  onRefactor,
}: EditorToolbarProperties) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <Tooltip.Provider>
      <div
        role="toolbar"
        aria-label="Editor toolbar"
        className="flex items-center flex-wrap gap-0 px-2 py-1 border-b bg-background"
      >
        {canEdit && (
          <>
            <ToolbarGroup label="Text Formatting"    actions={TEXT_FORMATTING} view={view} />
            <ToolbarGroup label="Structure"          actions={STRUCTURE}       view={view} />
            <ToolbarGroup label="Blocks"             actions={BLOCKS}          view={view} />
            <ToolbarGroup label="Inline/References"  actions={INLINE_REFS}     view={view} />
          </>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {onGoToSymbol && (
            <EditorToolbarButton
              icon={<ListTree className="h-4 w-4" />}
              label="Go to Symbol"
              shortcut="Ctrl+Shift+O"
              onClick={onGoToSymbol}
            />
          )}
          {onRefactor && (
            <EditorToolbarButton
              icon={<Replace className="h-4 w-4" />}
              label="Refactor"
              shortcut="Ctrl+Shift+R"
              onClick={() => onRefactor(view ? symbolAtCursor(view) : null)}
            />
          )}
          <EditorSettingsButton
            open={settingsOpen}
            onToggle={() => setSettingsOpen((previous) => !previous)}
          />
        </div>
      </div>
      {settingsOpen && (
        <EditorSettingsSurface
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
    </Tooltip.Provider>
  );
}
