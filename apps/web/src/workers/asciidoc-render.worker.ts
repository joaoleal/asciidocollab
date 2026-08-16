import { load as loadAsciidoc } from 'asciidoctor';
import hljs from 'highlight.js/lib/common';
import { ON_DEMAND_GRAMMARS, type OnDemandGrammar } from './hljs-languages.generated';
import { assembleIncludes } from './assemble-includes';
import { trimTermIndentation } from '../lib/asciidoc-html/trim-term-indentation';
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

// Matches the OPENING of the <pre class="highlight"><code class="language-X" ...> markup Asciidoctor
// emits for a source block that declares a language.
//
// Only the opening: the body is found by scanning for the close rather than by a pattern. The body
// is HTML-escaped — a literal "<" the author typed is emitted as "&lt;" — but it is NOT free of
// markup, because a listing that carries callouts has `<i class="conum" …></i><b>(1)</b>` dropped
// into it at each marker. The old pattern captured the body as `[^<]*` and so matched nothing at all
// for such a block, which is why a source block with callouts came back unhighlighted while the same
// code without them was coloured. A pattern that crosses markup instead has to search for its own
// terminator, and every form of that search backtracks quadratically on a body whose close never
// comes; `indexOf` does not.
//
// Held as a template rather than used directly: each pass copies it, because the scan now suspends
// while a grammar is fetched and a `g` regex keeps its position on the object. See
// `highlightCodeBlocks`.
//
// ## The language's character set, and why it is this one
//
// Asciidoctor imposes NO character set on a source block's language. The name is a positional
// attribute, so `AttributeList` reads it as everything up to the next comma — or, quoted, as
// everything up to the closing quote, commas included (`attribute_list.js`, `#parseAttribute` /
// `#parseAttributeValue`) — and `convert_listing` interpolates whatever that was straight into
// `class="language-${lang}" data-lang="${lang}"` with no escaping at all (`converter/html5.js:904`).
// A fenced block is the same story from the other end: the fence's tail up to a comma, trimmed
// (`parser.js`, the `fenced_code` case). Rendered against 4.0.8, `[source,foo bar]` emits
// `class="language-foo bar"`, `[source,"a\"b"]` emits `class="language-a"b"` — an attribute the engine
// itself has already broken — and `[source,rubisé]` emits the accented name verbatim.
//
// So the name matched here is NOT bounded by the engine; it is bounded by what a match can usefully
// mean, which is a spelling highlight.js answers to. Across all 371 spellings the installed package
// carries — 104 in the bundled `common` set, 267 in the generated on-demand map — the entire character
// inventory is `[0-9a-z]` plus `+`, `#`, `-` and `.`. The dot was the one missing here, and it is not
// an edge case: `cmake.in`, `html.hbs`, `html.handlebars` and `pf.conf` are highlight.js's own
// spellings, the generated map carries a grammar for each, and every one of them came back with no
// colour at all because this pattern refused the name before the map was ever consulted. Adding the
// dot makes all 267 on-demand spellings reachable (verified by rendering each one through the engine
// and back through this pattern).
//
// Nothing WIDER is admitted, and that is deliberate rather than lazy. The name is author-controlled
// text; a match here is re-emitted below into `class="language-${lang}"`, and it is also the string the
// Print style reaches with `[class~="language-…"]` to put an unlexed language back at the code colour.
// `"` would leave the attribute and `<`/`>`/`&` would put markup in it; a space is worse than either,
// because `class="language-foo bar"` is TWO class tokens — it answers to `[class~="language-foo"]`, so
// the listing takes a DIFFERENT language's rule, while a selector for the whole name matches nothing;
// and `/` reads as a path. No highlight.js spelling contains any of them, so admitting them would buy
// no highlighting whatsoever and cost the one guarantee this bound provides. A name carrying such a
// character therefore matches at most its sanctioned prefix — `a"b` gets as far as `a` — which then
// misses the lookup like any other unknown language, and the block is left exactly as the engine
// wrote it. The widening is strictly additive besides: the run is terminated by a literal `"`, which
// is not in the class, so every name the narrow pattern matched the wide one matches identically.
//
// The class stays a single bounded repetition followed by a literal `"`, so it scans linearly (the
// repository's ReDoS rule) — a dot inside a character class is a literal dot and adds no alternation.
const SOURCE_BLOCK_OPEN_RE = /<pre class="highlight"><code class="language-([\w+#.-]+)"([^>]*)>/g;

