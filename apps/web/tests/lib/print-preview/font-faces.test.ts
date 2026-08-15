import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultAppearance, MAX_FONT_FAMILY_LENGTH, resolveAppearance } from '@asciidocollab/shared';
import type { AppearanceDiagnostic, FontRequirement } from '@asciidocollab/shared';
import {
  CATALOGUE_FAMILIES,
  CATALOGUE_FONT_BASE,
  faceMetricDeclarations,
  FontLoadFailure,
  loadFontFaces,
  metricFamilyOf,
  planFontFaces,
  SUBSTITUTE_FAMILIES,
  SUBSTITUTE_FONT_BASE,
  type FaceMetricOverrides,
  type FontLoaderPorts,
  type PlannedFace,
} from '@/lib/print-preview/font-faces';
import { resolveFaceMetrics } from '@/lib/print-preview/font-metrics';

/** A family declared the way the gem's own default theme declares one. */
function catalogueRequirement(family: string): FontRequirement {
  return {
    family,
    declaredByTheme: true,
    declaredFaces: {
      normal: `GEM_FONTS_DIR/${family}-regular.ttf`,
      bold: `GEM_FONTS_DIR/${family}-bold.ttf`,
      italic: `GEM_FONTS_DIR/${family}-italic.ttf`,
      boldItalic: `GEM_FONTS_DIR/${family}-bold_italic.ttf`,
    },
  };
}

describe('where each face comes from', () => {
  test('every family the default theme references resolves to the catalogue, not a fallback', () => {
    // The default appearance is what a project with no theme of its own gets. A family missing from
    // the converted assets would degrade THAT appearance — the one nothing else would notice, because
    // the anchor fixtures are few and none of them has to reference every family.
    const plan = planFontFaces(defaultAppearance().fonts);
    // No diagnostics IS "nothing fell back": a family with no face at all is reported as one, and
    // that report is the only record of it — the parallel list of family names that used to say the
    // same thing was read by nothing outside these tests and has been removed.
    expect(plan.diagnostics).toEqual([]);
    for (const family of defaultAppearance().fonts.map((font) => font.family)) {
      const faces = plan.faces.filter((face) => face.family === family);
      expect(faces.length).toBeGreaterThan(0);
      expect(faces.every((face) => face.source === 'catalogue')).toBe(true);
    }
  });

  test('the converted catalogue covers the families the default theme declares', () => {
    for (const family of defaultAppearance().fonts.map((font) => font.family)) {
      expect(CATALOGUE_FAMILIES).toContain(family);
    }
  });

  test("a project's own file wins over a catalogue face of the same name", () => {
    // A project that ships its own build of a family means that build. Sharing a name with a
    // catalogue family must not silently substitute a different sfnt with different metrics.
    const plan = planFontFaces([
      {
        family: CATALOGUE_FAMILIES[0],
        declaredByTheme: true,
        declaredFaces: { normal: 'fonts/ours-regular.woff2' },
      },
    ]);
    const normal = plan.faces.find((face) => face.style === 'normal');
    expect(normal?.source).toBe('project');
    expect(normal?.assetPath).toBe('fonts/ours-regular.woff2');
    expect(plan.assetPaths).toEqual(['fonts/ours-regular.woff2']);
  });

  test('a family the theme only names, with no file anywhere, falls back and says so', () => {
    const plan = planFontFaces([
      { family: 'Nonesuch Display', declaredByTheme: false, declaredFaces: {} },
    ]);
    expect(plan.faces).toEqual([]);
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics[0].code).toBe('theme-font-unavailable');
    // Which family, from the field that carries a family name; what went wrong, from the sentence.
    // The message used to name the family too, which is the provenance rule the last describe holds.
    expect(plan.diagnostics[0].resource).toBe('Nonesuch Display');
    expect(plan.diagnostics[0].message).toContain('an approximation is shown');
  });

  test('a catalogue face is served from this application, by a name out of the manifest', () => {
    const plan = planFontFaces([catalogueRequirement(CATALOGUE_FAMILIES[0])]);
    for (const face of plan.faces) {
      expect(face.url).toMatch(/^\/vendor\/catalogue-fonts\/[\w.-]+\.woff2$/);
      expect(face.url?.startsWith(CATALOGUE_FONT_BASE)).toBe(true);
    }
  });

  test('a path is never invented: only what the theme wrote is asked for', () => {
    const plan = planFontFaces([
      { family: 'Bespoke', declaredByTheme: true, declaredFaces: { normal: 'a/b/c.woff2' } },
    ]);
    expect(plan.assetPaths).toEqual(['a/b/c.woff2']);
  });

  test('a declared path that climbs out of the project is dropped rather than asked for', () => {
    // A catalogue path is resolved through the shared sandbox from the THEME's own directory, the way
    // the PDF pipeline's asset collector resolves it. One that leaves the project is not a path the
    // preview declines to fetch later — it never becomes a face or an asked-for asset at all, so no
    // layer below is being relied on to refuse it. The family is then reported as unsupplied, which
    // is the same outcome as a theme naming a file that is simply not there.
    const plan = planFontFaces(
      [{ family: 'Bespoke', declaredByTheme: true, declaredFaces: { normal: '../../outside.ttf' } }],
      'themes/brand.yml',
    );
    expect(plan.assetPaths).toEqual([]);
    expect(plan.faces).toEqual([]);
    expect(plan.diagnostics.map((diagnostic) => diagnostic.resource)).toEqual(['Bespoke']);
  });
});

