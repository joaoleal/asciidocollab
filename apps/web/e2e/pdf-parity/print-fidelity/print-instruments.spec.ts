/**
 * @file The instruments this suite measures with, measured.
 *
 * ## What this file is, and what it is not
 *
 * A UNIT TEST of the harness's own PDF-reading instruments, and nothing else. Every case below hands
 * a decoder a document written three lines above it and compares the answer; the Print preview, the
 * stylesheet, the appearance projection and the render worker are not loaded, not exercised, and not
 * constrained. No change to anything under `apps/web/src` can turn a test in this file red.
 *
 * That is what a harness unit test is for, and it is deliberate — but it means the sixteen results
 * here are not sixteen statements about the preview, and counting them alongside the fidelity
 * comparisons would overstate what this suite has measured by exactly that many. What they establish
 * is that the instruments the fidelity comparisons read a reference PDF THROUGH give the answers the
 * PDF specification says they should; whether the preview then matches the reference is a question
 * every other file here asks and this one does not.
 *
 * ## Why the instruments need their own checks
 *
 * Every other spec here compares the Print preview against a reference PDF, and every one of them
 * reads that PDF through the same two decoders — {@link paintedBoxes} and {@link strokedPaths} — and
 * the same colour reader. Those are the only things in the suite that nothing checks, and three
 * successive review rounds found the same class of defect in them: an instrument that answers
 * confidently and wrongly makes a spec pass or fail for a reason that has nothing to do with the
 * preview, and no amount of care in the specs can see it.
 *
 * It was the CLIPPING support that made this unavoidable. Six defects were introduced or left in the
 * decoders across two rounds, and not one of them was reachable from the 39 committed references:
 * every reference is drawn under the identity transform with no clipping except inside an embedded
 * SVG, so the corpus exercises a single bare `n` and nineteen clip paths in total, and none of the
 * six shows up there. Waiting for a fixture to grow one is waiting for a silent wrong answer.
 *
 * So the documents here are written for the occasion: a few hundred bytes of PDF each, holding
 * exactly the operator sequence under test and nothing else. They cost no toolchain, no Docker image
 * and no browser, and they say what the decoder is supposed to answer in the one form that cannot
 * drift from the decoder — a page whose content stream is right there in the assertion.
 *
 * ## What each case is
 *
 * `W n` and its relatives are the PDF's clipping idiom (32000-1, 8.5.4): `W` marks the current path
 * as a clipping path, and the painting operator that FOLLOWS it — usually `n`, "paint nothing" — both
 * ends the path and decides what, if anything, it is drawn with. Two consequences drive every case
 * below. A bare `n` with no `W` in front of it clips nothing at all; and a `W` does not excuse its
 * path from being painted, so a `W f` is a mark on the page as well as a region for what comes after.
 *
 * The specification's own ordering — the clip takes effect after the painting operator on its own
 * path — is stated here and asserted nowhere, because no content stream can witness it: the path
 * being painted IS the clip path, so `path ∩ old ∩ path` and `path ∩ old` are the same box under
 * either order. See the `W f` case for the extents that were once offered as evidence for it.
 */

import { expect, test } from '@playwright/test';
import { paintedBoxes, strokedPaths, type PaintedBox } from '../harness/pdftools';
import { colourOf, hexOf } from './harness';

/**
 * A one-page PDF whose content stream is exactly `content`.
 *
 * Written out by hand rather than produced by a library: the point of these documents is that the
 * bytes the decoder is handed are the operators in the test, so a generator that reordered, merged or
 * optimised them would put the thing under test out of the test's reach.
 *
 * @param content - The page's content stream.
 * @returns The file's bytes.
 */
