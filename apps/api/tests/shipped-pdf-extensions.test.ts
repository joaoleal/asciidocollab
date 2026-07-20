import { canonicalThemeKey, themeSetting } from '@asciidocollab/shared';
import {
  SHIPPED_PDF_EXTENSION_MANIFESTS,
  SHIPPED_PDF_EXTENSION_SOURCES,
} from '../src/lib/pdf-extensions';

/**
 * @file The shipped extension set, judged as a set.
 *
 * The per-extension parity fixtures prove each one DOES what it claims. These assertions cover the
 * properties that only make sense across the whole catalogue, and the one that is easiest to lose
 * silently: that a document carrying an extension's targeting markup still renders correctly when
 * that extension is switched off (FR-031a2).
 */

describe('the shipped extension set loads', () => {
  it('offers every extension in the gem', () => {
    expect(SHIPPED_PDF_EXTENSION_MANIFESTS.length).toBeGreaterThan(0);
  });

  it('ships Ruby for every manifest, and a manifest for every Ruby', () => {
    // A manifest with no source is an entry the catalogue offers and the renderer cannot load; a
    // source with no manifest is code that ships and can never be enabled.
    expect(Object.keys(SHIPPED_PDF_EXTENSION_SOURCES).toSorted()).toEqual(
      SHIPPED_PDF_EXTENSION_MANIFESTS.map((manifest) => manifest.id).toSorted(),
    );
  });

  it('orders by id, so load order never depends on how the directory enumerated', () => {
    const ids = SHIPPED_PDF_EXTENSION_MANIFESTS.map((manifest) => manifest.id);
    expect(ids).toEqual(ids.toSorted((a, b) => a.localeCompare(b)));
  });

  it('gives every extension a distinct id', () => {
    const ids = SHIPPED_PDF_EXTENSION_MANIFESTS.map((manifest) => manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * The renderer publishes the ids THIS render selected into the VM, and each extension compares its
 * own `EXTENSION_ID` against that set before acting — because `Module#prepend` cannot be undone and
 * the warm VM otherwise carries every extension any earlier render enabled.
 *
 * That makes the gate the single point where an extension can fail silently in either direction, and
 * neither failure is visible in the extension's own parity fixture. A fixture enables exactly what it
 * is testing, so an UNGATED hook still produces the right output there and only misbehaves in the
 * render that follows it; and an id that drifts from the manifest disables the extension everywhere
 * while the fixture — which generates its reference through the canonical CLI, where a nil set means
 * "everything loaded is enabled" — keeps passing. Both are caught here instead.
 */
/**
 * The public converter hooks a module overrides — everything Asciidoctor-PDF will call into.
 *
 * Matched by EXCLUSION rather than by a `convert_`/`ink_` prefix. The prefixes described every hook
 * the gem overrode when this was written, which quietly made the gating check below opt-in: an
 * override of any differently-named converter method — `add_dest_for_block`, say, which is where a
 * block's anchor page is decided — was not a hook as far as this test was concerned and could act on
 * every render regardless of what the project enabled. Anything defined above the module's `private`
 * that is not one of this gem's own `_asciidocollab_`-prefixed helpers is a hook.
 */
function publicHooks(source: string): string[] {
  const hooks: string[] = [];
  for (const line of source.split('\n')) {
    if (/^ {4}private\s*$/.test(line)) break;
    const match = /^ {4}def ([a-z]\w*[?!]?)/.exec(line);
    if (match !== null) hooks.push(match[1]);
  }
  return hooks;
}

describe('every shipped extension gates itself on the per-render enabled set', () => {
  it.each(SHIPPED_PDF_EXTENSION_MANIFESTS.map((manifest) => manifest.id))(
    '%s declares its own catalogue id',
    (id) => {
      // A typo here costs nothing visible: the extension loads, gates itself on an id nobody
      // publishes, and quietly does nothing for the rest of the deployment.
      expect(SHIPPED_PDF_EXTENSION_SOURCES[id]).toContain(`EXTENSION_ID = '${id}'`);
    },
  );

  it.each(SHIPPED_PDF_EXTENSION_MANIFESTS.map((manifest) => manifest.id))(
    '%s checks the set before acting in every hook it overrides',
    (id) => {
      const source = SHIPPED_PDF_EXTENSION_SOURCES[id] ?? '';
      const hooks = publicHooks(source);
      // An extension that overrides nothing cannot do anything either; that is a defect on its own.
      expect(hooks.length).toBeGreaterThan(0);
      for (const hook of hooks) {
        const body = source.slice(source.indexOf(`    def ${hook}`));
        expect(body.split('\n')[1]?.trim()).toBe(
          'return super unless _asciidocollab_extension_enabled? EXTENSION_ID',
        );
      }
    },
  );

  it.each(SHIPPED_PDF_EXTENSION_MANIFESTS.map((manifest) => manifest.id))(
    '%s reads the set the renderer actually publishes',
    (id) => {
      // The global's name is the contract between `invokeConvert` and nine separate Ruby files that
      // cannot share a helper — the registry mounts exactly one file per extension, so there is
      // nowhere to put one. Nothing but this assertion would notice the two drifting apart.
      expect(SHIPPED_PDF_EXTENSION_SOURCES[id]).toContain('$__asciidocollab_enabled_extensions');
    },
  );
});

describe('targeting markup is inert when its extension is disabled (FR-031a2)', () => {
  /**
   * The forms of targeting markup that cannot produce stray output or an error on their own.
   *
   * Verified against the real toolchain rather than asserted from documentation: the theme editor's
   * sample carries every one of these, and rendering it with and without the markup — both times with
   * NO extensions loaded — produced identical text and an identical page count. The one exception is
   * recorded in its own test below.
   */
  const INERT_FORMS = [
    // A document attribute. Asciidoctor stores it; nothing reads it, so nothing renders.
    /^:[a-z][a-z-]*:$/,
    // A role on a block. The PDF converter has no style for an unknown role and ignores it.
    /^\[\.[a-z][a-z-]*]$/,
    // A standard AsciiDoc section style, which degrades to its own built-in meaning.
    /^\[[a-z][a-z-]*]$/,
  ];

  it.each(SHIPPED_PDF_EXTENSION_MANIFESTS.map((manifest) => [manifest.id, manifest.targeting]))(
    '%s targets nothing the base converter would render literally',
    (_id, targeting) => {
      // An extension with no targeting acts on ordinary content (paragraph numbering, the contents
      // list) and so has nothing that could be left behind.
      if (targeting === '') return;
      expect(INERT_FORMS.some((form) => form.test(targeting))).toBe(true);
    },
  );

  it('records the one marker that is NOT invisible when disabled', () => {
    // `[colophon]` is standard AsciiDoc, not something this catalogue invented: the base converter
    // already renders it, as an ordinary numbered chapter, and `colophon-placement` changes where it
    // goes rather than whether it renders. So with the extension off, a marked section reads
    // "Chapter 11. Colophon" instead of an unnumbered "Colophon" at the back.
    //
    // That is a BETTER outcome than invisibility and is why it is allowed: the markup degrades to the
    // meaning AsciiDoc already gives it. Pinned here so the difference stays a decision rather than
    // something a later reader discovers in a diff and treats as a bug.
    const colophon = SHIPPED_PDF_EXTENSION_MANIFESTS.find(
      (manifest) => manifest.id === 'colophon-placement',
    );
    expect(colophon?.targeting).toBe('[colophon]');
  });
});

describe('every shipped extension describes itself to an author', () => {
  it.each(SHIPPED_PDF_EXTENSION_MANIFESTS.map((manifest) => [manifest.id, manifest]))(
    '%s carries a name, a description and sample prose',
    (_id, manifest) => {
      // The extensions settings section shows all three. An empty one renders as a blank row the
      // author cannot act on.
      expect(manifest.displayName.length).toBeGreaterThan(0);
      expect(manifest.description.length).toBeGreaterThan(0);
      expect(manifest.sampleContent.length).toBeGreaterThan(0);
    },
  );

  it.each(
    SHIPPED_PDF_EXTENSION_MANIFESTS.flatMap((manifest) =>
      manifest.themeKeys.map((key) => [`${manifest.id} → ${key.key}`, key] as const),
    ),
  )('%s is namespaced and described', (_label, key) => {
    // Namespaced by FEATURE rather than by extension id — `auto-license-page` contributes
    // `license-page.*`, not `auto-license-page.*` — because the key is what an author writes in a
    // theme, and it should read as the thing being styled rather than as the module that reads it.
    expect(key.key).toMatch(/^[a-z][a-z-]*\.[a-z][a-z-]*$/);
    expect(key.description.length).toBeGreaterThan(0);
  });

  it('contributes no key the renderer already defines', () => {
    // A contributed key that collided with a built-in would silently shadow it in completion, and an
    // author would have no way to tell which of the two their theme was setting. This is the one real
    // hazard in letting extensions widen the catalogue, so it is checked against the catalogue itself
    // rather than by eye.
    for (const manifest of SHIPPED_PDF_EXTENSION_MANIFESTS) {
      for (const key of manifest.themeKeys) {
        expect({ key: key.key, builtIn: themeSetting(key.key) !== undefined }).toEqual({
          key: key.key,
          builtIn: false,
        });
      }
    }
  });

  it('contributes each key from exactly one extension', () => {
    // Two extensions claiming one key is the same shadowing problem between contributors, and the
    // winner would depend on catalogue order.
    const keys = SHIPPED_PDF_EXTENSION_MANIFESTS.flatMap((manifest) =>
      manifest.themeKeys.map((key) => canonicalThemeKey(key.key)),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
