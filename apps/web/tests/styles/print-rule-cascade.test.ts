/* @jest-environment jsdom */
/**
 * @file Which of the Print stylesheet's rules actually wins, on the markup a converter produces.
 *
 * Every other test over this sheet asks what it SAYS: that a fallback is the value the projection
 * would write, that no selector escapes the container, that the vocabulary matches the projection's.
 * None of them asks what a browser would do with two rules that both reach the same element, and that
 * is where three defects lived at once — a button set upright inside `_…_` by a rule written for a
 * codespan's very different mechanism, a book's part title centred by the document title's rule, and
 * an admonition's textual label drawn as a caption because Asciidoctor names both `.title`.
 *
 * So this file resolves the cascade itself, over fixtures built from real converter output. It cannot
 * use `getComputedStyle`: jsdom's selector engine rejects some of the sheet's selectors outright, and
 * it resolves no custom property, so the winning declaration would come back as the literal text
 * `var(--print-x, y)` at best and as nothing at all at worst. Reading the winner out of the rules
 * directly is the same answer with the parts that matter left in — the property name AND the value
 * the rule gives it, which is exactly what these defects were about.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PRINT = path.resolve(__dirname, '../../src/styles/print-preview.css');

/** One rule of the stylesheet: a single selector, and the declarations it carries. */
interface Rule {
  /** The selector, with a selector list already split into one rule per selector. */
  readonly selector: string;
  /** Property name to value, in source order. */
  readonly declarations: ReadonlyMap<string, string>;
  /** Where the rule sits in the file, so a tie on specificity is broken the way CSS breaks it. */
  readonly order: number;
}

/** Split a selector list on its top-level commas, so `:is(a, b)` stays one selector. */
function splitSelectorList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const character = list[index];
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(list.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Read one rule's declarations, keeping only the last value written for a property. */
function readDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  let depth = 0;
  let start = 0;
  const statements: string[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ';' && depth === 0) {
      statements.push(body.slice(start, index));
      start = index + 1;
    }
  }
  statements.push(body.slice(start));
  for (const statement of statements) {
    const colon = statement.indexOf(':');
    if (colon === -1) continue;
    const name = statement.slice(0, colon).trim();
    if (name.length === 0) continue;
    declarations.set(name, statement.slice(colon + 1).trim().replaceAll(/\s+/g, ' '));
  }
  return declarations;
}

/** Every rule in the Print stylesheet, comments removed and selector lists split. */
function printRules(): Rule[] {
  const css = readFileSync(PRINT, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = readDeclarations(match[2]);
    for (const selector of splitSelectorList(match[1])) {
      rules.push({ selector, declarations, order: rules.length });
    }
  }
  return rules;
}

const RULES = printRules();

/**
 * A selector's specificity as the three counts CSS compares.
 *
 * Narrow on purpose: this sheet has no identifier selector and no `:not()`/`:where()`, and the only
 * functional pseudo-class it uses is `:is()` — whose specificity is its most specific argument — and
 * `:has()`, whose is the same. Anything outside that raises rather than being counted wrongly, so a
 * selector this cannot weigh fails the test that asked instead of quietly losing a tie.
 *
 * @param selector - One complex selector.
 * @returns The `[identifiers, classes, elements]` triple.
 */
