import type { PDFDocumentProxy } from "pdfjs-dist";
import type { AnnotationLayer } from "pdfjs-dist";
import { clamp } from "@/lib/utilities";

/**
 * The pdf.js link service the PDF preview renders link annotations through.
 *
 * This module is the single, deliberately-contained boundary where the preview's minimal link service
 * is reconciled to pdf.js's declared one, mirroring `packages/asciidoc-pdf/src/vm/wasi-bridge.ts`.
 *
 * In pdfjs-dist 6 the slot is typed as the concrete `PDFLinkService` from its bundled web viewer. That class
 * cannot be constructed here — the viewer bundle needs a `globalThis.pdfjsLib` and its `EventBus` is
 * not exported from the package entry — and its remaining members (event bus, external-link targets,
 * presentation-mode plumbing, destination zoom) are viewer chrome the preview has no counterpart for.
 * The runtime does not need them: `AnnotationLayer` takes the service through its CONSTRUCTOR, stores
 * it privately, and `render()` reads that private copy rather than its own `linkService` parameter —
 * so only the members implemented below are ever reached for a link annotation.
 *
 * That leaves a declared contract that cannot be satisfied cast-free, which is why the no-assertions
 * rule is relaxed for THIS FILE ONLY (see eslint.config.js) and every other web source file stays
 * cast-free. `PreviewLinkService` below keeps the implementation itself structurally checked.
 */

/** The slice of pdf.js's link-service contract this preview actually implements. */
interface PreviewLinkService {
  pagesCount: number;
  page: number;
  rotation: number;
  isInPresentationMode: boolean;
  externalLinkEnabled: boolean;
  addLinkAttributes(link: HTMLAnchorElement, url: string): void;
  getDestinationHash(): string;
  getAnchorUrl(): string;
  goToDestination(destination: string | unknown[]): Promise<void>;
  goToPage(): void;
  setHash(): void;
  executeNamedAction(): void;
  executeSetOCGState(): Promise<void>;
}

/** The link-service type pdf.js's annotation layer declares. */
export type PdfLinkService = Parameters<AnnotationLayer["render"]>[0]["linkService"];

/** The same top breathing room applied when an internal link scrolls its destination into view. */
const INTERNAL_LINK_TOP_MARGIN = 12;

/**
 * Build the pdf.js link service the annotation layer renders link annotations through, scoped to one
 * loaded document. External `http(s)` links become hardened new-tab anchors; internal links
 * (cross-references, the TOC, figure/image refs) resolve their destination against the document and
 * scroll the target page into view — offset within the page when the destination carries a y-coordinate.
 * Invalid or missing destinations are swallowed so a dead link never throws.
 *
 * @param binding - The loaded pdf.js document and the page-stack container/scroll viewport to scroll.
 * @param binding.pdfDocument - The loaded document, used to resolve a destination to a page index.
 * @param binding.pagesContainer - The stack whose children are the rendered page elements.
 * @param binding.scrollContainer - The scroll viewport whose `scrollTop` positions the destination.
 * @returns A link service satisfying the annotation layer's contract for this document.
 */
export function createPreviewLinkService(binding: {
  pdfDocument: PDFDocumentProxy;
  pagesContainer: HTMLElement;
  scrollContainer: HTMLElement;
}): PdfLinkService {
  const { pdfDocument, pagesContainer, scrollContainer } = binding;

  /** Scroll the resolved 0-based page index into view, offsetting within it by `yFraction` when known. */
  const scrollToPage = (pageIndex: number, yFraction: number | null): void => {
    const pageElement = pagesContainer.children[pageIndex];
    if (!(pageElement instanceof HTMLElement)) return;
    if (yFraction === null) {
      pageElement.scrollIntoView({ block: "start" });
      return;
    }
    // offsetTop/offsetHeight are layout metrics that ignore any CSS zoom transform, so the target stays
    // correct while a debounced re-paint is pending.
    scrollContainer.scrollTop =
      pageElement.offsetTop + yFraction * pageElement.offsetHeight - INTERNAL_LINK_TOP_MARGIN;
  };

  return {
    pagesCount: 0,
    page: 0,
    rotation: 0,
    isInPresentationMode: false,
    externalLinkEnabled: true,
    addLinkAttributes(link: HTMLAnchorElement, url: string) {
      link.href = url;
      link.title = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    },
    getDestinationHash() {
      // The href is cosmetic — navigation happens through goToDestination on click — so an empty hash
      // is fine and avoids fabricating a page-anchor the scrollable preview has no location bar for.
      return "";
    },
    getAnchorUrl() {
      return "";
    },
    async goToDestination(destination: string | unknown[]) {
      try {
        const explicit =
          typeof destination === "string"
            ? await pdfDocument.getDestination(destination)
            : destination;
        if (!Array.isArray(explicit) || explicit.length === 0) return;
        const pageIndex = await pdfDocument.getPageIndex(explicit[0]);
        if (!Number.isInteger(pageIndex) || pageIndex < 0) return;
        // An explicit destination is `[pageRef, {name}, x, y, zoom]`; a numeric y is the target's top in
        // PDF points measured up from the page bottom. Convert it to a fraction from the top.
        const y = explicit[3];
        if (typeof y === "number" && Number.isFinite(y)) {
          const page = await pdfDocument.getPage(pageIndex + 1);
          const heightPoints = page.getViewport({ scale: 1 }).height;
          const fraction = heightPoints > 0 ? clamp((heightPoints - y) / heightPoints, 0, 1) : 0;
          scrollToPage(pageIndex, fraction);
        } else {
          scrollToPage(pageIndex, null);
        }
      } catch {
        // A missing/invalid destination must not throw; leave the view where it is.
      }
    },
    goToPage() {
      // The preview renders every page at once, so there is nothing to navigate to.
    },
    setHash() {
      // The preview has no addressable location bar to update.
    },
    executeNamedAction() {
      // Named actions (print, next-page, …) have no meaning in a scrollable preview.
    },
    // Async because pdfjs-dist 6 types this as returning a promise.
    async executeSetOCGState() {
      // Optional-content toggles are not exposed by the preview.
    },
  } satisfies PreviewLinkService as unknown as PdfLinkService;
}
