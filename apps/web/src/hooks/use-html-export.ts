'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type { HtmlExportPackaging, HtmlExportStyle, HtmlExportTheme } from '@asciidocollab/shared';
import { createRenderWorker } from '@/lib/create-render-worker';
import { projectAssetUrl } from '@/lib/pdf/fetch-project-asset';
import { collectAppFontFaceCss } from '@/lib/html-export/app-fonts';
import {
  buildStandaloneHtml,
  composeExportCss,
  type ExportDocumentDetails,
} from '@/lib/html-export/build-standalone-html';
import { filterFontFaces, resolveFontFaces } from '@/lib/html-export/font-faces';
import {
  resolveImageAssets,
  type AssetFailure,
  type AssetFetcher,
  type ExportAsset,
} from '@/lib/html-export/inline-assets';
import { usedFontFamilies } from '@/lib/html-export/math-fonts';
import { prerenderContent } from '@/lib/html-export/prerender-content';
import {
  downloadExport,
  packageExport,
  stylesheetAsset,
  ZIP_STYLESHEET_NAME,
  type PackagedExport,
} from '@/lib/html-export/package-export';

/** The stages an export passes through, in pipeline order, as reported to the trigger. */
export type HtmlExportPhase = 'rendering' | 'diagrams-math' | 'assets' | 'packaging';

/** Stable empty reference so an idle export and a clean one share one array identity. */
const NO_FAILURES: readonly AssetFailure[] = [];

/** Message shape the render worker replies with; only the parts an export consumes are declared. */
interface RenderResult {
  requestId: number;
  ok: boolean;
  html: string | null;
  error: string | null;
  mathPresent?: boolean;
  diagramsPresent?: boolean;
  details?: ExportDocumentDetails & { title?: string; lang?: string };
}

/** Everything one export needs, resolved by the caller at click time. */
export interface HtmlExportRequest {
  /** Project-relative path of the render root — the main document, exactly as the PDF export uses it. */
  readonly rootPath: string;
  /** The project's display name, which the downloaded file is named after (never the render root). */
  readonly projectName: string;
  /** Project-relative path → content for the whole tree, so includes can be assembled. */
  readonly files: Record<string, string>;
  /** Project render-config attributes (already soft-defaulted), seeded beneath the document's own. */
  readonly projectAttributes?: Record<string, string>;
  /** Whether to produce one self-contained file or a zip holding the document beside its images. */
  readonly packaging: HtmlExportPackaging;
  /** Which stylesheet to dress the exported document in. */
  readonly style: HtmlExportStyle;
  /** Which palette to bake into it. */
  readonly theme: HtmlExportTheme;
}

/** Injectable seams for {@link useHtmlExport}; every unset seam uses its real implementation. */
export interface UseHtmlExportOptions {
  /** The project whose asset endpoint the exported images are pulled from. */
  readonly projectId: string;
  /** Builds the render worker. Injected in tests so no real Asciidoctor bundle is loaded. */
  readonly createWorker?: () => Worker;
  /** Retrieves one image's bytes; defaults to the project's authenticated asset endpoint. */
  readonly fetchAsset?: AssetFetcher;
  /** Retrieves one font file's bytes; defaults to a plain same-origin request. */
  readonly fetchFont?: AssetFetcher;
  /**
   * Hands the finished bytes to the browser; injected so a test can observe them.
   *
   * @param packaged - The bytes and file name to save.
   */
  readonly download?: (packaged: PackagedExport) => void;
}

/** The value and behaviour a one-click HTML export exposes to the UI. */
export interface UseHtmlExportResult {
  /**
   * Kick off an export. Supersedes any in-flight export: only the latest request's result is
   * honoured, and its document is downloaded automatically.
   *
   * @param request - The render root, its file tree, and the resolved export options.
   */
  exportHtml: (request: HtmlExportRequest) => void;
  /** True from `exportHtml` until the download is handed over or the export fails. */
  isExporting: boolean;
  /** The stage the current export has reached, once it has started. */
  phase?: HtmlExportPhase;
  /** The failure message from the last export, if it failed as a whole. */
  error?: string;
  /** Images the last export could not retrieve; their references were left pointing where they were. */
  failures: readonly AssetFailure[];
}