/** The close of a source block, searched for from the end of its opening tag. */
const SOURCE_BLOCK_CLOSE = '</code></pre>';

// The callout markers Asciidoctor drops into a listing's body, in all three forms
// `convert_inline_callout` emits: a font icon followed by its plain-text twin (`icons=font`), the
// plain-text marker alone (no icons), and an image of the numbered icon (`icons` set to anything
// else). The image form was missing while the comment claimed both forms were covered, so a project
// rendering callouts as images had every annotated listing come back unhighlighted — gracefully, and
// silently, and contradicting what was written here.
//
// The image is matched by its SHAPE — a `src`, then an `alt` carrying the callout's number — and not
// by the `callouts/` segment inside the path, because a pattern that scans within the quoted src
// backtracks polynomially (the repository's ReDoS rule rejects it, and a code body is attacker-
// supplied text). Nothing is lost by that: what is matched here is lifted out and put back verbatim,
// so an author's own `<img>` inside a listing — which only `subs=macros` can produce — is restored
// byte for byte and merely lets the block be highlighted rather than left alone.
const CALLOUT_MARKUP_RE =
  /<i class="conum"[^<>]*><\/i>(?:<b>[^<]*<\/b>)?|<b class="conum">[^<]*<\/b>|<img src="[^"<>]*" alt="\d+"[^<>]*>/g;

/** A run of markup lifted out of a code body, and where it belongs in the decoded code text. */
interface CodeBodyMarkup {
  /** Offset into the DECODED code text, counted in characters. */
  at: number;
  /** The markup exactly as Asciidoctor emitted it. */
  html: string;
}

/**
 * Separates a code body into the code the highlighter should see and the markup Asciidoctor put
 * inside it, remembering where each run belongs so it can be put back afterwards.
 *
 * Highlighting the body with the markers still in it would tokenise `(1)` as part of the program;
 * dropping them would lose the callouts entirely. Returns null when the body holds markup this does
 * not recognise — better to leave such a block exactly as it arrived than to guess at where a tag
 * belongs and reassemble it wrongly.
 *
 * @param body - The code element's inner HTML.
 * @returns The decoded code, the markup runs and their offsets — or null when unrecognised markup is present.
 */
function separateCodeBodyMarkup(body: string): { code: string; markup: CodeBodyMarkup[] } | null {
  const markup: CodeBodyMarkup[] = [];
  let code = '';
  let cursor = 0;
  for (const match of body.matchAll(CALLOUT_MARKUP_RE)) {
    // Checked on EVERY segment, not just the tail. A body may hold markup Asciidoctor emitted for
    // something else — `subs="+macros"` turns a bare URL in a listing into an `<a>` — and a segment
    // that reached `unescapeHtml` would have its tags decoded into the code text, highlighted as
    // program source and re-escaped, so the reader would see the raw tag as literal text. Guarding
    // only the tail left every segment BEFORE a callout unguarded, which is the shape a listing
    // that both links and annotates takes.
    const segment = body.slice(cursor, match.index);
    if (segment.includes('<')) return null;
    code += unescapeHtml(segment);
    markup.push({ at: code.length, html: match[0] });
    cursor = match.index + match[0].length;
  }
  const tail = body.slice(cursor);
  if (tail.includes('<')) return null;
  code += unescapeHtml(tail);
  return { code, markup };
}

/**
 * Puts the lifted markup back into highlighted HTML at the text offsets it came from.
 *
 * Walks the highlighted output counting DECODED characters — a tag contributes none, an entity
 * exactly one — so an offset taken from the plain code still names the same place once the
 * highlighter has wrapped that code in token spans. Closing tags are emitted before any marker due at
 * the same offset, so a marker at the end of a token lands after it rather than inside it.
 *
 * @param html - The highlighter's output for the code alone.
 * @param markup - The runs to restore, in ascending offset order.
 * @returns The highlighted HTML with every run restored.
 */
