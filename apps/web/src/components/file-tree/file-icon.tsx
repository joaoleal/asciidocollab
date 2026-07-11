import { File, FileType, FileText, FileSpreadsheet, FileImage } from 'lucide-react';
import { cn } from '@/lib/utilities';
import { isAsciiDocumentFile } from '@/lib/asciidoc/file-name';
import { isImageFile } from '@/lib/codemirror/asciidoc-image-extensions';

/** File extensions rendered with the spreadsheet icon. */
const CSV_EXTENSIONS = new Set(['.csv', '.tsv']);

/** Returns true if the file name has a comma/tab-separated-values extension. */
function isCsvFile(nodeName: string): boolean {
  const dotIndex = nodeName.lastIndexOf('.');
  if (dotIndex <= 0) return false;
  return CSV_EXTENSIONS.has(nodeName.slice(dotIndex).toLowerCase());
}

/** Returns true if the file name ends in .txt. */
function isPlainTextFile(nodeName: string): boolean {
  return nodeName.toLowerCase().endsWith('.txt');
}

/**
 * Picks a file-type icon (and its accent colour) from the file name's extension.
 * AsciiDoc — the app's primary format — gets an accented icon so it stands out;
 * data, image, and plain-text files each get a distinct glyph, and anything
 * unrecognised falls back to the generic file icon.
 */
function iconForName(nodeName: string): { Icon: typeof File; className: string } {
  if (isAsciiDocumentFile(nodeName)) return { Icon: FileType, className: 'text-sky-500' };
  if (isImageFile(nodeName)) return { Icon: FileImage, className: 'text-violet-500' };
  if (isCsvFile(nodeName)) return { Icon: FileSpreadsheet, className: 'text-emerald-500' };
  if (isPlainTextFile(nodeName)) return { Icon: FileText, className: 'text-muted-foreground' };
  return { Icon: File, className: 'text-muted-foreground' };
}

/** Renders the extension-appropriate icon for a file node in the tree. */
export function FileIcon({ name }: { name: string }) {
  const { Icon, className } = iconForName(name);
  return <Icon className={cn('h-4 w-4 shrink-0', className)} />;
}