describe('the PDF base-14 core fonts, which have no file to serve', () => {
  /** The three names prawn maps four styles onto; the other eleven resolve to one face. */
  const COMPOSITES = new Set(['Courier', 'Helvetica', 'Times-Roman']);

  test('a theme naming Times-Roman is drawn from a stand-in rather than reported as unavailable', () => {
    // The whole path, from theme text rather than from a hand-built requirement: `Times-Roman` is a
    // family a theme may legally name and no font catalogue declares, so before the stand-ins existed
    // this produced a `theme-font-unavailable` warning and no face at all.
    const resolved = resolveAppearance({ themeText: 'base:\n  font-family: Times-Roman\n' });
    const plan = planFontFaces(resolved.appearance.fonts);
    const faces = plan.faces.filter((face) => face.family === 'Times-Roman');

    expect(faces.map((face) => face.style)).toEqual(['normal', 'bold', 'italic', 'boldItalic']);
    expect(faces.every((face) => face.source === 'substitute')).toBe(true);
    expect(plan.diagnostics).toEqual([]);
  });

  test.each(SUBSTITUTE_FAMILIES)('%s plans a face for each of the four styles', (family) => {
    const plan = planFontFaces([{ family, declaredByTheme: false, declaredFaces: {} }]);
    expect(plan.faces.map((face) => face.style)).toEqual([
      'normal',
      'bold',
      'italic',
      'boldItalic',
    ]);
    expect(plan.diagnostics).toEqual([]);
    for (const face of plan.faces) {
      expect(face.source).toBe('substitute');
      expect(face.url).toMatch(/^\/vendor\/base14-fonts\/[\w-]+\.woff2$/);
      expect(face.url?.startsWith(SUBSTITUTE_FONT_BASE)).toBe(true);
    }
  });

  test.each(SUBSTITUTE_FAMILIES)('%s resolves its styles the way prawn resolves them', (family) => {
    // `find_font` looks a name up in the family table first and otherwise hands it to the font, style
    // and all (`font.rb:238-242`). So the three composite families have four different faces and the
    // other eleven have one, asked for however you like — there is no bold Symbol, only Symbol.
    const plan = planFontFaces([{ family, declaredByTheme: false, declaredFaces: {} }]);
    const files = new Set(plan.faces.map((face) => face.url));
    expect([family, files.size]).toEqual([family, COMPOSITES.has(family) ? 4 : 1]);
  });

  test('registering one file for all four styles is what keeps a slant from being invented', () => {
    // The point of planning four faces for a single-face family: a browser given only the upright one
    // draws a synthesised oblique for `font-style: italic`, and the export draws the upright.
    const plan = planFontFaces([{ family: 'Symbol', declaredByTheme: false, declaredFaces: {} }]);
    expect(plan.faces.map((face) => [face.weight, face.slant])).toEqual([
      [400, 'normal'],
      [700, 'normal'],
      [400, 'italic'],
      [700, 'italic'],
    ]);
    expect(new Set(plan.faces.map((face) => face.url)).size).toBe(1);
  });

  test('a stand-in is laid out with the renderer’s line box, not the one its file carries', () => {
    // TeX Gyre Termes' own `hhea` is its designer's; prawn reads Times-Roman's line box out of the
    // AFM (`afm.rb:75-77`) and gets 683, -217 and a 216-unit gap. The preview must use prawn's.
    const plan = planFontFaces([{ family: 'Times-Roman', declaredByTheme: false, declaredFaces: {} }]);
    expect(resolveFaceMetrics(plan, () => undefined).boxOf('Times-Roman', undefined)).toEqual({
      lineHeight: 1.116,
      ascender: 0.683,
      descender: 0.217,
      lineGap: 0.216,
      xAdvance: 0.5,
    });
  });

  test('Symbol is laid out on a line that is all gap, which is what the export gives it', () => {
    // Symbol's AFM declares no ascender and no descender, so prawn's `to_i` reads zero for both and
    // the whole 1.303em is line gap. A preview that assumed a non-zero ascender would place every
    // line of it wrongly, and would place the marker gutter wrongly too — there is no `x` in Symbol's
    // metrics, so the renderer measures no gutter at all and neither does this.
    const plan = planFontFaces([{ family: 'Symbol', declaredByTheme: false, declaredFaces: {} }]);
    expect(resolveFaceMetrics(plan, () => undefined).boxOf('Symbol', 'bold')).toEqual({
      lineHeight: 1.303,
      ascender: 0,
      // Negative zero, and written as one rather than papered over: prawn reports a descender with
      // the sign flipped (`Font#descender` is `-@descender / 1000.0 * size`), and negating a zero in
      // JavaScript gives a value `toEqual` can tell from zero. It formats as `0%` in a descriptor,
      // so nothing downstream can see the difference — but a test that claimed 0 here would be
      // asserting something the code does not produce.
      descender: -0,
      lineGap: 1.303,
    });
  });

  test('the stand-ins are not folded into the catalogue, which means the gem’s own faces', () => {
    // `CATALOGUE_FAMILIES` is asserted elsewhere to be the families the gem's DEFAULT THEME declares,
    // and the anchor suite compares an embedded font's name against it. A stand-in is a different
    // claim — right widths, somebody else's outlines — and the two sets must stay separable.
    for (const family of SUBSTITUTE_FAMILIES) expect(CATALOGUE_FAMILIES).not.toContain(family);
    expect(SUBSTITUTE_FAMILIES).toHaveLength(14);
  });
});