function restoreCodeBodyMarkup(html: string, markup: readonly CodeBodyMarkup[]): string {
  if (markup.length === 0) return html;
  let out = '';
  let decoded = 0;
  let pending = 0;
  let index = 0;
  const emitDue = (): void => {
    while (pending < markup.length && markup[pending].at <= decoded) {
      out += markup[pending].html;
      pending += 1;
    }
  };
  while (index < html.length) {
    if (html.startsWith('</', index)) {
      const close = html.indexOf('>', index);
      const stop = close === -1 ? html.length : close + 1;
      out += html.slice(index, stop);
      index = stop;
      continue;
    }
    emitDue();
    const character = html[index];
    if (character === '<') {
      const close = html.indexOf('>', index);
      const stop = close === -1 ? html.length : close + 1;
      out += html.slice(index, stop);
      index = stop;
      continue;
    }
    if (character === '&') {
      // Every entity the highlighter emits is short; anything longer is a literal ampersand.
      const semicolon = html.indexOf(';', index);
      const stop = semicolon === -1 || semicolon - index > 8 ? index + 1 : semicolon + 1;
      out += html.slice(index, stop);
      index = stop;
      decoded += 1;
      continue;
    }
    out += character;
    index += 1;
    decoded += 1;
  }
  emitDue();
  return out;
}

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

/** What a monospaced table cell's paragraph opens with, once Asciidoctor has converted the cell. */
const MONOSPACED_CELL_OPEN = '<p class="tableblock"><code>';

/** Where that paragraph's own class list ends, so the name below can be appended to it. */
const CELL_CLASS_END = '<p class="tableblock';

// The two tokens the walk below counts, in exactly the spelling the old two-`indexOf` walk searched
// for: a close carries its `>` (so `</codex>` is not one), an open does not (so `<code class="…">`
// is). The close is listed first only for readability — at any one offset at most one of them can
// match, because the character after `<` decides which.
const CODE_TAG_RE = /<\/code>|<code/g;

/** The offset from a monospaced cell's paragraph to the `<code>` that paragraph opens with. */
const CELL_CODE_OFFSET = MONOSPACED_CELL_OPEN.length - '<code>'.length;

/**
 * Names the cells of a monospaced table COLUMN, which Asciidoctor's HTML otherwise leaves
 * indistinguishable from an inline codespan.
 *
 * The two are different constructs and the PDF export draws them differently. A `[cols="1m"]` column
 * reaches `convert_table`'s `:monospaced` branch, which gives the whole cell the codespan's family,
 * size and colour and nothing else; an inline codespan is a text fragment the formatter also paints a
 * box behind. So a monospaced column is bare monospace on the page, and the chip belongs only to the
 * codespans an author wrote inside it.
 *
 * Asciidoctor emits `<p class="tableblock"><code>…</code></p>` for both, and CSS cannot separate them:
 * a selector cannot ask whether an element has TEXT beside it, so `code:only-child` also matches the
 * codespan in `Insert \`code\`` and would strip a chip the export really does paint. The whole cell's
 * text is available here, which is why the distinction is drawn here — the same reason the footnote
 * separator above is named rather than left as a text node no stylesheet can reach.
 *
 * One cell is named wrongly here, and knowingly: a plain cell whose entire content is one codespan the
 * author wrote is the same markup as a monospaced cell in every respect, so it is named too and loses a
 * chip the export really does paint. Its text keeps the codespan's family, size and colour; what it
 * loses is the tint behind it and the rounded corners.
 *
 * The HTML cannot separate the two, but the DOCUMENT can — a cell in an `m` column reports its style as
 * monospaced and an ordinary cell does not — and the parsed document is right here. What stops us is
 * the mapping from its cells onto these paragraphs. The markup offers no key to join them on, so the
 * alignment could only be positional, and a positional walk has to know how many `<p class="tableblock">`
 * each cell contributes. That count is `Cell#content.length`, and asking a cell for its content is not
 * a read: `Cell#text` runs `apply_subs` over the cell's own text every time it is asked, with no memo
 * (`table.rb:357`), so a cell holding `footnote:[…]` registers ANOTHER footnote and bumps
 * `footnote-number` on each ask (`substitutors.rb:871`). Doing that to every cell before `convert()`
 * would renumber a document's footnotes and leave phantoms in its list — the document damaged to fix a
 * tint. Counting the paragraphs here instead, by splitting the cell's text on blank lines the way
 * `Cell#content` does, is a copy of one of the renderer's rules kept in the preview, which is the kind
 * that drifts without saying so.
 *
 * The walk would also have to change shape. `findBy({})` never enters a cell's inner document
 * (`abstract_block.rb:496` descends into `c.inner_document` only under `traverse_documents`), so a table
 * nested inside an `a|` cell contributes paragraphs to this HTML that no such walk would see — and that
 * one walk is also where the diagram swap and every block's `data-source-line` come from.
 *
 * Matched in ONE pass over the document, not one walk per candidate.
 *
 * What each cell needs to know is where the `<code>` its paragraph opens with closes: a monospaced
 * cell may carry codespans of its own, and those are NESTED inside the cell's own `<code>`, so the
 * question is whether the FIRST one closes at the very end of the paragraph and not whether the
 * paragraph happens to end in `</code></p>`. That was answered by walking the tags from each
 * candidate with a pair of `indexOf`s per step, and the pair is what made it CUBIC: once no further
 * `<code` lies ahead, `indexOf('<code', cursor)` scans to the end of the document and finds nothing —
 * once per step, per candidate. Nesting is what supplies the candidates and the steps at the same
 * time, and an author can write nesting of any depth directly, because a `++++` passthrough block is
 * emitted byte for byte. Measured on `<p class="tableblock"><code>` × N followed by `</code></p>` × N:
 * 19 KB took 0.5 s, 38 KB 4.1 s, 76 KB 31.8 s — while the parse and convert that produced that HTML
 * together took 3.6 ms. The preview renders the collaboratively synced document on a per-keystroke
 * debounce, in all three styles, so that is one co-editor's paste against every other editor's worker.
 *
 * Bracket matching does not need a walk per candidate at all: every `<code>` in the document is
 * matched to its close by one left-to-right scan and one stack, which is where a single pass with a
 * monotonically advancing scan position gets the whole answer. The result is identical, not merely
 * close — the close a stack pops for a given open is by construction the same one the walk from that
 * open reached, since the opens above it on the stack are exactly the ones the walk would have to
 * balance first, and an open the scan ends still holding is one whose walk would have run out of
 * closes. Only the candidates' own closes are kept, so the memory is one entry per monospaced cell
 * rather than one per `<code>` in the document.
 *
 * @param html - The converted HTML.
 * @returns The HTML with every paragraph a `<code>` fills named — every monospaced cell, and the one
 *   plain cell above that is not one.
 */