/** The body the render worker produced, plus the document header it resolved. */
interface RenderedDocument {
  readonly html: string;
  readonly title?: string;
  readonly lang?: string;
  readonly details: ExportDocumentDetails;
  /** Whether the body carries in-effect stem math, so MathJax is only loaded when there is math. */
  readonly math: boolean;
  /** Whether the body carries diagram placeholders, so the diagram engines are only loaded for them. */
  readonly diagrams: boolean;
}

/**
 * Render the whole document, rooted at the main file, and resolve with its body and header.
 *
 * `imagesDir` is deliberately NOT passed. In the preview it maps each image onto the authenticated
 * endpoint, which is right on screen and wrong in a file; leaving it unset keeps every `<img src>` a
 * project-relative path, which is exactly the key the asset step fetches by.
 *
 * `showIncludes` is forced on: an export is the whole document, like the PDF, never the placeholder
 * view the panel shows while an author is working on one file.
 *
 * @param worker - The render worker to drive; it serves this one request and is then discarded.
 * @param request - The export request supplying the root, the file tree and the project attributes.
 * @returns The rendered body and the document header Asciidoctor resolved.
 */
function requestRender(worker: Worker, request: HtmlExportRequest): Promise<RenderedDocument> {
  return new Promise((resolve, reject) => {
    worker.addEventListener(
      'message',
      (event: MessageEvent<RenderResult>) => {
        const result = event.data;
        if (!result.ok || result.html === null) {
          reject(new Error(result.error ?? 'The document could not be rendered.'));
          return;
        }
        const details = result.details ?? {};
        resolve({
          html: result.html,
          math: result.mathPresent === true,
          diagrams: result.diagramsPresent === true,
          ...(details.title === undefined ? {} : { title: details.title }),
          ...(details.lang === undefined ? {} : { lang: details.lang }),
          details: {
            ...(details.author === undefined ? {} : { author: details.author }),
            ...(details.revnumber === undefined ? {} : { revnumber: details.revnumber }),
            ...(details.revdate === undefined ? {} : { revdate: details.revdate }),
          },
        });
      },
      { once: true },
    );
    worker.addEventListener('error', () => reject(new Error('The render engine could not be started.')), {
      once: true,
    });

    worker.postMessage({
      requestId: 1,
      content: request.files[request.rootPath] ?? '',
      openFileId: request.rootPath,
      files: request.files,
      showIncludes: true,
      // No scroll-sync hints in an exported file: nothing reads them once the document leaves the app,
      // and generating them would put synthetic `__src_paragraph_241`-style ids into the published id
      // namespace beside the author's own anchors. Asked for at render time rather than stripped
      // afterwards, so no pass ever has to tell a synthetic id from a real one.
      sourceLineHints: false,
      ...(request.projectAttributes === undefined ? {} : { projectAttributes: request.projectAttributes }),
    });
  });
}

/** Fetch one project-relative image from the authenticated asset endpoint. */
async function fetchProjectImage(
  projectId: string,
  source: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const response = await fetch(projectAssetUrl(projectId, source), { credentials: 'include' });
  if (!response.ok) return null;
  const buffer = await response.arrayBuffer();
  // The server's own content type is the authority — the endpoint's paths do not always carry a usable
  // extension, and the exported `data:` URI has to declare the right type or nothing renders it.
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  return { bytes: new Uint8Array(buffer), contentType };
}

/** Font MIME types by extension, for a server that declares something unhelpful. */
const FONT_TYPE_BY_EXTENSION: Record<string, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

