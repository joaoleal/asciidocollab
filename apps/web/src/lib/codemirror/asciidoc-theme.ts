/**
 * AsciiDoCollab CodeMirror 6 editor theme covering both the editor chrome and
 * the syntax highlighting. Colours are read from CSS variables in globals.css,
 * so the editor follows the app's light and dark themes automatically with no
 * JavaScript switching.
 */
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { ad } from "./asciidoc-highlight-tags";

/** Builds an `hsl(var(--name))` colour string, optionally with an alpha value. */
const c = (name: string, alpha?: number) =>
  alpha === undefined ? `hsl(var(${name}))` : `hsl(var(${name}) / ${alpha})`;

/** Chrome: editor surface, gutters, cursor, selection, active line. */
export const asciidocEditorTheme = EditorView.theme({
  "&": {
    color: c("--foreground"),
    backgroundColor: c("--background"),
  },
  ".cm-content": {
    fontFamily:
      "var(--font-mono, 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace)",
    caretColor: c("--primary"),
    padding: "8px 0",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: c("--primary"), borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: c("--primary", 0.18),
  },
  ".cm-selectionMatch": { backgroundColor: c("--primary", 0.16) },
  ".cm-gutters": {
    backgroundColor: c("--background"),
    color: c("--markup"),
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: c("--accent", 0.45) },
  ".cm-activeLineGutter": { backgroundColor: c("--accent", 0.55), color: c("--foreground") },
  ".cm-foldPlaceholder": {
    backgroundColor: c("--muted"),
    color: c("--muted-foreground"),
    border: "none",
    padding: "0 6px",
    borderRadius: "4px",
  },
  // Combined line-number + fold gutter: a right-aligned line number with a reserved fold slot to its
  // right. The fold chevron is always shown on foldable/folded lines (so folding stays discoverable),
  // and the slot is empty on other lines — folding needs no separate gutter column.
  ".cm-lnfold-gutter .cm-gutterElement": { padding: "0" },
  ".cm-lnfold": {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    width: "100%",
    padding: "0 15px 0 6px",
  },
  ".cm-fold-marker": { display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
  ".cm-fold-marker svg": { width: "10px", height: "10px" },
  ".cm-lnfold-chev": {
    position: "absolute",
    right: "2px",
    top: "0",
    bottom: "0",
    width: "12px",
    color: c("--markup"),
  },
  // Spellcheck / diagnostics gutter: replace the library's triangle with a slim severity dot and
  // tighten the column to 12px (was 1.4em). Warnings keep their own column, always visible and
  // independent of the comment mark. Scoped under .cm-gutter-lint so these win over the library's
  // default marker theme regardless of extension order.
  ".cm-gutter-lint": { width: "12px" },
  ".cm-gutter-lint .cm-gutterElement": {
    padding: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  ".cm-gutter-lint .cm-lint-marker": { width: "6px", height: "6px", borderRadius: "50%" },
  ".cm-gutter-lint .cm-lint-marker-warning": { content: "normal", backgroundColor: c("--warning") },
  ".cm-gutter-lint .cm-lint-marker-error": { content: "normal", backgroundColor: c("--destructive") },
  ".cm-gutter-lint .cm-lint-marker-info": { content: "normal", backgroundColor: c("--muted-foreground") },
  // On-device grammar checker: colour each writing-issue category's underline from its design token
  // (Principle V — no colour literals). The mark class is added by `lintToDiagnostic`; overriding the
  // library's default severity wavy keeps spelling/grammar/style visually distinct at a glance.
  ".cm-lintRange.cm-grammar-spelling": {
    backgroundImage: "none",
    textDecoration: `underline wavy ${c("--syntax-grammar-spelling")}`,
    textDecorationSkipInk: "none",
  },
  ".cm-lintRange.cm-grammar-grammar": {
    backgroundImage: "none",
    textDecoration: `underline wavy ${c("--syntax-grammar-grammar")}`,
    textDecorationSkipInk: "none",
  },
  ".cm-lintRange.cm-grammar-style": {
    backgroundImage: "none",
    textDecoration: `underline wavy ${c("--syntax-grammar-style")}`,
    textDecorationSkipInk: "none",
  },
  ".cm-tooltip": {
    backgroundColor: c("--popover"),
    color: c("--popover-foreground"),
    border: `1px solid ${c("--border")}`,
    borderRadius: "6px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: c("--accent"),
    color: c("--accent-foreground"),
  },
  // Effective heading-level styling — sizes a heading line by its effective level.
  // Headings are ALWAYS bold (700) across every level so depth reads by size + colour, not weight.
  ".cm-ad-h0": { fontSize: "1.6em", fontWeight: "700" },
  ".cm-ad-h1": { fontSize: "1.45em", fontWeight: "700" },
  ".cm-ad-h2": { fontSize: "1.3em", fontWeight: "700" },
  ".cm-ad-h3": { fontSize: "1.17em", fontWeight: "700" },
  ".cm-ad-h4": { fontSize: "1.08em", fontWeight: "700" },
  ".cm-ad-h5": { fontSize: "1em", fontWeight: "700" },
  // Discrete/float headings
  ".cm-ad-discrete": { fontStyle: "italic", color: c("--syntax-keyword") },
  // Heading `=` marker run recedes to muted markup color and normal weight. The
  // grammar wraps the `=` in an INNER highlight span carrying the heading colour, so the rule must
  // target that child span too (`, … span`) with `!important` to win — exactly as the
  // suppressed-heading rule below does. Without the child selector the `=` reads in the heading colour.
  ".cm-ad-heading-marker, .cm-ad-heading-marker span": { color: `${c("--markup")} !important`, fontWeight: "400 !important" },
  // Leading `.` of a block title recedes to muted markup so the title text leads (parity).
  // Same inner-span override as the heading marker (the `.` is wrapped in a block-title highlight span).
  ".cm-ad-block-title-marker, .cm-ad-block-title-marker span": { color: `${c("--markup")} !important`, fontWeight: "400 !important" },
  // Table cell separators (`|`) recede; header-row cells go bold (table structure). The sep
  // colour overrides the table body's content-fill inner span via the child selector + `!important`.
  ".cm-ad-table-sep, .cm-ad-table-sep span": { color: `${c("--markup")} !important` },
  ".cm-ad-table-header-cell": { fontWeight: "700" },
  // Inline stem: bold the `stem:` prefix, scope the violet math chip to the `[…]` formula (proposal §10).
  ".cm-ad-stem-prefix": { fontWeight: "700" },
  ".cm-ad-stem-body": { backgroundColor: c("--syntax-keyword", 0.12), borderRadius: "3px", padding: "0 2px" },
  // Suppressed headings (exceed max level)
  ".cm-ad-suppressed-heading, .cm-ad-suppressed-heading span": {
    color: `${c("--foreground")} !important`,
    fontWeight: "400 !important",
    fontSize: "1em !important",
  },
  // Collapsed {attr} reference rendered as its resolved value.
  ".cm-ad-attr-value": {
    color: c("--syntax-attr"),
    borderBottom: `1px dotted ${c("--syntax-attr")}`,
  },
  // Known cross-document attribute reference
  ".cm-ad-attr-known": {
    color: c("--syntax-attr"),
    textDecoration: `underline dotted ${c("--syntax-attr")}`,
    textUnderlineOffset: "2px",
  },
  // Inactive conditional branch
  ".cm-ad-conditional-dimmed": { opacity: "0.45" },
  // ── Review comments (feature 038) ─────────────────────────────────────────
  // Resting: a subtle dotted underline over an anchored passage. Active: a stronger tinted
  // background + solid underline for the two-way editor↔rail hover linkage. Both read in light
  // and dark automatically via the theme-aware `--primary` token.
  ".cm-review-highlight": {
    textDecoration: "underline",
    textDecorationStyle: "dotted",
    textDecorationColor: c("--primary", 0.6),
    textUnderlineOffset: "3px",
  },
  ".cm-review-highlight-active": {
    backgroundColor: c("--primary", 0.16),
    textDecoration: "underline",
    textDecorationColor: c("--primary"),
    textUnderlineOffset: "3px",
  },
  // One-shot pulse when the user navigates to a passage (scroll-into-view). The keyframes ramp a
  // stronger primary wash down to the resting state, drawing the eye to where the editor jumped.
  ".cm-review-flash": {
    borderRadius: "2px",
    animation: "cm-review-flash-kf 0.7s ease-out",
  },
  "@keyframes cm-review-flash-kf": {
    "0%": { backgroundColor: c("--primary", 0.45) },
    "60%": { backgroundColor: c("--primary", 0.3) },
    "100%": { backgroundColor: c("--primary", 0.16) },
  },
  // Honour reduced-motion: skip the pulse animation (the active emphasis still marks the passage).
  "@media (prefers-reduced-motion: reduce)": {
    ".cm-review-flash": { animation: "none" },
  },
  // Review gutter: collapses to zero width until it carries content (an existing-thread dot or the
  // per-line "add comment" affordance), so it stays inert on documents without review commenting.
  ".cm-review-gutter": { width: "0", position: "relative" },
  ".cm-review-gutter:has(.cm-review-gutter-marker)": { width: "12px" },
  ".cm-review-gutter:has(.cm-review-add-comment)": { width: "12px" },
  ".cm-review-gutter .cm-gutterElement": { position: "relative" },
  // Existing-thread dot, centred in the gutter cell.
  ".cm-review-gutter-marker::before": {
    content: '""',
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: "5px",
    height: "5px",
    borderRadius: "50%",
    backgroundColor: c("--primary"),
  },
  // "Add comment" affordance: fills the gutter cell as the click target; the "+" glyph is hidden until
  // the line's gutter is hovered or the line overlaps a selection. Replaces the old floating over-text
  // "Comment" button (feature 038) so ordinary selections no longer summon a button over the text.
  ".cm-review-add-comment": {
    position: "absolute",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    opacity: "0",
    // Resting (hidden) affordance must not intercept clicks — otherwise clicking an existing-thread
    // dot lands on this invisible cell-filling element and starts a new comment. Re-enabled only when
    // it is actually revealed (the line overlaps a selection), below.
    pointerEvents: "none",
  },
  // Filled chip: a solid rounded square in the identity colour with a light icon, so the affordance
  // reads as a deliberate button rather than a thin floating outline.
  ".cm-review-add-comment-chip": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "11px",
    height: "11px",
    borderRadius: "3px",
    backgroundColor: c("--primary"),
    color: c("--primary-foreground"),
  },
  ".cm-review-add-comment svg": { width: "8px", height: "8px" },
  // The add-comment "+" reveals only while the line overlaps a non-empty selection — not on hover — so
  // it appears exactly when there is selected text to comment on.
  ".cm-review-gutter-selected .cm-review-add-comment": { opacity: "1", pointerEvents: "auto" },
  // Hide the resting existing-thread dot while the "+" is showing so the two don't overlap in one cell.
  ".cm-review-gutter-selected .cm-review-gutter-marker::before": { opacity: "0" },
  "&.cm-focused": { outline: "none" },
}, { dark: false });

/** Token colours — AsciiDoc markup + fenced source blocks. */
export const asciidocHighlightStyle = HighlightStyle.define([
  // ── Headings: four-level ramp (deep→light), NO underline, ALWAYS bold ─────
  // `textDecoration: none` is load-bearing: the shared `defaultHighlightStyle` (mounted in
  // editor-extensions for embedded source blocks) underlines every heading, and this style — at
  // Prec.highest, so its CSS wins on the same span — must explicitly clear it or the underline leaks.
  { tag: t.heading1, color: c("--syntax-heading"), fontWeight: "700", textDecoration: "none" },
  { tag: t.heading2, color: c("--syntax-h1"),      fontWeight: "700", textDecoration: "none" },
  { tag: t.heading3, color: c("--syntax-h2"),      fontWeight: "700", textDecoration: "none" },
  { tag: [t.heading4, t.heading5, t.heading6], color: c("--syntax-h3"), fontWeight: "700", textDecoration: "none" },

  // ── Scaffold / muted markup ───────────────────────────────────────────────
  { tag: ad.markup, color: c("--markup") },
  { tag: [t.punctuation, t.separator, t.operator, t.bracket, t.character, t.escape, t.contentSeparator],
    color: c("--markup") },

  // ── Bold / italic / monospace content (delimiters handled by ad.markup) ──
  { tag: t.strong,    color: c("--foreground"), fontWeight: "700" },
  { tag: t.emphasis,  color: c("--foreground"), fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  // Inline code chip: fg on bg
  { tag: t.monospace, color: c("--syntax-code-fg"), backgroundColor: c("--syntax-code-bg"),
    borderRadius: "3px", padding: "0 2px" },

  // ── Links / macros / cross-references ────────────────────────────────────
  { tag: [t.link, t.url], color: c("--syntax-link"), textDecoration: "underline" },
  { tag: ad.xrefLabel, color: c("--foreground") },

  // ── Document attributes & block metadata ─────────────────────────────────
  { tag: [t.meta, t.attributeName, t.docComment, t.macroName], color: c("--syntax-attr") },
  // Block title text reads as a foreground caption (italic); its leading `.` recedes via the
  // cm-ad-block-title-marker decoration so the words lead, not the marker.
  { tag: ad.blockTitle, color: c("--foreground"), fontStyle: "italic", fontWeight: "600" },

  // ── Admonition severity label chips ──────────────────────────────────────
  { tag: ad.admonNote,      color: c("--admon-note-fg"),      backgroundColor: c("--admon-note-bg"),      borderRadius: "3px", padding: "0 3px" },
  { tag: ad.admonTip,       color: c("--admon-tip-fg"),       backgroundColor: c("--admon-tip-bg"),       borderRadius: "3px", padding: "0 3px" },
  { tag: ad.admonWarning,   color: c("--admon-warning-fg"),   backgroundColor: c("--admon-warning-bg"),   borderRadius: "3px", padding: "0 3px" },
  { tag: ad.admonImportant, color: c("--admon-important-fg"), backgroundColor: c("--admon-important-bg"), borderRadius: "3px", padding: "0 3px" },
  { tag: ad.admonCaution,   color: c("--admon-caution-fg"),   backgroundColor: c("--admon-caution-bg"),   borderRadius: "3px", padding: "0 3px" },

  // ── Description list term ─────────────────────────────────────────────────
  { tag: ad.descTerm, color: c("--foreground"), fontWeight: "700" },

  // ── Checklist done / todo ─────────────────────────────────────────────────
  // Both box markers (`[x]` / `[ ]`) are bold so the task state reads at a glance (proposal §11).
  { tag: ad.checkDone, color: c("--syntax-string"), fontWeight: "700" },
  { tag: ad.checkTodo, color: c("--markup"), fontWeight: "700" },

  // ── Attribute references (`{name}`) ───────────────────────────────────────
  { tag: ad.attrRef, color: c("--attrref") },

  // ── Callout markers ───────────────────────────────────────────────────────
  { tag: ad.callout, color: c("--syntax-callout") },

  // ── Stem / math ──────────────────────────────────────────────────────────
  // Math is violet with a subtle tinted chip (proposal §10 tk-math). The block stem body carries the
  // chip directly via this tag. Inline `stem:[…]` only gets the violet colour here; the block-
  // decorations layer bolds the `stem:` prefix and scopes the chip to the `[…]` formula.
  { tag: ad.stem, color: c("--syntax-keyword"), backgroundColor: c("--syntax-keyword", 0.12),
    borderRadius: "3px", padding: "0 2px" },
  { tag: ad.inlineStem, color: c("--syntax-keyword") },

  // ── Document header metadata (author/revision) ───────────────────────────
  { tag: ad.docInfo, color: c("--syntax-attr"), fontStyle: "italic" },

  // ── Diagram block declaration (`[mermaid]`, `[graphviz]`, …) ───────────────
  // A distinct chip so "this block renders to an image" reads differently from a generic
  // `[source,ruby]` block-attribute line (amber `t.meta`): a bold callout-hued label.
  { tag: ad.diagramDecl, color: c("--syntax-callout"), backgroundColor: c("--syntax-callout", 0.12),
    borderRadius: "3px", padding: "0 2px", fontWeight: "600" },

  // Table header-row cells are bolded by the `cm-ad-table-header-cell` decoration
  // (asciidoc-block-decorations.ts), not a grammar tag — the header row is detected at the
  // decoration layer, so there is no `TableHeader` node for a tag to target.

  // ── Body content / verbatim blocks ───────────────────────────────────────
  { tag: t.content, color: c("--foreground") },

  // ── Structural keywords (conditionals) ────────────────────────────────────
  { tag: t.keyword, color: c("--syntax-keyword"), fontWeight: "600" },
  { tag: t.labelName, color: c("--syntax-keyword") },
  { tag: t.processingInstruction, color: c("--syntax-keyword") },

  // ── Monospace / strings inside source blocks ──────────────────────────────
  { tag: [t.string, t.attributeValue, t.special(t.string)], color: c("--syntax-string") },
  { tag: [t.number, t.bool, t.atom], color: c("--syntax-attr") },
  { tag: [t.function(t.variableName), t.definition(t.variableName)], color: c("--syntax-link") },
  { tag: [t.typeName, t.className], color: c("--syntax-keyword") },

  // ── Comments ─────────────────────────────────────────────────────────────
  { tag: [t.comment, t.lineComment, t.blockComment], color: c("--syntax-comment"), fontStyle: "italic" },

  // ── Misc ─────────────────────────────────────────────────────────────────
  { tag: t.invalid, color: c("--destructive") },
]);

/** Combined extension — add this to your editor's extensions array. */
export const asciidocTheme = [
  asciidocEditorTheme,
  syntaxHighlighting(asciidocHighlightStyle),
];

export default asciidocTheme;
