'use client';

import React, { useEffect, useState } from 'react';
import type { FileTreeNode } from '@/components/file-tree/types';
import { Label } from '@/components/ui/label';
import { fetchProjectFileTree } from '@/lib/api/file-tree';
import { isAsciiDocumentFile } from '@/lib/asciidoc/file-name';

/** A selectable AsciiDoc file in the project tree. */
interface AsciiDocFile {
  /** File node id. */
  nodeId: string;
  /** Project-relative path, used as the option label. */
  path: string;
}

/** Props for {@link MainFileField}. */
export interface MainFileFieldProperties {
  /** The project whose AsciiDoc files are offered. */
  projectId: string;
  /** The node id currently staged in the form, or null for "no main file". */
  value: string | null;
  /** Whether the field refuses edits (an archived project is read-only). */
  disabled: boolean;
  /**
   * Stage a new selection.
   *
   * @param next - The chosen file node id, or null to resolve each file on its own.
   */
  onChange: (next: string | null) => void;
}

/** The select's id, so the label and the field agree; the page renders one of these. */
const MAIN_FILE_SELECT_ID = 'main-file';

/** Recursively collect AsciiDoc file nodes (any AsciiDoc extension) from a file tree. */
function collectAsciiDocFiles(node: FileTreeNode, into: AsciiDocFile[]): void {
  if (node.type === 'file' && isAsciiDocumentFile(node.name)) {
    into.push({ nodeId: node.id, path: node.path });
  }
  for (const child of node.children) collectAsciiDocFiles(child, into);
}

/**
 * The project's main-file setting, as a field of the General form.
 *
 * It is deliberately CONTROLLED and persists nothing: a selection is a draft the enclosing form
 * writes when the viewer saves, like every other field beside it. Choosing a file used to store it
 * on the spot, which left one control in a form full of staged edits behaving unlike all the others
 * — there was no way to change your mind, and a Cancel that discarded everything else kept this.
 *
 * @param properties - The project, the staged selection, and the change handler.
 * @returns The main-file field element.
 */
export function MainFileField({
  projectId,
  value,
  disabled,
  onChange,
}: MainFileFieldProperties): React.JSX.Element {
  const [files, setFiles] = useState<AsciiDocFile[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchProjectFileTree(projectId)
      .then((root) => {
        if (cancelled) return;
        const list: AsciiDocFile[] = [];
        collectAsciiDocFiles(root, list);
        list.sort((a, b) => a.path.localeCompare(b.path));
        setFiles(list);
      })
      .catch(() => {
        /* A failed tree load leaves the field with the stored value and the clear option. */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Until the tree arrives — or if it never does — the stored main file has no option of its own,
  // and a select whose value matches nothing renders as blank: the field would claim the project has
  // no main file when it has one, and saving would then clear it.
  const staged = value ?? '';
  const listed = files.some((file) => file.nodeId === staged);

  return (
    <div className="space-y-2">
      <Label htmlFor={MAIN_FILE_SELECT_ID}>Main file</Label>
      <p className="text-sm text-muted-foreground">
        The main file scopes cross-file resolution (include graph, symbols, diagnostics, and heading
        levels) for the whole project. Leave it unset to resolve each file on its own.
      </p>
      <select
        id={MAIN_FILE_SELECT_ID}
        value={staged}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
      >
        <option value="">Not set — resolve each file on its own</option>
        {staged !== '' && !listed && <option value={staged}>Current main file</option>}
        {files.map((file) => (
          <option key={file.nodeId} value={file.nodeId}>
            {file.path}
          </option>
        ))}
      </select>
    </div>
  );
}
