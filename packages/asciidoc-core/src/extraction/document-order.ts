/**
 * The line-aware, document-order attribute engine — the single authority for "what attributes are in
 * scope at a given point". `documentOrderEvents` turns a file into an ordered stream of attribute
 * set/unset/inline-set events, include directives, and conditional-region boundaries (verbatim blocks
 * and wrapped-value continuations excluded); `applyAttributeEvent` folds one event into a running map
 * honouring unset / soft-set / `{ref}`-expansion precedence. Every higher-level resolver (attribute
 * scope, references, include graph, level offset) consumes THIS stream, so a `{set:}`, an unset, or a
 * wrapped value is interpreted identically everywhere. The single copy shared by the server (@asciidocollab/domain) and the editor (apps/web).
 */
import type { DocumentOrderEvent } from '../types';
import { substitutePathAttributes } from '../attribute-substitution';
import { conditionalLineKind } from '../conditional-regions';
import { ATTR_ENTRY_LINE_RE, INLINE_SET_RE, INCLUDE_RE, VALUE_CONTINUATION_RE, SOFT_SET_SUFFIX } from './grammar';
import { verbatimRanges, isInRanges, type TextSpan } from './text-ranges';

/**
 * The one attribute whose resolved VALUE is owned exclusively by `level-offset.ts` (it is
 * position-dependent and cumulative, so the raw last-written string an attribute map holds is
 * meaningless as an offset). It is kept in the running/gating maps — so `ifdef::leveloffset[]` gates
 * exactly as real Asciidoctor, where `leveloffset` is an ordinary settable document attribute — but
 * {@link stripReservedAttributes} removes it at every boundary that hands a map to a VALUE consumer
 * (attribute scope, inherited attributes, `{ref}` resolution), so nothing can mistake the raw string
 * for the resolved offset. Lowercase, matching the downcased names {@link documentOrderEvents} emits.
 */
export const RESERVED_LEVELOFFSET = 'leveloffset';

/**
 * Return a copy of `attributes` with the engine-reserved {@link RESERVED_LEVELOFFSET} removed — used
 * at every boundary that exposes an attribute map as resolved VALUES to a consumer. The offset itself
 * is resolved through `effectiveLevelOffset`, never read from a map.
 */
export function stripReservedAttributes(attributes: Map<string, string>): Map<string, string> {
  attributes.delete(RESERVED_LEVELOFFSET);
  return attributes;
}

/**
 * A {@link DocumentOrderEvent} extended with the conditional REGION boundaries (`region-open` /
 * `region-close`) the include-graph and level-offset walks need to gate includes the same way the
 * assembler does. These are internal to the walk — attribute folding ignores them.
 */
export type WalkEvent =
  | DocumentOrderEvent
  | { kind: 'region-open'; pos: number; line: string }
  | { kind: 'region-close'; pos: number };

/** One attribute-entry line and the characters it occupies, as scanned by {@link attributeEntrySpans}. */
interface AttributeEntrySpan {
  /**
   * The whole entry: the `:name:` itself, the value, and every `\`-continuation line (the trailing
   * newline of the last one included). It starts at column 0 because an attribute entry IS the whole
   * line — Asciidoctor recognizes no indented form.
   */
  readonly span: TextSpan;
  /** True for a SET entry (`:name: value`, value possibly empty), false for an unset (`:name!:`/`:!name:`). */
  readonly isSet: boolean;
}

/**
 * Scan every attribute-entry line of a file, following `\`-continuations and skipping entries inside
 * verbatim/comment blocks (there an attribute-looking line is sample text, not an entry). The single
 * place the entry-line walk lives, so the two range views below cannot drift from each other or from
 * the grammar's {@link ATTR_ENTRY_LINE_RE}.
 *
 * @param content - The file's full text.
 * @param verbatim - The already-computed verbatim/comment ranges, so callers that have them do not re-scan.
 * @returns One entry per attribute-entry line, in document order.
 */
function attributeEntrySpans(content: string, verbatim: readonly TextSpan[]): AttributeEntrySpan[] {
  const entries: AttributeEntrySpan[] = [];
  const lines = content.split('\n');
  let cursor = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const start = cursor;
    cursor += lines[index].length + 1;
    if (isInRanges(start, verbatim)) continue;
    const match = ATTR_ENTRY_LINE_RE.exec(lines[index]);
    if (match === null) continue;
    if (match[2] === undefined) {
      // An unset (`:name!:` / `:!name:`) — a single line, with no value to continue.
      entries.push({ span: { from: start, to: cursor }, isSet: false });
      continue;
    }
    let raw = match[2];
    while (VALUE_CONTINUATION_RE.test(raw) && index + 1 < lines.length) {
      raw = raw.replace(VALUE_CONTINUATION_RE, '').trimEnd() + ' ' + lines[index + 1].trim();
      index += 1;
      cursor += lines[index].length + 1;
    }
    entries.push({ span: { from: start, to: cursor }, isSet: true });
  }
  return entries;
}

