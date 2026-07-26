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
 * would otherwise defer the render indefinitely; this caps that so the preview refreshes at least
 * once every {@link PREVIEW_MAX_WAIT_MS} during a sustained edit.
 */
export const PREVIEW_MAX_WAIT_MS = Number(
  process.env.NEXT_PUBLIC_PREVIEW_MAX_WAIT_MS ?? 2000,
);

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
