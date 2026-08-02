/** Represents a node in the project file tree, either a file or a folder. */
export interface FileTreeNode {
  /** Unique identifier of the file node. */
  id: string;
  /** Display name of the file or folder. */
  name: string;
  /** Whether this node is a file or a folder. */
  type: 'file' | 'folder';
  /** Absolute path of this node within the project. */
  path: string;
  /** Identifier of the parent folder node, or null for the root. */
  parentId: string | null;
  /** Direct children of this node (populated for folders). */
  children: FileTreeNode[];
}

/** A node action a keyboard shortcut can ask for, each naming the dialog the actions menu opens. */
export type NodeActionKind = 'rename' | 'delete' | 'create-file' | 'create-folder';

/**
 * A request to open one of a node's action dialogs, raised by the tree's keyboard shortcuts.
 *
 * The dialogs belong to the node's actions menu — the same ones its menu items open — so a shortcut
 * cannot call them directly. It declares which node should open which dialog instead, and the tree
 * passes the request down until the named node picks it up. Going through the menu's own dialogs is
 * what makes a shortcut and its menu item the SAME action: one set of validation, one way of
 * reporting a name that is already taken, one refresh of the tree afterwards.
 *
 * The nonce makes repeat requests distinct, so pressing the shortcut again after cancelling reopens
 * the dialog rather than looking to the node like a value it has already seen.
 */
export interface NodeActionRequest {
  /** Identifier of the node whose actions menu should answer this. */
  nodeId: string;
  /** Which of that node's dialogs to open. */
  action: NodeActionKind;
  /** Increments on every request, so a repeat request still registers as new. */
  nonce: number;
}
