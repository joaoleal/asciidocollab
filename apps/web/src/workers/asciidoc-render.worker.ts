import { load as loadAsciidoc } from 'asciidoctor';
import hljs from 'highlight.js/lib/common';
import { assembleIncludes } from './assemble-includes';
import { resolveAttributeScope, effectiveLevelOffset } from '@asciidocollab/asciidoc-core';
import { RENDER_INTRINSIC_ATTRIBUTES } from '../lib/asciidoc/render-intrinsics';
import { resolveSandboxedPath } from '../lib/asciidoc/sandbox-path';
import { blockStartLine } from '../lib/asciidoc/block-start-line';
import type { RenderRequest, RenderResult, RenderDocumentDetails, RenderTimings } from './render-protocol';
import { SYNTHETIC_BLOCK_ID_PREFIX, SYNTHETIC_DIAGRAM_ID_PREFIX } from './render-protocol';

// Asciidoctor convention: a value ending in `@` is an overridable "soft" default — an in-document
// attribute entry of the same name may still override it. We mark every seeded inherited-scope value
// this way so a file's own definitions win, matching the resolution model's precedence.
const SOFT_DEFAULT_SUFFIX = '@';

/**
 * Build the attribute state in effect at the START of the assembled document — the intrinsics
 * Asciidoctor injects ({@link RENDER_INTRINSIC_ATTRIBUTES}) plus the API attributes the worker passes
 * to `load()` — so the include assembler's conditional gating and include-target `{attr}` substitution
 * match what Asciidoctor will resolve (Finding#1). The API attributes carry the overridable soft-default
 * `@` suffix; the assembler gives in-document entries document-order precedence over seeds on its own,
 * so the marker is stripped to recover the raw value (appending then stripping one `@` is an exact
 * round-trip).
 *
 * @param apiAttributes - The attribute object handed to `proc.load` (`showtitle`/`imagesdir`/scope).
 * @returns The seed map for {@link assembleIncludes}.
 */
function buildAssemblerSeed(apiAttributes: Record<string, string>): Map<string, string> {
  const seed = new Map(RENDER_INTRINSIC_ATTRIBUTES);
  for (const [name, value] of Object.entries(apiAttributes)) {
    seed.set(name, value.endsWith(SOFT_DEFAULT_SUFFIX) ? value.slice(0, -SOFT_DEFAULT_SUFFIX.length) : value);
  }
  return seed;
}

/**
 * Build the resolved inherited attribute scope for the open file, anchored to the project main file,
 * as Asciidoctor seed attributes. Each value is marked as an overridable soft-default (trailing `@`)
 * so an in-document entry can still override it. Returns an empty object when there is no root
 * (standalone) or the inputs are missing — in which case rendering falls back to current behavior.
 *
 * File ids here are project-relative paths: `readContent` reads from the `files` map and
 * `resolveInclude` confines every (user-controlled) target through {@link resolveSandboxedPath}
 * (Constitution IX) and only resolves to a path actually present in the snapshot.
 */
