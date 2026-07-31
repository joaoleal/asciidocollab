/**
 * Client-side editor configuration.
 *
 * All tuneable values are read from NEXT_PUBLIC_* environment variables so
 * operators can override them without rebuilding the application.  Defaults
 * are chosen to be safe for typical self-hosted deployments.
 *
 * Server-side API configuration lives in apps/api/config/*.yaml.
 */

/** Milliseconds between the last keystroke and the auto-save PUT request. */
export const AUTOSAVE_DEBOUNCE_MS = Number(
  process.env.NEXT_PUBLIC_EDITOR_AUTOSAVE_DEBOUNCE_MS ?? 4000,
);

/** Milliseconds of inactivity before the live preview panel auto-refreshes. */
export const PREVIEW_DEBOUNCE_MS = Number(
  process.env.NEXT_PUBLIC_PREVIEW_DEBOUNCE_MS ?? 500,
);

/**
 * Upper bound, in milliseconds, on how long the live preview may be postponed while the user keeps
 * typing. The preview uses a trailing debounce of {@link PREVIEW_DEBOUNCE_MS}, but continuous typing
 * would otherwise defer the render indefinitely; this caps that so a sustained edit refreshes the
 * preview at least once per {@link PREVIEW_MAX_WAIT_MS} interval, *or* as soon as the refresh in
 * progress finishes, whichever is later.
 *
 * The second clause is not a caveat but the self-limiting part of the guarantee: a document that
 * takes longer to render than this interval would otherwise have each cap expiry stack another
 * refresh on top of the one still running. So the cap yields while a render is in flight and fires
 * the moment it completes, keeping at most one render in flight however slow the document is.
 */
export const PREVIEW_MAX_WAIT_MS = Number(
  process.env.NEXT_PUBLIC_PREVIEW_MAX_WAIT_MS ?? 2000,
);

/**
 * Shortest trailing delay, in milliseconds, the live preview will ever wait before refreshing.
 *
 * {@link PREVIEW_DEBOUNCE_MS} is the ceiling and this is the floor of the delay derived from what the
 * last render actually cost (see {@link file://./preview/adaptive-delay.ts}). A floor is needed
 * because a document cheap enough to render in a couple of frames would otherwise drive the delay
 * towards zero and re-render on nearly every keystroke, spending more on scheduling and DOM work than
 * the typing is worth. This leaves the refresh comfortably inside the tenth-of-a-second band where a
 * change still reads as immediate, without chasing every character.
 */
export const PREVIEW_ADAPTIVE_MIN_MS = Number(
  process.env.NEXT_PUBLIC_PREVIEW_ADAPTIVE_MIN_MS ?? 120,
);

/**
 * How many times the render worker is rebuilt automatically after it dies before the application
 * stops trying and asks the author whether to try again.
 *
 * Three is a chosen figure, not a derived one. It is enough attempts to ride out a one-off loss — the
 * browser reclaiming a worker under memory pressure, a transient failure while a large document
 * loads — without letting a document that kills the engine every single time spin in a rebuild loop
 * that burns the machine and never converges. Move it on evidence from real crashes, not on taste.
 */
export const MAX_ENGINE_REBUILDS = 3;

/**
 * How long, in milliseconds, the render worker stays alive after its last consumer lets go.
 *
 * This reads like a leak and is the opposite of one. The web-formatted preview is the worker's only
 * consumer, so switching to the page-formatted preview, collapsing the preview panel or hiding it
 * all drop the consumer count to zero — precisely the moments the worker is meant to survive.
 * Shutting it down there would charge the engine's whole start-up cost again on the way back. So
 * having no consumers only starts this clock: the next consumer stops it and gets the running worker
 * straight away, and the worker is given up only if the clock runs out.
 *
 * A minute comfortably covers a look at the other format and back, or a panel closed and reopened,
 * while still handing the memory back from an editor that has been left sitting. Like the rebuild
 * bound above, it is a judgement to revisit on evidence.
 */
export const RENDER_WORKER_IDLE_RETENTION_MS = 60_000;

/** Milliseconds between external-change HEAD polls when the editor is open. */
export const EXTERNAL_CHANGE_POLL_INTERVAL_MS = Number(
  process.env.NEXT_PUBLIC_EDITOR_POLL_INTERVAL_MS ?? 30_000,
);

/** LocalStorage key prefix for offline draft content. */
export const OFFLINE_QUEUE_KEY_PREFIX = 'asciidocollab:editor-draft:';

/** Minimum allowed editor font size in pixels. */
export const FONT_SIZE_MIN = 8;

/** Maximum allowed editor font size in pixels. */
export const FONT_SIZE_MAX = 32;

/**
 * WebSocket URL of the collaboration server (apps/collab).
 *
 * The browser auto-attaches the session cookie to the handshake, so no token
 * is appended here (research D5). In production, collab must share a
 * registrable domain with the web app for the cookie to be sent.
 */
export const COLLAB_URL =
  process.env.NEXT_PUBLIC_COLLAB_URL ?? 'ws://localhost:4002';

/**
 * Maximum milliseconds to wait for the provider to reach `synced` before the
 * editor falls back to offline read-only mode (research D6/D11). If the collab
 * server is unreachable at open, this bounds how long the user waits.
 */
export const COLLAB_SYNC_TIMEOUT_MS = Number(
  process.env.NEXT_PUBLIC_COLLAB_SYNC_TIMEOUT_MS ?? 10_000,
);

/**
 * Builds the canonical collaboration room name from a project id and Yjs state
 * id. This is the format the collaboration server parses (`apps/collab`), so it
 * must not drift: `${projectId}/${yjsStateId}`.
 */
export function collabRoomName(projectId: string, yjsStateId: string): string {
  return `${projectId}/${yjsStateId}`;
}

/**
 * Key of the shared `Y.Text` the editor binds its document to. The collaboration server seeds this
 * same field from stored file content on first load and writes it back on persist
 * (`CODEMIRROR_TEXT` in apps/collab). It lives here — a zero-(browser-)dependency module — so every
 * reader (the editor binding, the outline's live-document observers) shares ONE source of truth
 * instead of re-declaring the literal `'codemirror'`.
 */
export const COLLAB_YTEXT_KEY = 'codemirror';


/**
 * A presence colour assigned to a collaborator, derived deterministically from
 * their user id (see {@link file://./collab/color-for-user.ts}).
 */
export interface PresenceColor {
  /** Primary cursor/caret colour. */
  readonly color: string;
  /** Lighter tint used for the selection-highlight background. */
  readonly colorLight: string;
}

/**
 * Fixed palette of presence colours. `colorForUser(userId)` hashes the user id
 * to an index here so every client renders the same colour for a given user
 * without server coordination (research D9). Each entry pairs a saturated
 * cursor colour with a translucent tint for selection backgrounds.
 */
export const PRESENCE_COLOR_PALETTE: readonly PresenceColor[] = [
  { color: '#30bced', colorLight: '#30bced33' },
  { color: '#6eeb83', colorLight: '#6eeb8333' },
  { color: '#ffbc42', colorLight: '#ffbc4233' },
  { color: '#ecd444', colorLight: '#ecd44433' },
  { color: '#ee6352', colorLight: '#ee635233' },
  { color: '#9ac2c9', colorLight: '#9ac2c933' },
  { color: '#8acb88', colorLight: '#8acb8833' },
  { color: '#bd7ebe', colorLight: '#bd7ebe33' },
  { color: '#f06595', colorLight: '#f0659533' },
  { color: '#5c7cfa', colorLight: '#5c7cfa33' },
] as const;
