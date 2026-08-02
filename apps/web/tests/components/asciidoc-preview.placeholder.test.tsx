import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import DOMPurify from 'dompurify';
import { AsciiDocPreview } from '@/components/asciidoc-preview';
import {
  INCLUDE_PLACEHOLDER_CLASS,
  INCLUDE_PLACEHOLDER_TARGET_ATTR,
} from '@/lib/asciidoc/include-placeholder';

// ── Mock useAsciidocPreview ──────────────────────────────────────────────────

jest.mock('@/hooks/use-asciidoc-preview', () => ({
  useAsciidocPreview: jest.fn(),
}));

// ── Mock the lazy-loaded math renderer (not under test here) ─────────────────
jest.mock('@/components/math/render-math', () => ({
  renderMath: jest.fn(() => Promise.resolve()),
}));

import { useAsciidocPreview } from '@/hooks/use-asciidoc-preview';
import { commitToPreviewOutput, previewHookResult } from '../helpers/preview-panel';
const mockUsePreview = useAsciidocPreview as jest.Mock;

const PLACEHOLDER_TARGET = 'parts/chapter1.adoc';
const PLACEHOLDER_HTML = `<div class="${INCLUDE_PLACEHOLDER_CLASS}" ${INCLUDE_PLACEHOLDER_TARGET_ATTR}="${PLACEHOLDER_TARGET}" role="button" tabindex="0">included: ${PLACEHOLDER_TARGET}</div>`;

/**
 * Render the panel with `markup` on screen, put there the way the hook puts it there — patched into
 * the element the panel hands over rather than rendered by React. The delegated listener under test is
 * attached to that element when the panel mounts, so it answers for whatever ends up inside it.
 *
 * @param markup - The rendered document to display.
 * @param onOpenInclude - The open-the-included-file callback under test.
 * @returns The render harness.
 */
function renderPreview(markup: string, onOpenInclude: jest.Mock) {
  mockUsePreview.mockReturnValue(
    previewHookResult({ html: markup, state: 'up-to-date', renderNonce: 1 }),
  );
  const harness = render(
    <AsciiDocPreview
      content="= Doc"
      isEnabled={true}
      projectId="proj-1"
      scrollToLine={null}
      onOpenInclude={onOpenInclude}
    />,
  );
  commitToPreviewOutput(markup);
  return harness;
}

beforeEach(() => {
  mockUsePreview.mockReset();
  mockUsePreview.mockReturnValue(previewHookResult({ html: null, state: 'idle' }));
});

// ── AsciiDocPreview placeholder interaction ────────────────────────────

describe('AsciiDocPreview placeholder click/interaction', () => {
  // Test 1: Click on placeholder calls onOpenInclude with target
  it('calls onOpenInclude with the include target when placeholder is clicked', () => {
    const onOpenInclude = jest.fn();
    const { container } = renderPreview(PLACEHOLDER_HTML, onOpenInclude);

    const placeholder = container.querySelector(`.${INCLUDE_PLACEHOLDER_CLASS}`);
    expect(placeholder).toBeInTheDocument();

    fireEvent.click(placeholder!);

    expect(onOpenInclude).toHaveBeenCalledTimes(1);
    expect(onOpenInclude).toHaveBeenCalledWith(PLACEHOLDER_TARGET);
  });

  // Test 2: Enter key on focused placeholder calls onOpenInclude
  it('calls onOpenInclude with the include target when Enter is pressed on the placeholder', () => {
    const onOpenInclude = jest.fn();
    const { container } = renderPreview(PLACEHOLDER_HTML, onOpenInclude);

    const placeholder = container.querySelector(`.${INCLUDE_PLACEHOLDER_CLASS}`);
    expect(placeholder).toBeInTheDocument();

    fireEvent.keyDown(placeholder!, { key: 'Enter' });

    expect(onOpenInclude).toHaveBeenCalledTimes(1);
    expect(onOpenInclude).toHaveBeenCalledWith(PLACEHOLDER_TARGET);
  });

  // Test 3: Space key on focused placeholder calls onOpenInclude
  it('calls onOpenInclude with the include target when Space is pressed on the placeholder', () => {
    const onOpenInclude = jest.fn();
    const { container } = renderPreview(PLACEHOLDER_HTML, onOpenInclude);

    const placeholder = container.querySelector(`.${INCLUDE_PLACEHOLDER_CLASS}`);
    expect(placeholder).toBeInTheDocument();

    fireEvent.keyDown(placeholder!, { key: ' ' });

    expect(onOpenInclude).toHaveBeenCalledTimes(1);
    expect(onOpenInclude).toHaveBeenCalledWith(PLACEHOLDER_TARGET);
  });

  // Test 4: DOMPurify sanitization safety guard (Constitution VIII)
  // Uses the REAL DOMPurify — no React, no component — to confirm the placeholder survives the
  // sanitizer configuration the preview applies, asked for in the shape the preview asks for it:
  // nodes, which is what gets committed. Read back off the element rather than off serialized markup,
  // so what is asserted is what the delegated listener will actually find.
  it('placeholder element survives DOMPurify sanitization retaining class, data-include-target, role, and tabindex', () => {
    const clean = DOMPurify.sanitize(PLACEHOLDER_HTML, {
      USE_PROFILES: { html: true },
      RETURN_DOM_FRAGMENT: true,
    });

    const placeholder = clean.querySelector(`.${INCLUDE_PLACEHOLDER_CLASS}`);
    expect(placeholder).not.toBeNull();
    // The include target the listener reads to open the file.
    expect(placeholder?.getAttribute(INCLUDE_PLACEHOLDER_TARGET_ATTR)).toBe(PLACEHOLDER_TARGET);
    // role="button" — needed for a11y and delegated click handling.
    expect(placeholder?.getAttribute('role')).toBe('button');
    // tabindex="0" — needed for keyboard focus.
    expect(placeholder?.getAttribute('tabindex')).toBe('0');
  });

  // Test 5: onOpenInclude NOT called when clicking outside a placeholder
  it('does not call onOpenInclude when clicking on a non-placeholder element', () => {
    const onOpenInclude = jest.fn();
    const { container } = renderPreview('<p id="regular-para">Some regular paragraph text</p>', onOpenInclude);

    const para = container.querySelector('#regular-para');
    expect(para).toBeInTheDocument();

    fireEvent.click(para!);

    expect(onOpenInclude).not.toHaveBeenCalled();
  });
});
