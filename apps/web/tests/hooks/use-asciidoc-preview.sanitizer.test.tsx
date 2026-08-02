// The preview's sanitization boundary, proved equivalent across the two shapes it can return.
//
// The preview used to publish its markup as a STRING and let the browser parse it. It now asks the
// same sanitizer for NODES for everything that reaches the screen, so nothing re-parses markup on the
// way there, and asks for the string form only for the render's markup, only when a caller reads it.
// That is a change of return type at the security boundary of the whole preview, and a change at a
// security boundary is only safe if it is provably not a change of VERDICT: every payload the string
// form rejected must be rejected identically by the fragment form, and everything the preview
// legitimately renders must survive both forms identically.
//
// These tests deliberately use the REAL DOMPurify. The hook's own suite substitutes a test double for
// it — a double proves nothing about what an attacker's payload does, only about what the double was
// written to do — so this file stands apart from it, with no module mock in sight.

import DOMPurify from 'dompurify';

/** The sanitizer configuration the preview boundary applies, shared by both call shapes below. */
const PREVIEW_PROFILE = { USE_PROFILES: { html: true } } as const;

/** Sanitize to markup — the shape the preview published before it committed by patching the DOM. */
function sanitizeToMarkup(dirty: string): string {
  return DOMPurify.sanitize(dirty, PREVIEW_PROFILE);
}

/**
 * Sanitize to nodes — the shape the preview commits — read back as markup so the two verdicts can be
 * compared as like for like. The read-back is the test's own doing: the preview commits these nodes
 * directly and serializes nothing on that path.
 *
 * Which makes the equivalence below load-bearing rather than merely reassuring. The preview commits
 * nodes, but still owes a caller the render's markup, and it no longer produces that markup by
 * serializing the committed fragment — it asks this same sanitizer, in the string shape, for the same
 * worker output, and only if somebody actually reads it. Both shapes are therefore live in
 * production, and "the same verdict either way" is the property that keeps the deferred one from
 * being a second, weaker sanitization.
 */
function sanitizeToNodesThenRead(dirty: string): string {
  const fragment = DOMPurify.sanitize(dirty, { ...PREVIEW_PROFILE, RETURN_DOM_FRAGMENT: true });
  const holder = document.createElement('div');
  holder.append(fragment);
  return holder.innerHTML;
}

/**
 * One payload and the thing that must not survive it.
 *
 * `forbidden` is checked against the sanitized output of BOTH shapes. It names the executable part —
 * the element, the handler, the scheme — rather than the whole payload, because the harmless text
 * around it is expected to survive.
 */
interface Payload {
  /** What this payload is trying to get onto the page. */
  readonly attack: string;
  /** The markup handed to the sanitizer. */
  readonly dirty: string;
  /** Fragments of the payload that must appear in neither sanitized form. */
  readonly forbidden: readonly string[];
}

const HOSTILE_PAYLOADS: readonly Payload[] = [
  {
    attack: 'a script element',
    dirty: '<div class="paragraph"><p>Before</p></div><script>alert(1)</script>',
    forbidden: ['<script', 'alert(1)'],
  },
  {
    // Only the ELEMENT is forbidden here. What is left of this payload survives as inert text, which
    // is the correct outcome: text cannot execute, and demanding its removal would be asking the
    // sanitizer to censor the document rather than to disarm it.
    attack: 'a script element smuggled through a broken parent tag',
    dirty: '<div class="paragraph"><p>Before<scr<script>ipt>alert(2)</script></p></div>',
    forbidden: ['<script'],
  },
  {
    attack: 'an inline event-handler attribute',
    dirty: '<div class="paragraph" onclick="alert(3)"><p>Click me</p></div>',
    forbidden: ['onclick', 'alert(3)'],
  },
  {
    attack: 'an event handler on a failed image load',
    dirty: '<img src="x" onerror="alert(4)">',
    forbidden: ['onerror', 'alert(4)'],
  },
  {
    attack: 'a javascript: URL on a link',
    dirty: '<div class="paragraph"><p><a href="javascript:alert(5)">Read more</a></p></div>',
    forbidden: ['javascript:', 'alert(5)'],
  },
  {
    attack: 'a javascript: URL obscured by entities and whitespace',
    dirty: '<a href="jav&#x09;ascript:alert(6)">Read more</a>',
    forbidden: ['javascript:', 'alert(6)'],
  },
  {
    attack: 'an embedded browsing context',
    dirty: '<iframe src="https://attacker.example/frame"></iframe>',
    forbidden: ['<iframe', 'attacker.example'],
  },
  {
    attack: 'a plugin object',
    dirty: '<object data="https://attacker.example/payload.swf" type="application/x-shockwave-flash"></object>',
    forbidden: ['<object', 'attacker.example'],
  },
  {
    attack: 'an embedded plugin',
    dirty: '<embed src="https://attacker.example/payload.swf">',
    forbidden: ['<embed', 'attacker.example'],
  },
  {
    attack: 'a vector image carrying a script',
    dirty: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(7)</script></svg>',
    forbidden: ['<script', 'alert(7)'],
  },
  {
    attack: 'a vector image carrying a load handler',
    dirty: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(8)"><circle r="10"></circle></svg>',
    forbidden: ['onload', 'alert(8)'],
  },
  {
    attack: 'a vector image carrying a foreign object with a handler',
    dirty:
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><a href="javascript:alert(9)">go</a></foreignObject></svg>',
    forbidden: ['javascript:', 'alert(9)'],
  },
];