/**
 * Character spans occupied by attribute-entry VALUES (`:name: value`, including any `\`-continuation
 * lines), excluding entries inside verbatim/comment blocks. A `{set:}`/`include::` that falls inside
 * such a span is value TEXT, not a document-order directive, so body scans skip it. The caller passes
 * the already-computed verbatim ranges to avoid re-scanning.
 */
export function attributeEntryValueRanges(content: string, verbatim: readonly TextSpan[]): TextSpan[] {
  return attributeEntrySpans(content, verbatim)
    .filter((entry) => entry.isSet) // an unset carries no value, so it spans nothing a body scan may skip
    .map((entry) => entry.span);
}

/**
 * Character spans occupied by attribute ENTRIES — every form (`:name: value`, `:name!:`, `:!name:`),
 * name and value together, `\`-continuation lines included, entries inside verbatim/comment blocks
 * excluded. The superset of {@link attributeEntryValueRanges}, which sees only the entries that set a
 * value.
 *
 * This is the view a text consumer wants: an attribute entry is configuration — the name is a syntax
 * identifier and the value is overwhelmingly a token, path, version, or brand word — so the whole line
 * is markup, not writing. The editor's prose extraction masks these ranges before handing text to the
 * grammar/spell checker, which is why it must be computed HERE from the same grammar the preview and
 * resolution layers apply rather than from a second `:name:` pattern.
 *
 * @param content - The file's full text.
 * @returns The entry spans in document order (non-overlapping, ascending).
 */
export function attributeEntryLineRanges(content: string): TextSpan[] {
  return attributeEntrySpans(content, verbatimRanges(content)).map((entry) => entry.span);
}

/**
 * The attribute events (entry set/unset, inline `{set:}`, wrapped values), include directives, and
 * conditional-region boundaries of a file in document (offset) order, so a walk can apply attributes
 * and resolve includes interleaved exactly as Asciidoctor does: an include — and any reference — sees
 * only the attribute state established ABOVE it, not what is defined later in the same file.
 *
 * Attribute entries are scanned line-by-line (not via the global value regex) so a wrapping value (a
 * trailing `\` continues onto the next line) is joined, a prefix/suffix unset (`:!name:` / `:name!:`)
 * becomes a `value: null` event, and a soft-set (`value@`) carries overridable-default precedence.
 * Inline `{set:name:value}` / `{set:name!}` assignments in body text become `inline-set` events at their
 * position. Include directives carry their matched directive for later expansion.
 */
export function documentOrderEvents(content: string): WalkEvent[] {
  const events: WalkEvent[] = [];

  // Verbatim/comment regions (listing/literal/passthrough/comment blocks + `//` lines): an
  // attribute-looking line, `{set:}`, `include::`, or conditional directive INSIDE one is literal
  // sample text, not a real directive. extractSymbols/extractReferences already skip these ranges;
  // the resolution model must agree so a code sample documenting AsciiDoc cannot pollute scope or
  // synthesize includes.
  const verbatim = verbatimRanges(content);

  // Attribute ENTRIES, scanned per line so wrapping continuation and unset are expressible.
  // Character ranges consumed as `\`-continuation lines of a wrapped value: a directive-looking line
  // (an `include::` or `{set:}`) that is actually the continuation of an attribute value is value
  // TEXT, not a directive, so the body scans below must skip any match that starts inside one.
  const consumed: TextSpan[] = [];
  let cursor = 0;
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const start = cursor;
    cursor += lines[index].length + 1;
    if (isInRanges(start, verbatim)) continue; // inside a verbatim/comment block — literal text
    // Conditional region boundaries are document-order events too, so include-gating sees them
    // interleaved with the attribute state. A single-line `ifdef::name[text]` content form is NOT a
    // region opener (handled by conditionalLineKind), so it never gates the lines below it.
    const condKind = conditionalLineKind(lines[index]);
    if (condKind === 'endif') {
      events.push({ kind: 'region-close', pos: start });
      continue;
    }
    if (condKind === 'opener') {
      events.push({ kind: 'region-open', pos: start, line: lines[index] });
      continue;
    }
    const match = ATTR_ENTRY_LINE_RE.exec(lines[index]);
    if (match === null) continue;
    const unsetName = match[3] ?? match[4];
    if (unsetName !== undefined) {
      events.push({ kind: 'attribute', pos: start, name: unsetName.toLowerCase(), value: null });
      continue;
    }
    // A set entry: join `\`-continued lines into a single value. The ENTIRE entry span — the first
    // line's value AND any continuation lines — is value TEXT, so it is marked `consumed`: a
    // `{set:}`/`include::` appearing inside an attribute value is not a document-order directive and
    // must not be double-counted by the body scans below.
    const entryStart = start;
    let raw = match[2];
    while (VALUE_CONTINUATION_RE.test(raw) && index + 1 < lines.length) {
      raw = raw.replace(VALUE_CONTINUATION_RE, '').trimEnd() + ' ' + lines[index + 1].trim();
      index += 1;
      cursor += lines[index].length + 1;
    }
    consumed.push({ from: entryStart, to: cursor });
    // The raw value (soft-set `@` marker still attached) is carried through; precedence is applied
    // in applyAttributeEvent (a `value@` is an overridable default; a plain entry is a normal set).
    events.push({ kind: 'attribute', pos: start, name: match[1].toLowerCase(), value: raw.trimEnd() });
  }

  const inConsumedValue = (pos: number): boolean => consumed.some((range) => pos >= range.from && pos < range.to);
  const skip = (pos: number): boolean => inConsumedValue(pos) || isInRanges(pos, verbatim);

  // Inline `{set:}` assignments anywhere in the body, excluding those inside a wrapped value
  // or a verbatim block.
  for (const match of content.matchAll(INLINE_SET_RE)) {
    if (skip(match.index ?? 0)) continue;
    const value = match[2] === undefined ? null : match[2];
    events.push({ kind: 'inline-set', pos: match.index ?? 0, name: match[1].toLowerCase(), value });
  }

  for (const match of content.matchAll(INCLUDE_RE)) {
    if (skip(match.index ?? 0)) continue;
    events.push({ kind: 'include', pos: match.index ?? 0, match });
  }
  return events.toSorted((a, b) => a.pos - b.pos);
}