function seedAttributesFromScope(
  rootFileId: string | null | undefined,
  openFileId: string | undefined,
  files: Record<string, string> | undefined,
): { attributes: Record<string, string>; baseOffset: number } {
  if (rootFileId === undefined || rootFileId === null || openFileId === undefined || files === undefined) {
    return { attributes: {}, baseOffset: 0 };
  }
  const readContent = (path: string): string | null => files[path] ?? null;
  const resolveInclude = (from: string, target: string): string | null => {
    const resolved = resolveSandboxedPath(from, target);
    return resolved.ok && files[resolved.path] !== undefined ? resolved.path : null;
  };
  // Seed the render intrinsics into the GATING scope so a conditional include resolves the same way
  // the assembler gates it (e.g. `ifdef::backend-html5[]` active) — the inherited values themselves
  // are unaffected by the seed (#4).
  const scope = resolveAttributeScope({ rootFileId, fileId: openFileId, readContent, resolveInclude, seedAttributes: RENDER_INTRINSIC_ATTRIBUTES });
  // The root file's own header attributes are parsed by Asciidoctor from the rendered source, so only
  // a genuinely inherited scope needs seeding. Seed nothing for the root (origin 'root') / standalone.
  if (scope.origin !== 'inherited') return { attributes: {}, baseOffset: 0 };
  const seeded: Record<string, string> = {};
  // `leveloffset` is NOT part of `scope.values` (it is engine-reserved — stripped at the value
  // boundary): the resolved scope holds a file's END-of-document attribute state, but `:leveloffset:`
  // is position-dependent and cumulative, so its end value (e.g. a trailing `:leveloffset: +10`) is
  // meaningless — and disastrous — as a GLOBAL document attribute (it would shift every section from
  // the start of the render, pushing them past h6 so no headings render). Seed instead the offset in
  // effect at the file's INCLUDE POINT, resolved by the single offset authority `effectiveLevelOffset`
  // — combining include-EDGE `leveloffset=` options AND the attribute-form `:leveloffset:` (relative
  // `+N`/`-N` OR absolute `N`) an ancestor declares above the include, with the same conditional
  // gating the assembler uses. The result is an ABSOLUTE integer: the total offset already in effect at
  // the include point. It is returned as `baseOffset` so the include assembler emits its absolute
  // `:leveloffset:` set/restore lines RELATIVE to it (composing with — not clobbering — this seed), and
  // seeded as a global attribute so the open file's OWN top-level sections (which the assembler passes
  // through unwrapped) render at that inherited depth. The file's own in-document `:leveloffset:`
  // entries then shift further, relative to this base, in document order. Marked overridable (`@`).
  const baseOffset = effectiveLevelOffset({
    rootFileId,
    fileId: openFileId,
    readContent,
    resolveInclude,
    seedAttributes: RENDER_INTRINSIC_ATTRIBUTES,
  });
  if (baseOffset !== 0) seeded.leveloffset = `${baseOffset}${SOFT_DEFAULT_SUFFIX}`;
  // Seed the WHOLE resolved scope with no allow-list filtering, so the full inherited family flows
  // through as native document attributes: `idprefix`/`idseparator` (auto-ID generation),
  // `xrefstyle` (cross-reference text), and the caption/label/signifier family — `table-caption`,
  // `figure-caption`, `example-caption`, admonition `*-caption`, `appendix-caption`, `toc-title`,
  // `chapter-signifier`, `part-signifier`, `section-refsig`, `version-label`, `last-update-label`
  // — plus `sectnums`/`toc` etc. The resolution model already enforces AsciiDoc
  // unset/empty semantics: an unset attribute (`:name!:`) is deleted from `scope.values` and so is
  // simply never seeded (label removed), while an EMPTY value (`:name:`) is a real entry kept as ''.
  // The `@` soft-default suffix on an empty value yields the literal '@', which Asciidoctor treats
  // exactly like an empty in-document caption (blank prefix, auto-number retained) — i.e. the suffix
  // does NOT corrupt empty-value semantics.
  for (const [name, value] of scope.values) {
    seeded[name] = value + SOFT_DEFAULT_SUFFIX;
  }
  return { attributes: seeded, baseOffset };
}

// Diagram block styles that render natively on-screen (main thread), mapped to the engine name the
// preview dispatches on. `vega-lite` normalizes to `vegalite` so `data-diagram-engine` stays within the
// diagram notation set {mermaid, graphviz, vega, vegalite}. Offline-unsupported engines (plantuml/ditaa)
// are deliberately absent — they keep their default listing rendering, never a native placeholder.
const DIAGRAM_ENGINE_BY_STYLE: Readonly<Record<string, string>> = {
  mermaid: 'mermaid',
  graphviz: 'graphviz',
  vega: 'vega',
  vegalite: 'vegalite',
  'vega-lite': 'vegalite',
};

/** The normalized diagram engine for a block style, or `null` when the style is not a native diagram. */
function diagramEngineForStyle(style: string): string | null {
  return DIAGRAM_ENGINE_BY_STYLE[style.toLowerCase()] ?? null;
}

/** A native diagram block located during the pre-conversion walk, keyed by its (id'd) HTML element. */
interface DiagramBlock {
  id: string;
  engine: string;
  /** The file the diagram block was written in, and its line THERE (not in the assembled document). */
  origin: { path: string; line: number };
  source: string;
}

/** Escape a raw diagram source for inert placement as element text content. */
function escapeHtmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * The ` data-source-file="…"` fragment for an origin, or an empty string when the render knows no path.
 *
 * Omitted rather than emitted empty: an empty attribute would assert a provenance the worker does not
 * have, and a consumer matching on it would find nothing. Absent means "single file, the one you are
 * looking at", which is exactly what the line alone already says.
 *
 * @param path - The origin's project-relative path, possibly empty.
 * @returns The attribute fragment, with a leading space, or an empty string.
 */
