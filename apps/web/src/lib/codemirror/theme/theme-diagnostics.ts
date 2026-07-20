/**
 * @file Validation for Asciidoctor-PDF theme documents.
 *
 * Reports what the author can act on: a setting the renderer will not read, a keyword outside the
 * permitted set, a malformed colour, and structural YAML the reader cannot make sense of. The
 * standard it holds a document to is the renderer's own — an unknown key is one the generated
 * catalogue does not carry, so this cannot disagree with what completion offered.
 *
 * Two deliberate silences. A `$variable` reference or a `round(...)` expression is never flagged:
 * the renderer resolves those itself and this module does not evaluate them, so judging them would
 * mean rejecting valid themes.
 *
 * And keys are judged by `isPlausibleThemeKey`, NOT by catalogue membership. The catalogue is derived
 * from the two example themes the gem ships, which demonstrate only a fraction of the legal key
 * space: `extends` appears in no theme file, `role.<name>.*` is an open namespace the author fills,
 * and compositions like `heading.font-size` are valid but simply unused by the examples. Flagging
 * those produced a wall of warnings on themes copied straight from the Asciidoctor-PDF
 * documentation — which teaches authors to ignore the validation altogether, costing more than the
 * typos it catches. The check is a vocabulary test instead, and stays a WARNING because even a
 * genuine miss is only ever inert.
 */
import type { Diagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';
import { isPlausibleThemeKey, themeSetting } from '@asciidocollab/shared';
import type { ThemeSettingDescriptor } from '@asciidocollab/shared';
import { themeAssignments, type ThemeAssignment } from '@/lib/codemirror/theme/theme-yaml';

/** A `$variable` reference or theme function call — resolved by the renderer, not judged here. */
const COMPUTED = /^\s*(\$|round\(|ceil\(|floor\(|min\(|max\()/;
/**
 * The colour forms Asciidoctor-PDF accepts: `RRGGBB`, `#RRGGBB`, `RGB`, `#RGB`, or a CMYK array.
 *
 * The `#` is OPTIONAL on the short form as well as the long one. The gem's `HexColorEntryRx`
 * (theme_loader.rb) is `(?<h>#)?(?<v>\h\h\h\h{0,3})`, and `to_color` expands the shorthand — so
 * `base: font-color: f00` renders red. Requiring the `#` there reported that working theme as "not
 * a colour".
 */
const COLOUR = /^(#?([\da-f]{3}|[\da-f]{6})|\[\s*[\d.]+\s*(,\s*[\d.]+\s*){3}]|transparent)$/i;
/** A tab in the indentation, which YAML forbids outright and which silently breaks nesting. */
const LEADING_TAB = /^[ ]*\t/;

/** Build one diagnostic against a document range. */
function at(
  from: number,
  to: number,
  severity: Diagnostic['severity'],
  message: string,
): Diagnostic {
  return { from, to, severity, message };
}

/** Validate one assignment's value against what its descriptor says the setting accepts. */
function checkValue(
  assignment: ThemeAssignment,
  contributed: readonly ThemeSettingDescriptor[],
): Diagnostic | null {
  const descriptor = themeSetting(assignment.key, contributed);
  if (descriptor === undefined) return null;
  const { value, valueFrom, valueTo } = assignment;
  // The renderer computes these; this module does not, so it has no basis to judge them.
  if (COMPUTED.test(value)) return null;

  const unquoted = value.replaceAll(/^['"]|['"]$/g, '');

  if (descriptor.valueKind === 'keyword' && descriptor.permittedValues !== undefined) {
    if (!descriptor.permittedValues.includes(unquoted)) {
      return at(
        valueFrom,
        valueTo,
        'error',
        `${assignment.leaf} accepts ${descriptor.permittedValues.join(', ')} — not “${unquoted}”.`,
      );
    }
    return null;
  }

  if (descriptor.valueKind === 'colour' && !COLOUR.test(unquoted)) {
    return at(
      valueFrom,
      valueTo,
      'error',
      `${assignment.leaf} expects a colour such as 333333 or #333333 — “${unquoted}” is not one.`,
    );
  }

  return null;
}

/**
 * Compute the diagnostics for a theme document. Pure over the text, so it is unit-testable without
 * an editor.
 *
 * @param text - The whole theme document.
 * @param contributed - Settings contributed by the project's enabled extensions. Without these, a
 *   key an enabled extension declares would be reported as having no effect — the opposite of the
 *   truth, and precisely the false warning that teaches an author to ignore the validation.
 * @returns The diagnostics, in document order.
 */
export function themeDiagnostics(
  text: string,
  contributed: readonly ThemeSettingDescriptor[] = [],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Structural problems first: a tab in the indentation makes every nested key below it wrong, so
  // saying that plainly is more useful than the cascade of "unknown setting" it would otherwise
  // produce.
  let offset = 0;
  for (const line of text.split('\n')) {
    if (LEADING_TAB.test(line)) {
      diagnostics.push(
        at(offset, offset + line.length, 'error', 'YAML indentation must use spaces, not tabs.'),
      );
    }
    offset += line.length + 1;
  }

  for (const assignment of themeAssignments(text)) {
    if (!isPlausibleThemeKey(assignment.key, contributed)) {
      diagnostics.push(
        at(
          assignment.keyFrom,
          assignment.keyTo,
          'warning',
          `${assignment.key} does not look like a theme setting, so it will have no effect.`,
        ),
      );
      continue;
    }
    const valueProblem = checkValue(assignment, contributed);
    if (valueProblem !== null) diagnostics.push(valueProblem);
  }

  return diagnostics.toSorted((a, b) => a.from - b.from);
}

/**
 * The CodeMirror lint source for theme documents.
 *
 * @param getSettings - The settings currently offerable, including any an enabled extension
 *   contributes. Read lazily on every lint pass, so enabling an extension stops the warnings on its
 *   keys without the editor being remounted.
 * @returns A lint source for theme documents.
 */
export function createThemeDiagnosticsSource(
  getSettings: () => readonly ThemeSettingDescriptor[],
): (view: EditorView) => Diagnostic[] {
  return (view: EditorView): Diagnostic[] => themeDiagnostics(view.state.doc.toString(), getSettings());
}
