/**
 * @file That the horizontal term cell loses the converter's indentation and nothing else.
 *
 * The transform exists for one reason — a strut placed at the head of a term's first line turns the
 * converter's own newline into a rendered space — so the tests that matter are the ones that pin how
 * narrow it is. It must not touch a cell an author wrote, a term's real content, or any other kind of
 * table cell, because every one of those would be a silent change to what a reader sees.
 */
import { trimTermIndentation } from '@/lib/asciidoc-html/trim-term-indentation';

describe('trimTermIndentation', () => {
  it('drops the newline Asciidoctor writes before a horizontal list term', () => {
    expect(trimTermIndentation('<td class="hdlist1">\nlambda\n</td>')).toBe(
      '<td class="hdlist1">lambda\n</td>',
    );
  });

  it('drops indentation of any shape, not just one newline', () => {
    expect(trimTermIndentation('<td class="hdlist1">\n    \t\nmu</td>')).toBe('<td class="hdlist1">mu</td>');
  });

  it('drops it from every term in the list', () => {
    const html = '<td class="hdlist1">\nalpha</td><td class="hdlist1">\nbeta</td>';
    expect(trimTermIndentation(html)).toBe('<td class="hdlist1">alpha</td><td class="hdlist1">beta</td>');
  });

  it('keeps attributes the converter puts beside the class', () => {
    expect(trimTermIndentation('<td class="hdlist1" id="t">\nnu</td>')).toBe(
      '<td class="hdlist1" id="t">nu</td>',
    );
  });

  it('leaves whitespace INSIDE the term alone', () => {
    // The space between the words is the author's, and one of the fixtures depends on a term wide
    // enough to wrap — which it only is if its spaces survive.
    expect(trimTermIndentation('<td class="hdlist1">\na term long enough that it wraps</td>')).toBe(
      '<td class="hdlist1">a term long enough that it wraps</td>',
    );
  });

  it('leaves the description cell alone', () => {
    // Only the term is strutted, so only the term needs this — and `hdlist2` holds a `<p>`, whose own
    // markup carries no leading whitespace to begin with.
    const html = '<td class="hdlist2">\n<p>its meaning</p>\n</td>';
    expect(trimTermIndentation(html)).toBe(html);
  });

  it('leaves an ordinary table cell alone', () => {
    const html = '<td class="tableblock halign-left valign-top">\n<p class="tableblock">cell</p>\n</td>';
    expect(trimTermIndentation(html)).toBe(html);
  });

  it('leaves a cell whose class merely starts the same alone', () => {
    const html = '<td class="hdlist10">\nnot a term</td>';
    expect(trimTermIndentation(html)).toBe(html);
  });

  it('returns markup with no horizontal list unchanged', () => {
    const html = '<div class="paragraph"><p>Body text.</p></div>';
    expect(trimTermIndentation(html)).toBe(html);
  });
});