function sourceFileAttribute(path: string): string {
  return path === '' ? '' : ` data-source-file="${escapeHtmlAttribute(path)}"`;
}

/**
 * Escape a value for a double-quoted attribute.
 *
 * Separate from {@link escapeHtmlText} because that one leaves `"` alone, which is harmless in text and
 * would end the attribute early here. The values escaped with this are project-relative FILE PATHS, and
 * file names are author-controlled, so this is the boundary that keeps a name from closing the attribute
 * and introducing markup of its own.
 *
 * @param value - The raw value to place inside double quotes.
 * @returns The escaped value.
 */
function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll('"', '&quot;');
}

/**
 * The inert diagram placeholder the main thread locates and renders natively. `div` + `class` +
 * `data-*` + escaped text is `html`-profile-safe, so the shared preview sanitizer keeps it intact; the
 * source is preserved (escaped text) so a later re-render re-derives the SVG rather than nesting.
 */
function buildDiagramPlaceholder(diagram: DiagramBlock): string {
  return `<div class="adc-diagram" data-diagram-engine="${diagram.engine}" data-source-line="${diagram.origin.line}"${sourceFileAttribute(diagram.origin.path)}>${escapeHtmlText(diagram.source)}</div>`;
}

/**
 * Replace the whole element carrying `id="<id>"` (a diagram's rendered listing/literal block) with
 * `replacement`. Walks balanced `<div>`/`</div>` from the element's own open tag so a nested content or
 * title `<div>` is spanned correctly; the diagram source inside is HTML-escaped so no `<div` token can
 * appear in it. Returns the input unchanged when the id is not found.
 */
function replaceElementById(html: string, id: string, replacement: string): string {
  const idIndex = html.indexOf(`id="${id}"`);
  if (idIndex === -1) return html;
  const openStart = html.lastIndexOf('<div', idIndex);
  if (openStart === -1) return html;
  const tagRe = /<div\b|<\/div>/g;
  tagRe.lastIndex = openStart;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    if (match[0] === '</div>') {
      depth -= 1;
      if (depth === 0) return html.slice(0, openStart) + replacement + html.slice(tagRe.lastIndex);
    } else {
      depth += 1;
    }
  }
  return html;
}

/** Reverses the minimal HTML escaping Asciidoctor applies inside code blocks. */
function unescapeHtml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

// Matches the <pre class="highlight"><code class="language-X" ...>...</code></pre>
// markup Asciidoctor emits for a source block that declares a language. The code
// body is HTML-escaped (every literal "<" is emitted as "&lt;"), so the body itself
// contains no "<" and the first "<" after the open tag is always the real "</code>".
// Capturing the body as `[^<]*` is therefore behavior-equivalent to a lazy
// `[\s\S]*?` up to the close, but provably linear-time (no backtracking overlap).
const SOURCE_BLOCK_RE =
  /<pre class="highlight"><code class="language-([\w+#-]+)"([^>]*)>([^<]*)<\/code><\/pre>/g;

// Matches a whole <img …> / <object …> tag greedily up to its closing `>`. Attribute values never
// contain a literal `<` or `>` (Asciidoctor escapes them as &lt;/&gt;), so `[^<>]*` bounds the match to
// one tag and — by excluding `<` — cannot overlap a following tag, keeping the global scan linear.
const IMG_TAG_RE = /<img\b[^<>]*>/gi;
const OBJECT_TAG_RE = /<object\b[^<>]*>/gi;

