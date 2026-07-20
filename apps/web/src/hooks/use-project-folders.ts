'use client';

/**
 * Loads the project's folders (both a nested tree and a flat path list) for the render-config folder
 * pickers. The images directory and the custom font directories must reference folders that ACTUALLY
 * exist, so the UI offers a selection derived from the file tree rather than a free-text path. The
 * nested tree lets the picker stay compact and scrollable for projects with many/deep folders.
 */
import { useEffect, useState } from 'react';
import { fetchProjectFileTree } from '@/lib/api/file-tree';
import type { FileTreeNode } from '@/components/file-tree/types';

/** A folder in the project tree (folders only; files are pruned), for the folder-select pickers. */
export interface FolderNode {
  /** Project-relative path (no leading slash). */
  path: string;
  /** Display name (the last path segment). */
  name: string;
  /** Nested sub-folders. */
  children: FolderNode[];
}

/** Normalize a node's path to project-relative (no leading slash). */
function relativePath(node: FileTreeNode): string {
  return node.path.replace(/^\/+/, '');
}

/** Build the folder-only forest under the root (the root itself excluded), sorted at each level. */
function toFolderForest(root: FileTreeNode): FolderNode[] {
  const build = (node: FileTreeNode): FolderNode => ({
    path: relativePath(node),
    name: node.name,
    children: node.children
      .filter((child) => child.type === 'folder')
      .map(build)
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  });
  return root.children
    .filter((child) => child.type === 'folder')
    .map(build)
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Flatten a folder forest to every folder's path (excluding empties). */
function flattenPaths(forest: readonly FolderNode[]): string[] {
  const paths: string[] = [];
  const walk = (nodes: readonly FolderNode[]): void => {
    for (const node of nodes) {
      if (node.path.length > 0) paths.push(node.path);
      walk(node.children);
    }
  };
  walk(forest);
  return paths;
}

/** Every FILE path in the tree (folders excluded), sorted — the input theme resolution runs over. */
function collectFilePaths(root: FileTreeNode): string[] {
  const paths: string[] = [];
  const walk = (node: FileTreeNode): void => {
    for (const child of node.children) {
      if (child.type === 'folder') walk(child);
      else paths.push(relativePath(child));
    }
  };
  walk(root);
  return paths.toSorted();
}

/** The project's folders and the load state, for the render-config folder pickers. */
export interface UseProjectFolders {
  /** The folder forest (folders only; the root excluded), for the tree picker. */
  tree: FolderNode[];
  /** Every folder path (flattened), for validating a stored selection still exists. */
  folders: string[];
  /**
   * Every file path in the project, sorted. The PDF section resolves the project's theme over this
   * list with the same rule the renderer uses, so the options page cannot advertise a theme the
   * export does not apply.
   */
  files: string[];
  /** True while the file tree is loading. */
  loading: boolean;
  /** Load error message, or null. */
  error: string | null;
}

/** React hook returning the project's folders (tree + flat) for the render-config folder pickers. */
export function useProjectFolders(projectId: string): UseProjectFolders {
  const [tree, setTree] = useState<FolderNode[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchProjectFileTree(projectId)
      .then((root) => {
        if (active) {
          const forest = toFolderForest(root);
          setTree(forest);
          setFolders(flattenPaths(forest));
          setFiles(collectFilePaths(root));
        }
      })
      .catch(() => {
        if (active) {
          setError('Failed to load project folders.');
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  return { tree, folders, files, loading, error };
}
