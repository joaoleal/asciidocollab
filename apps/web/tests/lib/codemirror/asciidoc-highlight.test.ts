import fs from 'node:fs';
import path from 'node:path';
import { buildParser } from '@lezer/generator';
import { highlightTree, tags as t } from '@lezer/highlight';
import type { LRParser } from '@lezer/lr';
import { asciidocHighlightStyle } from '@/lib/codemirror/asciidoc-theme';
import { asciidocHighlightTags, ad } from '@/lib/codemirror/asciidoc-highlight-tags';
import {
  computeKnownRoleSpanMarks,
  registerInlineStyle,
  resetCustomInlineStyles,
} from '@/lib/codemirror/inline-style-registry';
import { createTestBlockTokenizer, createTestBlockContext } from '../../helpers/asciidoc-test-tokenizer';

/**
 * Highlight-consistency tests: each list/block construct added by feature 021 must receive the
 * SAME highlight class as its existing sibling, so the new tokens stay in lockstep with the
 * editor's colouring (no behaviour/highlight divergence). The parser is built from the grammar
 * source (the generated `asciidoc-parser.js` is ESM and not loadable here) and configured with
 * the production `asciidocHighlightTags`; classes are resolved through `asciidocHighlightStyle`
 * from `asciidoc-theme.ts`, the authoritative colour source (applied at `Prec.highest`).
 */

const grammarPath = path.resolve(__dirname, '../../../src/lib/codemirror/asciidoc.grammar');
const grammarSource = fs.readFileSync(grammarPath, 'utf8');

const parser = buildParser(grammarSource, {
  externalTokenizer: (_name: string, terms: Record<string, number>) => createTestBlockTokenizer(terms),
  contextTracker: (terms: Record<string, number>) => createTestBlockContext(terms),
}).configure({ props: [asciidocHighlightTags] }) as LRParser;

/** Returns the highlight class string applied at `pos` when `source` is parsed + highlighted. */
function classAt(source: string, pos: number): string {
  const tree = parser.parse(source);
  let result = '';
  highlightTree(tree, asciidocHighlightStyle, (from, to, classes) => {
    if (from <= pos && to > pos) result = classes;
  });
  return result;
}