// Matches the `src="…"` / `data="…"` target attribute WITHIN a single already-isolated tag (linear: a
// fixed attribute anchor then a `[^"]` run bounded by the closing quote). Asciidoctor emits `<img src>`
// for a raster/normal image and `<object … data>` for an interactive SVG (`opts=interactive`).
const IMG_SRC_ATTRIBUTE_RE = /(\ssrc=")([^"]*)(")/i;
const OBJECT_DATA_ATTRIBUTE_RE = /(\sdata=")([^"]*)(")/i;

// A target carrying a URI scheme (`https:`, `data:`), a protocol-relative `//`, a root-absolute `/`, or
// a fragment `#` is already fully qualified; only a document-relative target is mapped to the endpoint.
const ABSOLUTE_SRC_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

/** Prefix a single relative target attribute with the endpoint base; pass absolute targets through. */
function prefixTargetAttribute(tag: string, attributePattern: RegExp, endpointBase: string): string {
  return tag.replace(attributePattern, (whole, prefix: string, source: string, suffix: string) => {
    if (source === '' || ABSOLUTE_SRC_RE.test(source)) return whole;
    return `${prefix}${endpointBase}/${source.replace(/^\.\//, '')}${suffix}`;
  });
}

/**
 * Prefix every project-relative image target (`<img src>` and interactive-SVG `<object data>`) with the
 * authenticated image endpoint base. The preview resolves `imagesdir` exactly as the PDF engine does (a
 * project render-config soft-default, overridden by a document `:imagesdir:`), so Asciidoctor emits
 * project-root-relative image paths; this maps each onto the endpoint that serves project files by path
 * — giving both engines one image base. Absolute, protocol-relative, root-absolute, `data:`, and
 * fragment targets pass through unchanged.
 */
function rewriteImageSources(html: string, endpointBase: string): string {
  return html
    .replaceAll(IMG_TAG_RE, (tag) => prefixTargetAttribute(tag, IMG_SRC_ATTRIBUTE_RE, endpointBase))
    .replaceAll(OBJECT_TAG_RE, (tag) => prefixTargetAttribute(tag, OBJECT_DATA_ATTRIBUTE_RE, endpointBase));
}

// A table's column widths, as a percentage, on the `<col>` elements Asciidoctor writes into the
// `<colgroup>`. Bounded to that one element and that one attribute: the width is the whole attribute
// list the engine emits there, so there is nothing else inside the tag for the pattern to reach past,
// and a `<col>` with no width (an autowidth column) does not match at all.
const COLUMN_WIDTH_ATTRIBUTE_RE = /<col width="(\d+(?:\.\d+)?)%">/g;

/**
 * Restore the canonical CSS form of a table column's width.
 *
 * Asciidoctor states a column width as a style — `<col style="width: 25%;">` — and that is what both
 * the previous JS engine and the reference Ruby toolchain produce. The JS engine at 4.0.6 writes the
 * presentational `width` attribute instead (`@asciidoctor/core`, `src/converter/html5.js`: the
 * `<col width="…%">` branch of the table converter, and the matching branch for a horizontal
 * description list's `labelwidth`/`itemwidth`). That attribute was made obsolete in HTML5, so it is a
 * porting slip rather than a deliberate change of output, and it is corrected HERE rather than
 * absorbed by the render-equivalence gates: the point of those gates is that the preview agrees with
 * canonical Asciidoctor, and teaching them to accept either spelling would retire their ability to
 * see a column-width change at all.
 *
 * Written so it costs nothing once the engine is fixed: the canonical form does not match the
 * pattern, so this becomes a no-op the day the emitted markup is correct, and the gates go on
 * checking that it is.
 *
 * @param html - The converted HTML.
 * @returns The HTML with every `<col>` width expressed as a style.
 */
function restoreColumnWidthStyles(html: string): string {
  return html.replaceAll(
    COLUMN_WIDTH_ATTRIBUTE_RE,
    (_, width: string) => `<col style="width: ${width}%;">`,
  );
}

// Asciidoctor renders checklist items as a leading unicode glyph in the paragraph text
// (&#10003; "✓" when checked, &#10063; "❏" otherwise) — emitted only as these numeric
// entities, so matching them is precise and never touches ordinary prose. We swap each for
// a stateful <span>, letting the preview stylesheets render a real checkbox (brand style) or
// reproduce the original glyph (faithful Asciidoctor style) instead of the bare character.
function styleChecklistMarkers(html: string): string {
  return html
    .replaceAll(
      '<p>&#10003; ',
      '<p class="checklist-item"><span class="checklist-box checklist-box--checked" aria-hidden="true"></span>',
    )
    .replaceAll(
      '<p>&#10063; ',
      '<p class="checklist-item"><span class="checklist-box" aria-hidden="true"></span>',
    );
}

/**
 * Applies highlight.js syntax highlighting to every source block in the rendered
 * HTML. Runs in the worker (string-only, no DOM) so the main thread stays free,
 * and emits hljs token spans (.hljs-*) that the preview stylesheet themes.
 */
function highlightCodeBlocks(html: string): string {
  return html.replaceAll(SOURCE_BLOCK_RE, (match, lang: string, attributes: string, body: string) => {
    const code = unescapeHtml(body);
    try {
      const result = hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang })
        : hljs.highlightAuto(code);
      return `<pre class="highlight hljs"><code class="language-${lang}"${attributes}>${result.value}</code></pre>`;
    } catch {
      // Unknown/unsupported language — keep the original escaped markup.
      return match;
    }
  });
}

