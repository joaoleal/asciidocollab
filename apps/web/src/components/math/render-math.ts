// Client-side STEM (math) rendering for the AsciiDoc preview.
//
// Asciidoctor emits stem expressions as inert delimiter markup — inline `\(…\)` (latexmath) and
// `\$…\$` (asciimath), display `\[…\]`, wrapped for blocks in `<div class="stemblock">`. The render
// worker leaves it untouched and DOMPurify keeps it (the delimiters are plain text), so by the time
// we get here the math is already inside the sanitized, scoped `.asciidoc-preview-content` container.
// This module typesets that already-sanitized DOM in place with MathJax 3.
//
// Output: when the browser can render native MathML (`MathMLElement` exists — Chromium ≥109, Firefox,
// Safari), each expression is converted to a native `<math>` element (`tex2mmlPromise`/
// `asciimath2mmlPromise`) and rendered by the browser's own MathML engine. Otherwise it falls back to
// MathJax's CHTML output (`tex2chtmlPromise`/`asciimath2chtmlPromise` → `mjx-container`). See
// {@link preferMathML} / {@link convertSite}.
//
// Why per-expression conversion (not `typesetPromise`'s delimiter auto-scan):
// - MathJax's auto-scan MISHANDLES Asciidoctor's `\$…\$` asciimath delimiters. The literal
//   backslash-dollar (which Asciidoctor emits so a browser shows `$…$` plain when MathJax is absent)
//   regex-escapes to a bare `$`, and the scan leaves the opening delimiter behind as a protected
//   `<span>$</span>` — the user sees a stray `$` glued onto the rendered math. So instead of relying
//   on the ambiguous scan, we find each delimited expression ourselves, strip the delimiters, render
//   the raw expression through MathJax's explicit convert API, and REPLACE the delimited text/content
//   node with the produced `mjx-container`. No delimiter survives → no stray `$`.
//
// Constraints (Constitution VI/VIII/IX):
// - Self-hosted only: MathJax loads from the web app's OWN `public/vendor/mathjax/` (copied from the
//   `mathjax` npm package at build time by scripts/build-mathjax-assets.mjs). No CDN, no network.
// - Real `<script>` tag, not `import()`: the package's `es5/*` files are browser IIFE bundles, not ES
//   modules. Importing them as modules in the Next.js/webpack browser bundle does NOT run their global
//   side effects / deferred MathJax 3 startup, so the convert helpers never appear and nothing renders
//   (even though it works under jsdom's CommonJS `require`). The supported MathJax 3 browser path is a
//   `<script src=".../tex-mml-chtml.js">`; MathJax derives its component base URL from that script's
//   `src`, so the AsciiMath component requested via `loader.load` resolves to the same self-hosted
//   `/vendor/mathjax/input/asciimath.js`.
// - Both notations from one dependency: MathJax is configured with BOTH the TeX and AsciiMath input
//   jaxes, so per-expression `latexmath:[]`/`asciimath:[]` overrides and the active `:stem:` notation
//   are all handled — TeX via `tex2chtmlPromise`, AsciiMath via `asciimath2chtmlPromise`.
// - Math source is inert: the convert API reads a string and builds DOM; nothing is executed.
// - Scoped: we only ever walk/replace inside the passed container (Constitution VI).
// - Per-expression errors are non-fatal: a single bad expression is replaced by MathJax's own
//   `merror` (or left as-is) and `renderMath` never throws — the rest of the preview stays intact.
// - Idempotent: a re-render first restores any prior delimiter text (recorded on the produced node)
//   so the same source is not double-converted.

/** Base URL of the self-hosted MathJax bundle (same-origin, copied into public/ at build). */
const MATHJAX_BASE = '/vendor/mathjax';
/** The combined entry bundle: TeX + MathML input, CHTML output, and the loader/startup. */
const MATHJAX_SCRIPT = `${MATHJAX_BASE}/tex-mml-chtml.js`;

/** Output document exposed by MathJax startup; used to attach CHTML styles/fonts after conversion. */
interface MathJaxDocument {
  /** Drop the document's record of previously-typeset math so a fresh update re-attaches styles. */
  clear: () => void;
  /** (Re)compute and inject the CHTML stylesheet/fonts for the math now present in the DOM. */
  updateDocument: () => void;
}

