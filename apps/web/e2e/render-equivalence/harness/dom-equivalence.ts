/**
 * @file Reduces rendered preview HTML to a canonical form two renders can be compared on, and
 * describes the difference when they disagree.
 *
 * The reduction decides what counts as "the same render". It deliberately erases only differences a
 * reader could not perceive and a browser could not act on — how the markup was laid out on the page,
 * and the order attributes happened to be written in. Everything else is compared, including two
 * things a looser comparison would be tempted to normalise:
 *
 *   - `id` attributes. A changed identifier leaves the visible text untouched and silently breaks every
 *     cross-reference that pointed at it. This is exactly the failure the gate exists to catch, so ids
 *     are compared verbatim and are additionally extracted into their own sequence, so a rename is
 *     reported as a rename rather than buried in a wall of markup.
 *   - `data-source-line` / `data-source-file`. The editor navigates by them: click-to-source and
 *     scroll-sync are behaviour carried entirely in those attributes.
 *
 * Whitespace is collapsed BETWEEN elements only. Inside `<pre>`, `<code>` and the diagram placeholder,
 * whitespace is content — indentation in a code block and line structure in a diagram source are things
 * the reader sees — so text there is compared byte for byte apart from line endings.
 *
 * A rendered preview is a document fragment, and the HTML parser puts some of a fragment's leading
 * content — a `<style>` or `<meta>` written by a passthrough block — in `<head>` rather than in the
 * body. Both are walked, so nothing the render emitted falls outside the comparison.
 *
 * {@link canonicaliseRenderedHtml} runs inside a real browser page (it is handed to `page.evaluate`),
 * which is why it is written self-contained, with no reference to anything outside its own body: a real
 * HTML parser is the only honest way to decide what markup means, and hand-rolling one would make the
 * gate's verdict a property of the parser rather than of the render.
 */

/**
 * A rendered document reduced to the three sequences the gate compares.
 */
export interface CanonicalDocument {
  /** The element tree in document order: one indented entry per element, text node and comment. */
  readonly lines: readonly string[];
  /** Every `id` in document order, tagged with its element, e.g. `h2#installation`. */
  readonly identifiers: readonly string[];
  /** Every source-provenance marker in document order, e.g. `h2 chapter-one.adoc:8`. */
  readonly provenance: readonly string[];
}

/**
 * Reduce rendered HTML to its canonical form by parsing it with the browser's own HTML parser.
 *
 * Runs in the page, so it must stay free of references to module scope.
 *
 * @param html - The rendered HTML to canonicalise.
 * @returns The document's canonical element tree, identifiers and provenance markers.
 */
export function canonicaliseRenderedHtml(html: string): CanonicalDocument {
  const lines: string[] = [];
  const identifiers: string[] = [];
  const provenance: string[] = [];

  // Elements whose text content is verbatim by nature: code keeps its indentation, a diagram
  // placeholder carries diagram source whose line structure is part of the diagram. `adc-diagram` is
  // listed as both a tag and a class because the preview's placeholder is a `div` carrying the class,
  // while the canonical form the reference gate reduces BOTH toolchains' diagram blocks to is an
  // element of that name — and indentation is content in a diagram source either way.
  const verbatimTags = new Set(['pre', 'code', 'textarea', 'adc-diagram']);
  const verbatimClass = 'adc-diagram';

  const walk = (node: Node, depth: number, verbatim: boolean): void => {
    const indent = '  '.repeat(depth);

    if (node instanceof Element) {
      const tag = node.tagName.toLowerCase();
      // Sorting the names is the whole of the attribute-order normalisation: values are untouched.
      let line = `${indent}<${tag}`;
      let identifier: string | null = null;
      let sourceFile: string | null = null;
      let sourceLine: string | null = null;
      for (const name of node.getAttributeNames().toSorted()) {
        const value = node.getAttribute(name) ?? '';
        line += ` ${name}=${JSON.stringify(value)}`;
        switch (name) {
          case 'id': {
            identifier = value;
            break;
          }
          case 'data-source-file': {
            sourceFile = value;
            break;
          }
          case 'data-source-line': {
            sourceLine = value;
            break;
          }
          default: {
            break;
          }
        }
      }
      lines.push(`${line}>`);

      if (identifier !== null) {
        identifiers.push(`${tag}#${identifier}`);
      }
      if (sourceLine !== null || sourceFile !== null) {
        provenance.push(`${tag} ${sourceFile ?? '(no file)'}:${sourceLine ?? '(no line)'}`);
      }

      const childrenAreVerbatim =
        verbatim || verbatimTags.has(tag) || node.classList.contains(verbatimClass);
      for (const child of node.childNodes) {
        walk(child, depth + 1, childrenAreVerbatim);
      }
      return;
    }

    if (node instanceof Comment) {
      lines.push(`${indent}comment ${JSON.stringify(node.data.replaceAll(/[\t\n\r ]+/g, ' ').trim())}`);
      return;
    }

    if (node instanceof Text) {
      if (verbatim) {
        lines.push(`${indent}text ${JSON.stringify(node.data.replaceAll('\r\n', '\n'))}`);
        return;
      }
      const text = node.data.replaceAll(/[\t\n\r ]+/g, ' ').trim();
      if (text.length > 0) {
        lines.push(`${indent}text ${JSON.stringify(text)}`);
      }
    }
  };

  const parsed = new DOMParser().parseFromString(html, 'text/html');
  // The head is walked as well as the body, and first. Rendered previews are document FRAGMENTS, and
  // the HTML parser hoists a few things it meets before any body content — a `<style>`, `<meta>` or
  // `<link>` from a passthrough block at the top of a document — into `<head>` instead. A walk of the
  // body alone would drop them from the comparison entirely, so a passthrough that changed or
  // disappeared would read as agreement. Their position relative to the body is the parser's, not the
  // render's, which is why they are compared as a group at the front rather than in place.
  for (const child of [...parsed.head.childNodes, ...parsed.body.childNodes]) {
    walk(child, 0, false);
  }
  return { lines, identifiers, provenance };
}