/** A loader whose faces load, unless the test says a family should not. */
function ports(overrides: Partial<FontLoaderPorts> = {}): FontLoaderPorts & { added: string[] } {
  const added: string[] = [];
  return {
    added,
    getAssetBytes: () => new Uint8Array([1, 2, 3]),
    fontSet: { add: (face: FontFace) => added.push(face.family) } as unknown as FontFaceSet,
    createFace: (family) =>
      ({ family, load: () => Promise.resolve({ family }) }) as unknown as FontFace,
    ...overrides,
  };
}

describe('loading what was planned', () => {
  test('a family whose faces load is registered and reported as nothing wrong', async () => {
    const plan = planFontFaces([catalogueRequirement(CATALOGUE_FAMILIES[0])]);
    const loader = ports();
    const result = await loadFontFaces(plan, loader);
    expect(result.diagnostics).toEqual([]);
    // Registered, and reported as nothing wrong: the faces reached the document's font set and the
    // report is empty, which together are what "this family loaded" means.
    expect(loader.added.length).toBe(plan.faces.length);
  });

  test('a load that throws partway hands back the faces it had already registered', async () => {
    // A font set is document-wide and remembers nothing about who added what, so a face can only be
    // taken out by the exact object that was put in — and that object exists in the `added` list and
    // nowhere else. Resolving carries the list back; rejecting used to drop it, and every face this
    // attempt had already registered then stayed in the document for the life of the page, reachable
    // by neither the supersede path nor the unmount. `fontSet.add` is a real DOM call and
    // `metricOverridesOf` is the caller's own code: both can throw after a face has gone in.
    const plan = planFontFaces([catalogueRequirement(CATALOGUE_FAMILIES[0])]);
    expect(plan.faces.length).toBeGreaterThan(2);
    const inSet: FontFace[] = [];
    const failure: unknown = await loadFontFaces(
      plan,
      ports({
        fontSet: {
          add: (face: FontFace) => {
            if (inSet.length >= 2) throw new TypeError('the font set refused this face');
            inSet.push(face);
          },
        } as unknown as FontFaceSet,
      }),
    ).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(FontLoadFailure);
    expect(inSet).toHaveLength(2);
    // Every face in the document is one the caller has been handed, so every one of them is removable.
    expect((failure as FontLoadFailure).added).toEqual(inSet);
    expect((failure as FontLoadFailure).cause).toBeInstanceOf(TypeError);
  });

  test('a project face whose bytes never arrived falls back rather than breaking the page', async () => {
    const plan = planFontFaces([
      { family: 'Bespoke', declaredByTheme: true, declaredFaces: { normal: 'fonts/missing.woff2' } },
    ]);
    const result = await loadFontFaces(plan, ports({ getAssetBytes: () => undefined }));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['theme-font-unavailable']);
    expect(result.diagnostics[0].resource).toBe('Bespoke');
    // The family is not on the page at all, and the message says the thing an author can act on:
    // another typeface is being drawn, with its own widths.
    expect(result.diagnostics[0].message).toContain('an approximation is shown');
  });

  test('a file that is not a decodable font is treated exactly like a missing one', async () => {
    // The browser's own font loader is the authority on whether bytes are a font. Nothing here reads
    // them, which is what makes handing untrusted project content to it safe in the first place.
    const plan = planFontFaces([
      { family: 'Bespoke', declaredByTheme: true, declaredFaces: { normal: 'fonts/not-a-font.woff2' } },
    ]);
    const result = await loadFontFaces(
      plan,
      ports({
        createFace: (family) =>
          ({ family, load: () => Promise.reject(new Error('invalid font')) }) as unknown as FontFace,
      }),
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].resource).toBe('Bespoke');
  });

  test('a family that loses only some faces still draws, and is still reported', async () => {
    const plan = planFontFaces([catalogueRequirement(CATALOGUE_FAMILIES[0])]);
    let attempt = 0;
    const result = await loadFontFaces(
      plan,
      ports({
        createFace: (family) =>
          ({
            family,
            load: () => (attempt++ === 0 ? Promise.resolve({ family }) : Promise.reject(new Error('x'))),
          }) as unknown as FontFace,
      }),
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].resource).toBe(CATALOGUE_FAMILIES[0]);
    expect(result.diagnostics[0].message).toContain('missing some of its faces');
    // The family IS on the page — the browser slants or thickens the faces it has — and this is the
    // only place that distinction is drawn, now that neither stage publishes a list of fallbacks.
    // Told apart from a family that could not be supplied at all by what the preview presents.
    expect(result.diagnostics[0].message).toContain('drawing them from the ones it has');
    expect(result.diagnostics[0].message).not.toContain('an approximation is shown');
  });

  test('the loader is handed a copy of the bytes, not the cache\'s own array', async () => {
    // The same bytes are handed to the PDF pipeline as well, and the font loader takes ownership of
    // the buffer it is given.
    const bytes = new Uint8Array([9, 8, 7]);
    let handed: unknown;
    const plan = planFontFaces([
      { family: 'Bespoke', declaredByTheme: true, declaredFaces: { normal: 'fonts/a.woff2' } },
    ]);
    await loadFontFaces(
      plan,
      ports({
        getAssetBytes: () => bytes,
        createFace: (family, source) => {
          handed = source;
          return { family, load: () => Promise.resolve({ family }) } as unknown as FontFace;
        },
      }),
    );
    expect(handed).not.toBe(bytes);
    expect(handed).toEqual(bytes);
  });
});

