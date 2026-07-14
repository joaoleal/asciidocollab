/**
 * Pipeline stage: turn text-described diagram and math blocks into content-addressed image assets.
 *
 * It scans the assembled `/project` root document for diagram blocks (mermaid/graphviz/vega/vega-lite),
 * math blocks (`stem`/`latexmath`/`asciimath`), and inline math macros, renders each block of INERT
 * source through the appropriate injected {@link RenderShim} (SVG-first, PNG raster fallback), writes
 * the bytes to `/project/.gen/<sourceHash>.<ext>`, and rewrites the block to an `image::`/`image:` ref.
 * Rendering is content-addressed: an unchanged block resolves to the same `sourceHash`, the same
 * `.gen` filename, and a cache hit — so identical source never re-renders and placement stays stable.
 *
 * The stage is fail-soft per block: a malformed block or a shim failure records a diagnostic and
 * leaves that block untouched, so the rest of the document still exports. Diagram engines that have no
 * offline client-side renderer (PlantUML/ditaa) are skipped with a diagnostic — never fetched.
 *
 * Detection is a pragmatic line scan (no full AsciiDoc parse): an attribute line `[name]` immediately
 * followed by a matching block delimiter opens a block; a bare delimiter opens a verbatim region that
 * is copied through unchanged so inline math inside listings/literals/passthroughs is never rewritten.
 */

import type { PipelineStage, StageContext, StageResult } from '../orchestrator';
import type { RenderShim, ShimAssetFormat } from '../../ports/shim';
import { computeSourceHash } from '../../cache/content-address';
import type {
  DiagnosticCode,
  DiagnosticSeverity,
  GeneratedAsset,
} from '../../protocol';

// ---------------------------------------------------------------------------
// Stage identity, VFS layout, and diagnostic codes (named — never bare literals).
// ---------------------------------------------------------------------------

/** This stage's fixed slot in the pipeline order. */
const STAGE_KIND = 'diagrams-math' as const;

/** Root of the in-memory project tree the pipeline rewrites. */
const PROJECT_ROOT = '/project';

/** Directory (relative to the project root) that holds generated diagram/math image assets. */
const GEN_DIR_NAME = '.gen';

/** Absolute VFS directory the rendered asset bytes are written under. */
const GEN_DIR_PATH = `${PROJECT_ROOT}/${GEN_DIR_NAME}`;

/** The format the orchestrator asks a shim for first; PNG is the raster fallback. */
const PREFERRED_FORMAT: ShimAssetFormat = 'svg';

/**
 * A synthetic render param carrying the block's AsciiDoc notation/engine so it participates in the
 * cache key and tells a single math shim which notation to interpret.
 */
const BLOCK_NOTATION_PARAM = 'asciidoc-block-notation';

/** Prefix for positional block attributes captured from an attribute line. */
const POSITIONAL_PARAM_PREFIX = 'pos';

const DIAGNOSTIC_DIAGRAM_UNSUPPORTED: DiagnosticCode = 'diagram-unsupported';
const DIAGNOSTIC_RASTERIZED: DiagnosticCode = 'unsupported-image';
const DIAGNOSTIC_REMOTE_SKIPPED: DiagnosticCode = 'remote-skipped';

/**
 * A remote resource reference inside diagram source: a `scheme://` URL (`http`, `https`, …). A relative
 * or bare path is NOT remote — the offline renderer resolves those locally (or rejects them); only an
 * absolute `scheme://` target would require reaching over the network. `data:` URIs carry their bytes
 * inline (no `//`) and so are not treated as remote.
 */