function nameMonospacedCells(html: string): string {
  const candidates: number[] = [];
  for (let at = html.indexOf(MONOSPACED_CELL_OPEN); at !== -1; at = html.indexOf(MONOSPACED_CELL_OPEN, at + 1)) {
    candidates.push(at);
  }
  if (candidates.length === 0) return html;

  // The `<code>` each candidate paragraph opens with — the only opens whose closes are worth keeping.
  const wanted = new Set(candidates.map((at) => at + CELL_CODE_OFFSET));
  /** For each wanted open, the offset just past its matching `</code>`. */
  const closeOf = new Map<number, number>();
  const openStack: number[] = [];
  // `matchAll` rather than the pattern itself, because a `g` regex carries its scan position on the
  // object and this one is a module constant: `matchAll` iterates over a copy, so two renders cannot
  // take turns advancing one another's.
  for (const tag of html.matchAll(CODE_TAG_RE)) {
    if (tag[0] === '<code') {
      openStack.push(tag.index);
      continue;
    }
    // A close with nothing open is stray markup; the per-candidate walk never counted below its own
    // starting depth either, and a stack with nothing to pop is the same statement.
    const start = openStack.pop();
    if (start !== undefined && wanted.has(start)) closeOf.set(start, tag.index + '</code>'.length);
  }

  let out = '';
  let copied = 0;
  for (const at of candidates) {
    const closed = closeOf.get(at + CELL_CODE_OFFSET);
    if (closed === undefined || !html.startsWith('</p>', closed)) continue;
    const classEnd = at + CELL_CLASS_END.length;
    out += html.slice(copied, classEnd) + ' monospaced';
    copied = classEnd;
  }
  return copied === 0 ? html : out + html.slice(copied);
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

// A footnote entry's marker: the back-link carrying the number, then the separator Asciidoctor
// writes as a bare "." in the text. A bare text node is unreachable from CSS, so a stylesheet that
// wants a different marker — the PDF sets one off with brackets rather than a full stop — cannot
// suppress it. Naming it costs the styles that keep it nothing: the span still renders ". ".
const FOOTNOTE_MARKER_RE =
  /(<div class="footnote" id="_footnotedef_(\d+)">\s*<a href="#_footnoteref_\2">\2<\/a>)\. /g;

/**
 * Wraps each footnote entry's marker separator in a span so a stylesheet can present it.
 *
 * @param html - The converted HTML.
 * @returns The HTML with every footnote separator named.
 */
function nameFootnoteSeparators(html: string): string {
  return html.replaceAll(
    FOOTNOTE_MARKER_RE,
    (_, marker: string) => `${marker}<span class="footnote-separator">. </span>`,
  );
}

// The sign between two key caps of a chord. Asciidoctor's HTML backend joins the caps with a bare
// `+` and nothing else, while the PDF renderer joins them with the theme's own `kbd.separator` —
// which by default carries a narrow no-break space on either side of the sign, and that air is most
// of the gap a reader sees between two caps. A bare text node is unreachable from CSS, so the Print
// style could neither add the air nor put it anywhere but on the caps, where a cap's own tinted box
// grows with it. Naming it costs the styles that leave it alone nothing: the span still renders `+`.
//
// Anchored on `</kbd>` and `<kbd` so only a run BETWEEN two caps matches; the separator is written
// by the same converter that writes the caps, so it never carries markup of its own.
const KEYSEQ_SEPARATOR_RE = /<\/kbd>([^<>]{1,16})<kbd(?=[\s>])/g;

// A CHORD, and only a chord. `convert_inline_kbd` wraps a multi-key chord in this span and emits a
// bare `<kbd>` for a single key, so the span is the only thing in the output that says two caps
// belong to ONE keystroke. Searched for outside the separator pattern, because without it
// `Press <kbd>Ctrl</kbd> and then <kbd>Alt</kbd> to switch.` reads as a chord whose separator is the
// sentence " and then " — prose, named as punctuation, and then given the theme's air on both sides.
// Nothing suppresses `.keyseq-separator` today, which is why the visible cost was small; a rule that
// did would have deleted the author's words.
const KEYSEQ_OPEN = '<span class="keyseq">';

/** The close of a chord, searched for from the end of its opening tag. */
const KEYSEQ_CLOSE = '</span>';

/**
 * Wraps the sign between two key caps of a chord in a span, so a stylesheet can present it.
 *
 * The chord's extent is found with `indexOf` rather than by a pattern, for the reason
 * {@link SOURCE_BLOCK_OPEN_RE} gives: a pattern that has to cross markup to find its own terminator
 * backtracks polynomially on input whose terminator never comes, and this walks rendered output
 * built from text an author wrote.
 *
 * @param html - The converted HTML.
 * @returns The HTML with every chord separator named.
 */
function nameKeyseqSeparators(html: string): string {
  let out = '';
  let copied = 0;
  for (let open = html.indexOf(KEYSEQ_OPEN); open !== -1; open = html.indexOf(KEYSEQ_OPEN, copied)) {
    const capsStart = open + KEYSEQ_OPEN.length;
    const capsEnd = html.indexOf(KEYSEQ_CLOSE, capsStart);
    if (capsEnd === -1) break;
    out += html.slice(copied, capsStart);
    out += html
      .slice(capsStart, capsEnd)
      .replaceAll(
        KEYSEQ_SEPARATOR_RE,
        (_, separator: string) => `</kbd><span class="keyseq-separator">${separator}</span><kbd`,
      );
    copied = capsEnd;
  }
  return copied === 0 ? html : out + html.slice(copied);
}

/**
 * Grammars this worker has fetched, by the name they are registered under.
 *
 * The promise is stored, not the outcome, so two renders that both want Dockerfile share ONE fetch
 * and one registration: `hljs`'s language registry is global to the module, and registering the same
 * grammar twice from two overlapping renders is a write nothing orders. A rejected fetch is dropped
 * from the map instead of remembered, so an author who was offline for one keystroke is not left
 * without colour for the rest of the session.
 */
const grammarRegistrations = new Map<string, Promise<boolean>>();

/**
 * Fetch and register one grammar, once.
 *
 * @param grammar - The map entry for the declared language.
 * @returns Whether the grammar is now registered.
 */
async function registerGrammar(grammar: OnDemandGrammar): Promise<boolean> {
  const inFlight = grammarRegistrations.get(grammar.name);
  if (inFlight !== undefined) return inFlight;
  const attempt = grammar
    .load()
    .then((grammarModule) => {
      // Registration is idempotent by construction: this is reached once per grammar, because the
      // promise goes into the map before anything awaits it.
      hljs.registerLanguage(grammar.name, grammarModule.default);
      return true;
    })
    .catch(() => {
      grammarRegistrations.delete(grammar.name);
      return false;
    });
  grammarRegistrations.set(grammar.name, attempt);
  return attempt;
}

/**
 * The attribute that says a block's colouring was GUESSED rather than read off a grammar.
 *
 * A listing whose declared language no installed grammar answers to is still coloured — highlight.js
 * is asked to detect the language, which is what this worker did for every such block until the
 * on-demand grammars arrived. The guess is right often enough to be worth having in the two styles
 * that only claim to present the document, and it is confidently wrong often enough to be worth
 * refusing in the one style that claims to show the PAGE: rouge does not guess, so a listing the
 * export prints in one colour must not be shown here in five. A block of `include::` directives came
 * back with `include` in green and its numbers in bold blue, because the detector recognised
 * something in some other language.
 *
 * One rendered document serves all three preview styles at once — the style is an attribute on the
 * container and switching it deliberately does not re-render — so this worker cannot make that
 * decision, and does not try to. It marks the guess; the Print style declines it, in the generated
 * region of `print-preview.css`.
 *
 * An ATTRIBUTE rather than a class, and that is forced rather than chosen. The rule beside it excludes
 * the languages the export does lex with `:not([class~="language-…"])`, so for a language rouge lexes
 * and highlight.js has no grammar for — 222 of the 392 names in rouge's registry — no class added
 * here could bring the block back into that rule. A separate rule keyed on something that is not a
 * class is the only join that reaches those.
 */
const GUESSED_MARKUP_MARKER = 'data-hljs-guessed';

/**
 * The grammars a guess may be made from: everything registered before the first render.
 *
 * Read once, at module load, so it is exactly `highlight.js/lib/common`'s own set and not that set
 * plus whatever the session has since fetched. See the guess itself for why a fixed subset matters.
 */
// Not `readonly`: `highlightAuto` declares its subset parameter as a mutable array, so a readonly
// one cannot be handed to it. Nothing writes to this.
const BUNDLED_LANGUAGES: string[] = hljs.listLanguages();

/** One source block in the converted HTML: where it sits, and what it says it is. */
interface SourceBlock {
  /** Offset of the opening `<pre class="highlight">`. */
  readonly start: number;
  /** Offset just past the block's `</code></pre>`. */
  readonly end: number;
  /** The declared language, exactly as the document spelled it. */
  readonly lang: string;
  /** The rest of the `<code>` tag, re-emitted verbatim beside the language class. */
  readonly attributes: string;
  /** The code element's inner HTML, markers and all. */
  readonly body: string;
}

/**
 * Find every source block in the converted HTML, in document order.
 *
 * Separated from the highlighting so that the whole document is examined BEFORE anything is
 * fetched: which grammars this render needs is a question about all of its blocks, and it cannot be
 * answered one block at a time without also fetching them one at a time. See
 * {@link highlightCodeBlocks}.
 *
 * Synchronous, so no other render can interleave with it — the scan of one document runs to the end
 * before any other work happens at all. The pattern is nonetheless a COPY: a `g` regex carries its
 * scan position on the object, and this loop can stop early — a block whose close never comes (an
 * author mid-keystroke) leaves the rest of the document unexamined — so the shared pattern would be
 * left pointing into the middle of one document for whatever scanned next.
 *
 * @param html - The converted HTML.
 * @returns Every source block found, in the order they appear.
 */
function findSourceBlocks(html: string): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  const scan = new RegExp(SOURCE_BLOCK_OPEN_RE, 'g');
  for (let open = scan.exec(html); open !== null; open = scan.exec(html)) {
    const [opening, lang, attributes] = open;
    const bodyStart = open.index + opening.length;
    const bodyEnd = html.indexOf(SOURCE_BLOCK_CLOSE, bodyStart);
    if (bodyEnd === -1) break;
    // Resume the scan after this block whatever is decided about it, so a block left alone is not
    // re-examined from inside its own body.
    scan.lastIndex = bodyEnd + SOURCE_BLOCK_CLOSE.length;
    blocks.push({
      start: open.index,
      end: scan.lastIndex,
      lang,
      attributes,
      body: html.slice(bodyStart, bodyEnd),
    });
  }
  return blocks;
}

