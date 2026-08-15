import { readFileSync } from 'node:fs';
import path from 'node:path';

// The previewed page is paper. Paper does not change colour when the application does, so every
// colour on it must come from the theme or from a fixed literal — never from a design token, and
// never from a dark-mode branch. The chrome AROUND the page is the opposite: it is the application
// talking, so it stays token-driven and follows the interface.
const PRINT = path.resolve(__dirname, '../../src/styles/print-preview.css');

/** The stylesheet with its comments removed, so prose cannot satisfy or break an assertion. */
const RULES = readFileSync(PRINT, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '');

describe('the page looks the same in light and dark mode', () => {
  it('reads no design token, so nothing on the page follows the application theme', () => {
    // `hsl(var(--foreground))` and friends are how the rest of the preview adapts to light and dark.
    // One of them here is one element of the page that changes colour with the interface around it.
    //
    // A token is a property this file does not define: it arrives from the application's own theme
    // layer, which is exactly what makes it follow the interface. So the rule is that every custom
    // property read here is either one the projection writes (`--print-*`, held to the writer by its
    // own test) or one this file DECLARES itself. That is a stricter statement than "the name starts
    // with `--print-`", and it is the one that actually describes the danger — a stylesheet that
    // relays a value of its own through the cascade is not reaching outside itself to get it.
    const declared = new Set(
      [...RULES.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((match) => match[1]),
    );
    const read = [...RULES.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]);
    const foreign = read.filter((name) => !name.startsWith('--print-') && !declared.has(name));
    expect([...new Set(foreign)].toSorted()).toEqual([]);
    expect(RULES).not.toMatch(/\bhsl\(/);
  });

  it('carries no dark-mode branch of any kind', () => {
    expect(RULES).not.toMatch(/prefers-color-scheme/);
    expect(RULES).not.toMatch(/\.dark\b/);
    expect(RULES).not.toMatch(/light-dark\(/);
  });

  it('tells the browser the page is a light surface, so the UA does not invert its own parts', () => {
    // Form controls, scrollbars and the default canvas follow `color-scheme`. Without this, a reader
    // in dark mode gets a page whose theme colours are right and whose UA-drawn parts are not.
    expect(RULES).toMatch(/color-scheme:\s*light/);
  });

  it('states every literal colour as a fixed value rather than a computed one', () => {
    // Anything that is not a hex literal, a colour keyword this file uses on purpose, or a custom
    // property is a colour that could resolve differently in another context.
    const values = [...RULES.matchAll(/(?:color|background-color|border-color)\s*:\s*([^;]+);/g)].map(
      (match) => match[1].trim(),
    );
    // The guard has to count the list the loop below actually walks. It counted `values` — 162
    // declarations on this anchor — while the loop drops every one whose value is nothing but a
    // `var()`, which is 66 of them; a change that left two literals in the file and turned the other
    // 94 into custom-property reads would have passed a threshold of ten with room to spare. The
    // bound is on what is asserted, and is set just under what this anchor measures.
    const asserted = values
      .map((value) => value.replaceAll(/var\([^;]*\)/g, '').trim())
      .filter((literals) => literals !== '');
    expect(asserted.length).toBeGreaterThan(90);
    for (const literals of asserted) {
      expect(literals).toMatch(/^(#[\da-f]{3,8}|transparent|inherit|currentcolor|none)$/i);
    }
  });
});