const REMOTE_REFERENCE_PATTERN = /[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Whether a diagram block's source references a remote resource (a `scheme://` URL) — e.g. a
 * vega/vega-lite spec's remote `data.url`, or a remote image referenced by a mermaid node. Such a block
 * is SKIPPED with a warning and never rendered, so no fetch is ever attempted for it (offline export).
 * Exported so the main-thread mermaid pre-pass can apply the exact same rule and stay in parity.
 */
export function diagramSourceReferencesRemoteResource(source: string): boolean {
  return REMOTE_REFERENCE_PATTERN.test(source);
}

const SEVERITY_WARNING: DiagnosticSeverity = 'warning';
const SEVERITY_ERROR: DiagnosticSeverity = 'error';

// ---------------------------------------------------------------------------
// Block-name classification.
// ---------------------------------------------------------------------------

/** The shim family a detected block resolves to, or that it is an unsupported diagram. */
type BlockCategory = 'diagram' | 'math' | 'diagram-unsupported';

/** Diagram block names → the engine shim name that renders them. */
const DIAGRAM_SHIM_BY_BLOCK: Readonly<Record<string, string>> = Object.freeze({
  mermaid: 'mermaid',
  graphviz: 'graphviz',
  vega: 'vega',
  vegalite: 'vega',
  'vega-lite': 'vega',
});

/** Diagram engines with no offline client-side renderer — skipped with a diagnostic. */
const UNSUPPORTED_DIAGRAM_BLOCKS: ReadonlySet<string> = new Set(['plantuml', 'ditaa']);

/** Math block/inline notations rendered through the math shim family. */
const MATH_NOTATIONS: ReadonlySet<string> = new Set(['stem', 'latexmath', 'asciimath']);

/**
 * Fold a raw diagram block name to its canonical notation, collapsing the `vega-lite` alias onto
 * `vegalite`. This is the renderer-side twin of the editor's normalization, kept here (rather than
 * imported from the app) so this browser-leaf package stays one-directional.
 */
function canonicalDiagramNotation(name: string): string {
  return name === 'vega-lite' ? 'vegalite' : name;
}

/**
 * The diagram notation names this stage can render offline, published read-only so the editor can
 * pin its own diagram-highlighting set against them (a consistency seam, not a shared registry).
 *
 * DERIVED from {@link DIAGRAM_SHIM_BY_BLOCK} — the single source of truth for supported engines —
 * with the `vega-lite` alias folded onto `vegalite`, so the published set is
 * `{mermaid, graphviz, vega, vegalite}` and never drifts from what the stage actually renders.
 */
export const DIAGRAM_NOTATIONS: ReadonlySet<string> = new Set(
  Object.keys(DIAGRAM_SHIM_BY_BLOCK).map(canonicalDiagramNotation),
);

/**
 * The diagram engines with no offline client-side renderer (PlantUML/ditaa), published read-only.
 * DERIVED from {@link UNSUPPORTED_DIAGRAM_BLOCKS} so the editor can treat them consistently — never
 * highlighting a declaration the exporter will silently skip.
 */
export const UNSUPPORTED_DIAGRAM_NOTATIONS: ReadonlySet<string> = new Set(UNSUPPORTED_DIAGRAM_BLOCKS);

/**
 * Recognise a PlantUML body that actually wraps Graphviz/DOT — a `digraph`/`graph { … }` definition or
 * a `!include` of a DOT file — so the skip diagnostic can point at the offline `graphviz` engine (which
 * renders that same source) rather than at mermaid.
 */
const PLANTUML_DOT_HINT_RE = /\bdigraph\b|\bgraph\s+[^\n{]*\{|^\s*!include\b/im;

/**
 * The honest, actionable advice appended to a skipped unsupported-offline block's warning: it NAMES a
 * supported offline engine the author can re-author the block as, or states plainly that none exists.
 * This only shapes the diagnostic text — the block is still skipped and the rest of the document still
 * renders. PlantUML maps onto graphviz when its body is really DOT, otherwise onto mermaid; ditaa has
 * no close offline equivalent, so the message says so instead of inventing one.
 */
function offlineAlternativeAdvice(notation: string, source: string): string {
  if (notation === 'plantuml') {
    if (PLANTUML_DOT_HINT_RE.test(source)) {
      return 'This block is Graphviz/DOT; re-author it as a [graphviz] block, which renders offline.';
    }
    return 'Most PlantUML diagrams can be expressed as mermaid, which renders offline.';
  }
  if (notation === 'ditaa') {
    return 'ditaa has no offline renderer and no close offline equivalent; pre-render it to an image and reference that instead.';
  }
  return 'No supported offline diagram engine can render this notation.';
}

function classifyBlock(name: string): BlockCategory | null {
  if (name in DIAGRAM_SHIM_BY_BLOCK) {
    return 'diagram';
  }
  if (UNSUPPORTED_DIAGRAM_BLOCKS.has(name)) {
    return 'diagram-unsupported';
  }
  if (MATH_NOTATIONS.has(name)) {
    return 'math';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Line-scan primitives.
// ---------------------------------------------------------------------------

/** Minimum run length for a block delimiter line (AsciiDoc requires four or more). */
const MIN_DELIMITER_LENGTH = 4;

/** Delimiter characters this scan recognises: listing (`-`), literal (`.`), passthrough (`+`). */
const DELIMITER_CHARS: ReadonlySet<string> = new Set(['-', '.', '+']);

const BLOCK_ATTR_RE = /^\[([^\]]+)\]\s*$/;
// An AsciiDoc block title: a leading `.` followed by a non-space, non-`.` character (so a `....`
// literal delimiter is never mistaken for one) and the caption text.
const BLOCK_TITLE_RE = /^\.([^.\s].*)$/;
// The body captures every character up to the closing `]`, but the `(?!:\[)` guard also stops it at
// the start of a following inline-math macro. That tempering bounds each scan to a single macro so the
// match cost stays linear (an unguarded `[^\]]*` rescans the whole line from every macro start), while
// leaving the captured expression identical for any real macro whose content holds no `notation:[`.
const INLINE_MATH_RE = /(stem|latexmath|asciimath):\[((?:(?!:\[)[^\]])*)\]/g;

/** Whether a line is a block delimiter (a run of four or more identical delimiter characters). */
function isDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < MIN_DELIMITER_LENGTH) {
    return false;
  }
  const first = trimmed[0];
  if (!DELIMITER_CHARS.has(first)) {
    return false;
  }
  for (const ch of trimmed) {
    if (ch !== first) {
      return false;
    }
  }
  return true;
}

/** A parsed block attribute line: its lowercased name and its (positional/named) render params. */
interface BlockAttributes {
  readonly name: string;
  readonly params: Record<string, string>;
}

function parseAttributeLine(line: string): BlockAttributes | null {
  const match = BLOCK_ATTR_RE.exec(line);
  if (match === null) {
    return null;
  }
  const parts = match[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }
  const parameters: Record<string, string> = {};
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    const eq = part.indexOf('=');
    if (eq > 0) {
      parameters[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    } else {
      parameters[`${POSITIONAL_PARAM_PREFIX}${index}`] = part;
    }
  }
  return { name: parts[0].toLowerCase(), params: parameters };
}

/** The caption of a block-title line (`.Some caption`), or `undefined` when the line is not one. */
function matchBlockTitle(line: string): string | undefined {
  const match = BLOCK_TITLE_RE.exec(line);
  return match === null ? undefined : match[1].trim();
}

// ---------------------------------------------------------------------------
// Shared detection: the single authority over what the stage renders and hashes.
// ---------------------------------------------------------------------------

/**
 * One renderable diagram or math block located in a document. This is the shared contract between
 * detection and the stage's rendering/hashing: `source` and `params` are the exact inputs the stage
 * feeds {@link computeSourceHash}, so a record's content address never drifts from what gets rendered.
 */
export interface RenderableBlock {
  /** The shim family that renders this record. */
  readonly category: 'diagram' | 'math';
  /** The lowercased engine/notation (`mermaid`, `graphviz`, `vega`, `stem`, `latexmath`, …). */
  readonly notation: string;
  /** A delimited block, or an inline math macro (inline applies to math only). */
  readonly kind: 'block' | 'inline';
  /** The verbatim block/inline source text — part of the content-address hash. */
  readonly source: string;
  /** Named + positional (`pos<N>`) attributes plus the synthetic {@link BLOCK_NOTATION_PARAM}. */
  readonly params: Record<string, string>;
  /** 1-based line of the block's attribute line (or the inline macro's line), for diagnostics. */
  readonly line: number;
}

/**
 * A block located by the line scan, widened to include the unsupported-diagram category the public
 * detector filters out. Carries the original block lines so the stage can leave a block untouched on
 * a skip or a render failure.
 */
interface ScannedBlock {
  readonly category: BlockCategory;
  readonly notation: string;
  readonly source: string;
  readonly params: Record<string, string>;
  readonly line: number;
  readonly originalBlock: readonly string[];
  /** The block-title caption (`.Some caption`) on the line immediately above, if any. */
  readonly title?: string;
}

/** An inline math macro located on a prose line, with the span the stage splices over. */
interface InlineMatch {
  readonly block: RenderableBlock;
  readonly start: number;
  readonly length: number;
}

/** One region of the document, yielded in order so a consumer can rebuild the whole text. */
type ScanEvent =
  | { readonly kind: 'block'; readonly block: ScannedBlock }
  | { readonly kind: 'verbatim'; readonly lines: readonly string[] }
  | { readonly kind: 'prose'; readonly line: string; readonly matches: readonly InlineMatch[] };

/** Locate every inline math macro on a prose line (none inside verbatim regions ever reach here). */
function detectInlineMatches(line: string, lineNumber: number): InlineMatch[] {
  if (!line.includes(':[')) {
    return [];
  }
  const matches: InlineMatch[] = [];
  for (const match of line.matchAll(INLINE_MATH_RE)) {
    const start = match.index;
    if (start === undefined) {
      continue;
    }
    const notation = match[1];
    matches.push({
      block: {
        category: 'math',
        notation,
        kind: 'inline',
        source: match[2],
        params: { [BLOCK_NOTATION_PARAM]: notation },
        line: lineNumber,
      },
      start,
      length: match[0].length,
    });
  }
  return matches;
}

/**
 * Walk the document once, in order, classifying it into renderable/unsupported blocks, verbatim
 * regions copied through unchanged, and prose lines with their inline math. This pragmatic line scan
 * (no full AsciiDoc parse) is the sole detection authority: both the public {@link detectRenderableBlocks}
 * and the stage's rewrite loop drive it, so the two can never diverge on what is renderable.
 */
function* scanDocument(text: string): Generator<ScanEvent> {
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const attribute = parseAttributeLine(line);

    if (attribute !== null && index + 1 < lines.length && isDelimiter(lines[index + 1])) {
      const category = classifyBlock(attribute.name);
      if (category !== null) {
        const delimiter = lines[index + 1].trim();
        let close = index + 2;
        while (close < lines.length && lines[close].trim() !== delimiter) {
          close += 1;
        }
        if (close < lines.length) {
          yield {
            kind: 'block',
            block: {
              category,
              notation: attribute.name,
              source: lines.slice(index + 2, close).join('\n'),
              params: { ...attribute.params, [BLOCK_NOTATION_PARAM]: attribute.name },
              line: index + 1,
              originalBlock: lines.slice(index, close + 1),
              // Read (but do not consume) a caption on the line above: it stays in the output so
              // its rendered figure title is preserved, and it seeds the image's alt text.
              title: index > 0 ? matchBlockTitle(lines[index - 1]) : undefined,
            },
          };
          index = close + 1;
          continue;
        }
      }
    }

    if (isDelimiter(line)) {
      // A bare delimited region (listing/literal/passthrough): copied through verbatim so inline math
      // inside it is treated as literal content, never rewritten.
      const delimiter = line.trim();
      const start = index;
      index += 1;
      while (index < lines.length && lines[index].trim() !== delimiter) {
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      yield { kind: 'verbatim', lines: lines.slice(start, index) };
      continue;
    }

    yield { kind: 'prose', line, matches: detectInlineMatches(line, index + 1) };
    index += 1;
  }
}

/**
 * Locate every renderable diagram/math block and inline math macro in a document, in order. Diagram
 * engines with no offline renderer (PlantUML/ditaa) and inline math inside verbatim regions are
 * excluded — they are not renderable here.
 */
export function detectRenderableBlocks(text: string): RenderableBlock[] {
  const blocks: RenderableBlock[] = [];
  for (const event of scanDocument(text)) {
    if (event.kind === 'block') {
      const { category, notation, source, params, line } = event.block;
      if (category === 'diagram-unsupported') {
        continue;
      }
      blocks.push({ category, notation, kind: 'block', source, params, line });
    } else if (event.kind === 'prose') {
      for (const match of event.matches) {
        blocks.push(match.block);
      }
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// VFS path helpers.
// ---------------------------------------------------------------------------

/** Join a project-relative path onto the project root. */
function toVfsPath(relativePath: string): string {
  const trimmed = relativePath.replace(/^\/+/, '');
  return `${PROJECT_ROOT}/${trimmed}`;
}

/** The `image::`/`image:` target that points from the root document at a `.gen` asset. */
function genReference(rootPath: string, filename: string): string {
  const segments = rootPath.split('/').filter((segment) => segment.length > 0);
  const depth = Math.max(0, segments.length - 1);
  return `${'../'.repeat(depth)}${GEN_DIR_NAME}/${filename}`;
}

// ---------------------------------------------------------------------------
// Rendering + caching.
// ---------------------------------------------------------------------------

const GENERATED_ASSET_KIND: Readonly<Record<'diagram' | 'math', GeneratedAsset['kind']>> =
  Object.freeze({ diagram: 'diagram', math: 'math' });

/** Fallback label when a math block carries neither a caption nor any source expression. */
const MATH_DEFAULT_ALT = 'math expression';

/** Collapse runs of whitespace (including newlines) to single spaces and trim the ends. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The named `title=` attribute value, if the block carried one. */
function titleParam(params: Readonly<Record<string, string>> | undefined): string | undefined {
  const value = params?.title;
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/** Inputs a renderable block exposes for deriving its accessibility alt text. */
interface AltTextSource {
  readonly category: 'diagram' | 'math';
  readonly notation: string;
  readonly source: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly title?: string;
}

/**
 * Derive meaningful alt text for a rendered block. A caption (a `.Some caption` block title or a
 * `title=` attribute) always wins; otherwise a diagram falls back to its engine name and a math
 * block to its source expression (or a generic label when the expression is empty).
 */
function deriveAltText(block: AltTextSource): string {
  const caption = block.title ?? titleParam(block.params);
  if (caption !== undefined && caption.trim().length > 0) {
    return collapseWhitespace(caption);
  }
  if (block.category === 'diagram') {
    return `${block.notation} diagram`;
  }
  const expression = collapseWhitespace(block.source);
  return expression.length > 0 ? expression : MATH_DEFAULT_ALT;
}

/**
 * Render alt text as the first (positional) attribute of an `image::`/`image:` macro. The value is
 * always double-quoted so commas and closing brackets cannot split or truncate the attribute list,
 * and embedded backslashes/quotes are escaped for the quoted-attribute context.
 */
function escapeAltForMacro(alt: string): string {
  const escaped = alt.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

interface RenderRequestForBlock {
  readonly shim: RenderShim;
  readonly source: string;
  readonly params: Readonly<Record<string, string>>;
  readonly category: 'diagram' | 'math';
  readonly resource: string;
  readonly line: number;
  /** Alt text stored on the asset; derived per block and independent of the content address. */
  readonly altText: string;
}

/**
 * Resolve a block to a placed {@link GeneratedAsset} (rendering on a cache miss, reusing on a hit) or
 * `null` when the shim reports the source malformed. Ensures the asset bytes are present in the VFS
 * and records the raster-fallback diagnostic when a render fell back to PNG.
 */
async function renderOrReuse(
  context: StageContext,
  request: RenderRequestForBlock,
): Promise<GeneratedAsset | null> {
  const sourceHash = computeSourceHash({
    source: request.source,
    renderParams: request.params,
    shimVersion: request.shim.version,
  });

  let asset = context.cache.get(sourceHash);
  if (asset === undefined) {
    const output = await request.shim.render({
      source: request.source,
      params: request.params,
      preferredFormat: PREFERRED_FORMAT,
    });
    if (!output.ok) {
      context.diagnostics.report({
        severity: SEVERITY_ERROR,
        code: output.diagnostic.code,
        resource: request.resource,
        location: { path: request.resource, line: request.line },
        message: output.diagnostic.message,
      });
      return null;
    }
    asset = {
      sourceHash,
      kind: GENERATED_ASSET_KIND[request.category],
      format: output.asset.format,
      bytes: output.asset.bytes,
      rasterFallback: output.asset.rasterFallback,
      altText: request.altText,
    };
    context.cache.set(asset);
    if (asset.rasterFallback) {
      context.diagnostics.report({
        severity: SEVERITY_WARNING,
        code: DIAGNOSTIC_RASTERIZED,
        resource: request.resource,
        location: { path: request.resource, line: request.line },
        message: `Rendered ${request.category} rasterized to PNG because the SVG used a feature the PDF renderer cannot draw.`,
      });
    }
  }

  const genPath = `${GEN_DIR_PATH}/${asset.sourceHash}.${asset.format}`;
  if (!context.vfs.exists(genPath)) {
    context.vfs.writeFile(genPath, asset.bytes);
  }
  return asset;
}

/** Pick the shim that renders a diagram block, by engine name with a same-family fallback. */
function resolveDiagramShim(context: StageContext, blockName: string): RenderShim | undefined {
  const shimName = DIAGRAM_SHIM_BY_BLOCK[blockName];
  const byName = shimName === undefined ? undefined : context.shims.byName(shimName);
  if (byName !== undefined && byName.kind === 'diagram') {
    return byName;
  }
  return context.shims.byKind('diagram')[0];
}

// ---------------------------------------------------------------------------
// The stage.
// ---------------------------------------------------------------------------

/** Build the diagrams-math pre-processing stage. */
export function createDiagramsMathStage(): PipelineStage {
  return {
    kind: STAGE_KIND,
    run: (context) => runDiagramsMath(context),
  };
}

async function runDiagramsMath(context: StageContext): Promise<StageResult> {
  const rootPath = context.request.snapshot.rootPath;
  const rootVfsPath = toVfsPath(rootPath);
  const original = context.vfs.readText(rootVfsPath);
  if (original === null) {
    return {};
  }

  const resource = rootPath;
  const out: string[] = [];

  for (const event of scanDocument(original)) {
    if (event.kind === 'block') {
      out.push(...(await handleBlock(context, event.block, resource)));
    } else if (event.kind === 'verbatim') {
      out.push(...event.lines);
    } else {
      out.push(await rewriteInlineMath(context, event, resource));
    }
  }

  const rewritten = out.join('\n');
  if (rewritten !== original) {
    context.vfs.writeText(rootVfsPath, rewritten);
  }
  return {};
}

/** Render one detected block and return the lines that replace it (unchanged on skip/failure). */
async function handleBlock(
  context: StageContext,
  block: ScannedBlock,
  resource: string,
): Promise<readonly string[]> {
  if (block.category === 'diagram-unsupported') {
    context.diagnostics.report({
      severity: SEVERITY_WARNING,
      code: DIAGNOSTIC_DIAGRAM_UNSUPPORTED,
      resource,
      location: { path: resource, line: block.line },
      message: `Diagram engine "${block.notation}" has no offline renderer; the block was skipped. ${offlineAlternativeAdvice(block.notation, block.source)}`,
    });
    return block.originalBlock;
  }

  if (block.category === 'diagram' && diagramSourceReferencesRemoteResource(block.source)) {
    context.diagnostics.report({
      severity: SEVERITY_WARNING,
      code: DIAGNOSTIC_REMOTE_SKIPPED,
      resource,
      location: { path: resource, line: block.line },
      message: `Diagram "${block.notation}" references a remote resource and was skipped; remote and file data are never fetched during export.`,
    });
    return block.originalBlock;
  }

  const shim =
    block.category === 'diagram'
      ? resolveDiagramShim(context, block.notation)
      : context.shims.byKind('math')[0];
  if (shim === undefined) {
    context.diagnostics.report({
      severity: SEVERITY_WARNING,
      code: DIAGNOSTIC_DIAGRAM_UNSUPPORTED,
      resource,
      location: { path: resource, line: block.line },
      message: `No renderer is available for "${block.notation}"; the block was skipped.`,
    });
    return block.originalBlock;
  }

  const altText = deriveAltText({
    category: block.category,
    notation: block.notation,
    source: block.source,
    params: block.params,
    title: block.title,
  });
  const asset = await renderOrReuse(context, {
    shim,
    source: block.source,
    params: block.params,
    category: block.category,
    resource,
    line: block.line,
    altText,
  });
  if (asset === null) {
    return block.originalBlock;
  }
  const target = genReference(resource, `${asset.sourceHash}.${asset.format}`);
  return [`image::${target}[${escapeAltForMacro(altText)}]`];
}

/** Rewrite every detected inline math macro on a prose line to an inline `image:` reference. */
async function rewriteInlineMath(
  context: StageContext,
  event: { readonly line: string; readonly matches: readonly InlineMatch[] },
  resource: string,
): Promise<string> {
  if (event.matches.length === 0) {
    return event.line;
  }
  const shim = context.shims.byKind('math')[0];

  let result = '';
  let cursor = 0;
  for (const match of event.matches) {
    result += event.line.slice(cursor, match.start);
    const macro = event.line.slice(match.start, match.start + match.length);
    cursor = match.start + match.length;

    if (shim === undefined) {
      result += macro;
      continue;
    }
    const altText = deriveAltText({
      category: 'math',
      notation: match.block.notation,
      source: match.block.source,
      params: match.block.params,
    });
    const asset = await renderOrReuse(context, {
      shim,
      source: match.block.source,
      params: match.block.params,
      category: 'math',
      resource,
      line: match.block.line,
      altText,
    });
    if (asset === null) {
      result += macro;
      continue;
    }
    const target = genReference(resource, `${asset.sourceHash}.${asset.format}`);
    result += `image:${target}[${escapeAltForMacro(altText)}]`;
  }
  result += event.line.slice(cursor);
  return result;
}
