'use client';

import type { ConnectionState } from '@/hooks/use-collab-document';

interface EditorBannersProperties {
  externalChange: boolean;
  draftContent: string | null;
  onDismissExternalChange: () => void;
  onRestoreDraft: () => void;
  onDiscardDraft: () => void;
  /** Collaboration connection state, when on the collab path; drives the status banner. */
  connectionState?: ConnectionState;
  /** True when the editor is read-only because the user is an observer. */
  readOnly?: boolean;
  /** True when this text document has no collaborative backing and is therefore read-only. */
  collabUnavailable?: boolean;
  /** A display message when the inline blame gutter's load was refused, or null/undefined for none. */
  blameError?: string | null;
}

const INFO_CLASS =
  'px-3 py-1 text-xs border-b flex items-center gap-2 bg-[hsl(var(--info-bg))] border-[hsl(var(--info-border))] text-[hsl(var(--info))]';
const WARNING_CLASS =
  'px-3 py-1 text-xs border-b flex items-center gap-2 bg-[hsl(var(--warning-bg))] border-[hsl(var(--warning-border))] text-[hsl(var(--warning))]';

/** The collaboration connection/read-only status strip, or null when nothing to show. */
function ConnectionBanner({ connectionState, readOnly, collabUnavailable }: { connectionState?: ConnectionState; readOnly?: boolean; collabUnavailable?: boolean }) {
  if (collabUnavailable) {
    return (
      <div role="status" data-testid="collab-banner-unavailable" className={WARNING_CLASS}>
        <span>Collaboration is unavailable for this document, so it is read-only to prevent conflicting edits. Reload once the collaboration service is reachable.</span>
      </div>
    );
  }
  if (connectionState === 'offline') {
    return (
      <div role="status" data-testid="collab-banner-offline" className={WARNING_CLASS}>
        <span>Editing is unavailable — the collaboration server can’t be reached. This file is read-only; no changes will be lost.</span>
      </div>
    );
  }
  if (connectionState === 'connecting') {
    return (
      <div role="status" data-testid="collab-banner-connecting" className={INFO_CLASS}>
        <span>Connecting to the collaboration server…</span>
      </div>
    );
  }
  if (connectionState === 'reconnecting') {
    return (
      <div role="status" data-testid="collab-banner-reconnecting" className={WARNING_CLASS}>
        <span>Connection lost — reconnecting…</span>
      </div>
    );
  }
  // synced (or no connection state): only show the observer read-only notice, if any.
  if (readOnly) {
    return (
      <div role="status" data-testid="collab-banner-readonly" className={INFO_CLASS}>
        <span>You have read-only (observer) access to this file.</span>
      </div>
    );
  }
  return null;
}

/** Notification strips rendered above the editor canvas. */
export function EditorBanners({
  externalChange,
  draftContent,
  onDismissExternalChange,
  onRestoreDraft,
  onDiscardDraft,
  connectionState,
  readOnly,
  collabUnavailable,
  blameError,
}: EditorBannersProperties) {
  return (
    <>
      <ConnectionBanner connectionState={connectionState} readOnly={readOnly} collabUnavailable={collabUnavailable} />
      {blameError && (
        <div role="status" data-testid="blame-error-banner" className={WARNING_CLASS}>
          <span>{blameError}</span>
        </div>
      )}
      {externalChange && (
        <div role="status" className={WARNING_CLASS}>
          <span>This file was updated externally.</span>
          <button type="button" className="underline" onClick={onDismissExternalChange}>Dismiss</button>
        </div>
      )}
      {draftContent !== null && (
        <div role="status" className={INFO_CLASS}>
          <span>An unsaved draft was recovered.</span>
          <button type="button" className="underline" onClick={onRestoreDraft}>Restore</button>
          <button type="button" className="underline" onClick={onDiscardDraft}>Discard</button>
        </div>
      )}
    </>
  );
}
