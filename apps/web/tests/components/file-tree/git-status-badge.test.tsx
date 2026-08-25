import { render, screen } from '@testing-library/react';
import { GitStatusBadge, gitStatusBadgeStyle, rollUpFolderStatus } from '@/components/file-tree/git-status-badge';
import type { FileTreeNode } from '@/components/file-tree/types';

describe('gitStatusBadgeStyle', () => {
  test('returns null for unchanged (no badge)', () => {
    expect(gitStatusBadgeStyle('unchanged')).toBeNull();
  });

  test.each([
    ['modified', 'Modified', 'warning'],
    ['staged', 'Staged', 'success'],
    ['untracked', 'Untracked', 'info'],
  ] as const)('%s maps to a tokenized className carrying the %s token and label %s', (status, label, token) => {
    const style = gitStatusBadgeStyle(status);
    expect(style).not.toBeNull();
    expect(style!.label).toBe(label);
    expect(style!.className).toContain(token);
  });

  test.each([
    ['removed', 'Removed'],
    ['conflicted', 'Conflicted'],
  ] as const)('%s maps to the destructive token with label %s', (status, label) => {
    const style = gitStatusBadgeStyle(status);
    expect(style).not.toBeNull();
    expect(style!.label).toBe(label);
    expect(style!.className).toContain('destructive');
  });

  test('never returns a hardcoded hex or rgb color', () => {
    const statuses = ['modified', 'staged', 'untracked', 'removed', 'conflicted'] as const;
    for (const status of statuses) {
      const style = gitStatusBadgeStyle(status);
      expect(style!.className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(style!.className).not.toMatch(/rgb\(/);
    }
  });
});

describe('GitStatusBadge', () => {
  test('renders nothing for an unchanged file', () => {
    const { container } = render(<GitStatusBadge status="unchanged" />);
    expect(container).toBeEmptyDOMElement();
  });

  test('renders a dot with an accessible name (not aria-hidden) for a modified file', () => {
    render(<GitStatusBadge status="modified" />);
    const badge = screen.getByRole('img', { name: 'Modified' });
    expect(badge).not.toHaveAttribute('aria-hidden');
    expect(badge).toHaveAttribute('title', 'Modified');
  });

  test('renders an accessible name for a conflicted file', () => {
    render(<GitStatusBadge status="conflicted" />);
    expect(screen.getByRole('img', { name: 'Conflicted' })).toBeInTheDocument();
  });

  test('renders a roll-up label when rollup is set, distinguishing it from a direct-file badge', () => {
    render(<GitStatusBadge status="modified" rollup />);
    const badge = screen.getByRole('img', { name: 'Contains changes: Modified' });
    expect(badge).toHaveAttribute('title', 'Contains changes: Modified');
  });
});

function file(id: string): FileTreeNode {
  return { id, name: id, type: 'file', path: `/${id}`, parentId: 'parent', children: [] };
}

function folder(id: string, children: FileTreeNode[]): FileTreeNode {
  return { id, name: id, type: 'folder', path: `/${id}`, parentId: null, children };
}

describe('rollUpFolderStatus', () => {
  test('returns null when no descendant file has a changed status', () => {
    const tree = folder('src', [file('a'), folder('nested', [file('b')])]);
    expect(rollUpFolderStatus(tree, { a: 'unchanged', b: 'unchanged' })).toBeNull();
  });

  test('returns null when no descendant appears in the status map at all', () => {
    const tree = folder('src', [file('a')]);
    expect(rollUpFolderStatus(tree, {})).toBeNull();
  });

  test('picks up a status from a directly-contained file', () => {
    const tree = folder('src', [file('a')]);
    expect(rollUpFolderStatus(tree, { a: 'modified' })).toBe('modified');
  });

  test('picks up a status from a deeply-nested descendant file', () => {
    const tree = folder('src', [folder('mid', [folder('deep', [file('a')])])]);
    expect(rollUpFolderStatus(tree, { a: 'staged' })).toBe('staged');
  });

  test.each([
    [['staged', 'untracked'], 'untracked'],
    [['untracked', 'modified'], 'modified'],
    [['modified', 'removed'], 'removed'],
    [['removed', 'conflicted'], 'conflicted'],
    [['staged', 'conflicted', 'modified'], 'conflicted'],
  ] as const)('picks the highest-precedence status among %j → %s', (statuses, expected) => {
    const files = statuses.map((status, index) => file(`f${index}`));
    const tree = folder('src', files);
    const statusByFileNodeId = Object.fromEntries(statuses.map((status, index) => [`f${index}`, status]));
    expect(rollUpFolderStatus(tree, statusByFileNodeId)).toBe(expected);
  });
});
