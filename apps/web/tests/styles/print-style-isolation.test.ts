import { readFileSync } from 'node:fs';
import path from 'node:path';

// Guards Style Isolation for the third preview style. `print-preview.css` is imported app-wide, so
// every rule in it MUST be confined to a container that has actually been asked for the Print style
// — and, just as importantly, the two older stylesheets must leave that container alone. A style
// that inherits half of another one looks almost right, which is the hardest kind of wrong to spot.
//
// The checks below read SELECTOR STRUCTURE, not selector spelling. That distinction is the whole
// point of the rewrite this file went through: the previous version compared prefixes and searched
// for substrings, which made it a test of how a selector is WRITTEN rather than of what it MATCHES,
// and four separate shapes leaked past it while it stayed green —
//
//   `.dark .asciidoc-preview-content blockquote`            (the container is not the first compound)
//   `.asciidoc-preview-content[data-preview-style="print"]` (in the BRAND sheet: pinned TO Print)
//   `.asciidoc-preview-content p:not([data-preview-style="print"])`   (negation on the wrong compound)
//   `…[data-preview-style="print"] ~ .app-sidebar`          (subject outside the container entirely)
//
// — every one of which really does reach the Print page. Each is now a fixture in "the analysis the
// scoping checks rest on" below, asserted to be REPORTED, so the checks cannot regress to spelling.
const PRINT = path.resolve(__dirname, '../../src/styles/print-preview.css');
const BRAND = path.resolve(__dirname, '../../src/styles/asciidoc-preview.css');
const GENERATED = path.resolve(__dirname, '../../src/styles/asciidoctor-style.generated.css');
const GLOBALS = path.resolve(__dirname, '../../src/styles/globals.css');

const CONTAINER_CLASS = 'asciidoc-preview-content';
const PRINT_ATTRIBUTE = '[data-preview-style="print"]';
const PRINT_SCOPE = `.${CONTAINER_CLASS}${PRINT_ATTRIBUTE}`;

