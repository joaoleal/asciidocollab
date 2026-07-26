/**
 * MathJax's injected stylesheet declares an `@font-face` for all 22 of its fonts whatever the document
 * contains — 392 KB of `http://localhost:3000/vendor/mathjax/…`. These pin which of them a given
 * document actually justifies, because the answer is normally "none".
 */
import { classNames, usedFontFamilies } from '@/lib/html-export/math-fonts';

/** The shape of what MathJax injects: variant classes naming families, then a face for every family. */
const MATHJAX_CSS = `
mjx-container[jax="CHTML"] {line-height: 0;}
mjx-container[jax="CHTML"][display="true"] {display: block; text-align: center; margin: 1em 0;}
.MJX-TEX {font-family: MJXZERO, MJXTEX;}
.TEX-B {font-family: MJXZERO, MJXTEX-B;}
.TEX-I {font-family: MJXZERO, MJXTEX-I;}
.TEX-S1 {font-family: MJXZERO, MJXTEX-S1;}
@font-face /* 0 */ {font-family: MJXZERO; src: url("http://localhost:3000/vendor/mathjax/output/chtml/fonts/woff-v2/MathJax_Zero.woff") format("woff");}
@font-face /* 1 */ {font-family: MJXTEX; src: url("http://localhost:3000/vendor/mathjax/output/chtml/fonts/woff-v2/MathJax_Main-Regular.woff") format("woff");}
@font-face /* 2 */ {font-family: MJXTEX-B; src: url("http://localhost:3000/vendor/mathjax/output/chtml/fonts/woff-v2/MathJax_Main-Bold.woff") format("woff");}
@font-face /* 3 */ {font-family: MJXTEX-I; src: url("http://localhost:3000/vendor/mathjax/output/chtml/fonts/woff-v2/MathJax_Math-Italic.woff") format("woff");}
@font-face /* 4 */ {font-family: MJXTEX-S1; src: url("http://localhost:3000/vendor/mathjax/output/chtml/fonts/woff-v2/MathJax_Size1-Regular.woff") format("woff");}
`;

/** CHTML output for an italic variable: the variant class travels on the character element. */
const CHTML_HTML =
  '<mjx-container class="MathJax" jax="CHTML"><mjx-math class=" MJX-TEX">' +
  '<mjx-mi class="mjx-i"><mjx-c class="mjx-c1D465 TEX-I"></mjx-c></mjx-mi></mjx-math></mjx-container>';

describe('classNames', () => {
  test('collects exact tokens, not substrings', () => {
    // `TEX-B` is a substring of nothing here, but `MJX-TEX` contains `TEX` — a substring search would
    // report families the document never uses, and every false positive is 40 KB.
    const names = classNames('<p class="MJX-TEX other"></p>');
    expect(names.has('MJX-TEX')).toBe(true);
    expect(names.has('TEX')).toBe(false);
    expect(names.has('other')).toBe(true);
  });

  test('reads both quoting styles', () => {
    expect([...classNames("<i class='a b'></i>")]).toEqual(['a', 'b']);
  });

  test('markup with no classes uses nothing', () => {
    expect(classNames('<p>plain</p>').size).toBe(0);
  });
});

describe('usedFontFamilies', () => {
  test('reports only the families the rendered markup asks for', () => {
    const used = usedFontFamilies(MATHJAX_CSS, CHTML_HTML);
    expect([...used].toSorted()).toEqual(['MJXTEX', 'MJXTEX-I', 'MJXZERO']);
  });

  test('reports nothing for maths typeset as native MathML, which needs no MathJax font at all', () => {
    // This is the normal case: every current browser renders MathML itself, so an export that embedded
    // MathJax's fonts anyway would be shipping half a megabyte nobody ever reads.
    const mathml = '<math display="block"><mi>x</mi><mo>=</mo><mn>1</mn></math>';
    expect(usedFontFamilies(MATHJAX_CSS, mathml).size).toBe(0);
  });

  test('reports nothing for a document with no maths', () => {
    expect(usedFontFamilies(MATHJAX_CSS, '<p>Just prose.</p>').size).toBe(0);
  });

  test('a face cannot justify its own existence', () => {
    // `@font-face` declares a family without using it; counting that would keep every face forever.
    const facesOnly = '@font-face {font-family: MJXZERO; src: url("http://host/z.woff");}';
    expect(usedFontFamilies(facesOnly, '<p class="MJXZERO"></p>').size).toBe(0);
  });
});