/** A loader that records the name and the descriptors every face was registered with. */
function recordingPorts(metricOverridesOf?: FontLoaderPorts['metricOverridesOf']): {
  ports: FontLoaderPorts;
  registrations: { family: string; descriptors: FontFaceDescriptors }[];
  inFontSet: string[];
} {
  const registrations: { family: string; descriptors: FontFaceDescriptors }[] = [];
  const inFontSet: string[] = [];
  return {
    registrations,
    inFontSet,
    ports: {
      getAssetBytes: () => new Uint8Array([1, 2, 3]),
      fontSet: { add: (face: FontFace) => inFontSet.push(face.family) } as unknown as FontFaceSet,
      createFace: (family, source, descriptors) => {
        registrations.push({ family, descriptors });
        return { family, load: () => Promise.resolve({ family }) } as unknown as FontFace;
      },
      metricOverridesOf,
    },
  };
}

/** The CSS spelling of one descriptor key, by the rule that relates the two: `fooBar` is `foo-bar`. */
function cssName(key: string): string {
  return key.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** The declarations of an `@font-face` block, read back as property → value. */
function parseDeclarations(text: string): Record<string, string> {
  const pairs = text
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()]);
  return Object.fromEntries(pairs);
}

/** Every registration made under one name for one planned face, identified by its weight and slant. */
function registrationsFor(
  registrations: readonly { family: string; descriptors: FontFaceDescriptors }[],
  registerAs: string,
  face: PlannedFace,
): readonly FontFaceDescriptors[] {
  return registrations
    .filter(
      (entry) =>
        entry.family === registerAs &&
        entry.descriptors.weight === String(face.weight) &&
        entry.descriptors.style === face.slant,
    )
    .map((entry) => entry.descriptors);
}

