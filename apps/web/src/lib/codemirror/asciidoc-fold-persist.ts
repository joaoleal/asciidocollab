import { EditorView, ViewPlugin, type Command, type ViewUpdate } from '@codemirror/view';
import { foldAll, unfoldAll, foldEffect, foldedRanges } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { computeHeadingLevels, type HeadingLevelInfo } from './asciidoc-heading-levels';
import { foldRangeForSection } from './asciidoc-fold';

/**
 * Whole-document folding controls + persistence:
 * fold-all / unfold-all / fold-to-level, and fold state persisted per
 * `userId:projectId:fileId` (here, browser-scoped localStorage keyed by
 * project:file — localStorage is already per-user/per-browser) and restored on
 * reopen, reconciled against the current document (out-of-range folds dropped).
 */

/** A persisted folded range (document offsets). */
export interface SerializedFold {
  /** Start offset of a folded range. */
  from: number;
  /** End offset of a folded range. */
  to: number;
}

const STORAGE_PREFIX = 'asciidocollab:folds:';

/** Build the persistence key for a file's fold state. */
export function foldStorageKey(projectId: string, fileId: string): string {
  return `${STORAGE_PREFIX}${projectId}:${fileId}`;
}

/** Headings whose section should be folded for "fold to level N" (effective level ≥ N). */
export function headingsToFoldForLevel(headings: HeadingLevelInfo[], level: number): HeadingLevelInfo[] {
  return headings.filter((heading) => !heading.discrete && !heading.beyondMax && heading.effectiveLevel >= level);
}

function isSerializedFold(entry: unknown): entry is SerializedFold {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'from' in entry &&
    'to' in entry &&
    typeof entry.from === 'number' &&
    typeof entry.to === 'number'
  );
}

/** Parse persisted fold state, dropping malformed or out-of-range entries. */
export function parseFoldState(raw: string | null, documentLength: number): SerializedFold[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(isSerializedFold)
    .filter((fold) => fold.from >= 0 && fold.to <= documentLength && fold.from < fold.to);
}

/** Command: fold every section whose heading effective level is ≥ `level`. */
export function foldToLevel(level: number): Command {
  return (view: EditorView) => {
    const headings = computeHeadingLevels(view.state.doc.toString());
    const effects = [];
    for (const heading of headingsToFoldForLevel(headings, level)) {
      const range = foldRangeForSection(view.state, heading.from);
      if (range) effects.push(foldEffect.of(range));
    }
    if (effects.length === 0) return false;
    view.dispatch({ effects });
    return true;
  };
}

/**
 * The whole-document fold commands, by the action id the key bindings registry knows each one by.
 * See {@link formatCommands} for why these are commands rather than a keymap.
 */
export const foldCommands: Readonly<Record<string, Command>> = {
  'editor:fold-all': foldAll,
  'editor:unfold-all': unfoldAll,
  'editor:fold-level-1': foldToLevel(1),
  'editor:fold-level-2': foldToLevel(2),
};

/** Read the currently folded ranges from editor state. */
export function serializeFolds(view: EditorView): SerializedFold[] {
  const folds: SerializedFold[] = [];
  const ranges = foldedRanges(view.state);
  const iterator = ranges.iter();
  while (iterator.value !== null) {
    folds.push({ from: iterator.from, to: iterator.to });
    iterator.next();
  }
  return folds;
}

/**
 * Restores saved folds on mount and saves them on every fold change. Becomes a
 * no-op when `storageKey` is null, such as a file without a project context.
 */
export function foldPersistence(storageKey: string | null): Extension {
  if (!storageKey) return [];
  const key: string = storageKey;
  return ViewPlugin.fromClass(
    class {
      private saved = '';
      private restored = false;
      private restoring = false;

      constructor(view: EditorView) {
        // On the REST path the doc is present at mount; on the collab path it is
        // empty until the first sync, so defer the restore until content arrives
        // (otherwise parseFoldState drops every range as out-of-bounds).
        this.tryRestore(view);
      }

      private tryRestore(view: EditorView) {
        if (this.restored || this.restoring || view.state.doc.length === 0) return;
        const folds = parseFoldState(globalThis.localStorage?.getItem(key) ?? null, view.state.doc.length);
        if (folds.length === 0) {
          // Nothing to restore — baseline from the current (empty) fold set and start persisting.
          this.saved = JSON.stringify(serializeFolds(view));
          this.restored = true;
          return;
        }
        // Apply the saved folds in a microtask, but do NOT mark restored until they have
        // actually landed — otherwise an update() firing before the microtask (e.g. the
        // mount's cursor-restore dispatch) would serialize the still-empty fold set and
        // clobber storage with '[]'. `restoring` keeps update() from persisting meanwhile.
        this.restoring = true;
        queueMicrotask(() => {
          view.dispatch({ effects: folds.map((fold) => foldEffect.of(fold)) });
          this.saved = JSON.stringify(serializeFolds(view));
          this.restoring = false;
          this.restored = true;
        });
      }

      update(update: ViewUpdate) {
        if (!this.restored) {
          if (!this.restoring) this.tryRestore(update.view);
          return; // don't persist until the saved state has been restored
        }
        const current = JSON.stringify(serializeFolds(update.view));
        if (current !== this.saved) {
          this.saved = current;
          try {
            globalThis.localStorage?.setItem(key, current);
          } catch {
            /* Storage unavailable / quota exceeded — folds simply aren't persisted. */
          }
        }
      }
    },
  );
}