function onePage(content: string): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>',
    `<< /Length ${String(Buffer.byteLength(content, 'latin1'))} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  }
  const startxref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(startxref)}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

/** One box as `left,bottom→right,top`, so a whole answer compares as a single readable value. */
function extentOf(box: { leftPt: number; bottomPt: number; rightPt: number; topPt: number }): string {
  return `${box.leftPt.toFixed(2)},${box.bottomPt.toFixed(2)}→${box.rightPt.toFixed(2)},${box.topPt.toFixed(2)}`;
}

/** Every box a content stream paints, as extents in drawing order. */
async function extentsPainted(content: string): Promise<string[]> {
  const boxes = await paintedBoxes(onePage(content));
  return boxes.map((box) => extentOf(box));
}

/** Every path a content stream strokes, as extents in drawing order. */
async function extentsStroked(content: string): Promise<string[]> {
  const strokes = await strokedPaths(onePage(content));
  return strokes.map((stroke) => extentOf(stroke));
}

/**
 * What {@link hexOf} answers for one value, or null where it refused to answer.
 *
 * The two permitted outcomes, as one value: the property being asserted is that there is no third.
 *
 * @param value - The value to read.
 * @returns The colour as `#rrggbb`, or null when the reader threw.
 */
function readOrRefuse(value: string | undefined): string | null {
  try {
    return hexOf(value, 'the value under test');
  } catch {
    return null;
  }
}

