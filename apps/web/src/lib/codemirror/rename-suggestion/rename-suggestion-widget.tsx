import { WidgetType, type EditorView } from '@codemirror/view';
import type { StateEffect } from '@codemirror/state';
import type { SymbolKind } from './types';
import { applyRequestEffect, dismissRequestEffect, undoRequestEffect } from './rename-suggestion-effects';

/**
 * The inline rename-suggestion widget.
 *
 * A CodeMirror block widget rendered just below the renamed definition. It is plain DOM (not React)
 * so it can live inside the editor's decoration layer, and it is provided from a StateField (block
 * widgets may not come from a plugin). Buttons dispatch request effects through the view — the
 * plugin, which holds the API config, performs the async work. All colours come from design tokens
 * via the `cm-ad-rename-suggestion*` classes in `editor-themes.css` (Principle V, light/dark).
 */

/** The visible data driving the widget — everything that affects rendering, for `eq()` reuse. */
export interface RenameSuggestionWidgetData {
  /** The name being rewritten from. */
  oldName: string;
  /** The name being rewritten to. */
  newName: string;
  /** The kind of symbol being renamed. */
  kind: SymbolKind;
  /** Number of references/occurrences that would be rewritten. */
  usageCount: number;
  /** Number of files affected. */
  fileCount: number;
  /** New name collides with an existing same-kind symbol → apply blocked. */
  collision: boolean;
  /** The author just typed on to this name; usage/collision not yet re-confirmed → apply blocked. */
  revalidating: boolean;
  /** The rename has been applied → show the undo affordance. */
  applied: boolean;
}

/**
 * Compact impact summary kept short so the whole offer fits one line even with the file tree and
 * HTML preview open. References always show; the file count is omitted for the common single-file
 * case (it is just noise) and only appears when the rename spans more than one file.
 *
 * @param usageCount - Number of references that would be rewritten.
 * @param fileCount - Number of files affected.
 * @returns For example `1 ref`, `7 refs`, or `7 refs · 3 files`.
 */
const impact = (usageCount: number, fileCount: number): string => {
  const references = `${usageCount} ref${usageCount === 1 ? '' : 's'}`;
  return fileCount > 1 ? `${references} · ${fileCount} files` : references;
};

/** A monospaced, truncatable name chip; the full identifier stays in the title when it clips. */
const nameChip = (text: string, variant: 'old' | 'new'): HTMLElement => {
  const element = document.createElement('code');
  element.className = `cm-ad-rename-suggestion-name cm-ad-rename-suggestion-name-${variant}`;
  element.textContent = text;
  element.title = text;
  return element;
};

/** The `old → new` fragment shared by the offer and applied states. */
const renameFragment = (oldName: string, newName: string): Node[] => {
  const arrow = document.createElement('span');
  arrow.className = 'cm-ad-rename-suggestion-arrow';
  arrow.textContent = '→';
  arrow.setAttribute('aria-hidden', 'true');
  return [nameChip(oldName, 'old'), arrow, nameChip(newName, 'new')];
};

/** The block widget rendered below a renamed definition offering the project-wide refactor. */
export class RenameSuggestionWidget extends WidgetType {
  /**
   * @param data - The visible data driving the widget's rendering.
   */
  constructor(private readonly data: RenameSuggestionWidgetData) {
    super();
  }

  /** Two widgets are equal (and the DOM is reused) only when the visible data matches. */
  eq(other: RenameSuggestionWidget): boolean {
    const a = this.data;
    const b = other.data;
    return (
      a.oldName === b.oldName &&
      a.newName === b.newName &&
      a.kind === b.kind &&
      a.usageCount === b.usageCount &&
      a.fileCount === b.fileCount &&
      a.collision === b.collision &&
      a.revalidating === b.revalidating &&
      a.applied === b.applied
    );
  }

  /**
   * Build the widget DOM for the current state (offer, collision, or applied/undo).
   *
   * @param view - The editor view, used to dispatch button request effects.
   * @returns The widget's root element.
   */
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div');
    root.className = 'cm-ad-rename-suggestion';
    root.dataset.testid = 'rename-suggestion';
    root.dataset.collision = String(this.data.collision);
    root.setAttribute('role', 'status');

    const message = document.createElement('span');
    message.className = 'cm-ad-rename-suggestion-msg';

    const button = (
      label: string,
      testid: string,
      variant: string,
      effect: StateEffect<null>,
      options: { disabled?: boolean; title?: string } = {},
    ): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `cm-ad-rename-suggestion-btn cm-ad-rename-suggestion-btn-${variant}`;
      b.dataset.testid = testid;
      b.textContent = label;
      b.disabled = options.disabled ?? false;
      if (options.title) b.title = options.title;
      b.addEventListener('click', (event) => {
        event.preventDefault();
        if (b.disabled) return;
        view.dispatch({ effects: effect });
      });
      return b;
    };

    if (this.data.applied) {
      message.append('Renamed ', ...renameFragment(this.data.oldName, this.data.newName));
      root.append(message);
      // A section heading's rename is not reversible by the tool: it never retyped the heading, so an
      // undo would rewrite references back to an id no heading carries (a dangling reference). Offer
      // Undo only for anchors/attributes, whose definition the rewrite genuinely restores.
      if (this.data.kind !== 'heading') {
        root.append(button('Undo', 'rename-suggestion-undo', 'primary', undoRequestEffect.of(null)));
      }
      root.append(button('Dismiss', 'rename-suggestion-dismiss', 'ghost', dismissRequestEffect.of(null)));
      return root;
    }

    if (this.data.collision) {
      message.append(nameChip(this.data.newName, 'new'), ' already exists');
      root.append(message, button('Dismiss', 'rename-suggestion-dismiss', 'ghost', dismissRequestEffect.of(null)));
      return root;
    }

    const meta = document.createElement('span');
    meta.className = 'cm-ad-rename-suggestion-meta';
    // While revalidating, the name just changed and its impact/collision is still being re-confirmed;
    // show the invariant reference count but signal that Apply is momentarily unavailable.
    meta.textContent = this.data.revalidating ? 'checking…' : impact(this.data.usageCount, this.data.fileCount);
    message.append('Rename ', ...renameFragment(this.data.oldName, this.data.newName), meta);
    root.append(
      message,
      button('Apply', 'rename-suggestion-apply', 'primary', applyRequestEffect.of(null), {
        disabled: this.data.revalidating,
        title: this.data.revalidating ? 'Checking references…' : undefined,
      }),
      button('Dismiss', 'rename-suggestion-dismiss', 'ghost', dismissRequestEffect.of(null)),
    );
    return root;
  }

  /** Buttons manage their own clicks; keep other DOM events from bubbling into the editor. */
  ignoreEvent(_event: Event): boolean {
    return true;
  }
}