describe('AsciiDoc highlight consistency', () => {
  test('a .... literal block body gets the same class as a ---- listing block body', () => {
    // Both bodies start at offset 5 ('....\n' / '----\n' are 5 chars).
    const literalClass = classAt('....\nlit\n....\n', 5);
    const listingClass = classAt('----\nlit\n----\n', 5);
    expect(literalClass).not.toBe('');
    expect(literalClass).toBe(listingClass);
  });

  test('explicit `1. x` gets the same class as implicit `. x`', () => {
    const explicitClass = classAt('1. x\n', 0);
    const implicitClass = classAt('. x\n', 0);
    expect(explicitClass).not.toBe('');
    expect(explicitClass).toBe(implicitClass);
  });

  test('dash checklist `- [ ] x` gets the same class as `* [ ] x`', () => {
    const dashClass = classAt('- [ ] x\n', 0);
    const starClass = classAt('* [ ] x\n', 0);
    expect(dashClass).not.toBe('');
    expect(dashClass).toBe(starClass);
  });

  test('`Term;; x` gets the same class as `Term:: x`', () => {
    // Both separators sit at offset 4 (after the 4-char term `Term`).
    const semicolonClass = classAt('Term;; x\n', 4);
    const colonClass = classAt('Term:: x\n', 4);
    expect(semicolonClass).not.toBe('');
    expect(semicolonClass).toBe(colonClass);
  });

  // Every new inline/break construct must resolve to a non-empty highlight class
  // through the production highlight style (so all five themes colour it). The offset points
  // inside the construct on each sample line.
  test.each([
    ['a +literal+ b\n', 3, 'passthrough'],
    ['x [[anchor]] y\n', 3, 'inline anchor'],
    ['[[[ref]]] z\n', 0, 'bibliography anchor'],
    ['Acme (C) co\n', 5, 'replacement'],
    ['a &amp; b\n', 2, 'entity'],
    ['code <1>\n', 5, 'callout'],
    ['press kbd:[Esc] x\n', 8, 'ui macro'],
    ['see stem:[x^2] y\n', 6, 'inline stem'],
    ['go https://x.com now\n', 5, 'bare url'],
    ['a "`smart`" quote\n', 2, 'smart quote'],
    ['line one +\ntwo\n', 9, 'hard break'],
    ["'''\n", 0, 'thematic break'],
    ['<<<\n', 0, 'page break'],
  ])('%j (offset %i) is highlighted as a %s', (source, offset) => {
    expect(classAt(source, offset)).not.toBe('');
  });

  // Inline `{set:name:value}` / `{set:name!}` assignments are highlighted as
  // attribute definitions (the same `t.meta` class as an `:name:` entry), so an inline assignment
  // reads as an attribute construct in the editor.
  test('an inline `{set:name:value}` assignment gets the AttributeEntry class', () => {
    // The `{set:...}` token spans the whole construct; offset 5+4 sits inside it.
    const setClass = classAt('Intro {set:basedir:src} end\n', 5 + 4);
    const entryClass = classAt(':one: x\n', 0); // a plain `:name:` attribute entry
    expect(setClass).not.toBe('');
    expect(setClass).toBe(entryClass);
  });

  test('an inline `{set:name!}` unset assignment is highlighted', () => {
    expect(classAt('Reset {set:basedir!} now\n', 6 + 4)).not.toBe('');
  });

  // A multi-line wrapped attribute entry (a value continued with a trailing
  // `\`) highlights EVERY continued line as part of the same AttributeEntry, so the whole entry
  // reads as one attribute definition rather than the continuation falling back to plain prose.
  test('all lines of a `\\`-continued attribute entry get the AttributeEntry class', () => {
    const source = ':longval: first \\\nsecond \\\nthird\nbody\n';
    const entryClass = classAt(':one: x\n', 0); // a plain attribute entry's class
    expect(entryClass).not.toBe('');
    // The first physical line.
    expect(classAt(source, 0)).toBe(entryClass);
    // The second (continued) line — offset of `second`.
    expect(classAt(source, source.indexOf('second'))).toBe(entryClass);
    // The third (continued) line — offset of `third`.
    expect(classAt(source, source.indexOf('third'))).toBe(entryClass);
    // The following plain line is NOT part of the entry.
    expect(classAt(source, source.indexOf('body'))).not.toBe(entryClass);
  });

  // A role span `[.role]#text#` (and its unconstrained `##text##` form) is
  // tokenised as a RoleSpan and highlighted generically. EVERY role span — known or unknown — gets a
  // non-empty highlight class; the known-vs-unknown distinction is layered on by a decoration (below).
  describe('role spans highlight generically', () => {
    test('a `[.lead]#text#` role span is highlighted', () => {
      // `[.lead]#` is 8 chars; offset 9 sits inside the body.
      expect(classAt('A [.lead]#intro# end\n', 9 + 2)).not.toBe('');
    });

    test('an unconstrained `[.lead]##text##` role span is highlighted', () => {
      expect(classAt('A [.lead]##in##tro end\n', 9 + 3)).not.toBe('');
    });

    test('an UNKNOWN custom role still highlights generically', () => {
      // The role is not in the registry, yet the span is still a role span and is coloured.
      expect(classAt('A [.totally-custom]#x# end\n', 2 + 19)).not.toBe('');
    });

    test('a known and an unknown role span share the same generic grammar class', () => {
      const knownClass = classAt('[.lead]#x#\n', 8);
      const unknownClass = classAt('[.zzz]#x#\n', 7);
      expect(knownClass).not.toBe('');
      expect(knownClass).toBe(unknownClass);
    });
  });
});