test.describe('the painted-box decoder reads a clipping path the way the file means it', () => {
  test('a bare `n` discards its path and clips nothing that follows', async () => {
    // No `W`, so `0 0 10 10 re n` names no region: the fill after it covers its whole rectangle.
    // Read as a clip, it confined every later mark on the page to a tenth-inch square — and
    // prawn-svg really does write a bare `n`, so this is not a hypothetical shape.
    expect(await extentsPainted('0 0 10 10 re n\n0 0 400 400 re f')).toEqual(['0.00,0.00→400.00,400.00']);
  });

  test('a `W n` clips every mark after it, and a `W* n` does too', async () => {
    for (const clip of ['W', 'W*']) {
      expect(
        await extentsPainted(`q 0 0 100 100 re ${clip} n\n0 0 400 400 re f Q`),
        `${clip} n confines the fill after it`,
      ).toEqual(['0.00,0.00→100.00,100.00']);
    }
  });

  test('a clip is released by the `Q` that ends its graphics state', async () => {
    expect(
      await extentsPainted('q 0 0 100 100 re W n\n0 0 400 400 re f Q\n0 0 400 400 re f'),
    ).toEqual(['0.00,0.00→100.00,100.00', '0.00,0.00→400.00,400.00']);
  });

  test('a `W f` is a mark as well as a clip: it paints its own path, and confines what follows to it', async () => {
    // Two claims, and only these two. The path a `W f` names is PAINTED — a decoder that read the `W`
    // as "this path is a region, not a mark" reports one box where the file draws two — and the same
    // path is the region every later mark is confined to, which the 400x400 fill behind it shows by
    // coming back at the first rectangle's size instead of its own.
    //
    // What is deliberately NOT claimed is the ORDER. This case was named "paints its own path through
    // the OLD region", after 32000-1 8.5.4, and the two extents below were offered as evidence for it;
    // they are evidence for neither order over the other. The path being filled IS the clip path, so
    // the fill's extent is `path ∩ old ∩ path` if the clip lands first and `path ∩ old` if it lands
    // second, and those are the same box. Verified directly: both orderings answer identically on
    // every stream in this file. A sentence a test cannot fail on is not a property of the decoder.
    const atOrigin = await paintedBoxes(onePage('q 0 0 100 100 re W f\n0 0 400 400 re f Q'));
    expect(atOrigin.map(extentOf)).toEqual(['0.00,0.00→100.00,100.00', '0.00,0.00→100.00,100.00']);
    // Both are FILLS, which is what separates this from the `W S` case below: the `W f` is neither
    // dropped as a bare clip nor demoted to the stroke of a clip outline.
    expect(atOrigin.map((box: PaintedBox) => box.filled)).toEqual([true, true]);
    // …and the region is at the path's own coordinates rather than at the origin, which is the part a
    // decoder that carried a clip's SIZE without its position would answer wrongly — and would answer
    // rightly for the stream above, where the two are the same thing.
    expect(await extentsPainted('q 200 0 100 100 re W f\n0 0 400 400 re f Q')).toEqual([
      '200.00,0.00→300.00,100.00',
      '200.00,0.00→300.00,100.00',
    ]);
  });

  test('a `W S` clips what comes after it, and is reported as a stroke rather than a fill', async () => {
    const boxes = await paintedBoxes(onePage('q 0 0 100 100 re W S\n0 0 400 400 re f Q'));
    expect(boxes.map(extentOf)).toEqual(['0.00,0.00→100.00,100.00', '0.00,0.00→100.00,100.00']);
    expect(boxes.map((box: PaintedBox) => box.filled)).toEqual([false, true]);
  });

  test('two clips that do not meet hide everything after them rather than moving the region', async () => {
    // The reader sees nothing here: the two regions are disjoint, so their intersection is empty.
    // Reported as "no clip", the answer became the SECOND region — a box at coordinates nothing on
    // the page is drawn at, which is worse than no answer.
    expect(
      await extentsPainted('q 0 0 100 100 re W n 200 200 100 100 re W n\n0 0 400 400 re f Q'),
    ).toEqual([]);
    // …and it stays empty however many clips follow, rather than being re-established by one.
    expect(
      await extentsPainted(
        'q 0 0 100 100 re W n 200 200 100 100 re W n 0 0 400 400 re W n\n0 0 400 400 re f Q',
      ),
    ).toEqual([]);
  });

  test('a rule of no height inside a clip that contains it is still a mark on the page', async () => {
    // `stroke_horizontal_rule` writes a rectangle of zero height, and so does every connector line
    // in a diagram. Treated as an empty intersection it was deleted outright: thirteen real marks
    // across three committed references vanished, six of them the connector strokes of the diagram
    // on page 7 of `theme-editing`. A spec of the "the preview draws as many rules as the page
    // does" shape then under-counts the reference and passes a preview that draws too few.
    expect(await extentsPainted('q 0 0 400 400 re W n\n10 50 380 0 re f Q')).toEqual([
      '10.00,50.00→390.00,50.00',
    ]);
    // The same path with nothing clipping it, which is what it has to agree with.
    expect(await extentsPainted('10 50 380 0 re f')).toEqual(['10.00,50.00→390.00,50.00']);
    // A rule of no WIDTH — a `stroke_vertical_rule`, which is how every block frame's side is drawn.
    expect(await extentsPainted('q 0 0 400 400 re W n\n50 10 0 380 re f Q')).toEqual([
      '50.00,10.00→50.00,390.00',
    ]);
  });

  test('a mark wholly outside its clip is reported not at all', async () => {
    expect(await extentsPainted('q 0 0 100 100 re W n\n200 200 100 100 re f Q')).toEqual([]);
  });

  test('a clip is mapped through the transform in force, as the marks under it are', async () => {
    // The region is named in the space the clip path was written in, so it has to travel through the
    // same matrix — which is what an embedded SVG's viewport is: a clip under a scale and a
    // translate. Here the region is written as 0..100 under a half scale, so it lands at 0..50.
    expect(await extentsPainted('q 0.5 0 0 0.5 0 0 cm 0 0 100 100 re W n\n0 0 400 400 re f Q')).toEqual([
      '0.00,0.00→50.00,50.00',
    ]);
  });
});