// A STEM BLOCK renders as `<div class="stemblock">` — a precise, stem-only signal in the output.
const STEM_BLOCK_OUTPUT_RE = /class="stemblock"/;
// An INLINE stem is authored with one of these macros. Inline stem leaves NO distinctive wrapper in
// the output (only the ambiguous `\$…\$` / `\(…\)` / `\[…\]` delimiters, which Asciidoctor also emits
// for escaped text and backslash/regex content in code), so we detect it from the SOURCE macro.
const STEM_INLINE_MACRO_RE = /(?:stem|latexmath|asciimath):\[/;

/**
 * Whether the document carries STEM math the client must typeset. STEM must be in effect AND real
 * stem markup must be present. STEM is in effect when the resolved `:stem:` value is set (the empty
 * string for the bare AsciiMath default, or a notation such as `latexmath`); an `undefined`/`null`
 * value means the author opted out with `:stem!:`, so even real markup is left as literal text.
 * Real markup is a `stemblock` wrapper in the output OR an inline `stem:`/`latexmath:`/
 * `asciimath:` macro in the source. This deliberately does NOT key on the bare `\(`/`\[`/`\$`
 * output delimiters, because Asciidoctor also emits those for escaped text and for backslash or
 * regex content inside code (such as a `/\[0-9\]+/` regex in a listing block); keying on them would
 * make the client typeset, and so corrupt, ordinary code or prose that contains no math at all.
 *
 * @param stemAttribute - The resolved `:stem:` document attribute (`''`/`'latexmath'`/`undefined`).
 * @param source - The rendered AsciiDoc source (assembled), scanned for inline stem macros.
 * @param html - The converted HTML, scanned for the stem-block wrapper.
 * @returns True only when STEM is in effect AND real stem markup is present.
 */
function detectMathPresent(stemAttribute: unknown, source: string, html: string): boolean {
  if (stemAttribute === undefined || stemAttribute === null) return false;
  return STEM_BLOCK_OUTPUT_RE.test(html) || STEM_INLINE_MACRO_RE.test(source);
}

// The engine exposes `load` and `convert` as module functions and both are asynchronous, so the
// handler is asynchronous too. Two consequences worth stating, because neither is obvious from the
// diff: there is no processor object to build or keep — the module IS the processor, so the render
// path holds no engine state between requests; and a second request can now arrive while the first is
// still awaiting, so replies are no longer guaranteed to come back in the order they were asked for.
// Nothing here is shared across invocations (every value below is a local), and the caller keeps only
// the reply whose `requestId` matches the request it is still waiting for, so an overtaking reply is
// discarded on arrival exactly as a stale one always was.
onmessage = async function (event: MessageEvent<RenderRequest>) {
  // Taken before anything else so the reported total covers the whole handler, include assembly and
  // block walk included — the stages below deliberately leave those out, and a total that started
  // later would hide them instead of leaving them visible as the remainder.
  const startedAt = performance.now();
  // `renderId` is read out and echoed back untouched: it means nothing here, and everything to the
  // holder that has to say which consumer this reply belongs to. See its declaration.
  const { requestId, renderId, content, imagesDir, mainPath, files, rootFileId, openFileId, showIncludes, projectAttributes, sourceLineHints } =
    event.data;
  // Absent means on: the preview is the dominant caller and navigates by these, so a request that says
  // nothing gets the behaviour it has always had. An export opts out explicitly.
  const wantSourceLineHints = sourceLineHints !== false;
  try {
    // `showtitle` renders the document title in embedded output. `imagesdir` is the base path
    // prepended to relative image targets so `image::diagram.png[]` resolves to the project's
    // asset endpoint; absolute-URL targets are left untouched by Asciidoctor.
    //
    // Section numbering & TOC across includes: `sectnums`/`sectnumlevels`
    // and `toc`/`toclevels` are NOT special-cased here — they ride through the full inherited-scope
    // seeding below (`seedAttributesFromScope`, no allow-list filtering). Combined with the assembler's
    // absolute `:leveloffset:` set/restore entries, Asciidoctor natively numbers sections and builds the
    // TOC over the ASSEMBLED, offset-adjusted structure: two `leveloffset=+1` chapters number
    // continuously (1, 2) and the TOC lists them at their effective (offset) levels. Embedded output
    // (`showtitle`, no header/footer) still emits the `<div id="toc">` block when `toc` is set as a
    // document attribute, so no placement fix is needed.
    // The open file's cross-document attribute scope — the values it inherits at its
    // first include-point under the project main file (including a resolved `:leveloffset:`), so a
    // `{name}` defined only in a parent resolves here — is seeded FIRST as overridable soft-defaults.
    // Host render controls are applied AFTER it so they win: `showtitle` renders the title in embedded
    // output. NOTE: `imagesdir` is intentionally NOT forced here — it resolves exactly as the PDF
    // engine resolves it (a project render-config soft-default, overridden by a document `:imagesdir:`
    // or the inherited scope), so both engines share one image base. The resulting project-relative
    // `<img src>` targets are mapped onto the authenticated image endpoint after conversion (see
    // `rewriteImageSources`). Empty seed ⇒ current standalone/root behavior preserved.
    // The open file's inherited scope, plus the include-point offset (`baseOffset`) that its content is
    // rendered at when previewed on its own — seeded globally as `:leveloffset:` for the file's own
    // sections AND passed to the assembler so its absolute `:leveloffset:` set/restore lines compose
    // with it. 0 / empty for a root or standalone document (current behavior preserved).
    const { attributes: scopeSeed, baseOffset } = seedAttributesFromScope(rootFileId, openFileId, files);
    const attributes: Record<string, string> = {
      // Project render-config defaults (soft-defaulted) sit at the BASE so the inherited document scope
      // and the in-document header both override them; the host controls below (imagesdir) still win.
      ...projectAttributes,
      // Enable STEM by default so an author who writes `stem:[…]`/`[stem]` sees rendered math in the
      // preview WITHOUT having to remember the `:stem:` header. The value `'@'` is an empty
      // value carrying the overridable soft-default marker, so it resolves to the AsciiMath default
      // ('') when the document says nothing, yet a document can still pick a notation (`:stem:
      // latexmath`), inherit one from its cross-document scope below, or opt out entirely (`:stem!:`
      // → resolved value undefined → `detectMathPresent` stays false). Seeded FIRST so the inherited
      // scope and the in-document header both win over it.
      stem: SOFT_DEFAULT_SUFFIX,
      ...scopeSeed,
      showtitle: '',
    };
    // When a main file + its tree's contents are supplied, assemble the include tree (sandbox-
    // confined) and render that; otherwise render the open file's content unchanged so the
    // default preview keeps exact source-line mapping for scroll-sync (Constitution VIII). The
    // assembler is seeded with the same document-start attribute state Asciidoctor will resolve (the
    // intrinsics + these API attributes) so its conditional include-gating and `{attr}` target
    // substitution agree with the render — an include guarded by `ifdef::backend-html5[]` is kept,
    // not silently dropped (Finding#1).
    // Assemble rooted at the open file for ANY file with includes.
    // `readFile` overlays the live editor buffer for the root path:
    // content is always the most current keystroke, while files[openPath] may lag.
    // Only overlay content when openFileId is explicitly provided (the live editor buffer IS that
    // file); when falling back to mainPath the content field may be for a different file.
    const openFilePath = openFileId ?? mainPath;
    const readFile =
      openFileId === undefined
        ? (p: string) => files![p] ?? null
        : (p: string) => (p === openFilePath ? content : (files![p] ?? null));
    // The assembly's provenance map is kept, not just its text. Asciidoctor reports every block's line in
    // ASSEMBLED coordinates, which is a different coordinate system from the file the author is editing as
    // soon as an `include::` inlines anything above it. Emitting assembled lines and expecting the editor
    // to translate them is what made click-to-scroll land on the wrong block: only one of the two panels
    // ever did the translation. Resolving each line back to (file, line) HERE means the markup states
    // where a block actually came from, and no consumer has to know the assembled coordinate space exists.
    const assembled =
      openFilePath && files && files[openFilePath] !== undefined
        ? assembleIncludes(openFilePath, readFile, {
            showIncludes,
            seedAttributes: buildAssemblerSeed(attributes),
            baseOffset,
            // Only built when the hints are wanted: an export asks for neither, and the map is a parallel
            // array the length of the assembled document.
            withSourceMap: wantSourceLineHints,
          })
        : null;
    const source = assembled === null ? content : assembled.content;
    /**
     * Resolve an assembled line number to the file and line it came from.
     *
     * Without an assembly there is nothing to translate: the rendered text IS the open file, so its own
     * path and the line as reported stand. An out-of-range line (defensive only) is treated the same way
     * rather than dropped, because a block with no provenance still deserves a position.
     */
    const originOf = (assembledLine: number): { path: string; line: number } => {
      const entry = assembled?.sourceMap?.lineToSource[assembledLine - 1];
      return entry === undefined
        ? { path: openFilePath ?? '', line: assembledLine }
        : { path: entry.path, line: entry.sourceLine };
    };
    const parseStartedAt = performance.now();
    const asciidocDocument = await loadAsciidoc(source, {
      safe: 'safe',
      sourcemap: true,
      attributes,
    });
    const parseMs = performance.now() - parseStartedAt;

    // Collect source locations BEFORE conversion. Blocks that have no ID get a
    // synthetic one so we can inject data-source-line via a post-processing pass
    // on the raw HTML string (setAttribute alone does not produce HTML attributes).
    const blockSourceLines: Array<{ id: string; origin: { path: string; line: number } }> = [];
    // Native-diagram blocks: located here (parsed style + source), then swapped for an inert placeholder
    // in the converted HTML so the main thread renders them on-screen (never the raw listing).
    const diagramBlocks: DiagramBlock[] = [];
    // Track the document title line number (from the level-0 section block).
    // The showtitle <h1> has no id attribute, so it needs special handling below.
    let documentTitleOrigin: { path: string; line: number } | null = null;

    // The assembled source, split once, so a block's data-source-line can be lifted to its visual start
    // (the topmost of its title/attribute metadata lines) instead of its delimiter — see blockStartLine.
    const sourceLines = source.split('\n');

    const blocks = asciidocDocument.findBy({});
    for (const block of blocks) {
      // Read the line from the block rather than from its source-location cursor. Both are engine
      // accessors for the same value, but only this one is answered consistently by every node the
      // walk returns: a table cell's cursor is stored as a plain copy of the object, so it carries the
      // position but none of the cursor's methods, and asking it for its line number throws. That
      // would abort the whole render — and with it the diagram placeholders and the provenance for
      // every block — for any document containing a table. Nothing here needs the rest of the cursor.
      const lineNumber = block.getLineNumber();
      if (lineNumber === undefined) continue;
      const startLine = blockStartLine(sourceLines, lineNumber);
      const context = String(block.getContext());
      // The document-level block has no wrapping HTML element.
      if (context === 'document') continue;

      // Level-0 sections render as an <h1> via showtitle but have no id in the HTML.
      // Capture the line number for the post-processing step below.
      if (context === 'section' && typeof block.getLevel === 'function' && block.getLevel() === 0) {
        documentTitleOrigin = originOf(lineNumber);
        continue;
      }

      // A native-diagram block (mermaid/graphviz/vega/vegalite) renders on-screen on the main thread.
      // Give it an id so its converted element can be located, record engine + source line + inert
      // source, and skip the default block handling so the raw source is never shown as a listing.
      const style: string =
        typeof block.getStyle === 'function' ? String(block.getStyle() ?? '') : '';
      const engine = context === 'listing' || context === 'literal' ? diagramEngineForStyle(style) : null;
      if (engine !== null) {
        const rawDiagramId: unknown = block.getId();
        let diagramId: string = typeof rawDiagramId === 'string' && rawDiagramId ? rawDiagramId : '';
        if (!diagramId) {
          diagramId = `${SYNTHETIC_DIAGRAM_ID_PREFIX}${diagramBlocks.length}`;
          block.setId(diagramId);
        }
        // `getSource` is a Block (listing/literal) method, not on the AbstractBlock the walk is typed as.
        const rawSource: unknown =
          'getSource' in block && typeof block.getSource === 'function' ? block.getSource() : '';
        diagramBlocks.push({
          id: diagramId,
          engine,
          origin: originOf(startLine),
          source: typeof rawSource === 'string' ? rawSource : String(rawSource ?? ''),
        });
        continue;
      }

      // Everything above this line serves the diagram swap, which happens either way. Only the
      // scroll-sync bookkeeping below is optional.
      if (!wantSourceLineHints) continue;

      const rawId: unknown = block.getId();
      let id: string = typeof rawId === 'string' ? rawId : '';
      if (!id) {
        id = `${SYNTHETIC_BLOCK_ID_PREFIX}${context}_${lineNumber}`;
        block.setId(id);
      }
      blockSourceLines.push({ id, origin: originOf(startLine) });
    }

    const convertStartedAt = performance.now();
    let html = String(await asciidocDocument.convert());
    // Also the start of the post-conversion window: everything from here to the reply is the worker's
    // own work on the converted HTML.
    const convertedAt = performance.now();
    const convertMs = convertedAt - convertStartedAt;

    // Gate client-side math on the RESOLVED `:stem:` value (cross-document scope already seeded
    // above), not on the raw delimiters Asciidoctor always emits for stem macros.
    const stemAttribute =
      typeof asciidocDocument.getAttribute === 'function' ? asciidocDocument.getAttribute('stem') : undefined;
    const mathPresent = detectMathPresent(stemAttribute, source, html);

    // The resolved header, for a consumer rendering this outside the app's chrome (see `details`).
    // Read through the same `typeof` guard the stem lookup uses, so a processor build without
    // `getAttribute` degrades to "no header metadata" instead of throwing mid-render.
    const readAttribute = (name: string): string | undefined => {
      const value =
        typeof asciidocDocument.getAttribute === 'function' ? asciidocDocument.getAttribute(name) : undefined;
      return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
    };
    // `authors` carries every author when the header names several; `author` alone is the first of them.
    const author = readAttribute('authors') ?? readAttribute('author');
    const revnumber = readAttribute('revnumber');
    const revdate = readAttribute('revdate');
    const lang = readAttribute('lang');
    const doctitle = readAttribute('doctitle');
    const details: RenderDocumentDetails = {
      ...(doctitle === undefined ? {} : { title: doctitle }),
      ...(author === undefined ? {} : { author }),
      ...(revnumber === undefined ? {} : { revnumber }),
      ...(revdate === undefined ? {} : { revdate }),
      ...(lang === undefined ? {} : { lang }),
    };

    // Swap each native-diagram block's rendered listing for its inert placeholder (`html`-profile-safe
    // so the shared sanitizer keeps it). Done before the id-based source-line pass so the placeholder's
    // own `data-source-line` is authoritative and no leftover diagram id is decorated.
    for (const diagram of diagramBlocks) {
      html = replaceElementById(html, diagram.id, buildDiagramPlaceholder(diagram));
    }
    const diagramsPresent = diagramBlocks.length > 0;

    // Map project-relative image targets onto the authenticated image endpoint. Asciidoctor has
    // already applied the resolved `imagesdir` (identical to the PDF engine), so each `<img src>` is a
    // project-root-relative path the endpoint serves; only the URL base differs between the two engines.
    if (imagesDir) html = rewriteImageSources(html, imagesDir);

    // Syntax-highlight source blocks before the source-line pass below; this
    // only rewrites the <code> bodies and never touches id="..." attributes.
    html = highlightCodeBlocks(html);
    html = styleChecklistMarkers(html);
    html = restoreColumnWidthStyles(html);

    // Inject data-source-line next to each id="..." attribute in a single pass
    // so the preview hook can use querySelector('[data-source-line="N"]').
    if (blockSourceLines.length > 0) {
      const originMap = new Map(blockSourceLines.map(({ id, origin }) => [id, origin]));
      html = html.replaceAll(/id="([^"]+)"/g, (_, id: string) => {
        const origin = originMap.get(id);
        return origin === undefined
          ? `id="${id}"`
          : `id="${id}" data-source-line="${origin.line}"${sourceFileAttribute(origin.path)}`;
      });
    }

    // The showtitle <h1> is the document title and has no id attribute.
    // Inject data-source-line directly so click-to-scroll works for line 1.
    // Use string replace (not /^<h1>/) to handle a leading newline Asciidoctor
    // sometimes emits in embedded mode.
    if (wantSourceLineHints && documentTitleOrigin !== null) {
      html = html.replace(
        '<h1>',
        `<h1 data-source-line="${documentTitleOrigin.line}"${sourceFileAttribute(documentTitleOrigin.path)}>`,
      );
    }

    const finishedAt = performance.now();
    const timings: RenderTimings = {
      parseMs,
      convertMs,
      postProcessMs: finishedAt - convertedAt,
      totalMs: finishedAt - startedAt,
    };

    postMessage({
      requestId,
      renderId,
      ok: true,
      html,
      error: null,
      mathPresent,
      diagramsPresent,
      details,
      timings,
    } satisfies RenderResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postMessage({ requestId, renderId, ok: false, html: null, error: message } satisfies RenderResult);
  }
};