/**
 * Apply one attribute event to the running accumulator in document reading order, honoring
 * precedence:
 * - an unset removes the name;
 * - a soft-set (value ending in `@`) is an overridable default — it applies only when the name is
 *   not already in scope, so it cannot clobber an existing value (Asciidoctor soft-set precedence);
 * - a plain entry / inline-set overrides any existing value.
 *
 * Nested `{ref}`s in a set value are expanded against the attributes-so-far at definition time,
 * matching Asciidoctor.
 */
export function applyAttributeEvent(
  event: Extract<DocumentOrderEvent, { kind: 'attribute' | 'inline-set' }>,
  attributes: Map<string, string>,
): void {
  // `leveloffset` IS retained here (unlike other reserved-value handling): the running map doubles as
  // the conditional-gating scope, and real Asciidoctor treats `leveloffset` as an ordinary settable
  // attribute — so `ifdef::leveloffset[]` must see it. Its meaningless raw string is instead removed by
  // {@link stripReservedAttributes} at every boundary that returns VALUES to a consumer; the offset is
  // resolved through `effectiveLevelOffset` (reading the event value directly), never from this map.
  if (event.value === null) {
    attributes.delete(event.name);
    return;
  }
  const soft = event.value.endsWith(SOFT_SET_SUFFIX);
  if (soft && attributes.has(event.name)) return; // overridable default — do not clobber.
  const value = soft ? event.value.slice(0, -SOFT_SET_SUFFIX.length).trimEnd() : event.value;
  attributes.set(event.name, substitutePathAttributes(value, attributes));
}

/**
 * Apply a single line's attribute effects to a running accumulator, in document order, honoring
 * Asciidoctor precedence (set / prefix-or-suffix unset / inline `{set:}`, soft-set defaults). A
 * value continued with a trailing `\` is NOT joined here — the caller scanning line-by-line should
 * treat that as the start of a wrapped value; for include-target substitution the first physical
 * line already carries the leading value, which is sufficient. Used by the include assembler so a
 * later include target sees the same attribute state the resolution model computes.
 *
 * @param line - One physical line of content.
 * @param attributes - The accumulator, mutated in place.
 */
export function applyLineAttributes(line: string, attributes: Map<string, string>): void {
  const entry = ATTR_ENTRY_LINE_RE.exec(line);
  if (entry !== null) {
    const unsetName = entry[3] ?? entry[4];
    if (unsetName === undefined) {
      applyAttributeEvent({ kind: 'attribute', pos: 0, name: entry[1].toLowerCase(), value: entry[2].trimEnd() }, attributes);
    } else {
      applyAttributeEvent({ kind: 'attribute', pos: 0, name: unsetName.toLowerCase(), value: null }, attributes);
    }
  }
  // Inline `{set:name:value}` / `{set:name!}` assignments anywhere on the line.
  for (const match of line.matchAll(INLINE_SET_RE)) {
    const value = match[2] === undefined ? null : match[2];
    applyAttributeEvent({ kind: 'inline-set', pos: 0, name: match[1].toLowerCase(), value }, attributes);
  }
}

/**
 * Apply a file's OWN attribute events (set/unset/inline-set, in document order) on top of a seeded
 * scope (its inherited context), honoring soft-set/unset precedence. Returns the resulting name →
 * value map.
 */
export function applyOwnAttributes(content: string, seed: ReadonlyMap<string, string>): Map<string, string> {
  const attributes = new Map(seed);
  for (const event of documentOrderEvents(content)) {
    if (event.kind === 'attribute' || event.kind === 'inline-set') {
      applyAttributeEvent(event, attributes);
    }
  }
  return attributes;
}