// AsciiDoc constrained/unconstrained boundary rules. A constrained mark
// (single `*`/`_`/backtick) only forms emphasis when it abuts a word boundary; a mark embedded inside a
// word (`a*b*c`, `2*3*4`) is plain text. Unconstrained marks (`**`/`__`/double-backtick) form anywhere,
// including mid-word. The rule errs toward NO false highlights on ambiguity.
describe('constrained / unconstrained inline boundary rules', () => {
  test('genuine constrained `*bold*` is highlighted as strong', () => {
    // The `*` opens at offset 5 in `Some *bold* text`.
    expect(classAt('Some *bold* text\n', 6)).not.toBe('');
  });

  test('genuine constrained `_italic_` is highlighted', () => {
    expect(classAt('an _italic_ word\n', 4)).not.toBe('');
  });

  test('genuine constrained `` `mono` `` is highlighted', () => {
    expect(classAt('run `code` now\n', 5)).not.toBe('');
  });

  test('`a*b*c` does NOT highlight the embedded `*` as bold (constrained rule)', () => {
    // The `*` at offset 1 is surrounded by word chars — no emphasis.
    const boldClass = classAt('Some *bold* text\n', 6);
    expect(classAt('a*b*c here\n', 2)).not.toBe(boldClass);
  });

  test('`2*3*4` arithmetic does NOT bold', () => {
    const boldClass = classAt('Some *bold* text\n', 6);
    expect(classAt('2*3*4 done\n', 2)).not.toBe(boldClass);
  });

  test('`Vec<3>` is not falsely highlighted as bold/italic', () => {
    const boldClass = classAt('Some *bold* text\n', 6);
    expect(classAt('Vec<3> type\n', 4)).not.toBe(boldClass);
  });

  test('unconstrained `**bold**` is highlighted', () => {
    expect(classAt('a**bold**c word\n', 4)).not.toBe('');
  });

  test('unconstrained `__italic__` mid-word is highlighted', () => {
    // `un__der__score` — the inner mark is embedded in a word but unconstrained, so it forms.
    expect(classAt('un__der__score\n', 5)).not.toBe('');
  });

  test('a constrained bold span and an unconstrained bold span share the strong class', () => {
    const constrained = classAt('Some *bold* text\n', 6);
    const unconstrained = classAt('a**bold**c word\n', 4);
    expect(constrained).not.toBe('');
    expect(constrained).toBe(unconstrained);
  });
});

// A cross-reference `<<id,label>>` distinguishes its target ID from its
// display label, and a table block-attribute line's `cols="…"` specifier is tokenized distinctly.
describe('xref target/label and table cols highlighting', () => {
  test('an xref target id `<<id,label>>` is highlighted', () => {
    // `See <<intro,Introduction>>` — `intro` begins at offset 6.
    expect(classAt('See <<intro,Introduction>> end\n', 6)).not.toBe('');
  });

  test('an xref label is highlighted distinctly from the target', () => {
    const source = 'See <<intro,Introduction>> end\n';
    const targetClass = classAt(source, 6); // inside `intro`
    const labelClass = classAt(source, source.indexOf('Introduction')); // inside the label
    expect(targetClass).not.toBe('');
    expect(labelClass).not.toBe('');
    expect(targetClass).not.toBe(labelClass);
  });

  test('a bare `<<id>>` (no label) still highlights the target', () => {
    expect(classAt('See <<intro>> end\n', 6)).not.toBe('');
  });

  test('a table `[cols="1,>2"]` column spec is tokenized and highlighted', () => {
    const source = '[cols="1,>2"]\n';
    // The `1,>2` cols value begins at offset 7.
    expect(classAt(source, 8)).not.toBe('');
  });

  test('a `[cols="1,1,1"]` spec is tokenized', () => {
    expect(classAt('[cols="1,1,1"]\n', 8)).not.toBe('');
  });
});