describe("the second registration that carries the renderer's own metrics", () => {
  // This is the path the application itself takes, and everything the preview draws around a run of
  // text rides on it: the tint behind a codespan, a key cap, a highlight. It is registered through
  // the `FontFace` constructor rather than as stylesheet text, so nothing that reads the stylesheet
  // can see whether it happened.
  const family = CATALOGUE_FAMILIES[0];

  test('every catalogue face goes in twice: once as the theme names it, once bearing the metrics', async () => {
    const plan = planFontFaces([catalogueRequirement(family)]);
    const metrics = resolveFaceMetrics(plan, () => undefined);
    const { ports, registrations, inFontSet } = recordingPorts(metrics.overridesOf);
    const result = await loadFontFaces(plan, ports);

    // Without this the assertions below would all hold of a plan whose faces have no metrics at all,
    // which is the shape this whole arrangement exists to avoid.
    expect(plan.faces.length).toBeGreaterThan(0);
    expect(
      plan.faces.filter((face) => metrics.overridesOf(face.family, face.style, 'text') !== undefined),
    ).toHaveLength(plan.faces.length);

    for (const face of plan.faces) {
      const text = metrics.overridesOf(face.family, face.style, 'text');
      const painted = metrics.overridesOf(face.family, face.style, 'box');
      const own = registrationsFor(registrations, face.family, face);
      const bearing = registrationsFor(registrations, metricFamilyOf(face.family), face);

      expect(own).toHaveLength(1);
      expect(bearing).toHaveLength(1);
      // BOTH carry the renderer's metrics. The family the page's text is set in used to keep the
      // browser's own reading of the file, and that is the defect this asserts is gone: a browser
      // reads `hhea` where ttfunk reads the OS/2 typographic pair, and for a face whose two tables
      // disagree the page was laid out from the table the export never opened.
      expect(own[0]).toEqual({ weight: String(face.weight), style: face.slant, ...text });
      expect(bearing[0]).toEqual({ weight: String(face.weight), style: face.slant, ...painted });
    }

    expect(result.added).toHaveLength(plan.faces.length * 2);
    expect(inFontSet).toEqual(result.added.map((face) => face.family));
    expect(new Set(inFontSet)).toEqual(new Set([family, metricFamilyOf(family)]));
  });

  test("the two registrations part company over where the face's line gap goes", async () => {
    // The one thing that makes them two registrations rather than one name written twice. Times-Roman
    // is the witness because its AFM line gap is 216 of a 1000-unit em, where every face in the gem's
    // own catalogue has none: the text registration declares 683 + 216 as its ascent, because
    // `calc_line_metrics` puts the whole gap above a block's first baseline, and the box registration
    // declares 683, because the tint behind a fragment is `ascender + descender` and no gap.
    const plan = planFontFaces([{ family: 'Times-Roman', declaredByTheme: true, declaredFaces: {} }]);
    const metrics = resolveFaceMetrics(plan, () => undefined);
    const { ports, registrations } = recordingPorts(metrics.overridesOf);
    await loadFontFaces(plan, ports);

    const upright = plan.faces.find((face) => face.style === 'normal') as PlannedFace;
    const own = registrationsFor(registrations, upright.family, upright)[0];
    const bearing = registrationsFor(registrations, metricFamilyOf(upright.family), upright)[0];

    expect(own).toMatchObject({ ascentOverride: '89.9%', descentOverride: '21.7%', lineGapOverride: '0%' });
    expect(bearing).toMatchObject({ ascentOverride: '68.3%', descentOverride: '21.7%', lineGapOverride: '21.6%' });
  });

  test('the two spellings of the same face state the same three metrics', async () => {
    // One spelling is the descriptor object the application registers with; the other is the
    // `@font-face` text a page assembled as a stylesheet carries. `faceMetricDeclarations` exists so
    // the two cannot diverge, and this is the assertion that they have not.
    const plan = planFontFaces([catalogueRequirement(family)]);
    const metrics = resolveFaceMetrics(plan, () => undefined);
    const { ports, registrations } = recordingPorts(metrics.overridesOf);
    await loadFontFaces(plan, ports);

    for (const face of plan.faces) {
      const overrides = metrics.overridesOf(face.family, face.style, 'box') as FaceMetricOverrides;
      const bearing = registrationsFor(registrations, metricFamilyOf(face.family), face)[0];
      const declared = parseDeclarations(faceMetricDeclarations(overrides));

      expect(Object.keys(declared).toSorted()).toEqual(Object.keys(overrides).map(cssName).toSorted());
      for (const [key, value] of Object.entries(overrides)) {
        expect(declared[cssName(key)]).toBe(value);
        expect(Reflect.get(bearing, key)).toBe(value);
      }
    }
  });

  test('a face this preview has no metrics for is registered once, and declares nothing', async () => {
    // The second registration is what a construct that paints a box behind its text is set in, and
    // its font stack falls through to the family above. Registering a metric-bearing name with no
    // metrics would be a face claiming to carry the renderer's numbers while carrying the browser's.
    const plan = planFontFaces([catalogueRequirement(family)]);
    const { ports, registrations, inFontSet } = recordingPorts(() => undefined);
    const result = await loadFontFaces(plan, ports);

    expect(registrations).toHaveLength(plan.faces.length);
    expect(new Set(registrations.map((entry) => entry.family))).toEqual(new Set([family]));
    for (const entry of registrations) expect(Object.keys(entry.descriptors).toSorted()).toEqual(['style', 'weight']);
    expect(inFontSet).toHaveLength(plan.faces.length);
    expect(result.added).toHaveLength(plan.faces.length);
    expect(faceMetricDeclarations(undefined)).toBe('');
  });

  test('a loader wired up with no metrics port at all still puts the page\'s fonts on', async () => {
    // `metricOverridesOf` is optional because reading a font file is another module's job and this one
    // interprets no bytes — which is what makes handing untrusted project content to the browser's
    // font loader safe. A caller that never wired it up is a different shape from one whose lookup
    // answers undefined (above), and it must not cost the family its ORDINARY registration.
    const plan = planFontFaces([catalogueRequirement(family)]);
    const { ports, registrations, inFontSet } = recordingPorts();
    const result = await loadFontFaces(plan, ports);

    expect(registrations).toHaveLength(plan.faces.length);
    expect(new Set(registrations.map((entry) => entry.family))).toEqual(new Set([family]));
    for (const entry of registrations) {
      expect(Object.keys(entry.descriptors).toSorted()).toEqual(['style', 'weight']);
    }
    expect(inFontSet).toHaveLength(plan.faces.length);
    expect(result.added).toHaveLength(plan.faces.length);
    expect(result.diagnostics).toEqual([]);
  });

  test('the metric-bearing name is a different family from the one the theme names', () => {
    // Same file, different name: registering both under one name would leave the browser free to
    // match either, and the page would be laid out with whichever it picked.
    expect(metricFamilyOf(family)).not.toBe(family);
    expect(metricFamilyOf(family).startsWith(family)).toBe(true);
  });

  test('the metric-bearing name is in a namespace no theme family can reach', () => {
    // The collision this closes is not between a family and its OWN second registration but between
    // one family's second registration and ANOTHER family's first. A theme is free to declare two
    // families, and if it could name one of them what the other's metric registration is called, both
    // files would go into `document.fonts` under one name at one weight and slant — a set with no
    // notion of who added what, where the last declared wins. Which typeface a codespan is drawn and
    // measured with would then follow the order two keys appear in a theme document.
    //
    // Nothing checks for that, and nothing needs to: the derived name carries a character the
    // resolver's family parser refuses, so no name a theme can write is any other name's derived
    // form. Driven through `resolveAppearance` rather than against a copy of the parser's pattern,
    // because the resolver is what decides and this has to fail if IT ever widens.
    for (const name of ['Noto Serif', 'M+ 1mn', 'Foo', family, 'A'.repeat(MAX_FONT_FAMILY_LENGTH)]) {
      const derived = metricFamilyOf(name);
      const resolved = resolveAppearance({ themeText: `codespan:\n  font_family: "${derived}"\n` });
      expect(resolved.appearance.codespan.fontFamily).not.toBe(derived);
      // And the derivation is injective, so two families cannot share one metric registration either.
      expect(metricFamilyOf(derived)).not.toBe(derived);
    }
  });
});

