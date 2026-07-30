/**
 * The wire protocol between the AsciiDoc render worker and its main-thread callers.
 *
 * This lived twice — once in `asciidoc-render.worker.ts` and once in `use-asciidoc-preview.ts` — and
 * the two copies drifted: the worker has been sending `details` for some time while the hook's copy
 * never declared it, so a consumer reading it had to widen the type at the call site to see a field
 * that was already on the wire. One declaration, imported by both ends, is what stops that recurring.
 *
 * It lives beside the worker rather than in `packages/shared` deliberately. `packages/shared` is for
 * DTOs that cross *package* boundaries; this shape crosses a worker↔main-thread boundary inside a
 * single app, and no package consumes it. Promoting it would widen its blast radius for no gain and
 * would put a browser-only shape somewhere the domain can see.
 */

/** One render asked of the worker. */
export interface RenderRequest {
  /** Monotonic id echoed back on the result, so a superseded render can be discarded on arrival. */
  requestId: number;
  /** The AsciiDoc source to render, used as-is unless {@link RenderRequest.mainPath} assembles a tree. */
  content: string;
  /** Base path Asciidoctor prepends to relative image targets (the project's image endpoint). */
  imagesDir?: string;
  /**
   * When set together with {@link RenderRequest.files}, the worker assembles the include tree rooted
   * at this project-relative main-file path (sandbox-confined via `resolveSandboxedPath`) and
   * renders the assembled document instead of `content`. Absent ⇒ render `content` as-is.
   */
  mainPath?: string;
  /** Project-relative path → content map supplying the include assembly. */
  files?: Record<string, string>;
  /**
   * Project main-file path (root) for cross-document attribute resolution. The open
   * file's `{name}` references resolve to the value in effect at its first include-point under this
   * root. `null`/absent ⇒ standalone resolution (the file's own attributes only).
   */
  rootFileId?: string | null;
  /** The previewed open file's path — the scope whose inherited attributes are seeded. */
  openFileId?: string;
  /** When false (default), the assembler hides included bodies and emits placeholders. */
  showIncludes?: boolean;
  /**
   * Project-level render-config attributes (already soft-defaulted with a trailing `@`). Seeded FIRST
   * so the document's inherited scope and its own header both override them, and so the host render
   * controls (`imagesdir`) still win.
   */
  projectAttributes?: Record<string, string>;
  /**
   * Whether to emit the editor's scroll-sync hints: `data-source-line` beside every block's id, and a
   * synthetic `__src_<context>_<line>` id on the blocks that have none so there is an id to sit beside.
   *
   * On (the default) for the preview, which navigates by them. Off for an export, whose output is read
   * by people and other tools rather than by this app: the hints are dead weight there, and the
   * synthetic ids put app-internal names into the published id namespace beside the author's own
   * anchors. Turning them off is a choice not to generate them, not a pass that strips them afterwards
   * — nothing has to distinguish a synthetic id from a real one after the fact, and the export skips
   * both whole-document rewrites instead of paying for a third.
   */
  sourceLineHints?: boolean;
}

/** The resolved document-header values a standalone render needs; every part is optional. */
export interface RenderDocumentDetails {
  /** The document title (`doctitle`). */
  title?: string;
  /** The author line (`author`, or the joined `authors` when there are several). */
  author?: string;
  /** The revision number (`revnumber`). */
  revnumber?: string;
  /** The revision date (`revdate`). */
  revdate?: string;
  /** The resolved document language (`lang`). */
  lang?: string;
}

/**
 * What one render cost, broken down by stage, in milliseconds. Every value is ≥ 0.
 *
 * The three stages do not have to add up to {@link RenderTimings.totalMs}: the include assembly and
 * the pre-conversion block walk sit between them and belong to neither. The remainder is therefore a
 * real figure about the render, not a rounding error — reading `totalMs` as the sum of the parts
 * would understate what a render costs.
 */
export interface RenderTimings {
  /** Time inside `load()` — parsing the assembled source into a document. */
  readonly parseMs: number;
  /** Time inside `convert()` — producing HTML from the parsed document. */
  readonly convertMs: number;
  /**
   * Time in the worker's own whole-document passes after conversion: the header reads, the diagram
   * placeholder swap, the image-source rewrite, syntax highlighting and the source-line injection.
   */
  readonly postProcessMs: number;
  /** Time for the whole handler, from the message arriving to the reply being posted. */
  readonly totalMs: number;
}

/** What the worker replies with for one {@link RenderRequest}. */
export interface RenderResult {
  /** The {@link RenderRequest.requestId} this result answers; anything but the latest is stale. */
  requestId: number;
  /** Whether the render completed. `false` carries {@link RenderResult.error} and no `html`. */
  ok: boolean;
  /** The converted (unsanitised) HTML on success; `null` on failure. */
  html: string | null;
  /** The failure message when `ok` is `false`; `null` otherwise. */
  error: string | null;
  /**
   * True when the rendered document contains STEM (math) output that is in effect, meaning the
   * resolved `:stem:` attribute is set AND Asciidoctor emitted stem markup carrying its delimiters.
   * The worker never renders math itself (client-side); this flag lets the
   * preview lazy-load MathJax only when there is math to typeset. Absent/`false` means no MathJax
   * load, so stem delimiters written where `:stem:` is not in effect stay as literal text.
   */
  mathPresent?: boolean;
  /**
   * True when the rendered document carries at least one native-diagram placeholder
   * (`<div class="adc-diagram">`). The worker never renders diagrams itself; this flag gates the main
   * thread's lazy import of the on-screen diagram engines. Absent/`false` ⇒ no engine import.
   */
  diagramsPresent?: boolean;
  /**
   * The document header as Asciidoctor resolved it, for consumers that render OUTSIDE the app's own
   * chrome. Embedded output carries the title (via `showtitle`) but never the author/revision line,
   * because on screen the app already says whose document this is — a file saved to disk does not.
   * Reported here rather than re-derived on the main thread: authors, revision lines and `lang` follow
   * AsciiDoc's own header grammar, and the document that just parsed them is the authority on them.
   */
  details?: RenderDocumentDetails;
  /**
   * What this render cost, by stage. Present on every successful render, in every build — the
   * adaptive refresh delay consumes it in production, and only its *display* is development-only.
   *
   * Absent when `ok` is `false`: a render that threw part-way has no stage breakdown to report, and
   * zeros would read as "this document renders instantly" to anything deriving a delay from it.
   */
  timings?: RenderTimings;
}