/**
 * Markup the preview legitimately renders. Present so the equivalence below cannot pass vacuously: if
 * one shape simply threw everything away, these would fail while the hostile cases still "agreed".
 */
const LEGITIMATE_MARKUP: readonly string[] = [
  '<div class="sect1"><h2 id="_intro">Intro</h2><div class="sectionbody"><div class="paragraph"><p>Body.</p></div></div></div>',
  '<div class="paragraph"><p>See <a href="#_intro">the intro</a> and <a href="https://example.com/docs">the docs</a>.</p></div>',
  '<div class="imageblock"><div class="content"><img src="/projects/p1/images/diagram.png" alt="Diagram"></div></div>',
  '<div class="adc-diagram" data-diagram-engine="mermaid" data-source-line="7">graph TD; A--&gt;B</div>',
  '<div style="page-break-after: always"></div>',
  String.raw`<div class="stemblock"><div class="content">\$x^2\$</div></div>`,
];

describe('preview sanitization — the same verdict whether it returns markup or nodes', () => {
  it.each(HOSTILE_PAYLOADS)('rejects $attack identically in both shapes', ({ dirty, forbidden }) => {
    const asMarkup = sanitizeToMarkup(dirty);
    const asNodes = sanitizeToNodesThenRead(dirty);

    for (const fragment of forbidden) {
      // Stated per shape rather than only on the comparison below, so a failure names WHICH shape let
      // the payload through instead of only reporting that the two disagreed.
      expect(asMarkup).not.toContain(fragment);
      expect(asNodes).not.toContain(fragment);
    }
    expect(asNodes).toBe(asMarkup);
  });

  it.each(LEGITIMATE_MARKUP)('passes rendered output through unchanged in both shapes: %s', (clean) => {
    const asMarkup = sanitizeToMarkup(clean);
    const asNodes = sanitizeToNodesThenRead(clean);

    expect(asNodes).toBe(asMarkup);
    // The preview would be useless if the boundary that keeps it safe also stripped what it renders.
    expect(asNodes).not.toBe('');
  });

  it('leaves nothing executable in the nodes it hands to the preview', () => {
    const everyPayload = HOSTILE_PAYLOADS.map((payload) => payload.dirty).join('\n');

    const fragment = DOMPurify.sanitize(everyPayload, {
      ...PREVIEW_PROFILE,
      RETURN_DOM_FRAGMENT: true,
    });
    const holder = document.createElement('div');
    holder.append(fragment);

    // Asserted on the NODES rather than on their markup: the fragment is what the preview commits, and
    // a query over the live tree cannot be fooled by how an attribute happens to serialize.
    expect(holder.querySelectorAll('script, iframe, object, embed, svg')).toHaveLength(0);
    for (const element of holder.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        expect(attribute.name.startsWith('on')).toBe(false);
        expect(attribute.value.replaceAll(/\s/g, '').toLowerCase()).not.toContain('javascript:');
      }
    }
  });
});
