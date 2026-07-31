/**
 * @file The declared size bound for the page-formatted render, and the refusal it produces.
 *
 * The render engine runs as a 32-bit WebAssembly program, so everything it allocates — the parsed
 * document, the laid-out page tree, the throwaway scratch document each keep-together block is
 * measured in, the font subsets — has to fit inside a single 4 GiB linear address space that only ever
 * grows. Measurement against the real engine (see the size-limit harness under `tests/integration/`)
 * shows that address space is what actually ends a render: consumption rises with the amount of
 * content, and once the space is exhausted the engine fails part-way through with an allocation error
 * or a pointer that has run past the range the host can address. Neither is intelligible to an author,
 * and neither leaves a usable VM behind.
 *
 * So the size is checked BEFORE the engine is asked to convert, and a document past the bound is
 * refused with a message that names the bound and what to do about it. A declared limit and an
 * unannounced one are different products; only the first can be planned around.
 *
 * The bound is expressed in BYTES OF ASSEMBLED SOURCE rather than in lines or in printed pages,
 * because that is the only one of the three that both predicts the failure and is knowable before the
 * render. Line count does not: measured across two document shapes, the same memory ceiling arrived at
 * 6,000 lines of section-and-code-block writing and at 700 lines of long-form prose — a factor of
 * eight apart, while their source sizes were within 10% of each other. Page count predicts it well but
 * is a RESULT of the render, so a bound stated in pages could only be enforced after the failure it
 * exists to prevent.
 */

/**
 * The largest assembled AsciiDoc source, in bytes, the page-formatted render supports.
 *
 * Measured, not assumed. Against the real engine, a section-and-code-block document of 131 kB rendered
 * (115 pages) while consuming 4,094 MiB of the 4,096 MiB address space, and 142 kB failed; a long-form
 * prose document of 140 kB rendered (43 pages) at 3,510 MiB and 200 kB failed. So the engine's own
 * ceiling sits between roughly 131 kB and 142 kB for the more memory-hungry of the two shapes.
 *
 * The declared bound is set below that, at a round 100 kB, for two reasons the measurement itself
 * cannot cover. The sweep documents are text only, and embedded diagrams and images allocate far more
 * per byte of source than prose does. And a render at 99% of the address space leaves nothing behind
 * for the next one in a VM that is reused across renders — the space is never returned. Headroom here
 * buys the difference between "this document is too big" and "this session is now broken".
 */
export const MAX_PAGE_FORMAT_SOURCE_BYTES = 100_000;

/** The stable machine code carried by a render refused for exceeding {@link MAX_PAGE_FORMAT_SOURCE_BYTES}. */
export const DOCUMENT_TOO_LARGE_CODE = 'document-too-large';

/** How a document's measured size compares against the declared bound. */
export interface DocumentSizeAssessment {
  /** The assembled source size that was measured, in bytes. */
  readonly bytes: number;
  /** The bound it was judged against, carried alongside so the refusal can state both. */
  readonly limitBytes: number;
  /** Whether the render may proceed. */
  readonly withinLimit: boolean;
}

const BYTES_PER_KILOBYTE = 1000;

const encoder = new TextEncoder();

/**
 * The encoded byte length of AsciiDoc source — what the engine has to hold, as opposed to what a
 * character count suggests.
 *
 * @param source - The AsciiDoc source to measure.
 * @returns The number of bytes that source occupies once encoded.
 */
export function sourceByteLength(source: string): number {
  return encoder.encode(source).byteLength;
}

/**
 * Judge a measured source size against the declared bound.
 *
 * A size that is not a usable measurement (not finite, or negative) is treated as WITHIN the bound.
 * The bound exists to replace an unexplained failure with an explained one; refusing a render because
 * its size could not be read would put back a failure nobody can act on, in a new disguise.
 *
 * @param sourceBytes - The assembled source size in bytes, as measured by the caller.
 * @returns The assessment, carrying the measurement, the bound, and whether the render may proceed.
 */
export function assessDocumentSize(sourceBytes: number): DocumentSizeAssessment {
  const measurable = Number.isFinite(sourceBytes) && sourceBytes >= 0;
  return {
    bytes: sourceBytes,
    limitBytes: MAX_PAGE_FORMAT_SOURCE_BYTES,
    withinLimit: !measurable || sourceBytes <= MAX_PAGE_FORMAT_SOURCE_BYTES,
  };
}

/** Present a byte count the way an author reads a document size. */
function kilobytes(bytes: number): string {
  return `${Math.round(bytes / BYTES_PER_KILOBYTE)} kB`;
}

/**
 * The user-facing refusal for a document past the bound: what its size is, what the bound is, why the
 * bound exists, and the two things that get the author moving again.
 *
 * The engine's own error text is deliberately NOT quoted. An allocation failure inside a 32-bit
 * runtime describes the runtime, not the document, and an author reading it learns only that something
 * broke. What they can act on is the size and the two ways around it.
 *
 * @param assessment - The assessment that refused the render.
 * @returns The message to surface to the author.
 */
export function documentTooLargeMessage(assessment: DocumentSizeAssessment): string {
  return (
    `This document is ${kilobytes(assessment.bytes)} of AsciiDoc, larger than the ` +
    `${kilobytes(assessment.limitBytes)} the page-formatted (PDF) render supports. Past that size the ` +
    'render runs out of the memory available to it and stops part-way through, so it is refused here ' +
    'instead. Point the project’s main document at a smaller part of the work — one chapter at a time ' +
    'renders and exports normally — or carry on in the web-formatted preview, which has no size limit.'
  );
}