/** Minimal shape of the parts of the MathJax 3 global object this module uses. */
interface MathJaxGlobal {
  /**
   * Convert a TeX (latexmath) expression string to a CHTML `mjx-container` node.
   *
   * @param math - The raw TeX source (delimiters already stripped).
   * @param options - Conversion options.
   * @param options.display - True for block (display) layout, false for inline.
   * @returns A promise resolving to the produced container node.
   */
  tex2chtmlPromise?: (math: string, options: { display: boolean }) => Promise<HTMLElement>;
  /**
   * Convert an AsciiMath expression string to a CHTML `mjx-container` node.
   *
   * @param math - The raw AsciiMath source (delimiters already stripped).
   * @param options - Conversion options.
   * @param options.display - True for block (display) layout, false for inline.
   * @returns A promise resolving to the produced container node.
   */
  asciimath2chtmlPromise?: (math: string, options: { display: boolean }) => Promise<HTMLElement>;
  /**
   * Convert a TeX (latexmath) expression to a serialized **MathML string** (`<math>…</math>`). Always
   * available when the TeX input jax is loaded (MathML is MathJax's internal format), independent of
   * the output jax. Used when the browser can render native MathML.
   *
   * @param math - The raw TeX source (delimiters already stripped).
   * @param options - Conversion options.
   * @param options.display - True for block (display) layout, false for inline.
   * @returns A promise resolving to the MathML markup string.
   */
  tex2mmlPromise?: (math: string, options: { display: boolean }) => Promise<string>;
  /**
   * Convert an AsciiMath expression to a serialized **MathML string** (`<math>…</math>`).
   *
   * @param math - The raw AsciiMath source (delimiters already stripped).
   * @param options - Conversion options.
   * @param options.display - True for block (display) layout, false for inline.
   * @returns A promise resolving to the MathML markup string.
   */
  asciimath2mmlPromise?: (math: string, options: { display: boolean }) => Promise<string>;
  /** Startup handshake exposed by the component bundles, plus the output document built from config. */
  startup?: { promise?: Promise<unknown>; typeset?: boolean; document?: MathJaxDocument };
  /** TeX (latexmath) input config — inline/display delimiter pairs. */
  tex?: { inlineMath?: string[][]; displayMath?: string[][] };
  /** AsciiMath input config — delimiter pairs Asciidoctor wraps asciimath in. */
  asciimath?: { delimiters?: string[][] };
  /** Component loader config — extra input/output components to fetch from the bundle base. */
  loader?: { load?: string[] };
}

declare global {
  // `var` is required for a global augmentation (let/const are not hoisted onto `globalThis`).
  var MathJax: MathJaxGlobal | undefined;
}

/**
 * Singleton load promise so the MathJax bundle is fetched/initialized exactly once per session,
 * even if several previews ask for it concurrently. Resolves to the ready MathJax global (or
 * `undefined` if the bundle did not install one).
 */
let mathJaxLoad: Promise<MathJaxGlobal | undefined> | null = null;

/**
 * Inject the self-hosted MathJax script element and resolve once it has loaded. The configuration
 * must be installed on the MathJax global before the script runs, because MathJax 3 reads it on
 * load. The returned promise rejects on the script element's error event, such as when the asset is
 * missing, so the caller can clear the singleton and retry.
 *
 * @returns A promise resolving when the MathJax script has loaded and run.
 */
function injectMathJaxScript(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Configure inputs/output/components before the script runs. We convert each expression
    // explicitly (per-container, post-sanitize), so disable the page-wide auto-typeset on startup.
    // The delimiter config is still installed so the loaded input jaxes match Asciidoctor's markup
    // (and so a future `typesetPromise` fallback would use the right pairs), but we do not rely on
    // the auto delimiter-scan — we strip delimiters ourselves before conversion.
    globalThis.MathJax = {
      ...globalThis.MathJax,
      // TeX (latexmath): standard inline `\(…\)` and display `\[…\]` delimiters.
      tex: { inlineMath: [[String.raw`\(`, String.raw`\)`]], displayMath: [[String.raw`\[`, String.raw`\]`]] },
      // AsciiMath: Asciidoctor wraps asciimath in `\$…\$`.
      asciimath: { delimiters: [[String.raw`\$`, String.raw`\$`]] },
      // `tex-mml-chtml` does NOT bundle the AsciiMath input jax — ask the loader to fetch it from the
      // same self-hosted base (MathJax derives the base from this script's src → /vendor/mathjax/).
      loader: { ...globalThis.MathJax?.loader, load: ['input/asciimath'] },
      // We drive conversion ourselves (per container, post-sanitize); preserve any startup fields.
      startup: { ...globalThis.MathJax?.startup, typeset: false },
    };

    const script = document.createElement('script');
    script.src = MATHJAX_SCRIPT;
    script.async = true;
    script.id = 'mathjax-script';
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error(`Failed to load MathJax from ${MATHJAX_SCRIPT}`)),
      { once: true },
    );
    document.head.append(script);
  });
}