function specificityOf(selector: string): [number, number, number] {
  if (selector.includes('#')) throw new Error(`unweighable selector: ${selector}`);
  let identifiers = 0;
  let classes = 0;
  let elements = 0;
  let rest = selector;
  // Functional pseudo-classes first: each contributes its most specific argument and nothing else.
  for (;;) {
    const opened = /:(is|has)\(/.exec(rest);
    if (opened === null) break;
    const start = opened.index + opened[0].length;
    let depth = 1;
    let end = start;
    while (end < rest.length && depth > 0) {
      if (rest[end] === '(') depth += 1;
      else if (rest[end] === ')') depth -= 1;
      if (depth > 0) end += 1;
    }
    const inner = rest.slice(start, end);
    let best: [number, number, number] = [0, 0, 0];
    for (const argument of splitSelectorList(inner)) {
      const weight = specificityOf(argument.replace(/^[>+~\s]+/, ''));
      if (weight > best) best = weight;
    }
    identifiers += best[0];
    classes += best[1];
    elements += best[2];
    rest = rest.slice(0, opened.index) + rest.slice(end + 1);
  }
  classes += (rest.match(/\.[\w-]+/g) ?? []).length;
  classes += (rest.match(/\[[^\]]*\]/g) ?? []).length;
  // Every remaining `:` is a plain pseudo-class or a pseudo-element; this sheet uses `::before`,
  // `::after`, `:first-child`, `:last-child`, `:not(:first-child)` and `:nth-of-type()`. None of them
  // decides any tie below, and both weights are counted so an unexpected one cannot be ignored.
  for (const pseudo of rest.match(/::?[\w-]+(\([^)]*\))?/g) ?? []) {
    if (pseudo.startsWith('::')) elements += 1;
    else classes += 1;
  }
  const bare = rest
    .replaceAll(/\[[^\]]*\]/g, ' ')
    .replaceAll(/::?[\w-]+(\([^)]*\))?/g, ' ')
    .replaceAll(/\.[\w-]+/g, ' ')
    .replaceAll(/[>+~]/g, ' ');
  elements += (bare.match(/(^|\s)[a-z][\w-]*/g) ?? []).length;
  return [identifiers, classes, elements];
}

/**
 * The same selector written out as a list with every `:is()` expanded into its alternatives.
 *
 * Only for MATCHING. jsdom's selector engine rejects an `:is()` nested inside a `:has()` outright —
 * `:has(> colgroup > :is(col[style], col[width]))` raises rather than answering — and a rule the
 * matcher cannot ask about is a rule that silently drops out of the cascade, which is worse than the
 * defect this file exists to catch. Expanding is exact: `:is(a, b)` matches what `a` or `b` matches.
 * Specificity is still weighed on the ORIGINAL, because expansion changes it.
 *
 * @param selector - One complex selector.
 * @returns One or more selectors whose union matches exactly what the original matches.
 */
function expandIs(selector: string): string[] {
  const opened = selector.indexOf(':is(');
  if (opened === -1) return [selector];
  const start = opened + ':is('.length;
  let depth = 1;
  let end = start;
  while (end < selector.length && depth > 0) {
    if (selector[end] === '(') depth += 1;
    else if (selector[end] === ')') depth -= 1;
    if (depth > 0) end += 1;
  }
  const before = selector.slice(0, opened);
  const after = selector.slice(end + 1);
  return splitSelectorList(selector.slice(start, end)).flatMap((argument) =>
    expandIs(`${before}${argument}${after}`),
  );
}

/** Whether an element matches a rule's selector, `:is()` and all. */
function matchesSelector(element: Element, selector: string): boolean {
  return expandIs(selector).some((expanded) => element.matches(expanded));
}