/**
 * Fetch one font file from the app's own origin.
 *
 * Same-origin and unauthenticated: these are the app's static assets (`/_next/static/media/…`,
 * `/vendor/mathjax/…`), not project content, so no credentials are sent.
 *
 * The type is taken from the PATH first, unlike an image. A font URL always carries a real extension,
 * while a static-file server often labels one `application/octet-stream` — and a `data:` URI with that
 * type is a font some browsers refuse to use.
 *
 * @param url - The absolute or app-relative URL of the file.
 * @returns The bytes and MIME type, or null when the request was refused.
 */
async function fetchFontFile(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const response = await fetch(url);
  if (!response.ok) return null;
  const buffer = await response.arrayBuffer();
  const extension = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() ?? '';
  const contentType =
    FONT_TYPE_BY_EXTENSION[extension] ?? response.headers.get('content-type') ?? 'font/woff2';
  return { bytes: new Uint8Array(buffer), contentType };
}

/**
 * The stylesheet text the rendered content needs, with every font it references carried by the export.
 *
 * Two sources of `@font-face`, both of which point at the app's own origin and would otherwise leave
 * the exported file asking a stranger's browser for `http://localhost:3000/…`:
 *
 *   - The app's own webfaces, which the document is actually set in.
 *   - MathJax's CHTML stylesheet, which declares a face for all 22 of its fonts whether the document
 *     uses one or none. Only the families the rendered markup asks for survive; a document with no
 *     maths, or one typeset as native MathML, ships no maths fonts at all.
 *
 * @param style - The export style, selecting which of the app's families the document is set in.
 * @param renderedHtml - The finished body, which decides which MathJax families are needed.
 * @param mathCss - The stylesheet MathJax injected, empty when the document has no maths.
 * @param packaging - Whether the files are embedded or written beside the document.
 * @param fetchFont - How to retrieve one font file.
 * @returns The stylesheet text and any font files to place beside the document.
 */
async function resolveFonts(
  style: HtmlExportStyle,
  renderedHtml: string,
  mathCss: string,
  packaging: HtmlExportPackaging,
  fetchFont: AssetFetcher,
): Promise<{ css: string; assets: readonly ExportAsset[] }> {
  const usedByMath = mathCss === '' ? new Set<string>() : usedFontFamilies(mathCss, renderedHtml);
  const trimmedMathCss = filterFontFaces(mathCss, (face) => usedByMath.has(face.family));
  const css = [collectAppFontFaceCss(style), trimmedMathCss].filter((part) => part.length > 0).join('\n\n');
  // Font failures are not reported to the user: unlike a missing image, a font that could not be
  // retrieved costs nothing but the exact typeface — `resolveFontFaces` drops the face and the text
  // renders in the next family of the stack.
  const resolved = await resolveFontFaces(css, fetchFont, packaging);
  return { css: resolved.css, assets: resolved.assets };
}

/**
 * Drives a one-click, fully client-side HTML export.
 *
 * The pipeline mirrors what the preview panel does to show a document, then keeps going: render the
 * assembled document in a worker, finish its diagrams and maths on the main thread the way the panel
 * finishes them, resolve every image into the file, and assemble a real standalone page around the
 * result. Each stage lives in its own module under `lib/html-export`; this hook is the sequencing and
 * the lifecycle around them.
 *
 * The worker is created per export and terminated afterwards rather than kept warm. Unlike the preview
 * — which re-renders on every keystroke — an export is a rare, deliberate action, so a second permanent
 * Asciidoctor worker would cost every session's memory to save a few seconds in the ones that export.
 *
 * @param options - The project the export belongs to, plus any injected seams.
 * @returns The trigger and the state the UI renders from.
 */