test.describe('the stroked-path decoder reports the mark rather than the operand', () => {
  test('a stroke is confined by the clip in force, as its fill is', async () => {
    // The companion decoder narrows a fill to its clip; a stroke reported at full extent no longer
    // pairs with the fill it frames, and `print-block-frames.spec.ts` pairs the two by coordinate.
    expect(await extentsStroked('q 0 0 100 100 re W n\n2 w 0 0 400 400 re S Q')).toEqual([
      '0.00,0.00→100.00,100.00',
    ]);
    expect(await extentsStroked('q 0 0 100 100 re W n\n2 w 200 200 100 100 re S Q')).toEqual([]);
    // And the fill of the same rectangle is narrowed to exactly the same box, which is what makes
    // the two recognisable as one framed block.
    expect(await extentsPainted('q 0 0 100 100 re W n\n0 0 400 400 re f Q')).toEqual(
      await extentsStroked('q 0 0 100 100 re W n\n2 w 0 0 400 400 re S Q'),
    );
  });

  test('a path that only sets a clip is no stroke of its own, and the region it sets still narrows one', async () => {
    // The clip path is painted with `n`, so it strokes nothing and must be reported as nothing —
    // while the region it names still applies to the `S` after it.
    //
    // Three rectangles, all different, and that is the whole design of the case. This asserted
    // `toHaveLength(1)` on the stream at the head of this describe, where the clip and the stroke
    // share a box: there "one path was reported" cannot tell the stroke being kept from the CLIP path
    // being reported in its place, because both answer `0.00,0.00→100.00,100.00` — and the `toEqual`
    // above already covers everything the length did. Here the clip is 60 wide, the stroke starts at
    // 10 and runs to 110, and the answer is the overlap. A decoder that reported the clip path as a
    // stroke answers two extents; one that ignored `W n` outright answers the stroke at its full
    // 10..110; one that let the clip REPLACE the stroke's own box answers 0..60. Each of the three is
    // a different wrong answer, and none of them is this one.
    expect(await extentsStroked('q 0 0 60 60 re W n\n2 w 10 10 100 100 re S Q')).toEqual([
      '10.00,10.00→60.00,60.00',
    ]);
  });

  test('a line width is scaled by the transform, and by the part of it a thickness can carry', async () => {
    /** The width one stream strokes at. */
    const widthOf = async (content: string): Promise<number> => {
      const strokes = await strokedPaths(onePage(content));
      expect(strokes, `${content} strokes exactly one path`).toHaveLength(1);
      return strokes[0].lineWidthPt;
    };
    // Untransformed: the operand itself.
    expect(await widthOf('2 w 0 0 100 0 re S')).toBeCloseTo(2, 6);
    // A uniform scale scales it.
    expect(await widthOf('q 3 0 0 3 0 0 cm 2 w 0 0 100 0 re S Q')).toBeCloseTo(6, 6);
    // A rotation does not: a rotated pen is the same pen.
    const [cos, sin] = [Math.cos(0.7).toFixed(6), Math.sin(0.7).toFixed(6)];
    expect(await widthOf(`q ${cos} ${sin} ${String(-Number(sin))} ${cos} 0 0 cm 2 w 0 0 100 0 re S Q`)).toBeCloseTo(
      2,
      5,
    );
    // A translate does not either.
    expect(await widthOf('q 1 0 0 1 40 40 cm 2 w 0 0 100 0 re S Q')).toBeCloseTo(2, 6);
    // Under a NON-uniform scale a thickness is no longer one number, and the scalar reported is the
    // square root of the determinant — the factor area is scaled by. Reading the matrix's x column
    // instead (`hypot(a, b)`) reported this 2pt rule as 8pt: the amount a HORIZONTAL distance is
    // stretched by, which is the one direction a horizontal rule's thickness does not lie in.
    expect(await widthOf('q 4 0 0 1 0 0 cm 2 w 0 0 100 0 re S Q')).toBeCloseTo(4, 6);
    // A reflection is uniform, and a negative determinant must not become an imaginary width.
    expect(await widthOf('q -3 0 0 3 0 0 cm 2 w 0 0 100 0 re S Q')).toBeCloseTo(6, 6);
  });
});