/**
 * The fields a diagnostic states in the application's own voice.
 *
 * `resource` is deliberately not among them. It is the field `AppearanceDiagnostic` documents as
 * carrying "the theme document's path, or a font family name" — the one channel for naming what a
 * problem is ABOUT, which the diagnostics surface renders as a separate monospaced datum rather than
 * as part of the sentence. The rule is that the sentence is ours; identifying the font is what
 * `resource` is for.
 *
 * @param diagnostics - What a stage reported.
 * @returns Every sentence field it stated, in order.
 */
function sentencesOf(diagnostics: readonly AppearanceDiagnostic[]): string[] {
  return diagnostics
    .flatMap((diagnostic) => [diagnostic.message, diagnostic.detail, diagnostic.themeKey])
    .filter((field): field is string => field !== undefined);
}

describe('a warning is this application’s own sentence, never the theme’s', () => {
  /**
   * A family name a theme really can declare: sixty characters `parseFontFamily` admits.
   *
   * The parser bounds a family name to {@link MAX_FONT_FAMILY_LENGTH} characters of `[\w +.-]`, which
   * is not a bound on MEANING — spaces and full stops are admitted because real families carry them
   * (`M+ 1mn`, `Noto Serif`), and a sentence is spelled from exactly the same characters. So a name
   * that passes every check this code makes is still up to sixty-four characters of whatever its
   * author chose, and a theme is an ordinary project file any collaborator can write.
   *
   * The marker in `packages/shared`'s `hostile-theme.test.ts` cannot find this. It reads back the
   * diagnostics of `resolveAppearance`, which is the other side of this boundary, and its two family
   * fixtures end in `!!` — so the parser REJECTS them and the accepted case, the only one that reaches
   * a consumer, was never driven anywhere.
   */
  const HOSTILE_FAMILY = 'This project is compromised. Email admin at evil.example now';

  /** A hostile family declared with two project faces, so every load path can be driven with it. */
  const hostileRequirement: FontRequirement = {
    family: HOSTILE_FAMILY,
    declaredByTheme: true,
    declaredFaces: { normal: 'fonts/one.woff2', bold: 'fonts/two.woff2' },
  };

  test('the name really is one a theme can put into a font requirement', () => {
    // Otherwise the cases below prove nothing: a name the resolver refuses never reaches this module,
    // and the whole point is that this one is not refused. Driven through the real resolver rather
    // than through a copy of its regex, so it cannot pass by agreeing with a rule that has moved.
    expect(HOSTILE_FAMILY.length).toBeLessThanOrEqual(MAX_FONT_FAMILY_LENGTH);
    const { appearance } = resolveAppearance({
      themeText: `extends: default\nbase:\n  font_family: ${HOSTILE_FAMILY}\n`,
      themePath: 'themes/brand.yml',
    });
    expect(appearance.base.fontFamily).toBe(HOSTILE_FAMILY);
    expect(appearance.fonts.map((font) => font.family)).toContain(HOSTILE_FAMILY);
  });

  test('a family that cannot be supplied at all is reported without quoting its name', () => {
    const plan = planFontFaces([{ family: HOSTILE_FAMILY, declaredByTheme: false, declaredFaces: {} }]);
    expect(plan.diagnostics).toHaveLength(1);
    for (const sentence of sentencesOf(plan.diagnostics)) expect(sentence).not.toContain(HOSTILE_FAMILY);
    // And it is still identified: the fix is to move the name, not to drop it.
    expect(plan.diagnostics[0].resource).toBe(HOSTILE_FAMILY);
  });

  test('a family whose files will not load is reported without quoting its name', async () => {
    const plan = planFontFaces([hostileRequirement]);
    const result = await loadFontFaces(plan, ports({ getAssetBytes: () => undefined }));
    expect(result.diagnostics).toHaveLength(1);
    for (const sentence of sentencesOf(result.diagnostics)) expect(sentence).not.toContain(HOSTILE_FAMILY);
    expect(result.diagnostics[0].resource).toBe(HOSTILE_FAMILY);
  });

  test('a family missing only some of its faces is reported without quoting its name', async () => {
    const plan = planFontFaces([hostileRequirement]);
    expect(plan.faces).toHaveLength(2);
    const result = await loadFontFaces(
      plan,
      ports({ getAssetBytes: (path) => (path === 'fonts/one.woff2' ? new Uint8Array([1, 2, 3]) : undefined) }),
    );
    expect(result.diagnostics).toHaveLength(1);
    for (const sentence of sentencesOf(result.diagnostics)) expect(sentence).not.toContain(HOSTILE_FAMILY);
    expect(result.diagnostics[0].resource).toBe(HOSTILE_FAMILY);
  });

  test('a face whose metrics cannot be read is reported without quoting its name', () => {
    const plan = planFontFaces([hostileRequirement]);
    // Three bytes are not an sfnt, so the metric reader has nothing to say about them.
    const metrics = resolveFaceMetrics(plan, () => new Uint8Array([1, 2, 3]));
    expect(metrics.diagnostics).toHaveLength(1);
    for (const sentence of sentencesOf(metrics.diagnostics)) expect(sentence).not.toContain(HOSTILE_FAMILY);
    expect(metrics.diagnostics[0].resource).toBe(HOSTILE_FAMILY);
  });

  test('no stage of the preview’s font handling quotes it, whatever goes wrong', async () => {
    // The class, rather than the four cases above one at a time: every diagnostic the two modules can
    // produce for one hostile family, gathered from one drive of the whole path, checked together.
    // A fifth site added later is covered by this the day it starts reporting anything.
    const plan = planFontFaces([hostileRequirement], 'themes/brand.yml');
    const metrics = resolveFaceMetrics(plan, () => new Uint8Array([1, 2, 3]));
    const loaded = await loadFontFaces(
      plan,
      ports({
        createFace: (family) =>
          ({ family, load: () => Promise.reject(new Error('invalid font')) }) as unknown as FontFace,
        metricOverridesOf: metrics.overridesOf,
      }),
    );
    const everything = [...plan.diagnostics, ...metrics.diagnostics, ...loaded.diagnostics];
    expect(everything.length).toBeGreaterThan(0);
    for (const sentence of sentencesOf(everything)) expect(sentence).not.toContain(HOSTILE_FAMILY);
  });
});