/**
 * Lazily load and configure self-hosted MathJax 3 for BOTH TeX and AsciiMath input with CHTML
 * output. Idempotent: subsequent calls reuse the cached promise. Returns `undefined` outside the
 * browser (SSR) where there is no `document` to inject into.
 *
 * @returns A promise resolving to the ready MathJax global (or `undefined` if unavailable).
 */
function loadMathJax(): Promise<MathJaxGlobal | undefined> {
  if (mathJaxLoad) return mathJaxLoad;

  // SSR / non-browser guard: there is no DOM to typeset and no `<script>` host. Do NOT cache this so
  // a later browser-side call can still load.
  if (typeof document === 'undefined' || globalThis.window === undefined) {
    return Promise.resolve(undefined);
  }

  mathJaxLoad = (async (): Promise<MathJaxGlobal | undefined> => {
    await injectMathJaxScript();
    const mathJax = globalThis.MathJax;
    // Wait for the startup handshake (component loading + document build) so the convert helpers and
    // the AsciiMath input jax are ready before the first conversion.
    if (mathJax?.startup?.promise) await mathJax.startup.promise;
    return mathJax;
  })();

  // On failure, drop the cached promise so a later preview can retry (e.g. transient load error).
  mathJaxLoad.catch(() => {
    mathJaxLoad = null;
  });

  return mathJaxLoad;
}

/**
 * Cached result of the browser's MathML-support probe. `null` until first checked; reset by
 * {@link resetMathJaxForTest}.
 */
let mathMLSupported: boolean | null = null;

/**
 * Whether to render math as NATIVE MathML rather than CHTML. True when the browser exposes the MathML
 * DOM interface (`MathMLElement`) — present in every engine that renders MathML Core (Chromium ≥109,
 * Firefox, Safari) and absent in engines that do not. When true, render-math emits `<math>` elements
 * the browser typesets itself; otherwise it falls back to MathJax's CHTML output.
 *
 * @returns True when native MathML output should be used.
 */
function preferMathML(): boolean {
  if (mathMLSupported === null) mathMLSupported = 'MathMLElement' in globalThis;
  return mathMLSupported;
}

/**
 * Parse a serialized MathML string into a live `<math>` element. The HTML5 fragment parser handles
 * MathML as foreign content, so an inert `<template>` yields a real namespaced `<math>` node. The
 * markup is MathJax-generated (a structured serialization of the expression, never raw user HTML),
 * and a `<template>` is inert (no scripts run, no resources load); we return only the `<math>` root.
 *
 * @param mml - The MathML markup string (`<math>…</math>`).
 * @returns The parsed `<math>` element, or null when the string did not parse to one.
 */
function mathMLStringToNode(mml: string): Element | null {
  const template = document.createElement('template');
  template.innerHTML = mml.trim();
  const node = template.content.firstElementChild;
  return node?.localName === 'math' ? node : null;
}

/** The notation of a stem expression — selects which MathJax input jax converts it. */
type Notation = 'asciimath' | 'tex';

/** What a delimited run converts to, independent of where it was found. */
interface ParsedExpression {
  /** Raw expression with delimiters stripped. */
  expression: string;
  /** Original delimited source (including delimiters) — recorded for idempotent re-render restore. */
  source: string;
  /** Which input jax converts it. */
  notation: Notation;
  /** Block (display) vs inline layout. */
  display: boolean;
}

