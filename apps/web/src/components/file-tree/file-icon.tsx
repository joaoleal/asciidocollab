import type { ComponentType } from 'react';
import { File, FileText, FileSpreadsheet, FileImage } from 'lucide-react';
import { cn } from '@/lib/utilities';
import { isAsciiDocumentFile } from '@/lib/asciidoc/file-name';
import { isImageFile } from '@/lib/codemirror/asciidoc-image-extensions';

/**
 * A document icon marked with an "A" for AsciiDoc. Lucide's FileType glyph draws
 * a "T", so we hand-roll one that reuses lucide's file outline (same 24×24 grid,
 * currentColor stroke, round caps) and draws an "A" — with crossbar — in the body.
 */
function AsciiDocIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('lucide lucide-file-a', className)}
      aria-hidden="true"
    >
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M9.5 18 12 10.5 14.5 18" />
      <path d="M10.6 14.8h2.8" />
    </svg>
  );
}

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
 * AsciiDoc — the app's primary format — gets an accented "A" icon so it stands
 * out; data, image, and plain-text files each get a distinct glyph, and anything
 * unrecognised falls back to the generic file icon.
 */
function iconForName(nodeName: string): { Icon: ComponentType<{ className?: string }>; className: string } {
  if (isAsciiDocumentFile(nodeName)) return { Icon: AsciiDocIcon, className: 'text-primary' };
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
