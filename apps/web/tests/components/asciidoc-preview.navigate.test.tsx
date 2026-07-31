import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { AsciiDocPreview } from '@/components/asciidoc-preview';

// The hook is mocked so the test drives the rendered HTML directly (the click delegation is under test,
// not the worker render).
jest.mock('@/hooks/use-asciidoc-preview', () => ({ useAsciidocPreview: jest.fn() }));
jest.mock('@/components/math/render-math', () => ({ renderMath: jest.fn(() => Promise.resolve()) }));

import { useAsciidocPreview } from '@/hooks/use-asciidoc-preview';
import { commitToPreviewOutput, previewHookResult } from '../helpers/preview-panel';
const mockUsePreview = useAsciidocPreview as jest.Mock;

/**
 * Render the panel with `markup` on screen, put there the way the hook puts it there — patched into
 * the element the panel hands over rather than rendered by React. The delegated listener under test is
 * attached to that element when the panel mounts, so it answers for whatever ends up inside it.
 *
 * @param markup - The rendered document to display.
 * @param onNavigateToSource - The jump-to-source callback under test.
 * @returns The render harness.
 */
function renderPreview(markup: string, onNavigateToSource: jest.Mock) {
  mockUsePreview.mockReturnValue(
    previewHookResult({ html: markup, state: 'up-to-date', renderNonce: 1 }),
  );
  const harness = render(
    <AsciiDocPreview
      content="= Doc"
      isEnabled
      projectId="p1"
      scrollToLine={null}
      onNavigateToSource={onNavigateToSource}
    />,
  );
  commitToPreviewOutput(markup);
  return harness;
}

beforeEach(() => mockUsePreview.mockReset());

describe('AsciiDocPreview click-to-source and link following', () => {
  it('navigates to a clicked block’s source line', () => {
    const onNavigateToSource = jest.fn();
    const { container } = renderPreview('<p id="b1" data-source-line="7">Body</p>', onNavigateToSource);
    fireEvent.click(container.querySelector('#b1')!);
    expect(onNavigateToSource).toHaveBeenCalledWith(7);
  });

  it('navigates using the nearest ancestor carrying data-source-line', () => {
    const onNavigateToSource = jest.fn();
    const { container } = renderPreview(
      '<div data-source-line="3"><span id="inner">word</span></div>',
      onNavigateToSource,
    );
    fireEvent.click(container.querySelector('#inner')!);
    expect(onNavigateToSource).toHaveBeenCalledWith(3);
  });

  it('does not navigate when the clicked block has no source line', () => {
    const onNavigateToSource = jest.fn();
    const { container } = renderPreview('<p id="b1">Body</p>', onNavigateToSource);
    fireEvent.click(container.querySelector('#b1')!);
    expect(onNavigateToSource).not.toHaveBeenCalled();
  });

  it('follows an internal cross-reference by scrolling to its target, not jumping to source', () => {
    const onNavigateToSource = jest.fn();
    // jsdom does not implement scrollIntoView, so install a mock rather than spying on it.
    const scrollSpy = jest.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollSpy;
    const { container } = renderPreview(
      '<a id="lnk" href="#sec2" data-source-line="4">see</a><h2 id="sec2" data-source-line="9">Section</h2>',
      onNavigateToSource,
    );
    fireEvent.click(container.querySelector('#lnk')!);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(onNavigateToSource).not.toHaveBeenCalled();
    HTMLElement.prototype.scrollIntoView = original;
  });

  it('opens an external link in a hardened new tab and does not jump to source', () => {
    const onNavigateToSource = jest.fn();
    const openSpy = jest.spyOn(globalThis, 'open').mockImplementation(() => null);
    const { container } = renderPreview(
      '<a id="ext" href="https://example.com/docs" data-source-line="4">site</a>',
      onNavigateToSource,
    );
    fireEvent.click(container.querySelector('#ext')!);
    expect(openSpy).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
    expect(onNavigateToSource).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