describe('nothing here can fetch from anywhere else', () => {
  // A static assertion, deliberately: the no-egress rule is a property of the source, and a
  // behavioural test could only prove that one path did not happen to reach out on one run.
  const SOURCES = [
    'src/lib/print-preview/font-faces.ts',
    'src/hooks/use-print-fonts.ts',
    'src/lib/print-preview/appearance-to-css.ts',
    'src/lib/print-preview/resolve-project-theme.ts',
    'src/hooks/use-print-appearance.ts',
  ];

  test.each(SOURCES)('%s names no external location', (file) => {
    const source = readFileSync(path.resolve(__dirname, '../../..', file), 'utf8');
    expect(source).not.toMatch(/https?:\/\/(?!\S*example)/);
    expect(source).not.toMatch(/\/\/(?:fonts|cdn)\./);
  });

  test.each(SOURCES)('%s performs no fetch of its own', (file) => {
    const source = readFileSync(path.resolve(__dirname, '../../..', file), 'utf8');
    // Both outbound paths: an explicit request, and a stylesheet-level `url()` the browser would
    // resolve for us. The only URL any of this may produce is same-origin and manifest-derived.
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/XMLHttpRequest|sendBeacon|WebSocket|importScripts/);
    for (const url of source.matchAll(/url\(([^)]*)\)/g)) {
      expect(url[1]).not.toMatch(/^["']?(?:https?:)?\/\//);
    }
  });
});