/** An inline/display delimited run inside a text node, with its offsets in that node's text. */
interface InlineSite extends ParsedExpression {
  /** The text node whose delimited run will be replaced. */
  textNode: Text;
  /** Character offset of the delimited run start within the text node. */
  start: number;
  /** Character offset just past the delimited run within the text node. */
  end: number;
}

/** A block stem site whose whole `.content` element holds one delimited display expression. */
interface BlockSite extends ParsedExpression {
  /** The `.stemblock .content` element whose contents will be replaced with the produced container. */
  content: Element;
}

// A delimited run anywhere in a text node: asciimath `\$…\$`, inline latexmath `\(…\)`, or display
// latexmath `\[…\]`. Each body is an unrolled loop matching every char up to the FIRST delimiter
// character — any non-backslash, or a backslash not immediately before the opening/closing delimiter
// char. This is behavior-equivalent to a non-greedy `[^]*?` body (bodies span newlines: display math
// can be multi-line) for all realistic math, but is provably linear-time: excluding the OPENING delim
// char from the body is what removes the O(n^2) global-scan blow-up on adversarial repeated openers
// (e.g. `\(\(\(…`). Caveat: a backslash placed IMMEDIATELY before a delimiter char ends the body
// there, so a body cannot contain a literal `\(`/`\[`/`\]`/`\)` nor the LaTeX line-break-spacing form
// `\\[2pt]` (its `\\` then `[` reads as an early stop). A provably-linear form that also handles that
// case needs lookahead-guarded escapes (which the ReDoS checker rejects as polynomial) or atomic
// groups (unsupported by the runtime); such content is left as literal text rather than typeset.
const INLINE_MATH_RE =
  /\\\$((?:[^\\]|\\(?!\$))*)\\\$|\\\(((?:[^\\]|\\(?![()]))*)\\\)|\\\[((?:[^\\]|\\(?![[\]]))*)\\\]/g;

/**
 * Classify a regex match of {@link INLINE_MATH_RE} into the expression, notation, and layout it
 * represents (asciimath `\$…\$`, inline latexmath `\(…\)`, or display latexmath `\[…\]`).
 *
 * @param match - A successful {@link INLINE_MATH_RE} match (its capture groups select the notation).
 * @returns The parsed expression details.
 */
function parseMatch(match: RegExpExecArray): ParsedExpression {
  const [source, asciimath, texInline, texDisplay] = match;
  const isAsciimath = asciimath !== undefined;
  return {
    expression: (asciimath ?? texInline ?? texDisplay ?? '').trim(),
    source,
    notation: isAsciimath ? 'asciimath' : 'tex',
    display: texDisplay !== undefined,
  };
}

/** Data attribute on a produced container recording the delimited source it was produced from. */
const SOURCE_ATTRIBUTE = 'data-stem-source';

/**
 * Collapse adjacent text nodes so the delimiter regex sees each run as one string.
 *
 * A refresh reaches this container as a patch rather than as fresh markup, and patching an element's
 * contents can leave what reads as one sentence spread over several text nodes. The delimiter regex
 * runs per text node, so an expression split across two of them would never match and would sit on
 * screen as raw `\$…\$`.
 *
 * @param container - The preview container to tidy in place.
 */
function joinTextRuns(container: HTMLElement): void {
  container.normalize();
}

/**
 * Collect the inline/display delimited math runs from the container's text nodes. Block stem
 * (`<div class="stemblock">`) is handled separately by {@link collectBlockSites} because its
 * expression is the whole `.content` text (Asciidoctor wraps the body in `\$…\$` or `\(…\)`/`\[…\]`).
 *
 * @param container - The preview container to scan.
 * @returns The discovered inline/display sites, in document order.
 */
function collectInlineSites(container: HTMLElement): InlineSite[] {
  const sites: InlineSite[] = [];
  // Skip text inside a stemblock's content (handled as a block), inside already-produced math, and
  // inside VERBATIM markup (`<pre>`/`<code>` — listing/literal/source blocks and inline monospace).
  // Asciidoctor emits literal `\[`/`\(`/`\$` there for escaped text and backslash/regex content (e.g.
  // a `/\[0-9\]+/` regex), which is NOT math: typesetting it would rip the sequence out of the
  // rendered code and corrupt it. Stem never renders inside `<pre>`/`<code>`, so this only excludes
  // false positives.
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (parent?.closest('.stemblock')) return NodeFilter.FILTER_REJECT;
      if (parent?.closest('mjx-container, math')) return NodeFilter.FILTER_REJECT;
      if (parent?.closest('pre, code')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node instanceof Text; node = walker.nextNode()) textNodes.push(node);

  for (const textNode of textNodes) {
    const text = textNode.data;
    INLINE_MATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_MATH_RE.exec(text)) !== null) {
      const parsed = parseMatch(match);
      sites.push({ ...parsed, textNode, start: match.index, end: match.index + parsed.source.length });
    }
  }
  return sites;
}

