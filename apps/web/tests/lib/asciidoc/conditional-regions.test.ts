// The editor-local conditional-region path is a re-export of the shared AsciiDoc authority. The
// point of the indirection is that every consumer of `@/lib/asciidoc/conditional-regions` gates
// content with the SAME grammar and evaluator as the preview and the server, so what is worth
// asserting here is that each symbol still arrives through this path and still behaves.
import {
  ENDIF_LINE_RE,
  CONDITIONAL_REGION_OPENER_RE,
  INCLUDE_LINE_RE,
  parseConditional,
  evaluateConditional,
  conditionalLineKind,
  ConditionalRegionStack,
} from '@/lib/asciidoc/conditional-regions';

describe('conditional-region re-exports', () => {
  test('recognises a whole-line endif closer', () => {
    expect(ENDIF_LINE_RE.test('endif::[]')).toBe(true);
    expect(ENDIF_LINE_RE.test('text endif::[]')).toBe(false);
  });

  test('treats an empty-bracket ifdef as a region opener but inline content as not', () => {
    expect(CONDITIONAL_REGION_OPENER_RE.test('ifdef::draft[]')).toBe(true);
    expect(CONDITIONAL_REGION_OPENER_RE.test('ifdef::draft[inline text]')).toBe(false);
  });

  test('matches a whole-line include directive and captures its target', () => {
    expect(INCLUDE_LINE_RE.exec('include::chapters/one.adoc[]')?.[1]).toBe('chapters/one.adoc');
    expect(INCLUDE_LINE_RE.test('see include::one.adoc[]')).toBe(false);
  });

  test('parses an ifdef directive into a structured expression', () => {
    expect(parseConditional('ifdef::draft[]')).toMatchObject({ kind: 'ifdef', attrs: ['draft'] });
    expect(parseConditional('just a paragraph')).toBeNull();
  });

  test('evaluates an ifdef against the attribute scope', () => {
    const expression = parseConditional('ifdef::draft[]');
    expect(expression).not.toBeNull();
    if (expression === null) return;
    expect(evaluateConditional(expression, new Map([['draft', '']]))).toBe(true);
    expect(evaluateConditional(expression, new Map())).toBe(false);
  });

  test('classifies a line as an opener, a closer, or neither', () => {
    expect(conditionalLineKind('ifdef::draft[]')).toBe('opener');
    expect(conditionalLineKind('endif::[]')).toBe('endif');
    expect(conditionalLineKind('a paragraph')).toBeNull();
  });

  test('gates content while an inactive region is open', () => {
    const stack = new ConditionalRegionStack();
    expect(stack.isActive()).toBe(true);
    stack.open('ifdef::draft[]', new Map());
    expect(stack.isActive()).toBe(false);
    stack.close();
    expect(stack.isActive()).toBe(true);
  });
});
