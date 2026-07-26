import type { EditorSaveState } from '@/hooks/use-auto-save';

const STATE_LABELS: Record<EditorSaveState, string> = {
  saved:   'Saved',
  saving:  'Saving…',
  unsaved: 'Unsaved',
  error:   'Error',
};

const STATE_CLASSES: Record<EditorSaveState, string> = {
  error:   'text-destructive',
  saving:  'text-muted-foreground',
  unsaved: 'text-[hsl(var(--warning))]',
  saved:   'text-[hsl(var(--success))]',
};

interface EditorStatusBarProperties {
  line: number;
  col: number;
  totalLines: number;
  saveState: EditorSaveState;
  onRetry: () => void;
  /** Live word count; omitted ⇒ not shown. */
  wordCount?: number;
  /** Estimated reading time in minutes; omitted ⇒ not shown. */
  readingTimeMin?: number;
  /** Grammar status readout (on-device indicator + per-category counts); omitted ⇒ not shown. */
  grammarStatus?: React.ReactNode;
}

/** Compact status bar showing cursor position, document metrics, and save state. */
export function EditorStatusBar({
  line, col, totalLines, saveState, onRetry, wordCount, readingTimeMin, grammarStatus,
}: EditorStatusBarProperties) {
  return (
    <div className="flex items-center gap-3 px-3 py-1 text-xs text-muted-foreground border-t bg-background select-none">
      <span>Ln {line}, Col {col}</span>
      <span className="text-muted-foreground/50">|</span>
      <span>{totalLines} lines</span>
      {wordCount !== undefined && (
        <>
          <span className="text-muted-foreground/50">|</span>
          <span data-testid="editor-word-count">{wordCount} words</span>
        </>
      )}
      {readingTimeMin !== undefined && (
        <>
          <span className="text-muted-foreground/50">|</span>
          <span data-testid="editor-reading-time">{readingTimeMin} min read</span>
        </>
      )}
      <span className="flex-1" />
      {grammarStatus}
      <span className={STATE_CLASSES[saveState]}>
        {STATE_LABELS[saveState]}
      </span>
      {saveState === 'error' && (
        <button
          type="button"
          aria-label="Retry save"
          className="text-xs underline hover:no-underline"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}