// The registry-driven decoration gives KNOWN roles a distinct emphasis on top of
// the generic grammar highlight, while leaving unknown roles with only the generic class. This is the
// known-vs-unknown layer; registering a custom role flips it on with no logic change.
describe('known role-span emphasis', () => {
  afterEach(() => resetCustomInlineStyles());

  test('a built-in role span is marked as known', () => {
    const marks = computeKnownRoleSpanMarks('A [.lead]#intro# end\n');
    expect(marks).toHaveLength(1);
    expect(marks[0].from).toBe(2);
    expect(marks[0].to).toBe('A [.lead]#intro#'.length);
  });

  test('an unknown role span is NOT marked as known', () => {
    expect(computeKnownRoleSpanMarks('A [.mystery]#x# end\n')).toHaveLength(0);
  });

  test('registering a custom role makes its span known — no logic change', () => {
    expect(computeKnownRoleSpanMarks('[.brandy]#x#\n')).toHaveLength(0);
    registerInlineStyle('brandy');
    expect(computeKnownRoleSpanMarks('[.brandy]#x#\n')).toHaveLength(1);
  });

  test('a multi-role span counts as known when ANY role is known', () => {
    expect(computeKnownRoleSpanMarks('[.unknownrole.lead]#x#\n')).toHaveLength(1);
  });
});

// ── Feature 030 — Syntax Highlighting Rework ─────────────────────────────────
describe('030 — structural markup recedes, block bodies not flooded', () => {
  test('example block fence class differs from body class', () => {
    const source = '====\nbody\n====\n';
    expect(classAt(source, 0)).not.toBe(classAt(source, 5));
  });

  test('listing block fence class differs from body class', () => {
    const source = '----\nbody\n----\n';
    expect(classAt(source, 0)).not.toBe(classAt(source, 5));
  });

  test('table block fence class differs from cell content class', () => {
    const source = '|===\n| cell\n|===\n';
    expect(classAt(source, 0)).not.toBe(classAt(source, 6));
  });

  test('all block fence types share the same markup class', () => {
    const exFence  = classAt('====\nbody\n====\n', 0);
    const listFence = classAt('----\nbody\n----\n', 0);
    const sideBar  = classAt('****\nbody\n****\n', 0);
    expect(exFence).not.toBe('');
    expect(listFence).toBe(exFence);
    expect(sideBar).toBe(exFence);
  });

  test('unordered list marker shares markup class with block fences', () => {
    expect(classAt('* item\n', 0)).toBe(classAt('====\nbody\n====\n', 0));
  });

  test('ordered list marker shares markup class with block fences', () => {
    expect(classAt('. item\n', 0)).toBe(classAt('====\nbody\n====\n', 0));
  });
});

