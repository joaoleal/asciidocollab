import {
  ViewPlugin,
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, StateEffect } from '@codemirror/state';
import { resolveAttributeReferences } from '@asciidocollab/asciidoc-core';

/**
 * `{attr}` collapse-to-value. Renders a resolved attribute
 * reference (`{version}`) as its value via a **replace decoration** — the
 * document text is never changed (Constitution VII). Resolution is delegated to
 * {@link resolveAttributeReferences}, the centralized document-order attribute
 * authority, so references resolve against attributes defined *earlier* in the
 * document (line-aware, like Asciidoctor), seeded with the attributes the open
 * file inherits from the documents that include it; verbatim blocks are skipped
 * and unknown/forward references are left as-is. Names are case-insensitive.
 */

// Inline attribute assignment `{set:name:value}` / `{set:name!}`. Group 1 is the name, group 2 the
// value (undefined for an unset). The single source of this grammar for the editor's CodeMirror layer
// (e.g. the rename detector); the resolution itself lives in the centralized extraction authority.
export const INLINE_SET_RE = /\{set:([A-Za-z0-9][\w-]*)(?:!|:((?:(?!\{set:)[^}])*))\}/g;
const NO_INHERITED_ATTRIBUTES: ReadonlyMap<string, string> = new Map();

/**
 * Dispatch this effect to recompute the collapsed `{attr}` values when nothing in the document
 * changed — such as when the project symbol index resolves new inherited attributes from a parent
 * file (an async load, or a main-file reconfiguration), so cross-document references collapse once
 * their values become available.
 */
export const refreshAttributeFoldEffect = StateEffect.define<void>();

/** A `{attr}` reference and the value it collapses to for display. */
export interface AttributeReplacement {
  /** Document offset of the `{`. */
  from: number;
  /** Document offset just past the `}`. */
  to: number;
  /** Resolved attribute value to display. */
  value: string;
}

/**
 * Compute the collapse-to-value replacements for a document: every `{name}` reference whose
 * attribute is in scope — defined on an earlier line, or inherited from a parent (including)
 * document. Delegates to {@link resolveAttributeReferences} (the centralized, line-aware
 * document-order attribute authority) so folding matches scope resolution exactly and never
 * re-implements attribute parsing — a reference inside a verbatim block or defined only later stays
 * uncollapsed, and an in-file definition/unset overrides the inherited value from its line onward.
 *
 * @param documentText - The open file's full text.
 * @param inherited - Attributes inherited from the documents that include this file; these seed the
 *   in-scope set so cross-document references collapse. Defaults to none.
 * @returns The replacements, each with the raw reference's offsets and its resolved value.
 */
export function computeAttributeReplacements(
  documentText: string,
  inherited: ReadonlyMap<string, string> = NO_INHERITED_ATTRIBUTES,
): AttributeReplacement[] {
  return resolveAttributeReferences(documentText, inherited);
}

class AttributeValueWidget extends WidgetType {
  constructor(private readonly value: string) {
    super();
  }

  eq(other: AttributeValueWidget): boolean {
    return other.value === this.value;
  }

  /**
   * Let the editor handle events that occur on the widget. The base widget ignores them by default,
   * which makes CodeMirror discard a selection change landing inside the widget — so a mouse click
   * would never move the cursor onto the collapsed reference and never reveal its raw source (only
   * arrow-key movement, handled by the keymap, would). Returning false lets a click place the cursor
   * on the reference, which {@link buildDecorations} then reveals.
   */
  ignoreEvent(): boolean {
    return false;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-ad-attr-value';
    span.textContent = this.value;
    span.title = 'Resolved attribute value (source unchanged)';
    return span;
  }
}

function buildDecorations(view: EditorView, getInheritedAttributes: () => ReadonlyMap<string, string>): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { from: selectionFrom, to: selectionTo } = view.state.selection.main;
  for (const replacement of computeAttributeReplacements(view.state.doc.toString(), getInheritedAttributes())) {
    // Reveal the raw reference when the selection/cursor overlaps it, so editing works.
    if (selectionFrom <= replacement.to && selectionTo >= replacement.from) continue;
    builder.add(
      replacement.from,
      replacement.to,
      Decoration.replace({ widget: new AttributeValueWidget(replacement.value) }),
    );
  }
  return builder.finish();
}

/**
 * CM6 extension rendering resolved `{attr}` references as their value (display only). The accessor
 * supplies the attributes the open file inherits from the documents that include it, so a reference
 * to a cross-document attribute collapses too; it is read lazily so a {@link
 * refreshAttributeFoldEffect} re-evaluates once the symbol index resolves those values.
 *
 * @param getInheritedAttributes - Returns the open file's inherited attribute map (default none).
 * @returns The attribute collapse-to-value view plugin.
 */
export function asciidocAttributeFold(
  getInheritedAttributes: () => ReadonlyMap<string, string> = () => NO_INHERITED_ATTRIBUTES,
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, getInheritedAttributes);
      }

      update(update: ViewUpdate) {
        const refreshed = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(refreshAttributeFoldEffect)),
        );
        if (update.docChanged || update.selectionSet || update.viewportChanged || refreshed) {
          this.decorations = buildDecorations(update.view, getInheritedAttributes);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