test.describe('the colour reader refuses to answer where there is no colour to read', () => {
  test('it reads both syntaxes a value arrives in', () => {
    expect(colourOf('#336699')).toEqual([0x33, 0x66, 0x99]);
    expect(colourOf('rgb(51, 102, 153)')).toEqual([51, 102, 153]);
    expect(colourOf('rgba(51, 102, 153, 0.5)')).toEqual([51, 102, 153]);
    expect(hexOf('rgb(51, 102, 153)')).toBe('#336699');
    expect(hexOf('#336699')).toBe('#336699');
  });

  test('`transparent` is a construct that is not painted, not a construct painted black', () => {
    // Chromium computes `transparent` to exactly this, and the Print stylesheet writes that keyword
    // as the fallback of five `var()`s — so it is the value a computed style really reports for a
    // construct whose custom property the projection failed to emit. Read as `[0, 0, 0]`, an
    // unbanded table footer came back as a footer banded in black.
    expect(() => colourOf('rgba(0, 0, 0, 0)', 'the footer band')).toThrow(/transparent/);
    expect(() => colourOf('rgba(255, 0, 0, 0)')).toThrow(/transparent/);
    // A colour that is merely translucent is still a colour.
    expect(() => colourOf('rgba(0, 0, 0, 0.01)')).not.toThrow();
  });

  test('a value that is not a colour throws rather than becoming NaN', () => {
    for (const value of [undefined, '', '   ', 'none', 'currentColor', 'var(--nothing)', '#12345', 'rgb(1, 2)']) {
      expect(() => colourOf(value, 'the value under test'), `${JSON.stringify(value)} is not a colour`).toThrow();
      expect(() => hexOf(value, 'the value under test'), `${JSON.stringify(value)} is not a colour`).toThrow();
    }
  });

  test('no reading it does return can contain NaN, whatever it is handed', () => {
    // The property this replaced a private copy to establish, stated over EVERYTHING rather than
    // over the values that happen to be colours: either the reader throws, or its answer is six hex
    // digits. There is no third outcome.
    //
    // The copy had one. It sliced hex out of fixed offsets, so any other syntax produced `NaN`
    // channels and the string `#NaNNaNNaN`; its companion comparison then evaluated
    // `Math.abs(NaN - x) > tolerance`, which is `false`, and reported every character on the page as
    // agreeing with every character in the PDF.
    const values = [
      '#336699',
      'rgb(51, 102, 153)',
      'rgba(51, 102, 153, 0.5)',
      '#FFF000',
      'rgb(0,0,0)',
      'rgb(0 0 0 / 50%)',
      'currentColor',
      'transparent',
      'none',
      'var(--print-code-font-color)',
      'color-mix(in srgb, red, blue)',
      '#abc',
      '',
      undefined,
    ];
    // Which of them the reader is expected to ANSWER for, stated before the loop. Without it the
    // `continue` below made the whole property conditional on the reader's own behaviour: one that
    // threw on every value in the list — including the six that are plainly colours — executed zero
    // assertions and reported green, which is the one outcome this file exists to make impossible.
    const readable = new Set([
      '#336699',
      'rgb(51, 102, 153)',
      'rgba(51, 102, 153, 0.5)',
      '#FFF000',
      'rgb(0,0,0)',
      'rgb(0 0 0 / 50%)',
    ]);
    let answered = 0;
    for (const value of values) {
      const answer = readOrRefuse(value);
      // A refusal is a legitimate outcome — for the values that are not colours. For the six that
      // are, it is the reader failing to read a colour, and that is a defect rather than an opinion.
      if (answer === null) {
        expect(
          value === undefined || !readable.has(value),
          `${JSON.stringify(value)} is a colour and the reader refused it`,
        ).toBe(true);
        continue;
      }
      answered += 1;
      expect(answer, `${JSON.stringify(value)} read as ${answer}`).toMatch(/^#[\da-f]{6}$/);
    }
    expect(answered, 'the reader answered for every value that is a colour').toBe(readable.size);
  });
});