export function useHtmlExport(options: UseHtmlExportOptions): UseHtmlExportResult {
  const [isExporting, setIsExporting] = useState(false);
  const [phase, setPhase] = useState<HtmlExportPhase | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [failures, setFailures] = useState<readonly AssetFailure[]>(NO_FAILURES);

  // Read at export time, not captured: `exportHtml` is a stable callback, so closing over these would
  // pin whichever values existed when the hook first ran.
  const optionsReference = useRef(options);
  optionsReference.current = options;

  // The worker serving the current export, and a monotonic counter identifying it. A superseded
  // export's late stages are dropped by comparing the counter, exactly as the PDF export does.
  const workerReference = useRef<Worker | null>(null);
  const runReference = useRef(0);

  useEffect(
    () => () => {
      workerReference.current?.terminate();
      workerReference.current = null;
    },
    [],
  );

  const exportHtml = useCallback((request: HtmlExportRequest) => {
    const { projectId, createWorker, fetchAsset, fetchFont, download } = optionsReference.current;

    runReference.current += 1;
    const run = runReference.current;
    // Supersede any export still in flight; its worker is abandoned mid-render.
    workerReference.current?.terminate();
    const worker = (createWorker ?? createRenderWorker)();
    workerReference.current = worker;

    setIsExporting(true);
    setPhase('rendering');
    setError(undefined);
    setFailures(NO_FAILURES);

    const isCurrent = () => runReference.current === run;

    void (async () => {
      try {
        const rendered = await requestRender(worker, request);
        if (!isCurrent()) return;

        // Sanitized on the same profile the preview uses, before anything renders into a live DOM.
        const bodyHtml = DOMPurify.sanitize(rendered.html, { USE_PROFILES: { html: true } });

        setPhase('diagrams-math');
        // Only the engines this document actually needs are loaded; both are heavy and lazily imported.
        const { html: renderedHtml, extraCss, assets: diagramAssets } = await prerenderContent(
          bodyHtml,
          request.style,
          {
            diagrams: rendered.diagrams,
            math: rendered.math,
            // A zip stores each diagram as its own `.svg` and links to it, the way it already stores
            // the document's images, fonts and stylesheet; a single file has nowhere to put them, so
            // they stay inline. One decision, taken from the packaging, rather than two paths.
            diagramPackaging: request.packaging === 'zip' ? 'extract' : 'inline',
          },
        );
        if (!isCurrent()) return;

        setPhase('assets');
        const fetcher: AssetFetcher = fetchAsset ?? ((source) => fetchProjectImage(projectId, source));
        const resolved = await resolveImageAssets(renderedHtml, fetcher, request.packaging);
        if (!isCurrent()) return;

        // The document's fonts travel with it too, or the file only looks right on the machine that
        // made it — and, worse, tells its reader where that machine was.
        const fonts = await resolveFonts(
          request.style,
          resolved.html,
          extraCss,
          request.packaging,
          fetchFont ?? fetchFontFile,
        );
        if (!isCurrent()) return;

        setPhase('packaging');
        const document_ = {
          bodyHtml: resolved.html,
          ...(rendered.title === undefined ? {} : { title: rendered.title }),
          details: rendered.details,
          style: request.style,
          theme: request.theme,
          ...(rendered.lang === undefined ? {} : { lang: rendered.lang }),
          ...(fonts.css === '' ? {} : { extraCss: fonts.css }),
        };
        // A zip links its stylesheet; a single file inlines it. Both texts come from the same
        // `composeExportCss`, so the two packagings cannot drift apart.
        const isZip = request.packaging === 'zip';
        const page = buildStandaloneHtml(
          isZip ? { ...document_, stylesheetHref: ZIP_STYLESHEET_NAME } : document_,
        );
        const files = isZip
          ? [
              ...resolved.assets,
              ...diagramAssets,
              ...fonts.assets,
              stylesheetAsset(composeExportCss(document_)),
            ]
          : resolved.assets;
        const packaged = packageExport(page, files, request.packaging, request.projectName);
        (download ?? downloadExport)(packaged);

        setFailures(resolved.failures.length > 0 ? resolved.failures : NO_FAILURES);
        setIsExporting(false);
        setPhase(undefined);
      } catch (error_) {
        if (!isCurrent()) return;
        setError(error_ instanceof Error ? error_.message : String(error_));
        setIsExporting(false);
        setPhase(undefined);
      } finally {
        if (workerReference.current === worker) {
          worker.terminate();
          workerReference.current = null;
        }
      }
    })();
  }, []);

  return { exportHtml, isExporting, phase, error, failures };
}
