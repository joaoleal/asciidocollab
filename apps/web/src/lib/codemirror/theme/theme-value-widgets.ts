/**
 * @file Inline previews of theme values: a colour swatch beside a colour, the family name set in
 * its own face beside a font.
 *
 * `194F8A` tells an author nothing about what it looks like, and checking means exporting. These are
 * **replace decorations** — the document text is never rewritten (Constitution VII); the widget
 * merely stands in for the value's range while the cursor is elsewhere.
 *
 * The rule that makes them editable rather than obstructive is the one `asciidoc-attribute-fold.ts`
 * established: a range the cursor or selection overlaps is left as raw text. Without it, clicking
 * into a colour to change it would land the author on an opaque widget with nothing to type over.
 *
 * A swatch is drawn only for a value this module can actually resolve to a colour. A `$variable`
 * reference or an unparseable value gets no widget — showing a wrong colour with the authority of a
 * rendered swatch is worse than showing none.
 */
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { themeSetting, type ThemeSettingDescriptor } from '@asciidocollab/shared';
import { themeAssignments } from '@/lib/codemirror/theme/theme-yaml';

/** A bare or hash-prefixed 6-digit hex colour. */
const HEX6 = /^#?([\da-f]{6})$/i;
/** A hash-prefixed 3-digit shorthand hex colour. */
const HEX3 = /^#([\da-f]{3})$/i;
/** A CMYK array, as the theming guide permits for print colours. */
const CMYK = /^\[\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*]$/;

/**
 * Resolve a theme colour value to a CSS colour.
 *
 * @param raw - The value as written in the document.
 * @returns A CSS colour string, or null when the value is not a colour this can render faithfully.
 */
export function themeColourToCss(raw: string): string | null {
  const value = raw.trim().replaceAll(/^['"]|['"]$/g, '');
  if (value.toLowerCase() === 'transparent') return 'transparent';

  const short = HEX3.exec(value);
  if (short !== null) {
    const [r, g, b] = [...short[1]];
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  const long = HEX6.exec(value);
  if (long !== null) return `#${long[1]}`;

  const cmyk = CMYK.exec(value);
  if (cmyk !== null) {
    // The theming guide expresses CMYK components as percentages; the conversion is the standard
    // one and only ever drives a preview swatch, never the render.
    const [c, m, y, k] = cmyk.slice(1, 5).map((part) => Number(part) / 100);
    if ([c, m, y, k].some((part) => !Number.isFinite(part) || part < 0 || part > 1)) return null;
    const channel = (component: number): number => Math.round(255 * (1 - component) * (1 - k));
    return `rgb(${channel(c)}, ${channel(m)}, ${channel(y)})`;
  }

  return null;
}

/** A colour swatch standing in for a colour value, with the raw text kept beside it. */
class ColourSwatchWidget extends WidgetType {
  constructor(
    private readonly css: string,
    private readonly raw: string,
  ) {
    super();
  }

  eq(other: ColourSwatchWidget): boolean {
    return other.css === this.css && other.raw === this.raw;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'cm-theme-colour';
    const swatch = document.createElement('span');
    swatch.className = 'cm-theme-colour-swatch';
    swatch.style.backgroundColor = this.css;
    // The widget replaces the value's text, so the value must still be readable and the swatch must
    // not read as content to a screen reader.
    swatch.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = this.raw;
    wrapper.append(swatch, label);
    return wrapper;
  }

  /** Let a click through so the cursor can land here and reveal the raw value for editing. */
  ignoreEvent(): boolean {
    return false;
  }
}

/** A font family name rendered in that family, so the author sees the face they selected. */
class FontSampleWidget extends WidgetType {
  constructor(private readonly family: string) {
    super();
  }

  eq(other: FontSampleWidget): boolean {
    return other.family === this.family;
  }

  toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'cm-theme-font';
    element.textContent = this.family;
    // Quoted so a multi-word family resolves; the generic fallback means an unavailable family
    // simply renders in the default face rather than disappearing.
    element.style.fontFamily = `"${this.family.replaceAll('"', '')}", serif`;
    return element;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** One value range and the widget that stands in for it. */
interface ValuePreview {
  readonly from: number;
  readonly to: number;
  readonly widget: WidgetType;
}

/**
 * The inline previews a theme document warrants: one per colour or font value that resolves.
 *
 * Exported so the decoration set can be unit-tested without mounting an editor.
 *
 * @param text - The whole theme document.
 * @returns The previews, in document order.
 */
export function computeThemeValuePreviews(
  text: string,
  contributed: readonly ThemeSettingDescriptor[] = [],
): ValuePreview[] {
  const previews: ValuePreview[] = [];
  for (const assignment of themeAssignments(text)) {
    const descriptor = themeSetting(assignment.key, contributed);
    if (descriptor === undefined) continue;

    if (descriptor.valueKind === 'colour') {
      const css = themeColourToCss(assignment.value);
      // A `$base-font-color` reference resolves to null here — no swatch rather than a wrong one.
      if (css === null) continue;
      previews.push({
        from: assignment.valueFrom,
        to: assignment.valueTo,
        widget: new ColourSwatchWidget(css, assignment.value),
      });
      continue;
    }

    if (descriptor.valueKind === 'font') {
      const family = assignment.value.replaceAll(/^['"]|['"]$/g, '');
      if (family === '' || family.startsWith('$')) continue;
      previews.push({
        from: assignment.valueFrom,
        to: assignment.valueTo,
        widget: new FontSampleWidget(family),
      });
    }
  }
  return previews;
}

/** Build the decoration set, skipping any range the cursor or selection touches. */
function buildDecorations(
  view: EditorView,
  contributed: readonly ThemeSettingDescriptor[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { from: selectionFrom, to: selectionTo } = view.state.selection.main;
  for (const preview of computeThemeValuePreviews(view.state.doc.toString(), contributed)) {
    // Reveal the raw value whenever the cursor or selection overlaps it, so it stays editable.
    if (selectionFrom <= preview.to && selectionTo >= preview.from) continue;
    builder.add(preview.from, preview.to, Decoration.replace({ widget: preview.widget }));
  }
  return builder.finish();
}

/** Styling for the two widgets, kept with them so a consumer needs only the one extension. */
const themeWidgetTheme = EditorView.baseTheme({
  '.cm-theme-colour': { display: 'inline-flex', alignItems: 'center', gap: '0.35em' },
  '.cm-theme-colour-swatch': {
    display: 'inline-block',
    width: '0.85em',
    height: '0.85em',
    borderRadius: '2px',
    border: '1px solid rgba(128, 128, 128, 0.5)',
    verticalAlign: 'middle',
  },
  '.cm-theme-font': { fontSize: '1.05em' },
});

/**
 * Inline colour swatches and font samples for a theme document.
 *
 * @param getSettings - Reads the settings currently in force, INCLUDING those contributed by the
 *   project's enabled extensions. Takes the same getter the linter, completion and hover take, so a
 *   key an extension contributes is validated, offered, explained AND previewed by one decision
 *   rather than four that can disagree — previously this one alone resolved against the built-in
 *   catalogue, so an extension's own colour key got everything except its swatch.
 * @returns The widget extension.
 */
export function createThemeValueWidgets(
  getSettings: () => readonly ThemeSettingDescriptor[],
): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = buildDecorations(view, getSettings());
        }

        update(update: ViewUpdate): void {
          // Selection changes matter as much as document changes: moving the cursor onto a value is
          // what reveals its raw text.
          if (update.docChanged || update.selectionSet || update.viewportChanged) {
            this.decorations = buildDecorations(update.view, getSettings());
          }
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
    themeWidgetTheme,
  ];
}