/**
 * Collect block stem sites: each `<div class="stemblock"><div class="content">…</div></div>` whose
 * content is a single delimited expression (`\$…\$` for asciimath, `\(…\)`/`\[…\]` for latexmath).
 * The whole `.content` is replaced with the produced display container.
 *
 * @param container - The preview container to scan.
 * @returns The discovered block sites.
 */
function collectBlockSites(container: HTMLElement): BlockSite[] {
  const sites: BlockSite[] = [];
  for (const content of container.querySelectorAll('.stemblock .content')) {
    if (content.querySelector('mjx-container, math')) continue; // already rendered (CHTML or MathML)
    const text = (content.textContent ?? '').trim();
    INLINE_MATH_RE.lastIndex = 0;
    const match = INLINE_MATH_RE.exec(text);
    if (!match || match[0].length !== text.length) continue; // not a single wrapped expression
    // Block stem is always display layout regardless of the delimiters Asciidoctor used.
    sites.push({ ...parseMatch(match), content, display: true });
  }
  return sites;
}

/**
 * Convert one site's expression to a rendered node, tagged with the original source for idempotent
 * re-render. Prefers NATIVE MathML (a `<math>` element the browser typesets) when the browser
 * supports it ({@link preferMathML}); otherwise produces a MathJax CHTML container. Errors are
 * non-fatal: a failed conversion returns null and the site is left untouched.
 *
 * @param mathJax - The ready MathJax global.
 * @param site - The expression to convert.
 * @returns The produced node (`<math>` or `mjx-container`), or null on failure.
 */
async function convertSite(mathJax: MathJaxGlobal, site: ParsedExpression): Promise<Element | null> {
  try {
    if (preferMathML()) {
      const node = await convertToMathML(mathJax, site);
      if (node) return node; // fall through to CHTML if the MathML jax was unavailable
    }
    const toChtml = site.notation === 'asciimath' ? mathJax.asciimath2chtmlPromise : mathJax.tex2chtmlPromise;
    if (typeof toChtml !== 'function') return null;
    const node = await toChtml(site.expression, { display: site.display });
    node.setAttribute(SOURCE_ATTRIBUTE, site.source);
    return node;
  } catch {
    // A malformed expression must never break the preview — leave its source in place.
    return null;
  }
}

/**
 * Convert a site to a native MathML `<math>` element via MathJax's `*2mmlPromise`. A display
 * (block) expression also gets `display="block"` so the browser lays it out as a centred block.
 * Returns null when the MathML jax is unavailable or the markup did not parse to a `<math>`.
 *
 * @param mathJax - The ready MathJax global.
 * @param site - The expression to convert.
 * @returns The produced `<math>` element, or null.
 */
async function convertToMathML(mathJax: MathJaxGlobal, site: ParsedExpression): Promise<Element | null> {
  const toMml = site.notation === 'asciimath' ? mathJax.asciimath2mmlPromise : mathJax.tex2mmlPromise;
  if (typeof toMml !== 'function') return null;
  const node = mathMLStringToNode(await toMml(site.expression, { display: site.display }));
  if (!node) return null;
  if (site.display) node.setAttribute('display', 'block');
  node.setAttribute(SOURCE_ATTRIBUTE, site.source);
  return node;
}

/**
 * Replace a block site's `.content` children with the produced container (keeping the wrapper divs
 * so the preview's block layout/spacing is preserved).
 *
 * @param content - The `.stemblock .content` element to repopulate.
 * @param node - The produced node (`<math>` or `mjx-container`).
 */
function replaceBlockSite(content: Element, node: Element): void {
  content.textContent = '';
  content.append(node);
}