/**
 * Applies highlight.js syntax highlighting to every source block in the rendered
 * HTML. Runs in the worker (string-only, no DOM) so the main thread stays free,
 * and emits hljs token spans (.hljs-*) that the preview stylesheet themes.
 *
 * Asynchronous because a language outside the grammars `highlight.js/lib/common` carries is fetched
 * on demand. Nothing waits for a bundled language: the registry answers for those before the first
 * render, so the common path never touches an `await`.
 *
 * The fetches this render needs are made TOGETHER, in one batch, rather than one at a time inside
 * the walk over the blocks. Awaiting each in turn made a document's grammars strictly sequential —
 * a paper with forty listings in forty unbundled languages paid forty round trips end to end before
 * a single line of HTML went back to the panel, and the panel shows nothing until it does. The cost
 * is paid once per grammar for the life of the worker ({@link grammarRegistrations} keeps them), so
 * this is a first-render cost; it is also exactly the render an author watches for.
 *
 * The declared name still only ever reaches the map as a KEY. Nothing composes it into a specifier —
 * every `import()` in the generated map is a literal, which is the whole reason that file is
 * generated (`hljs-languages.generated.ts`) — and batching does not change what is looked up, only
 * when.
 *
 * A block no grammar answers to is coloured by detection instead, and marked as guessed so the Print
 * style can decline it. See {@link GUESSED_MARKUP_MARKER}.
 *
 * @param html - The converted HTML.
 * @param stillWanted - Whether this render is still the newest one this worker has been handed.
 * @returns The HTML with every source block this render could colour coloured.
 */
