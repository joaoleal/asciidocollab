/**
 * @file Completion for Asciidoctor-PDF theme settings.
 *
 * Two completions in one source, because they are the same question asked at two points on a line:
 * before the colon the author is naming a SETTING, after it they are writing its VALUE. Splitting
 * them into separate sources would mean each re-deriving the cursor's nesting path, and the two
 * drifting is how completion starts offering a value for the wrong key.
 *
 * Keys are offered relative to the cursor's nesting, so inside `heading:` the author is shown
 * `font-color`, not `heading.font-color` — the latter would insert a key that reads as
 * `heading.heading.font-color` once the indentation is accounted for.
 */
import type { CompletionSource, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { canonicalThemeKey, themeSetting, type ThemeSettingDescriptor } from '@asciidocollab/shared';
import { themeCursorContext } from '@/lib/codemirror/theme/theme-yaml';

/** Supplies the settings currently valid, which widens when a project enables an extension. */
export type ThemeSettingsGetter = () => readonly ThemeSettingDescriptor[];

/** The `detail` line shown beside a completion: its default, so the author sees what they are changing. */
function detailOf(descriptor: ThemeSettingDescriptor): string | undefined {
  return descriptor.defaultValue === undefined ? undefined : `default: ${descriptor.defaultValue}`;
}

/**
 * The completions offered for a key being typed under `parentPath`.
 *
 * A setting nested deeper than the cursor contributes its NEXT segment as a container completion, so
 * an author inside `heading:` is offered `h2` as well as `font-color` and can nest as the default
 * theme does.
 */
function keyCompletions(
  settings: readonly ThemeSettingDescriptor[],
  parentPath: string,
): { label: string; type: string; detail?: string; info?: string }[] {
  const prefix = parentPath === '' ? '' : `${canonicalThemeKey(parentPath)}_`;
  const containers = new Map<string, number>();
  const leaves: { label: string; type: string; detail?: string; info?: string }[] = [];

  for (const descriptor of settings) {
    const canonical = canonicalThemeKey(descriptor.key);
    if (!canonical.startsWith(prefix)) continue;
    // Slice the REMAINDER off the descriptor's own spelling, so the offered text keeps the hyphens
    // the canonical form flattened away.
    const remainder = descriptor.key.slice(parentPath === '' ? 0 : parentPath.length + 1);
    const dot = remainder.indexOf('.');
    if (dot === -1) {
      leaves.push({
        label: remainder,
        type: 'property',
        detail: detailOf(descriptor),
        info: descriptor.description === '' ? undefined : descriptor.description,
      });
    } else {
      const container = remainder.slice(0, dot);
      containers.set(container, (containers.get(container) ?? 0) + 1);
    }
  }

  return [
    ...leaves,
    ...[...containers.entries()].map(([label, count]) => ({
      label,
      type: 'namespace',
      detail: `${count} setting${count === 1 ? '' : 's'}`,
    })),
  ];
}

/**
 * Theme-setting completion source.
 *
 * @param getSettings - The settings currently offerable, including any an enabled extension
 *   contributes. Read lazily so enabling an extension widens completion without a remount.
 * @returns A CodeMirror completion source for theme documents.
 */
export function createThemeKeyCompletionSource(getSettings: ThemeSettingsGetter): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const cursor = themeCursorContext(context.state.doc.toString(), context.pos);
    if (cursor === null) return null;

    if (cursor.inValue) {
      // Only a keyword setting has a closed set of legal values worth offering; a colour or a length
      // has no list, and inventing one would be a guess presented as authority.
      //
      // Resolved against the OFFERABLE settings rather than the built-in catalogue, so a keyword key
      // an enabled extension contributes offers its permitted values too. Looking it up globally
      // would complete the key and then go silent on its values.
      const descriptor = themeSetting(cursor.key, getSettings());
      const permitted = descriptor?.permittedValues;
      if (permitted === undefined || permitted.length === 0) return null;
      if (!context.explicit && cursor.typed === '') return null;
      return {
        from: cursor.from,
        options: permitted.map((label) => ({ label, type: 'enum' })),
        filter: false,
      };
    }

    // Without an explicit request, wait for a character: offering all 181 keys on every newline
    // makes the editor feel like it is fighting the author.
    if (!context.explicit && cursor.typed === '') return null;

    const typed = cursor.typed.toLowerCase();
    const options = keyCompletions(getSettings(), cursor.parentPath).filter((option) =>
      option.label.toLowerCase().startsWith(typed),
    );
    if (options.length === 0) return null;

    return {
      from: cursor.from,
      options: options.toSorted((a, b) => a.label.localeCompare(b.label)),
      filter: false,
    };
  };
}