describe('030 — heading level ramp', () => {
  test('DocumentTitle, Heading1, Heading2, Heading3 each get distinct classes', () => {
    const h0 = classAt('= Title\n', 2);
    const h1 = classAt('== Section\n', 3);
    const h2 = classAt('=== Sub\n', 4);
    const h3 = classAt('==== Sub-sub\n', 5);
    expect(h0).not.toBe('');
    expect(h1).not.toBe('');
    expect(h2).not.toBe('');
    expect(h3).not.toBe('');
    expect(h0).not.toBe(h1);
    expect(h1).not.toBe(h2);
    expect(h2).not.toBe(h3);
  });

  test('Heading4, Heading5, Heading6 share the grouped --syntax-h3 spec in asciidoc-theme', () => {
    // asciidoc-theme.ts groups h4/h5/h6 in one spec — verify the intent directly.
    const rampSpec = asciidocHighlightStyle.specs.find((spec) => {
      const specTags = Array.isArray(spec.tag) ? spec.tag : [spec.tag];
      return specTags.includes(t.heading4) && specTags.includes(t.heading5);
    });
    expect(rampSpec).toBeDefined();
    expect(rampSpec!.color).toContain('--syntax-h3');
    // All three levels must resolve to a non-empty highlight class.
    expect(classAt('==== Sub-sub\n', 5)).not.toBe('');
    expect(classAt('===== Deepest\n', 6)).not.toBe('');
    expect(classAt('====== Even-deeper\n', 7)).not.toBe('');
  });

  test('every heading spec is bold (fontWeight 700) at all levels', () => {
    const headingTagSet = new Set<unknown>([t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6]);
    for (const spec of asciidocHighlightStyle.specs) {
      const specTags = Array.isArray(spec.tag) ? spec.tag : [spec.tag];
      if (specTags.some((tag) => headingTagSet.has(tag))) {
        expect((spec as Record<string, unknown>).fontWeight).toBe('700');
      }
    }
  });

  test('every heading spec explicitly clears text-decoration (defaultHighlightStyle underline guard)', () => {
    // defaultHighlightStyle (mounted for embedded source blocks) underlines headings, so each heading
    // spec MUST set textDecoration:'none' to override it at Prec.highest — never 'underline'.
    const headingTagSet = new Set<unknown>([t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6]);
    for (const spec of asciidocHighlightStyle.specs) {
      const specTags = Array.isArray(spec.tag) ? spec.tag : [spec.tag];
      const isHeadingSpec = specTags.some((tag) => headingTagSet.has(tag));
      if (isHeadingSpec) {
        expect((spec as Record<string, unknown>).textDecoration).toBe('none');
      }
    }
  });
});

describe('030 — admonition severity labels (chip only, body clean)', () => {
  test('inline NOTE: prefix is highlighted', () => {
    expect(classAt('NOTE: body\n', 0)).not.toBe('');
  });

  test('all five inline severity labels have distinct classes', () => {
    const severities = [
      classAt('NOTE: x\n', 0),
      classAt('TIP: x\n', 0),
      classAt('WARNING: x\n', 0),
      classAt('IMPORTANT: x\n', 0),
      classAt('CAUTION: x\n', 0),
    ];
    for (const cls of severities) expect(cls).not.toBe('');
    for (let index = 0; index < severities.length; index++) {
      for (let jdx = index + 1; jdx < severities.length; jdx++) {
        expect(severities[index]).not.toBe(severities[jdx]);
      }
    }
  });

  test('admonition body text does not get the label chip class', () => {
    const source = 'NOTE: body text\n';
    expect(classAt(source, 0)).not.toBe(classAt(source, 6));
  });

  test('the label chip is TIGHT — the space after `NOTE:` reads as plain body, not chip', () => {
    const source = 'NOTE: body\n';
    const chipClass = classAt(source, 0); // inside `NOTE:`
    const spaceClass = classAt(source, 5); // the space between the colon and the body
    const bodyClass = classAt(source, 6); // `b` of body
    expect(chipClass).not.toBe('');
    expect(spaceClass).not.toBe(chipClass); // space is NOT part of the chip
    expect(spaceClass).toBe(bodyClass); // space reads as plain body
  });

  test('[NOTE] block annotation is highlighted', () => {
    expect(classAt('[NOTE]\n====\nbody\n====\n', 1)).not.toBe('');
  });

  test('[NOTE] block annotation class matches inline NOTE: prefix class', () => {
    const inlineCls = classAt('NOTE: x\n', 0);
    const blockCls  = classAt('[NOTE]\n====\nbody\n====\n', 1);
    expect(inlineCls).toBe(blockCls);
  });

  test('NOTE: mid-sentence is not highlighted as a severity label', () => {
    const inlineCls = classAt('NOTE: body\n', 0);
    expect(classAt('See NOTE: x\n', 4)).not.toBe(inlineCls);
  });
});