/**
 * Replace an inline/display site's delimited run within its text node with the produced container,
 * splitting the text node so the surrounding prose is preserved.
 *
 * @param site - The text-node site to replace.
 * @param node - The produced node (`<math>` or `mjx-container`).
 */
function replaceInlineSite(site: InlineSite, node: Element): void {
  // Split off the run: [before][run][after]; `splitText` returns the node starting at the offset.
  const runNode = site.textNode.splitText(site.start);
  runNode.splitText(site.end - site.start); // leaves `runNode` == just the delimited run
  runNode.replaceWith(node);
}

/**
 * Typeset all STEM expressions inside an already-sanitized preview container, in place, by
 * converting each delimited expression explicitly (no MathJax auto delimiter-scan — that mishandles
 * Asciidoctor's `\$…\$` and leaves a stray `$`). Inline `\$…\$`/`\(…\)`, display `\[…\]`, and block
 * `<div class="stemblock">` are all handled, for both AsciiMath and LaTeX. Per-expression errors are
 * non-fatal and this function resolves even on engine failure, so malformed math (or a missing
 * bundle) can never break the preview — the source delimiters simply remain.
 *
 * @param container - The scoped `.asciidoc-preview-content` element holding the sanitized HTML.
 * @returns A promise resolving when conversion completes (or is safely skipped on failure).
 */
export async function renderMath(container: HTMLElement): Promise<void> {
  try {
    const mathJax = await loadMathJax();
    if (
      typeof mathJax?.tex2chtmlPromise !== 'function' &&
      typeof mathJax?.asciimath2chtmlPromise !== 'function'
    ) {
      return;
    }

    // An expression that is ALREADY typeset is left exactly as it is — the node itself, not a fresh
    // one that looks the same. It stays because the only thing that can put a typeset expression back
    // to its delimited source is the preview's DOM patch, and that happens precisely when the source
    // changed; anything still typeset here is therefore still current. Typesetting it again would
    // throw away work MathJax has already done, and take the node's identity with it — a reader's
    // focus and the browser's own layout of it included — for output identical to what was there.
    //
    // This pass is consequently additive: it converts the delimited runs the patch has just brought
    // in, and touches nothing else. The collectors below already refuse to look inside a produced
    // `<math>`/`mjx-container`, so nothing is ever converted twice.
    joinTextRuns(container);

    // Discover every expression. Inline/display sites carry text-node offsets that shift as earlier
    // sites in the same text node are replaced, so replace each text node's sites from LAST to FIRST.
    const blockSites = collectBlockSites(container);
    const inlineSites = collectInlineSites(container);

    // Convert block sites (independent elements — order does not matter).
    for (const site of blockSites) {
      const node = await convertSite(mathJax, site);
      if (node) replaceBlockSite(site.content, node);
    }

    // Convert inline/display sites. Replacing right-to-left within each text node keeps the earlier
    // sites' offsets valid (a left replacement would shift everything after it).
    const inlineByNode = new Map<Text, InlineSite[]>();
    for (const site of inlineSites) {
      const list = inlineByNode.get(site.textNode) ?? [];
      list.push(site);
      inlineByNode.set(site.textNode, list);
    }
    for (const list of inlineByNode.values()) {
      const converted: Array<{ site: InlineSite; node: Element }> = [];
      for (const site of list) {
        const node = await convertSite(mathJax, site);
        if (node) converted.push({ site, node });
      }
      // Replace from the rightmost run to the leftmost so offsets stay valid mid-loop.
      converted.sort((a, b) => b.site.start - a.site.start);
      for (const { site, node } of converted) replaceInlineSite(site, node);
    }

    // Attach the CHTML stylesheet/fonts for the math now in the DOM. `clear()` drops any stale record
    // so `updateDocument()` recomputes styles for exactly what is present after this pass.
    mathJax.startup?.document?.clear();
    mathJax.startup?.document?.updateDocument();
  } catch {
    // A failure here means the engine itself could not load/run; swallow it so the rest of the
    // preview stays intact — math simply remains as its source delimiters.
  }
}

/**
 * Reset the singleton load cache and the cached MathML-support probe. Test-only hook.
 *
 * @internal
 */
export function resetMathJaxForTest(): void {
  mathJaxLoad = null;
  mathMLSupported = null;
}