async function highlightCodeBlocks(html: string, stillWanted: () => boolean): Promise<string> {
  const blocks = findSourceBlocks(html);
  if (blocks.length === 0) return html;

  // A language the installed grammars do not answer to is GUESSED at, and the guess is marked so a
  // style can decline it. "No grammar" used to mean "not among the 36 `highlight.js/lib/common`
  // bundles", which is a different statement and a Print-parity gap in the exact direction that style
  // promises not to have: rouge colours a Dockerfile and this did not. The declared name is looked up
  // in the generated map and that grammar alone is fetched — the name itself never reaches an
  // `import()`, which is the whole reason the map is generated. See `hljs-languages.generated.ts`.
  //
  // What is NOT claimed: that the two highlighters now cover the same languages. 84 of the 192
  // grammars name a language rouge has no lexer for, so this colours listings the export prints
  // plain — the same fidelity defect pointing the other way. It is answered in the STYLE rather than
  // here, because one rendered document serves all three preview styles and only Print claims to
  // look like the page: the generated region of `print-preview.css` puts those languages' tokens
  // back at the code colour, from an inventory of rouge's own lexer names. See
  // `scripts/build-print-highlight-css.mjs`. The same generated region is what declines the guess —
  // see {@link GUESSED_MARKUP_MARKER}.
  //
  // Keyed by REGISTRATION name, so two blocks declaring two spellings of one grammar — `cmake` and
  // `cmake.in` — ask for it once.
  const wantedGrammars = new Map<string, OnDemandGrammar>();
  /** The declared spellings whose grammar is not registered yet, so this render has to fetch it. */
  const awaitingGrammar = new Set<string>();
  for (const block of blocks) {
    if (hljs.getLanguage(block.lang)) continue;
    const grammar = ON_DEMAND_GRAMMARS.get(block.lang.toLowerCase());
    if (grammar === undefined) continue;
    wantedGrammars.set(grammar.name, grammar);
    awaitingGrammar.add(block.lang);
  }

  // Whether the grammars this render had to fetch may be painted with. A render another has already
  // overtaken fetches nothing: its reply is one the holder will drop on arrival, and the cost of a
  // grammar is a network round trip. Its blocks are left plain, which is what this worker did for
  // every unbundled language until on-demand fetching existed — never something wrong — and the
  // grammar a live render does fetch stays registered, so the next render of the same document
  // finds it there and colours the block with no wait at all.
  //
  // Checked again on the way out, because the fetch is where this render can lose its place: a
  // superseded render must not paint with a grammar that arrived after a newer render had already
  // answered. The registration itself is allowed to stand — it is a warm cache, and `hljs.highlight`
  // is synchronous, so no in-progress highlight can see a half-registered grammar.
  //
  // One flag for the whole batch rather than a re-check per block, and that is what makes the
  // decision the render's own: `hljs`'s registry is global, so asking it again below would let a
  // grammar ANOTHER render registered in the meantime decide what this one paints, which is a
  // different answer depending on how two handlers happened to interleave.
  let mayPaintFetched = false;
  if (wantedGrammars.size > 0 && stillWanted()) {
    await Promise.all([...wantedGrammars.values()].map((grammar) => registerGrammar(grammar)));
    mayPaintFetched = stillWanted();
  }

  let out = '';
  let copied = 0;
  for (const block of blocks) {
    const { lang } = block;
    const registered = hljs.getLanguage(lang) !== undefined;
    // A language this render went to fetch is never guessed at, and is painted only if this render
    // was entitled to fetch it and still is. Both ways out leave the block exactly as the engine
    // wrote it, because the grammar the document actually named is on its way: guessing here would
    // paint one keystroke in some other language's colours and repaint it in the right ones on the
    // next, which reads as the preview changing its mind. A fetch that FAILED lands here too, and for
    // the same reason — the retry is the next render, not a guess.
    if (awaitingGrammar.has(lang) && (!mayPaintFetched || !registered)) continue;
    // The callout markers live inside the body; the highlighter must see the program without them.
    const separated = separateCodeBodyMarkup(block.body);
    if (separated === null) continue;
    let value: string;
    try {
      value = restoreCodeBodyMarkup(
        registered
          ? hljs.highlight(separated.code, { language: lang }).value
          : // Guessed from the BUNDLED grammars alone. Left to itself the detector tries everything
            // the registry holds, which now grows as a session fetches grammars — so the same
            // document would be guessed one way in a fresh tab and another way after an unrelated
            // file had been opened. The subset is fixed at module load, before any on-demand grammar
            // can have been registered, which is the set this ever guessed from anyway.
            hljs.highlightAuto(separated.code, BUNDLED_LANGUAGES).value,
        separated.markup,
      );
    } catch {
      // The grammar exists but threw on this input — keep the original escaped markup.
      continue;
    }
    out += html.slice(copied, block.start);
    // The marker goes at the END of the tag, after whatever the engine wrote. `attributes` is the
    // rest of the opening tag verbatim, so `class="language-${lang}"${attributes}` reproduces the tag
    // byte for byte — including a tag the ENGINE broke, which is what `[source,"a\"b"]` produces
    // (`class="language-a"b"`, a name carrying the quote that ends the attribute). Inserted before
    // `attributes` the marker would land inside that wreckage and change what it says; appended, it
    // is at a token boundary whatever came before it.
    const marker = registered ? '' : ` ${GUESSED_MARKUP_MARKER}`;
    out += `<pre class="highlight hljs"><code class="language-${lang}"${block.attributes}${marker}>${value}</code></pre>`;
    copied = block.end;
  }
  return copied === 0 ? html : out + html.slice(copied);
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

/**
 * How many renders this worker has been handed BY EACH CONSUMER, by that consumer's id.
 *
 * Per consumer, because "a newer render arrived" is only ever a question about one preview's own
 * stream. Counted globally it was a question about the whole page: with two previews mounted, either
 * one's render silenced the other's grammar fetches, and the silenced consumer accepted the reply
 * because its own `requestId` still matched — a listing that simply came back uncoloured, with
 * nothing to say why, until something else made that panel render again.
 *
 * A render carrying no `consumerId` — one posted straight to the worker, as the worker's own tests
 * and the fidelity harness do — counts under {@link ANONYMOUS_CONSUMER}, so those renders are one
 * stream between them, which is what every render was before consumers were told apart.
 *
 * One `number` per consumer for the life of the worker, and consumers are made by mounting a preview,
 * so this grows with mounts and never shrinks — the worker is not told when a share is released. A
 * page that mounted a preview a thousand times would hold a thousand small integers.
 */
const renderOrdinals = new Map<number, number>();

/** The stream a render that names no consumer belongs to. Not an id the holder can ever allocate. */
const ANONYMOUS_CONSUMER = 0;

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
  // This render's place in the order ITS CONSUMER's renders arrived, taken synchronously, before the
  // first `await`.
  //
  // Only one thing reads it: whether to spend a network round trip fetching a syntax grammar for a
  // render that consumer has already replaced. Neither of the other two ids on the wire can answer
  // that. `requestId` is each consumer's own numbering and restarts at 1 for each of them, so two of
  // them routinely have a render numbered 1 in flight and the ids cannot be ordered against each
  // other; `renderId` is the holder's and is ordered, but it names a RENDER rather than the stream it
  // belongs to. `consumerId` names the stream, and this counts within it.
  const stream = event.data.consumerId ?? ANONYMOUS_CONSUMER;
  const ordinal = (renderOrdinals.get(stream) ?? 0) + 1;
  renderOrdinals.set(stream, ordinal);
  const stillWanted = (): boolean => ordinal === renderOrdinals.get(stream);
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
    html = await highlightCodeBlocks(html, stillWanted);
    html = styleChecklistMarkers(html);
    html = nameFootnoteSeparators(html);
    html = nameKeyseqSeparators(html);
    html = nameMonospacedCells(html);
    html = trimTermIndentation(html);
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
