/**
 * @file Hover documentation for Asciidoctor-PDF theme settings.
 *
 * The same prose completion already shows as its `info` line, surfaced at the other moment an author
 * needs it: reading a theme rather than writing one. Completion only fires while a key is being
 * typed, so the settings an author most needs explained — the ones already in the file, seeded from
 * the default theme or inherited from a colleague — are precisely the ones it can never describe.
 *
 * Resolved through {@link themeAssignments}, NOT `themeCursorContext`. The cursor reader answers
 * "what is being typed here", returning an empty key unless the caret is past the colon; hover needs
 * "what does this line assign", which is a different question with a different answer on every key a
 * hover would actually land on.
 *
 * The tooltip never renders empty. A description is hand-written prose and not every catalogue key
 * has one yet, but every descriptor carries its value kind and most carry the renderer's default —
 * facts worth showing on their own. A hover that silently does nothing reads as a broken feature
 * rather than a missing string, so an undescribed key still gets its kind, its default and its
 * permitted values.
 *
 * Split into a pure resolver and a DOM builder so both are testable without mounting a view: the
 * question "which key is under this offset, and what do we know about it" is the part that can be
 * wrong, and driving a real CodeMirror hover to ask it would test the framework instead.
 */
import { hoverTooltip, type Tooltip } from '@codemirror/view';
import { themeSetting, type ThemeSettingDescriptor } from '@asciidocollab/shared';
import { themeAssignments } from '@/lib/codemirror/theme/theme-yaml';
import type { ThemeSettingsGetter } from '@/lib/codemirror/completions/theme-key';

/** How each value kind reads in prose, for the line shown when no description has been written. */
const KIND_LABELS: Readonly<Record<ThemeSettingDescriptor['valueKind'], string>> = {
  colour: 'A colour, written as `RRGGBB`, `#RGB`, or a CMYK array.',
  font: 'A font family name, which must be registered in the font catalogue.',
  measurement: 'A length, in points unless another unit is given.',
  keyword: 'One of a fixed set of words.',
  number: 'A number.',
  boolean: 'Either true or false.',
  string: 'A text value.',
};

/** What a hover found: the range to anchor to, and the setting to describe. */
export interface ThemeHover {
  /** Document offset the tooltip anchors from. */
  readonly from: number;
  /** Document offset the tooltip anchors to. */
  readonly to: number;
  /** The full dotted key, which the line under the pointer carries only the last segment of. */
  readonly key: string;
  /** Everything known about the setting. */
  readonly descriptor: ThemeSettingDescriptor;
  /** True when the pointer was over the key, false when over its value. */
  readonly overKey: boolean;
}

/**
 * Resolve a document offset to the theme setting documented there.
 *
 * @param text - The whole theme document.
 * @param position - The document offset the pointer is over.
 * @param settings - The settings currently offerable, including any an enabled extension contributes.
 * @returns What to show, or null when the offset is not over a recognised setting.
 */
export function themeHoverAt(
  text: string,
  position: number,
  settings: readonly ThemeSettingDescriptor[],
): ThemeHover | null {
  // The VALUE side counts too: `font-style: italic` is where an author most wants to know which
  // other words are legal, and that is the one moment completion has already closed.
  const hit = themeAssignments(text).find(
    (assignment) =>
      (position >= assignment.keyFrom && position <= assignment.keyTo) ||
      (position >= assignment.valueFrom && position <= assignment.valueTo),
  );
  if (hit === undefined) return null;

  const descriptor = themeSetting(hit.key, settings);
  // An unrecognised key gets nothing. The linter already underlines it with a message saying so, and
  // a tooltip repeating "unknown" would be a second voice saying less.
  if (descriptor === undefined) return null;

  const overKey = position >= hit.keyFrom && position <= hit.keyTo;
  return {
    from: overKey ? hit.keyFrom : hit.valueFrom,
    to: overKey ? hit.keyTo : hit.valueTo,
    key: hit.key,
    descriptor,
    overKey,
  };
}

/**
 * The lines of a hover tooltip, in order.
 *
 * The key itself is always first, because the line under the pointer carries only its LAST segment —
 * an author hovering `font-color` nested three levels deep is often there precisely because they
 * have lost track of which container they are in.
 *
 * @param hover - The resolved hover.
 * @returns The text of each line, which {@link renderThemeHover} styles by position.
 */
export function themeHoverLines(hover: ThemeHover): string[] {
  const { key, descriptor } = hover;
  const lines = [
    key,
    // Falls back to the kind rather than rendering nothing — see the file header.
    descriptor.description === '' ? KIND_LABELS[descriptor.valueKind] : descriptor.description,
  ];
  if (descriptor.permittedValues !== undefined && descriptor.permittedValues.length > 0) {
    lines.push(`One of: ${descriptor.permittedValues.join(', ')}`);
  }
  if (descriptor.defaultValue !== undefined) {
    lines.push(`Default: ${descriptor.defaultValue}`);
  }
  if (descriptor.contributedBy !== undefined) {
    lines.push(`Contributed by the ${descriptor.contributedBy} extension.`);
  }
  return lines;
}

/** Build the tooltip node: the key in mono, the description in prose, the facts dimmed beneath. */
function renderThemeHover(hover: ThemeHover): HTMLElement {
  const dom = document.createElement('div');
  dom.style.padding = '4px 8px';
  dom.style.fontSize = '12px';
  dom.style.maxWidth = '380px';
  dom.style.lineHeight = '1.45';

  for (const [index, text] of themeHoverLines(hover).entries()) {
    const element = document.createElement('div');
    element.textContent = text;
    if (index === 0) {
      element.style.fontWeight = '600';
      element.style.fontFamily = 'var(--font-mono, monospace)';
    }
    if (index > 1) {
      element.style.opacity = '0.75';
      element.style.marginTop = '2px';
    }
    dom.append(element);
  }
  return dom;
}

/**
 * Hover-documentation source for theme documents.
 *
 * @param getSettings - The settings currently offerable, read lazily so that enabling an extension
 *   widens hover at the same moment it widens completion and validation, from the one getter all
 *   three share.
 * @returns A CodeMirror hover-tooltip extension.
 */
export function createThemeKeyHover(
  getSettings: ThemeSettingsGetter,
): ReturnType<typeof hoverTooltip> {
  return hoverTooltip((view, position): Tooltip | null => {
    const hover = themeHoverAt(view.state.doc.toString(), position, getSettings());
    if (hover === null) return null;
    return {
      pos: hover.from,
      end: hover.to,
      above: true,
      create: () => ({ dom: renderThemeHover(hover) }),
    };
  });
}