/** How many differing entries a single report prints before it says how many more there were. */
const MAX_REPORTED_ENTRIES = 10;

/** How many matching entries are printed before the first difference, to place it in the document. */
const CONTEXT_ENTRIES = 3;

/**
 * Describe how two sequences disagree, anchored at the first entry that differs.
 *
 * Alignment matters more than exhaustiveness here: one inserted element shifts every later entry, and
 * a report that listed all of them would say "everything changed" about a one-element insertion. The
 * common prefix and common suffix are therefore trimmed away first, so what is printed is the part
 * that genuinely differs.
 *
 * @param label - What the sequence is, used as the report's heading.
 * @param fixture - The captured sequence.
 * @param current - The sequence from today's render.
 * @returns A human-readable report, or `null` when the sequences are identical.
 */
export function describeSequenceDifference(
  label: string,
  fixture: readonly string[],
  current: readonly string[],
): string | null {
  let prefix = 0;
  while (prefix < fixture.length && prefix < current.length && fixture[prefix] === current[prefix]) {
    prefix += 1;
  }
  if (prefix === fixture.length && prefix === current.length) {
    return null;
  }

  let suffix = 0;
  while (
    suffix < fixture.length - prefix &&
    suffix < current.length - prefix &&
    fixture[fixture.length - 1 - suffix] === current[current.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const fixtureOnly = fixture.slice(prefix, fixture.length - suffix);
  const currentOnly = current.slice(prefix, current.length - suffix);

  const report: string[] = [
    `${label}: ${fixtureOnly.length} entr${fixtureOnly.length === 1 ? 'y' : 'ies'} in the fixture ` +
      `replaced by ${currentOnly.length} in the current render, starting at entry ${prefix + 1} ` +
      `(fixture has ${fixture.length} entries, current render ${current.length}).`,
  ];
  for (const entry of fixture.slice(Math.max(0, prefix - CONTEXT_ENTRIES), prefix)) {
    report.push(`    ${entry}`);
  }
  for (const entry of fixtureOnly.slice(0, MAX_REPORTED_ENTRIES)) {
    report.push(`  - ${entry}`);
  }
  if (fixtureOnly.length > MAX_REPORTED_ENTRIES) {
    report.push(`  - … and ${fixtureOnly.length - MAX_REPORTED_ENTRIES} more only in the fixture`);
  }
  for (const entry of currentOnly.slice(0, MAX_REPORTED_ENTRIES)) {
    report.push(`  + ${entry}`);
  }
  if (currentOnly.length > MAX_REPORTED_ENTRIES) {
    report.push(`  + … and ${currentOnly.length - MAX_REPORTED_ENTRIES} more only in the current render`);
  }
  return report.join('\n');
}

/**
 * Describe how today's render of a document differs from its captured fixture.
 *
 * Identifiers and provenance are reported first and on their own terms. They are already part of the
 * element tree, so the third report would catch them too — but a renamed heading id shows up there as
 * two nearly identical lines of markup, and whoever has to triage the failure needs to be told that an
 * identifier moved, not left to spot it.
 *
 * @param documentName - The corpus document being compared, so the report names it.
 * @param fixture - The canonical form of the captured fixture.
 * @param current - The canonical form of today's render.
 * @returns A human-readable report, or `null` when the renders are equivalent.
 */
export function describeRenderDifference(
  documentName: string,
  fixture: CanonicalDocument,
  current: CanonicalDocument,
): string | null {
  const reports = [
    describeSequenceDifference(
      'identifiers (`id` attributes — never normalised: a rename breaks every reference to it)',
      fixture.identifiers,
      current.identifiers,
    ),
    describeSequenceDifference(
      'source provenance (`data-source-file`:`data-source-line` — the editor navigates by these)',
      fixture.provenance,
      current.provenance,
    ),
    describeSequenceDifference(
      'element tree (attribute order and inter-element whitespace already normalised away)',
      fixture.lines,
      current.lines,
    ),
  ].filter((report) => report !== null);

  if (reports.length === 0) {
    return null;
  }
  return [
    `"${documentName}" no longer renders the way the captured previous-engine fixture does.`,
    ...reports,
  ].join('\n\n');
}