/** Whether the first specificity beats the second. */
function beats(left: [number, number, number], right: [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

/**
 * Build a fixture and return the element the assertions are about.
 *
 * @param markup - The converter's own output for the construct, without the preview container.
 * @param target - A selector for the element inside it.
 * @returns The element.
 */
function fixture(markup: string, target: string): Element {
  document.body.innerHTML = `<div class="asciidoc-preview-content" data-preview-style="print">${markup}</div>`;
  const element = document.querySelector(target);
  if (element === null) throw new Error(`the fixture carries no ${target}`);
  return element;
}

/**
 * The value one element ends up with for one property, resolving the cascade over this sheet alone.
 *
 * @param element - The element, inside a fixture.
 * @param property - The declaration to resolve.
 * @returns The winning value, or undefined when no rule in this sheet gives the element one.
 */
function winningValue(element: Element, property: string): string | undefined {
  let winner: Rule | undefined;
  for (const rule of RULES) {
    if (!rule.declarations.has(property)) continue;
    if (!matchesSelector(element, rule.selector)) continue;
    if (
      winner === undefined ||
      beats(specificityOf(rule.selector), specificityOf(winner.selector)) ||
      (!beats(specificityOf(winner.selector), specificityOf(rule.selector)) && rule.order > winner.order)
    ) {
      winner = rule;
    }
  }
  return winner?.declarations.get(property);
}

describe('the cascade resolver these assertions rest on', () => {
  it('reads the sheet at all, and reads whole declarations rather than fragments', () => {
    expect(RULES.length).toBeGreaterThan(150);
    const page = RULES.find((rule) => rule.selector === '.asciidoc-preview-content[data-preview-style="print"]');
    expect(page?.declarations.get('text-align')).toBe('var(--print-base-text-align, justify)');
  });

  it('weighs a selector the way CSS weighs it', () => {
    expect(specificityOf('.asciidoc-preview-content[data-preview-style="print"] b.button')).toEqual([0, 3, 1]);
    expect(specificityOf('.asciidoc-preview-content[data-preview-style="print"] em b.button')).toEqual([0, 3, 2]);
    // `:is()` takes its most specific argument, and nothing for the parentheses.
    expect(specificityOf(':is(h1, h2) code')).toEqual([0, 0, 2]);
    expect(specificityOf(':is(.sect0, h1)')).toEqual([0, 1, 0]);
    // `:has()` weighs the same way, which is what puts the textual-label rule above the icon widths.
    expect(specificityOf('td.icon:has(> .title)')).toEqual([0, 2, 1]);
  });

  it('prefers the more specific rule over the later one', () => {
    // A guard on the resolver itself: without it, every assertion below would be reporting nothing
    // more than source order, and the two rules that matter here are written in the other order.
    const paragraph = fixture('<p class="paragraph">text</p>', 'p');
    expect(winningValue(paragraph, 'nonesuch-property')).toBeUndefined();
  });
});

describe('a button and a menu path take the emphasis around them', () => {
  // `build_fragment` has one branch for all five inline constructs (`transform.rb:276`) and
  // `update_fragment` MERGES the theme's styles into what the markup contributed. Both constructs are
  // `bold` in the renderer's own default theme, so `_press btn:[Save] to continue_` is drawn
  // bold-italic on the page; the preview drew it upright, because the projection wrote
  // `--print-button-font-style: normal` and the only rule that could put the slant back was written
  // for codespans and key caps.
  const BUTTON = '<b class="button">Save</b>';
  const MENU =
    '<span class="menuseq"><b class="menu">File</b><i class="fa fa-angle-right caret"></i><b class="submenu">Save</b></span>';

  it('sets a button upright in ordinary prose, which is what the export draws', () => {
    // The other half of the same statement: `theme_font :caption` and every other block leave the
    // fragment's own styles alone, so a button outside emphasis really is upright whatever surrounds
    // it, and this rule must not be relaxed into `inherit` to make the case below work.
    const button = fixture(`<p class="paragraph">press ${BUTTON}</p>`, 'b.button');
    expect(winningValue(button, 'font-style')).toBe('var(--print-button-font-style, normal)');
    expect(winningValue(button, 'font-weight')).toBe('var(--print-button-font-weight, 700)');
  });

  it('slants a button inside emphasis and weights one inside strong text', () => {
    const slanted = fixture(`<p class="paragraph"><em>press ${BUTTON} now</em></p>`, 'b.button');
    expect(winningValue(slanted, 'font-style')).toBe('var(--print-button-font-style, inherit)');

    const heavy = fixture(`<p class="paragraph"><strong>press ${BUTTON} now</strong></p>`, 'b.button');
    expect(winningValue(heavy, 'font-weight')).toBe('var(--print-button-font-weight, inherit)');
  });

  it('takes both axes from a heading, which is the one block that passes its own style in', () => {
    // `ink_heading` hands the ambient style to the formatter as inherited fragment styles
    // (`converter.rb:3337`); no other block does.
    const button = fixture(`<h2>Use ${BUTTON}</h2>`, 'b.button');
    expect(winningValue(button, 'font-weight')).toBe('var(--print-button-font-weight, inherit)');
    expect(winningValue(button, 'font-style')).toBe('var(--print-button-font-style, inherit)');
  });

  it('reaches every part of a menu path, not only the span around them', () => {
    // Each part carries the weight and the slant of its own, so a rule on the `.menuseq` alone is
    // overridden on every one of them by the rule that sets `b.menu`.
    for (const part of ['b.menu', 'b.submenu']) {
      const element = fixture(`<p class="paragraph"><em>choose ${MENU}</em></p>`, part);
      expect(winningValue(element, 'font-style')).toBe('var(--print-menu-font-style, inherit)');
    }
    const upright = fixture(`<p class="paragraph">choose ${MENU}</p>`, 'b.menu');
    expect(winningValue(upright, 'font-style')).toBe('var(--print-menu-font-style, normal)');
  });
});

describe('a book part is not the document title', () => {
  // Asciidoctor writes a level-0 section as `<h1 class="sect0">` (`html5.rb:424`) and the document
  // title as a bare `<h1>`, and the renderer positions them from different chains: a part through
  // `heading.h1.text-align || heading.text-align || base.text-align` (`converter.rb:653`), the title
  // through `heading.h1.text-align` alone, centred when that key is unset (`converter.rb:194`).
  it('centres the document title', () => {
    const title = fixture('<h1>The Book</h1>', 'h1');
    expect(winningValue(title, 'text-align')).toBe('var(--print-heading-1-text-align, center)');
  });

  it('gives a part title the shared heading chain instead', () => {
    const part = fixture('<h1 class="sect0" id="_part_one">Part One</h1>', 'h1.sect0');
    expect(winningValue(part, 'text-align')).toBe(
      'var( --print-heading-1-text-align, var(--print-heading-text-align, var(--print-base-text-align, justify)) )',
    );
  });
});

describe('an admonition with no icon', () => {
  // `:icons!:` in a document header reaches this: the application's `icons=font` is a soft default a
  // document may replace. `convert_admonition` then measures the label — `label_width =
  // rendered_width_of_string label_text` (`converter.rb:952`), uppercased, in the label's own bold
  // face — where the icon branch reserves `icon_size * 1.5`.
  const TEXTUAL =
    '<div class="admonitionblock important"><table><tr><td class="icon"><div class="title">Important</div></td><td class="content">body</td></tr></table></div>';
  const ICON =
    '<div class="admonitionblock important"><table><tr><td class="icon"><i class="fa icon-important" title="Important"></i></td><td class="content">body</td></tr></table></div>';

  it('sizes the label column from the label rather than from an icon that is not there', () => {
    const cell = fixture(TEXTUAL, 'td.icon');
    expect(winningValue(cell, 'width')).toBe('1px');
    expect(winningValue(cell, 'white-space')).toBe('nowrap');
    const table = fixture(TEXTUAL, 'table');
    expect(winningValue(table, 'table-layout')).toBe('auto');
  });

  it('keeps the icon column exactly as it was when there IS an icon', () => {
    const cell = fixture(ICON, 'td.icon');
    expect(winningValue(cell, 'width')).toContain('--print-admonition-icon-important-size');
    expect(winningValue(cell, 'white-space')).toBeUndefined();
    const table = fixture(ICON, 'table');
    expect(winningValue(table, 'table-layout')).toBe('fixed');
  });

  it('sets the label in body text rather than in the caption group', () => {
    // Asciidoctor names the label `.title`, which is the class it also gives a block title — so the
    // caption rule reached it and drew every textual label at `caption.font-size`, in
    // `caption.font-style`'s italic, in `caption.font-color`. The renderer inks it inside
    // `theme_font_cascade [:admonition_label, …]`, which starts from whatever is in force.
    const label = fixture(TEXTUAL, 'td.icon .title');
    expect(winningValue(label, 'font-size')).toBe('var(--print-base-font-size, 14px)');
    expect(winningValue(label, 'font-family')).toBe('var(--print-base-font-family, "Noto Serif"), serif');
    expect(winningValue(label, 'color')).toBe('var(--print-base-font-color, #333333)');
    expect(winningValue(label, 'font-style')).toBe('var(--print-admonition-label-font-style, normal)');
    expect(winningValue(label, 'font-weight')).toBe('var(--print-admonition-label-font-weight, 700)');

    // And a real block title still is a caption, which is what the same class means everywhere else.
    const caption = fixture('<div class="listingblock"><div class="title">Listing 1</div></div>', '.title');
    expect(winningValue(caption, 'font-size')).toBe('var(--print-caption-font-size, 13.3px)');
  });
});
