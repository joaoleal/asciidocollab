'use client';

/**
 * Wires `HistoryPanel`'s `onSelectCommit` seam to `DiffView`: selecting a commit opens that
 * commit's diff, following the diff route's commit-vs-commit contract — `from` is the commit's
 * parent (`${commit.hash}^`), `to` is the commit hash itself. A first/rootless commit has no
 * parent, so that `^` may be invalid; `DiffView`'s own error state renders that refusal gracefully,
 * so this component does not need to special-case it.
 */
import { useState } from 'react';
import { HistoryPanel } from '@/components/git/history-panel';
import { DiffView } from '@/components/git/diff-view';
import type { CommitDto } from '@asciidocollab/shared';

/** Props for {@link HistoryPanelWithDiff} — the same surface `HistoryPanel` exposes, minus the `onSelectCommit` seam this component now owns. */
export interface HistoryPanelWithDiffProperties {
  /** The project whose connected repository's history is being viewed. */
  projectId: string;
  /** Whether the history panel is currently shown. */
  open: boolean;
  /**
   * Called whenever the history panel asks to open or close.
   *
   * @param open - True to show the panel, false to hide it.
   */
  onOpenChange: (open: boolean) => void;
  /** Project-relative path to scope the history to a single file. Omitted for the whole repository. */
  path?: string;
  /** Maximum number of commits to load. Omitted to use the server's default. */
  limit?: number;
}

/** Hosts `HistoryPanel` and the `DiffView` it opens when a commit row is selected. */
export function HistoryPanelWithDiff({ projectId, open, onOpenChange, path, limit }: HistoryPanelWithDiffProperties) {
  const [diffCommit, setDiffCommit] = useState<CommitDto | null>(null);

  return (
    <>
      <HistoryPanel
        projectId={projectId}
        open={open}
        onOpenChange={onOpenChange}
        path={path}
        limit={limit}
        onSelectCommit={setDiffCommit}
      />
      <DiffView
        projectId={projectId}
        open={diffCommit !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDiffCommit(null);
        }}
        from={diffCommit ? `${diffCommit.hash}^` : undefined}
        to={diffCommit?.hash}
      />
    </>
  );
}