describe('030 — block interiors readable', () => {
  test('block title is highlighted as a non-empty class', () => {
    expect(classAt('.Block Title\nbody\n', 1)).not.toBe('');
  });

  test('inside a listing block, `*` chars are not highlighted as bold', () => {
    const boldCls    = classAt('Some *bold* text\n', 6);
    const inBlockCls = classAt('----\n*not bold*\n----\n', 6);
    expect(inBlockCls).not.toBe(boldCls);
  });

  test('inside a listing block, `{attr}` chars are not highlighted as attribute refs', () => {
    const attributeCls    = classAt('{version}\n', 0);
    const inBlockCls = classAt('----\n{attr}\n----\n', 5);
    expect(inBlockCls).not.toBe(attributeCls);
  });
});

describe('030 — list types, inline code, links distinct', () => {
  test('checklist done [x] marker class differs from todo [ ] marker class', () => {
    const doneCls = classAt('* [x] done\n', 3);
    const todoCls = classAt('* [ ] todo\n', 3);
    expect(doneCls).not.toBe('');
    expect(todoCls).not.toBe('');
    expect(doneCls).not.toBe(todoCls);
  });

  test('both checklist box markers are bold (fontWeight 700)', () => {
    for (const adTag of [ad.checkDone, ad.checkTodo]) {
      const spec = asciidocHighlightStyle.specs.find((s) => {
        const tags = Array.isArray(s.tag) ? s.tag : [s.tag];
        return tags.includes(adTag);
      });
      expect(spec).toBeDefined();
      expect((spec as Record<string, unknown>).fontWeight).toBe('700');
    }
  });

  test('link is highlighted', () => {
    expect(classAt('Go https://example.org now\n', 5)).not.toBe('');
  });

  test('link class differs from unordered list marker class', () => {
    expect(classAt('Go https://example.org now\n', 5)).not.toBe(classAt('* item\n', 0));
  });

  test('inline code is highlighted', () => {
    expect(classAt('run `code` now\n', 5)).not.toBe('');
  });

  test('description list term is highlighted', () => {
    expect(classAt('Term:: description\n', 0)).not.toBe('');
  });

  // The term + `::` separator carry the term colour, but the DEFINITION on the same line reads as
  // body — the SAME class as a wrapped continuation line (so `Science…` and `math.` match).
  test('description definition text is body, distinct from the term', () => {
    const source = 'STEM:: Science, tech, engineering,\nmath.\n';
    const termClass = classAt(source, 1); // inside `STEM`
    const definitionClass = classAt(source, source.indexOf('Science')); // first-line definition
    const continuationClass = classAt(source, source.indexOf('math.')); // continuation line
    expect(termClass).not.toBe('');
    expect(definitionClass).not.toBe(termClass);
    expect(definitionClass).toBe(continuationClass);
  });
});

describe('030 — block-attribute lines read consistently (amber)', () => {
  test('[stem] annotation shares the class of a generic [source,ruby] block-attribute line', () => {
    const stemClass = classAt('[stem]\n++++\nx\n++++\n', 1);
    const blockAttributeClass = classAt('[source,ruby]\n----\nx\n----\n', 1);
    expect(stemClass).not.toBe('');
    expect(stemClass).toBe(blockAttributeClass);
  });

  test('[cols] table spec shares the class of a generic block-attribute line', () => {
    const colsClass = classAt('[cols="1,1"]\n|===\n| a | b\n|===\n', 1);
    const blockAttributeClass = classAt('[source,ruby]\n----\nx\n----\n', 1);
    expect(colsClass).not.toBe('');
    expect(colsClass).toBe(blockAttributeClass);
  });
});

describe('030 — attribute refs, callouts', () => {
  test('{name} attribute reference is highlighted', () => {
    expect(classAt('{version}\n', 0)).not.toBe('');
  });

  test('{name} attribute reference class differs from plain body text', () => {
    expect(classAt('{version}\n', 0)).not.toBe(classAt('plaintext\n', 0));
  });

  test('callout <1> is highlighted', () => {
    expect(classAt('code <1>\n', 5)).not.toBe('');
  });

  test('callout class differs from ordered list marker class', () => {
    expect(classAt('code <1>\n', 5)).not.toBe(classAt('. item\n', 0));
  });
});
