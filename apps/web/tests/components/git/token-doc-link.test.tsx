import { render, screen } from '@testing-library/react';
import { TokenDocLink } from '@/components/git/token-doc-link';
import { GIT_PROVIDERS } from '@asciidocollab/shared';
import type { GitProvider } from '@asciidocollab/shared';

/** The official host each provider's token guide must live on — a wrong-host link is worse than none. */
const EXPECTED_HOST: Record<GitProvider, string> = {
  github: 'docs.github.com',
  gitlab: 'docs.gitlab.com',
  bitbucket: 'support.atlassian.com',
};

describe('TokenDocLink', () => {
  test.each(GIT_PROVIDERS)('links to %s’s own token documentation host', (provider) => {
    render(<TokenDocLink provider={provider} />);
    const link = screen.getByRole('link');
    const href = link.getAttribute('href') ?? '';
    expect(new URL(href).hostname).toBe(EXPECTED_HOST[provider]);
    expect(href).toMatch(/^https:\/\//);
  });

  test('each provider points at a different page (no shared placeholder link)', () => {
    const hrefs = GIT_PROVIDERS.map((provider) => {
      const { unmount } = render(<TokenDocLink provider={provider} />);
      const href = screen.getByRole('link').getAttribute('href');
      unmount();
      return href;
    });
    expect(new Set(hrefs).size).toBe(GIT_PROVIDERS.length);
  });

  test('opens in a new tab safely, with a screen-reader-visible affordance', () => {
    render(<TokenDocLink provider="github" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('target', '_blank');
    // rel must neutralize both reverse-tabnabbing (noopener) and referrer leakage (noreferrer).
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(link).toHaveAccessibleName(/opens in a new tab/i);
  });

  test('follows the selected provider when it changes', () => {
    const { rerender } = render(<TokenDocLink provider="github" />);
    expect(screen.getByRole('link').getAttribute('href')).toContain('docs.github.com');
    rerender(<TokenDocLink provider="bitbucket" />);
    expect(screen.getByRole('link').getAttribute('href')).toContain('support.atlassian.com');
  });
});
