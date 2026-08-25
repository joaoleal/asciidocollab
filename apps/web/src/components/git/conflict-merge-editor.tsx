'use client';

/**
 * Inline three-way merge editor for one non-binary conflicting file: loads its merge-base/ours/theirs
 * content and lets the author produce the final text in a CodeMirror 6 `MergeView` — "ours" is the
 * editable side, "theirs" the read-only reference side, with revert controls to pull a chunk of
 * "theirs" across when that is the easier fix. The merge-base (when there is one — an add/add
 * conflict has none) is shown separately for reference rather than as a third diffed pane, since
 * `MergeView` only ever diffs two documents. On save, the edited "ours" buffer becomes the caller's
 * `mergedContent`; this component never calls `resolve` itself, so the panel decides what resolution
 * that content is saved under.
 */
import { useEffect, useRef, useState } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { asciidocEditorTheme } from '@/lib/codemirror/asciidoc-theme';
import { Button } from '@/components/ui/button';
import { getConflictStages } from '@/lib/api/git';
import type { ConflictStagesDto } from '@asciidocollab/shared';

/** Props for {@link ConflictMergeEditor}. */
export interface ConflictMergeEditorProperties {
  /** The project the conflicting file belongs to. */
  projectId: string;
  /** The conflicting file's project-relative path. */
  path: string;
  /**
   * Called with the edited "ours" buffer's full text once Save is clicked.
   *
   * @param mergedContent - The final merged text.
   */
  onSave: (mergedContent: string) => void | Promise<void>;
  /** Called when the editor is dismissed without saving. */
  onCancel: () => void;
}

/**
 * Loads one conflicting file's three-way stages and renders the editable merge view once they
 * arrive. Kept as its own component (rather than inline in the panel) so each conflicting file's
 * editor mounts and tears down independently of the others.
 */
export function ConflictMergeEditor({ projectId, path, onSave, onCancel }: ConflictMergeEditorProperties) {
  const [stages, setStages] = useState<ConflictStagesDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const containerReference = useRef<HTMLDivElement>(null);
  const mergeViewReference = useRef<MergeView | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getConflictStages(projectId, path)
      .then((result) => {
        if (!active) return;
        setStages(result);
      })
      .catch(() => {
        if (!active) return;
        setError("Couldn't load this file's conflicting versions.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, path]);

  useEffect(() => {
    if (!stages || stages.isBinary || !containerReference.current) return;
    const view = new MergeView({
      a: {
        doc: stages.ours,
        extensions: [asciidocEditorTheme],
      },
      b: {
        doc: stages.theirs,
        extensions: [asciidocEditorTheme, EditorState.readOnly.of(true), EditorView.editable.of(false)],
      },
      parent: containerReference.current,
      revertControls: 'b-to-a',
      highlightChanges: true,
      gutter: true,
    });
    mergeViewReference.current = view;
    return () => {
      view.destroy();
      mergeViewReference.current = null;
    };
  }, [stages]);

  const handleSave = async () => {
    const view = mergeViewReference.current;
    if (!view) return;
    setSaving(true);
    try {
      await onSave(view.a.state.doc.toString());
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="mt-2 text-sm text-muted-foreground">Loading merge editor…</p>;
  }

  if (error) {
    return (
      <div role="alert" className="mt-2 rounded-md bg-destructive/10 p-2 text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!stages) return null;

  if (stages.isBinary) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        This is a binary file — use Keep ours or Take theirs above.
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border p-2">
      {stages.base !== null && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Base (common ancestor)</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{stages.base}</pre>
        </details>
      )}
      <div ref={containerReference} className="cm-merge-container" />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
          {saving ? 'Saving…' : 'Save merge'}
        </Button>
      </div>
    </div>
  );
}