/** A stylesheet with its comments removed, so prose can neither satisfy nor break an assertion. */
function rulesOf(file: string): string {
  return readFileSync(file, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Split a selector list on the commas that separate SELECTORS, leaving the ones inside a functional
 * pseudo-class alone.
 *
 * `:is(.paragraph, .ulist)` is one selector carrying two commas, and splitting on every comma turns
 * it into three fragments of which two begin with a bare class — which reads to the checks below as
 * a rule that escaped the Print container, while the rule is in fact scoped. A depth counter is the
 * whole of the difference: a comma inside parentheses belongs to the pseudo-class, not to the list.
 *
 * @param selectorList - One rule's selector list.
 * @returns Each selector in it, trimmed.
 */
function splitSelectorList(selectorList: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of selectorList) {
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}

/** One rule: the selectors it is written for, and the declarations it applies to them. */
interface Rule {
  readonly selectors: readonly string[];
  readonly declarations: string;
}

/**
 * Every rule in a stylesheet, in source order, with its declaration block.
 *
 * Parsing by hand rather than by regex over the whole file: a pattern matching "a selector" against
 * raw CSS also matches the same shape written inside a declaration or a comment, and a test that
 * passes because its own extraction missed the rule is worse than no test.
 *
 * AT-RULES ARE DESCENDED INTO, not skipped. This used to delete `@media` blocks whole, which meant a
 * selector written inside one escaped every check below — and the checks below are the reason this
 * file exists. That the Print stylesheet carries no `@media`, `@supports`, `@font-face` or `@layer`
 * today is exactly why it was invisible: the hole could only ever open on the edit that introduced
 * one, which is the edit a scoping check most needs to survive. So an at-rule's PRELUDE is dropped
 * (it is not a selector, and `@media print` must not be reported as one) while its body is walked
 * like any other, and a rule nested inside it is reported like any other.
 *
 * A brace walk rather than a split, because "the text before the next `{`" is only a selector when
 * the brace opens a rule; inside a declaration block it is a declaration list. Quote-aware, so a
 * brace inside an attribute value — `[style*="{"]` is legal — cannot desynchronise the walk.
 *
 * @param css - Stylesheet text with comments already removed.
 * @returns Each rule, with its selectors split and its declarations sliced out.
 */
function rulesIn(css: string): Rule[] {
  const rules: Rule[] = [];
  let index = 0;

  /** Consume input up to and including the `}` that closes the block we were called inside. */
  function block(): void {
    let prelude = '';
    while (index < css.length) {
      const character = css[index];
      if (character === '"' || character === "'") {
        const quote = character;
        prelude += character;
        index += 1;
        while (index < css.length) {
          const inner = css[index];
          prelude += inner;
          index += 1;
          if (inner === '\\') {
            prelude += css[index] ?? '';
            index += 1;
          } else if (inner === quote) break;
        }
        continue;
      }
      if (character === '{') {
        const text = prelude.trim();
        prelude = '';
        index += 1;
        const start = index;
        block();
        // An at-rule's prelude names a condition, not a subject; its body has just been walked on.
        if (text.length > 0 && !text.startsWith('@')) {
          rules.push({
            selectors: splitSelectorList(text),
            declarations: css.slice(start, Math.max(start, index - 1)),
          });
        }
        continue;
      }
      if (character === '}') {
        index += 1;
        return;
      }
      prelude += character;
      index += 1;
    }
  }

  block();
  return rules;
}

/**
 * Every individual selector in a stylesheet.
 *
 * @param css - Stylesheet text with comments already removed.
 * @returns Each individual selector, trimmed.
 */
function selectorsOf(css: string): string[] {
  return rulesIn(css).flatMap((rule) => [...rule.selectors]);
}

/** One compound selector — the run of simple selectors between two combinators. */
interface Compound {
  readonly text: string;
  /** Classes written ON this compound, never the ones buried inside a `:not()` or `:is()`. */
  readonly classes: readonly string[];
  /** Attribute selectors written on this compound, normalised to double quotes. */
  readonly attributes: readonly string[];
  /** The arguments of every functional pseudo-class on this compound, one entry per argument. */
  readonly negations: readonly string[];
}

/** A complex selector, as the sequence of compounds and the combinators joining them. */
interface ComplexSelector {
  readonly compounds: readonly Compound[];
  /** `combinators[n]` joins `compounds[n]` to `compounds[n + 1]`. */
  readonly combinators: readonly string[];
}

/**
 * Read one compound's own classes, attributes and `:not()` arguments.
 *
 * Depth-aware throughout, because the difference between
 * `.asciidoc-preview-content:not([data-preview-style="print"])` and a compound that merely mentions
 * that attribute somewhere is the entire question this file asks.
 *
 * @param compound - One compound selector.
 * @returns Its top-level parts.
 */
function readCompound(compound: string): Compound {
  const classes: string[] = [];
  const attributes: string[] = [];
  const negations: string[] = [];
  let index = 0;
  while (index < compound.length) {
    const character = compound[index];
    if (character === '.') {
      let name = '';
      index += 1;
      while (index < compound.length && /[\w-]/.test(compound[index])) {
        name += compound[index];
        index += 1;
      }
      classes.push(name);
      continue;
    }
    if (character === '[') {
      let depth = 0;
      let text = '';
      while (index < compound.length) {
        const inner = compound[index];
        text += inner;
        index += 1;
        if (inner === '[') depth += 1;
        else if (inner === ']') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      attributes.push(text.replaceAll("'", '"'));
      continue;
    }
    if (character === ':') {
      index += 1;
      if (compound[index] === ':') index += 1;
      let name = '';
      while (index < compound.length && /[\w-]/.test(compound[index])) {
        name += compound[index];
        index += 1;
      }
      if (compound[index] === '(') {
        let depth = 0;
        let argument = '';
        while (index < compound.length) {
          const inner = compound[index];
          index += 1;
          if (inner === '(') {
            depth += 1;
            if (depth === 1) continue;
          } else if (inner === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
          argument += inner;
        }
        // Only a negation can EXCLUDE a style; `:is()`/`:where()` arguments are recorded as empty so
        // a `:is([data-preview-style="print"])` can never be mistaken for an exclusion of it.
        if (name === 'not') negations.push(...splitSelectorList(argument.replaceAll("'", '"')));
      }
      continue;
    }
    index += 1;
  }
  return { text: compound, classes, attributes, negations };
}

/**
 * Split a complex selector into its compounds and the combinators between them.
 *
 * The combinator is what decides whether a rule stays inside the preview container: a descendant or
 * child combinator after the container keeps the subject within it, while `+` or `~` walks out to a
 * sibling of the container — the whole application, as far as the page is concerned.
 *
 * @param selector - One complex selector.
 * @returns Its compounds and combinators.
 */
function parseSelector(selector: string): ComplexSelector {
  const compounds: Compound[] = [];
  const combinators: string[] = [];
  let depth = 0;
  let current = '';
  let pending: string | null = null;
  let index = 0;
  while (index < selector.length) {
    const character = selector[index];
    if (character === '"' || character === "'") {
      const quote = character;
      current += character;
      index += 1;
      while (index < selector.length) {
        const inner = selector[index];
        current += inner;
        index += 1;
        if (inner === '\\') {
          current += selector[index] ?? '';
          index += 1;
        } else if (inner === quote) break;
      }
      continue;
    }
    if (depth === 0) {
      if (/\s/.test(character)) {
        if (current.length > 0) pending = pending ?? ' ';
        index += 1;
        continue;
      }
      if (character === '>' || character === '+' || character === '~') {
        pending = character;
        index += 1;
        continue;
      }
      if (pending !== null && current.length > 0) {
        compounds.push(readCompound(current));
        combinators.push(pending);
        current = '';
        pending = null;
      }
    }
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    current += character;
    index += 1;
  }
  if (current.length > 0) compounds.push(readCompound(current));
  return { compounds, combinators };
}

/** What a selector does with the preview container — the one question every check below asks. */
interface ScopeReport {
  /** The index of the first compound that IS the preview container, or `null` if there is none. */
  readonly containerIndex: number | null;
  /** The style the container compound is pinned to by `[data-preview-style="…"]`, if any. */
  readonly pinnedStyle: string | null;
  /** Whether the container compound carries `:not([data-preview-style="print"])`. */
  readonly excludesPrint: boolean;
  /** Whether the subject can sit outside the container — a `+`/`~` immediately after it. */
  readonly escapesContainer: boolean;
  /** Classes on the container compound other than the container class itself. */
  readonly extraContainerClasses: readonly string[];
}

const STYLE_ATTRIBUTE = /^\[data-preview-style=(?:"([^"]*)")?\]$/;

/**
 * Describe what one selector does with the preview container.
 *
 * @param selector - One complex selector.
 * @returns The report the scoping checks read.
 */
function reportScope(selector: string): ScopeReport {
  const { compounds, combinators } = parseSelector(selector);
  const containerIndex = compounds.findIndex((compound) =>
    compound.classes.includes(CONTAINER_CLASS),
  );
  if (containerIndex === -1) {
    return {
      containerIndex: null,
      pinnedStyle: null,
      excludesPrint: false,
      escapesContainer: false,
      extraContainerClasses: [],
    };
  }
  const container = compounds[containerIndex];
  const pinned = container.attributes
    .map((attribute) => STYLE_ATTRIBUTE.exec(attribute)?.[1])
    .find((value) => value !== undefined);
  const following = combinators[containerIndex];
  return {
    containerIndex,
    pinnedStyle: pinned ?? null,
    excludesPrint: container.negations.includes(PRINT_ATTRIBUTE),
    // A `+`/`~` IMMEDIATELY after the container leaves it. One further along does not: `A B + C`
    // makes C a sibling of B, and B is inside A, so C is too.
    escapesContainer: following === '+' || following === '~',
    extraContainerClasses: container.classes.filter((name) => name !== CONTAINER_CLASS),
  };
}

/**
 * Whether a brand-sheet selector can match inside a container asked for the Print style.
 *
 * @param selector - One complex selector from the brand stylesheet.
 * @returns True when the Print page would wear this rule.
 */
function reachesPrint(selector: string): boolean {
  const report = reportScope(selector);
  if (report.containerIndex === null) return false;
  if (report.pinnedStyle !== null) return report.pinnedStyle === 'print';
  return !report.excludesPrint;
}

describe('the analysis the scoping checks rest on', () => {
  // Every assertion in this file is a claim about a LIST, and a list that quietly omits the rules an
  // edit is most likely to add is a green tick for a stylesheet nobody checked. Each fixture below
  // is a shape that really does reach the Print page and that the previous, spelling-based version
  // of this file reported as clean.
  it('reports a selector nested inside an at-rule instead of dropping the block', () => {
    const css = `
      @media print {
        .escaped-the-print-container { color: red; }
        ${PRINT_SCOPE} .kept { color: red; }
      }
      @supports (display: grid) {
        @media screen {
          .doubly-nested { color: red; }
        }
      }
      @font-face { font-family: "Not A Selector"; }
      .plain[style*="{"] { color: red; }
    `;

    expect(selectorsOf(css)).toEqual([
      '.escaped-the-print-container',
      `${PRINT_SCOPE} .kept`,
      '.doubly-nested',
      '.plain[style*="{"]',
    ]);
  });

  it('keeps each rule with its own declarations, through at-rules and quoted braces', () => {
    const css = `
      .a { color: red; }
      @media screen { .b { color: green; } }
      .c[style*="{"] { color: blue; }
    `;
    expect(rulesIn(css).map((rule) => [rule.selectors, rule.declarations.trim()])).toEqual([
      [['.a'], 'color: red;'],
      [['.b'], 'color: green;'],
      [['.c[style*="{"]'], 'color: blue;'],
    ]);
  });

  it('finds the container wherever in the selector it is written, not only at the front', () => {
    // Leak shape 1. `.dark …` is a real shape in the brand sheet — it is how the admonition icon
    // titles are re-toned for dark mode — so a prefix check does not merely miss a hypothetical.
    expect(reachesPrint(`.dark .${CONTAINER_CLASS} blockquote`)).toBe(true);
    expect(
      reachesPrint(`.dark .${CONTAINER_CLASS}:not([data-preview-style="print"]) blockquote`),
    ).toBe(false);
  });

  it('reads a container pinned TO Print as reaching Print, not as scoped away from it', () => {
    // Leak shape 2. `[data-preview-style=` is the shape of an exclusion AND of an inclusion; only
    // the value written in it says which, and the brand sheet has no business writing "print".
    expect(reachesPrint(`${PRINT_SCOPE} p`)).toBe(true);
    expect(reachesPrint(`.${CONTAINER_CLASS}[data-preview-style="asciidoctor"] p`)).toBe(false);
  });

  it('requires the exclusion to be on the container, not merely somewhere in the selector', () => {
    // Leak shape 3. This negation is on the `p`, so every paragraph on the Print page still matches
    // — the rule excludes nothing at all while reading, to a substring search, exactly like one that
    // excludes everything.
    expect(reachesPrint(`.${CONTAINER_CLASS} p:not([data-preview-style="print"])`)).toBe(true);
    expect(reachesPrint(`.${CONTAINER_CLASS}:not([data-preview-style="print"]) p`)).toBe(false);
  });

  it('will not read :is() as an exclusion', () => {
    // `:is([data-preview-style="print"])` contains the exclusion's every character and is its exact
    // opposite. Only `:not()` narrows.
    expect(reachesPrint(`.${CONTAINER_CLASS}:is([data-preview-style="print"]) p`)).toBe(true);
  });

  it('reports a subject the container is not an ancestor of', () => {
    // Leak shape 4. A sibling combinator on the container reaches out of the preview surface and
    // into the application chrome beside it, however correctly the container itself is named.
    expect(reportScope(`${PRINT_SCOPE} ~ .app-sidebar`).escapesContainer).toBe(true);
    expect(reportScope(`${PRINT_SCOPE} + .app-sidebar`).escapesContainer).toBe(true);
    // …while a sibling combinator further along stays inside: `A B + C` puts C beside B, and B is
    // inside A. The brand sheet writes exactly this (`.details span + span::before`).
    expect(reportScope(`${PRINT_SCOPE} .details span + span`).escapesContainer).toBe(false);
    expect(reportScope(`${PRINT_SCOPE} > .a ~ .b`).escapesContainer).toBe(false);
  });

  it('splits compounds without being confused by quotes, parentheses or nested brackets', () => {
    const parsed = parseSelector(`.a:not([x=" > "]) > .b[y='+'] .c`);
    expect(parsed.compounds.map((compound) => compound.text)).toEqual([
      '.a:not([x=" > "])',
      ".b[y='+']",
      '.c',
    ]);
    expect(parsed.combinators).toEqual(['>', ' ']);
  });
});

describe('the Print stylesheet stays inside the Print style', () => {
  const selectors = selectorsOf(rulesOf(PRINT));

  it('is actually scoped (sanity)', () => {
    expect(selectors.length).toBeGreaterThan(20);
  });

  it('has no selector that escapes a container asked for the Print style', () => {
    const leaking = selectors.filter((selector) => {
      const report = reportScope(selector);
      return (
        report.containerIndex === null ||
        report.pinnedStyle !== 'print' ||
        report.escapesContainer
      );
    });
    expect(leaking).toEqual([]);
  });

  it('declares no global at-rule that would reach the application around it', () => {
    const css = rulesOf(PRINT);
    expect(css).not.toMatch(/@page\b/);
    expect(css).not.toMatch(/:root\b/);
    expect(css).not.toMatch(/\bhtml\s*[,{]/);
    expect(css).not.toMatch(/\bbody\s*[,{]/);
  });
});

/**
 * The bare-container rules that apply to every preview style on purpose.
 *
 * These are affordances of the preview surface rather than of one style's look: the placeholder that
 * stands in for a hidden include, and the icon an admonition draws in place of a font glyph the
 * application never loads. Both are as true of the Print page as of the other two.
 *
 * Being shared, neither may read a design token — the Print page and the Asciidoctor page are fixed
 * white sheets that do not follow the application's light and dark modes, so a token puts app-themed
 * ink on paper-white. That is not a house rule, it is a bug that shipped: the include placeholder
 * read `hsl(var(--muted-foreground))` and came out at 2.54:1 on both of those pages in dark mode.
 * The premise is therefore ASSERTED below rather than asserted in prose, which is what it was when it
 * was false.
 *
 * Anything else written against the bare container reaches all three styles by accident, which is
 * how a style ends up wearing half of another one.
 */
const SHARED_BY_DESIGN: readonly string[] = [
  `.${CONTAINER_CLASS} .adoc-include-placeholder`,
  `.${CONTAINER_CLASS} .admonitionblock td.icon`,
];

/**
 * Whether a selector is one of the deliberately shared affordances.
 *
 * @param selector - One complex selector.
 * @returns True when the selector is allow-listed.
 */
function isSharedByDesign(selector: string): boolean {
  return SHARED_BY_DESIGN.some((shared) => selector.startsWith(shared));
}

/**
 * The custom properties the application declares as design tokens.
 *
 * Read from the declarations rather than from the file text: `.checklist-box--checked::after` puts
 * `--checked:` in front of a regex looking for a property name, and a token list with a phantom in
 * it is a token list nobody can reason about.
 *
 * @returns Every custom property declared on `:root` or `.dark` in globals.css.
 */
function designTokens(): Set<string> {
  const names = new Set<string>();
  for (const rule of rulesIn(rulesOf(GLOBALS))) {
    for (const match of rule.declarations.matchAll(/(--[\w-]+)\s*:/g)) names.add(match[1]);
  }
  return names;
}

/**
 * Every custom property a stylesheet DECLARES, taken from rule bodies only.
 *
 * @param file - The stylesheet to read.
 * @returns The declared property names.
 */
function propertiesDeclaredIn(file: string): Set<string> {
  const names = new Set<string>();
  for (const rule of rulesIn(rulesOf(file))) {
    for (const match of rule.declarations.matchAll(/(--[\w-]+)\s*:/g)) names.add(match[1]);
  }
  return names;
}

/**
 * Every custom property a stylesheet READS.
 *
 * @param file - The stylesheet to read.
 * @returns The property names appearing inside `var()`.
 */
function propertiesReadIn(file: string): Set<string> {
  return new Set([...rulesOf(file).matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]));
}

describe('the older styles leave the Print container alone', () => {
  // The brand stylesheet is scoped by exclusion — it applies to a container that is not one of the
  // other styles — so a style added without its exclusion inherits the whole brand look on top of
  // its own. That default is why this is asserted rather than assumed.
  const brandSelectors = selectorsOf(rulesOf(BRAND));

  it('is actually being read (sanity)', () => {
    expect(brandSelectors.length).toBeGreaterThan(100);
  });

  it('every brand rule either excludes the Print style by name or is shared on purpose', () => {
    const leaking = brandSelectors.filter(
      (selector) => reachesPrint(selector) && !isSharedByDesign(selector),
    );
    expect(leaking).toEqual([]);
  });

  it('every brand rule stays inside the preview container it names', () => {
    // Two ways out of the surface, both of which the previous prefix filter discarded rather than
    // reported: naming no container at all, and naming one only to step sideways out of it.
    const escaping = brandSelectors.filter((selector) => {
      const report = reportScope(selector);
      return report.containerIndex === null || report.escapesContainer;
    });
    expect(escaping).toEqual([]);
  });

  it('the rules shared with the Print page read no design token', () => {
    // The premise the allow-list rests on. A token here is app-themed ink on a page pinned to white.
    const tokens = designTokens();
    expect(tokens.size).toBeGreaterThan(20);
    const offences: string[] = [];
    for (const rule of rulesIn(rulesOf(BRAND))) {
      if (!rule.selectors.some((selector) => isSharedByDesign(selector))) continue;
      for (const match of rule.declarations.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (tokens.has(match[1])) offences.push(`${rule.selectors.join(', ')} → ${match[1]}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('the shared rules are actually present, and are the only bare-container ones', () => {
    // Guards the allow-list from both sides: an entry that matches nothing would silently permit
    // nothing while looking like a considered exception, and the list is only meaningful if the
    // sheet really does contain the rules it names.
    for (const shared of SHARED_BY_DESIGN) {
      expect(brandSelectors.some((selector) => selector.startsWith(shared))).toBe(true);
    }
  });

  it('the page break the other styles draw is not drawn on the Print page', () => {
    // The Print style shows one page's appearance, not a paginated document. A dashed rule across it
    // would be the one mark on the page the export does not draw.
    const pageBreakRules = rulesIn(rulesOf(BRAND)).filter((rule) =>
      rule.selectors.some((selector) => selector.includes('page-break-after')),
    );
    expect(pageBreakRules.length).toBeGreaterThan(0);
    for (const rule of pageBreakRules) {
      for (const selector of rule.selectors) expect(reachesPrint(selector)).toBe(false);
    }
  });

  it('the vendored Asciidoctor stylesheet names its own style, so it cannot reach Print', () => {
    const leaking = selectorsOf(rulesOf(GENERATED)).filter((selector) => {
      const report = reportScope(selector);
      return (
        report.containerIndex === null ||
        report.pinnedStyle !== 'asciidoctor' ||
        report.escapesContainer
      );
    });
    expect(leaking).toEqual([]);
  });
});

describe('nothing of one style survives a switch to another', () => {
  // Every style's rules hang off the container's own `data-preview-style`, so changing that attribute
  // changes which rules match with nothing left to clean up. What could survive a switch is anything
  // written onto the element instead: this asserts the three stylesheets ask for no such state.
  it('no stylesheet asks for a class on the container, only for its style attribute', () => {
    // A class-qualified container would have to be added AND removed by the panel, and "removed" is
    // the half that gets forgotten — the previous version of this test guarded one hypothetical
    // class name (`.print-page`) that no stylesheet has ever contained, so it could only ever fail
    // for the one spelling somebody happened to think of. The invariant is the general one.
    // The two HAND-WRITTEN sheets. The vendored one is excluded on purpose: it qualifies the
    // container with `.book` and `.toc2`, which are Asciidoctor's own DOCUMENT classes (doctype and
    // TOC placement) rather than anything the panel toggles when the style changes, and it is
    // generated from upstream so the rule could not be honoured there anyway.
    const qualified: string[] = [];
    for (const file of [PRINT, BRAND]) {
      for (const selector of selectorsOf(rulesOf(file))) {
        const extra = reportScope(selector).extraContainerClasses;
        if (extra.length > 0) qualified.push(`${path.basename(file)}: ${selector}`);
      }
    }
    expect(qualified).toEqual([]);
    expect(rulesOf(PRINT)).toContain(`${PRINT_SCOPE} {`);
  });

  it('the Print stylesheet reads no design token, so the page cannot follow the app theme', () => {
    // The page is paper. Paper looks the same under the application's light and dark modes, and the
    // file says so in its header — this is that sentence, made checkable.
    const tokens = designTokens();
    const properties = propertiesReadIn(PRINT);
    // Both halves of the intersection, in this test rather than in a sibling: a token table that came
    // back empty, or a sheet nothing could be read out of, makes the filter below empty whatever the
    // sheet says. The sibling tests that happen to guard the same two things today are free to change.
    expect(tokens.size).toBeGreaterThan(0);
    expect(properties.size).toBeGreaterThan(0);
    expect([...properties].filter((name) => tokens.has(name))).toEqual([]);
  });

  it("every property the Print sheet reads is either the projection's or its own", () => {
    // `--print-*` is the contract with `appearance-to-css.ts` (asserted, both directions, in
    // `appearance-to-css.test.ts`). Anything else has to be one of this sheet's own relays, declared
    // in this sheet — a name that is neither is a value arriving from somewhere nobody has named.
    const declared = propertiesDeclaredIn(PRINT);
    expect(declared.size).toBeGreaterThan(0);
    const unaccounted = [...propertiesReadIn(PRINT)].filter(
      (name) => !name.startsWith('--print-') && !declared.has(name),
    );
    expect(unaccounted).toEqual([]);
  });

  it('no style writes a custom property another style would read', () => {
    const printProperties = propertiesDeclaredIn(PRINT);
    const others = `${rulesOf(BRAND)}${rulesOf(GENERATED)}`;
    // Neither side may be empty, for the reason above: a Print sheet that declared nothing of its own,
    // or a pair of other sheets read as empty text, would satisfy this without either file changing.
    expect(printProperties.size).toBeGreaterThan(0);
    expect(others).toContain('var(');
    const shared = [...printProperties].filter((name) => others.includes(`var(${name}`));
    expect(shared).toEqual([]);
  });
});
