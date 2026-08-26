import { useEffect, useLayoutEffect, useCallback, useSyncExternalStore } from 'react';
import { API_BASE_URL } from '@/lib/api/file-content';

// Run the localStorage load as a layout effect on the client (a no-op on the server) so it commits
// BEFORE the browser paints and before any user interaction is possible. This keeps the hydrating
// render matching the server (defaults) — avoiding the React #418 mismatch — while closing the window
// in which a setter could fire against the default state and persist defaults over the saved values.
const useBrowserLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;
import { isPreviewStyleValue, type PreviewStyleValue } from '@/components/preview-style-control';

// Re-exported so consumers/tests that read preferences can validate tokens from one import.
export { isPreviewStyleValue } from '@/components/preview-style-control';
export type { PreviewStyleValue } from '@/components/preview-style-control';

/** Valid editor theme values. */
export type EditorThemeValue = 'default' | 'high-contrast' | 'dracula' | 'tomorrow' | 'espresso';

const VALID_THEMES: readonly string[] = [
  'default',
  'high-contrast',
  'dracula',
  'tomorrow',
  'espresso',
] satisfies EditorThemeValue[];

/** Returns true when `value` is a recognised EditorThemeValue. */
export function isEditorThemeValue(value: string): value is EditorThemeValue {
  return VALID_THEMES.includes(value);
}

/** Which view the editor's left panel shows (028). Persisted client-only, never synced to the account. */
export type LeftPanelTab = 'files' | 'outline' | 'search';

/** Returns true when `value` is a recognised LeftPanelTab. */
function isLeftPanelTab(value: unknown): value is LeftPanelTab {
  return value === 'files' || value === 'outline' || value === 'search';
}

/** Which view the editor's right panel shows. Persisted client-only, never synced to the account. */
export type RightPanelTab = 'comments' | 'writing';

/** Returns true when `value` is a recognised RightPanelTab. */
function isRightPanelTab(value: unknown): value is RightPanelTab {
  return value === 'comments' || value === 'writing';
}

/** Whether the outline shows the full assembled document or only the open file (032). */
export type OutlineScope = 'full' | 'current';

/** Returns true when `value` is a recognised OutlineScope. */
function isOutlineScope(value: unknown): value is OutlineScope {
  return value === 'full' || value === 'current';
}

const LS_KEY = 'asciidocollab:editor-preferences';
const DEBOUNCE_MS = 500;

interface EditorPrefs {
  fontSize: number;
  theme: EditorThemeValue;
  scrollSyncEnabled: boolean;
  softWrap: boolean;
  previewStyle: PreviewStyleValue;
  spellIgnore: string[];
  spellcheckEnabled: boolean;
  /** Whether the editor shows the document text-preview (minimap). Synced to the account; defaults off. */
  minimapEnabled: boolean;
  /**
   * Whether a git commit authored by this account uses a privacy-preserving email instead of the
   * account's real email. Synced to the account; defaults off.
   */
  privateCommitEmail: boolean;
  /** 028: the active left-panel view. Client-only — kept in localStorage, never PUT to the account. */
  leftPanelTab: LeftPanelTab;
  rightPanelTab: RightPanelTab;
  /** 029: whether to show included files inline in the editor. Client-only — kept in localStorage, never PUT to the account. */
  showIncludedFiles: boolean;
  /** 032: whether the outline shows the full document or the open file only. Client-only — kept in localStorage, never PUT to the account. */
  outlineScope: OutlineScope;
  /** 038: whether the review comments panel is shown. Client-only — kept in localStorage, never PUT to the account. */
  commentsPanelOpen: boolean;
}

const DEFAULT_PREFS: EditorPrefs = { fontSize: 14, theme: 'default', scrollSyncEnabled: false, softWrap: true, previewStyle: 'asciidocollab', spellIgnore: [], spellcheckEnabled: true, minimapEnabled: false, privateCommitEmail: false, leftPanelTab: 'files', rightPanelTab: 'comments', showIncludedFiles: false, outlineScope: 'full', commentsPanelOpen: false };

// Preference keys kept on THIS device only — never sent to (or read back from) the account API. The
// PUT-payload strip in schedulePut() is driven by this list, so a new client-only preference can never
// leak to the server by omission. The fetch-merge additionally keeps each such key's local value, and
// does so by naming every one of them — extend that too when adding a key here (028). Routing one
// through `settle` instead is not the same rule: `settle` keeps the local value only while the account
// says nothing about the key, which is a property of today's DTO rather than of this list.
//
// `spellIgnore` belongs here and was not in it. The account endpoint does not carry it and never did:
// it is absent from `EditorPreferencesDto`, from the `EditorPreferences` entity, and from the PUT
// body schema — which declares `additionalProperties: false`, and Fastify's validator removes an
// undeclared property rather than rejecting it. So the list was serialised into every save and
// discarded on arrival, and the GET it was supposedly synced with has never once answered with it.
//
// It is also the only field in this object with no bound: every other one is a small number, a
// boolean, or a token from a fixed enum, while an author's personal dictionary grows a word at a
// time with nothing to stop it. That is what put the `pagehide` flush at risk — a `keepalive` body is
// capped at 64 KB and a request over the cap is REJECTED outright, so a large enough dictionary made
// the last-chance save fail every time, for a field the server was going to throw away regardless.
// Off the wire, the payload is bounded by construction and the cap is unreachable.
//
// Nothing is lost by not sending it. The dictionary's only store on either side of the wire is this
// browser's localStorage, and the defect the flush exists to prevent — the next load's account fetch
// overwriting a local value with a stale server one — cannot touch a field the account never returns.
const CLIENT_ONLY_KEYS = ['leftPanelTab', 'rightPanelTab', 'showIncludedFiles', 'outlineScope', 'commentsPanelOpen', 'spellIgnore'] as const satisfies readonly (keyof EditorPrefs)[];

/** The same list as a set, for the membership test below. */
const CLIENT_ONLY: ReadonlySet<string> = new Set<string>(CLIENT_ONLY_KEYS);

/**
 * Whether a stored name is a preference the account carries.
 *
 * @param key - A key of the defaults document.
 * @returns Whether it names a preference, and one that is not client-only.
 */
function isSyncedKey(key: string): key is keyof EditorPrefs {
  return key in DEFAULT_PREFS && !CLIENT_ONLY.has(key);
}

/**
 * The preferences the account carries: every one that is not client-only.
 *
 * Derived from the defaults rather than written out, so a preference added to {@link EditorPrefs} is
 * covered by {@link readUnsaved} the moment it exists, and one added to {@link CLIENT_ONLY_KEYS} drops
 * out of it. A list of names kept by hand beside two others is a list that ends up disagreeing.
 */
const SYNCED_KEYS: readonly (keyof EditorPrefs)[] = Object.keys(DEFAULT_PREFS).filter(isSyncedKey);

function isStoredPrefs(value: unknown): value is { fontSize?: number; theme?: string; scrollSyncEnabled?: boolean; softWrap?: boolean; previewStyle?: string; spellIgnore?: unknown; spellcheckEnabled?: boolean; minimapEnabled?: boolean; privateCommitEmail?: boolean; leftPanelTab?: unknown; rightPanelTab?: unknown; showIncludedFiles?: unknown; outlineScope?: unknown; commentsPanelOpen?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function loadFromStorage(): EditorPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isStoredPrefs(parsed)) {
        const rawTheme = parsed.theme;
        const rawPreviewStyle = parsed.previewStyle;
        return {
          fontSize: typeof parsed.fontSize === 'number' ? parsed.fontSize : DEFAULT_PREFS.fontSize,
          theme: typeof rawTheme === 'string' && isEditorThemeValue(rawTheme) ? rawTheme : DEFAULT_PREFS.theme,
          scrollSyncEnabled: typeof parsed.scrollSyncEnabled === 'boolean' ? parsed.scrollSyncEnabled : DEFAULT_PREFS.scrollSyncEnabled,
          softWrap: typeof parsed.softWrap === 'boolean' ? parsed.softWrap : DEFAULT_PREFS.softWrap,
          previewStyle: typeof rawPreviewStyle === 'string' && isPreviewStyleValue(rawPreviewStyle) ? rawPreviewStyle : DEFAULT_PREFS.previewStyle,
          spellIgnore: toStringArray(parsed.spellIgnore),
          spellcheckEnabled: typeof parsed.spellcheckEnabled === 'boolean' ? parsed.spellcheckEnabled : DEFAULT_PREFS.spellcheckEnabled,
          minimapEnabled: typeof parsed.minimapEnabled === 'boolean' ? parsed.minimapEnabled : DEFAULT_PREFS.minimapEnabled,
          privateCommitEmail: typeof parsed.privateCommitEmail === 'boolean' ? parsed.privateCommitEmail : DEFAULT_PREFS.privateCommitEmail,
          leftPanelTab: isLeftPanelTab(parsed.leftPanelTab) ? parsed.leftPanelTab : DEFAULT_PREFS.leftPanelTab,
          rightPanelTab: isRightPanelTab(parsed.rightPanelTab) ? parsed.rightPanelTab : DEFAULT_PREFS.rightPanelTab,
          showIncludedFiles: typeof parsed.showIncludedFiles === 'boolean' ? parsed.showIncludedFiles : DEFAULT_PREFS.showIncludedFiles,
          outlineScope: isOutlineScope(parsed.outlineScope) ? parsed.outlineScope : DEFAULT_PREFS.outlineScope,
          commentsPanelOpen: typeof parsed.commentsPanelOpen === 'boolean' ? parsed.commentsPanelOpen : DEFAULT_PREFS.commentsPanelOpen,
        };
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_PREFS;
}

// ── One state, shared by every mounted instance ───────────────────────────────────────────────────
//
// The hook is mounted MORE THAN ONCE at a time — `project-editor-layout.tsx` holds one and
// `asciidoc-editor.tsx` holds another — and each instance used to keep a private copy of every
// preference and PUT a full snapshot of its own copy. So the two overwrote each other: set the
// preview style through the layout, then change the font size in the editor, and the editor's PUT
// carried `"previewStyle":"asciidocollab"` because that is what ITS copy still said. localStorage
// reverted with it, since every setter writes a whole snapshot there too. The debounce, the pending
// payload and the `pagehide` flush below were all working perfectly on a value that had already been
// replaced by a stale one.
//
// A shared store is the fix rather than a smaller one because the server takes a WHOLE record: the
// PUT body requires `fontSize` and `theme` and the use case behind it writes every field it is given,
// so there is no partial payload that would let two states coexist. One state is what makes a
// snapshot of it true.
//
// What the last mount going away releases is the two MARKS — that localStorage has been read, and
// that the account has been asked — so the next mount reads both again exactly as the first one did.
//
// The values themselves are kept, and that is the difference between this sentence being true and it
// merely sounding true. Emptying them to the defaults was a reset an author could see, twice over:
//
//  * Any setter firing after the last instance unmounted built its snapshot on the DEFAULTS and wrote
//    that whole snapshot to localStorage — every preference back to factory, the personal dictionary
//    gone. The account GET can repair a font size or a theme; it can never repair a CLIENT_ONLY_KEY,
//    because those are the keys the server does not carry by design.
//  * A keyed subtree that unmounts and remounts in ONE commit runs the new fiber's LAYOUT effects
//    before the old fiber's PASSIVE cleanup. So the mount that would have re-read localStorage had
//    already found the mark set and returned, and only then was the store emptied under it: a
//    visible, silent revert to the defaults with no mount left to undo it. Today's tree survives that
//    only because `project-editor-layout.tsx` happens to hold an instance that outlives its keyed
//    children — an accident of mount order that nothing declares and nothing enforces.
//
// Keeping the values costs nothing, because localStorage is the authority and the next mount re-reads
// it over them anyway. What it buys is that no window between two mounts can be a window in which the
// store lies.
//
// The release is DEFERRED to a microtask and cancelled if a subscriber takes the last one's place,
// because "the listener set is momentarily empty" is not "the page is finished with this": React
// empties and refills it inside a single commit for a keyed remount, and for every StrictMode
// double-invoke. Releasing on the spot meant releasing the marks out from under a still-mounted
// instance — a second identical account GET on every development mount, and a later-mounting second
// instance re-reading localStorage over state the account had already merged into.
let sharedPrefs: EditorPrefs = DEFAULT_PREFS;
/** Whether localStorage has been read into the store — once per store, not once per instance. */
let loadedFromStorage = false;
/** Whether the account has been asked — likewise once, rather than once per mounted instance. */
let fetchedFromAccount = false;
const prefsListeners = new Set<() => void>();
/** The debounce timer for the account save. One store, one save pipeline. */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** What a scheduled save is still holding, so the page can take it with it if it goes away first. */
let pendingPayload: Partial<EditorPrefs> | null = null;
/**
 * Where the values the account is not known to hold are kept.
 *
 * Beside the preferences rather than inside them, because it is a record ABOUT them: the preference
 * document is what an author's settings are, and a reader of it must not have to know which of its
 * fields are settings and which are bookkeeping.
 *
 * In SESSION storage, which is the lifetime of the thing being remembered — this tab, until it is
 * closed. A project switch is a client-side navigation and a reload is a fresh page, and a change
 * armed inside the debounce survives both of those exactly as the tab does. It must NOT survive the
 * tab: the `pagehide` flush is that change's last attempt by design, and a record that outlived it
 * would have this device re-assert a days-old value over one made since on another device.
 */
const UNSAVED_STORAGE_KEY = 'asciidocollab:editor-preferences:unsaved';

/**
 * Per preference, the value the account is not known to hold.
 *
 * The values are `unknown` because they come back out of storage, where anything can have been written
 * — and nothing here needs them to be anything else. They are compared against what the store holds
 * and never adopted from, so a record somebody else wrote can at worst match nothing.
 */
type UnsavedValues = Partial<Record<keyof EditorPrefs, unknown>>;

/**
 * Whether a parsed storage document can be read as that record.
 *
 * @param value - Whatever was parsed out of storage.
 * @returns Whether it is an object with named entries, which is all this record is.
 */
function isUnsavedRecord(value: unknown): value is UnsavedValues {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Per account-synced preference, the value the server is not yet known to hold.
 *
 * An entry is written when the author changes a preference and removed when a save carrying that very
 * value is answered with success, when the account's own answer turns out to agree with it, or when
 * the account refuses it in a way that trying again cannot fix — the point at which the change is
 * dropped and said (see {@link isRetriableStatus}).
 *
 * This is what tells an account answer from one that is simply OLDER than what is held here. The merge
 * used to protect only the changes made while its own request was open, by comparing the store now
 * against the store when the request went out. A change made half a second before an editor unmounted
 * is not that: the save it armed is still on its way, the release drops the pending payload, and the
 * next mount reads the new value out of localStorage BEFORE capturing its comparison point — so the
 * two are equal, the key looks untouched, and the server's older value is written over it. The author
 * watched their font size revert to a number the account itself was about to stop holding: the armed
 * PUT then landed, and the record, localStorage and the screen disagreed until the next remount.
 *
 * The VALUE and not merely the name, because the claim being made is about a value: "the account does
 * not hold 30 for `fontSize`". Once the store holds something else for that key the claim says nothing
 * about what is on screen — the change was replaced by another (which records its own), or the store
 * was filled from a localStorage the change never reached.
 *
 * In storage and not in a module variable, because the change it is about is in storage too: a reload
 * inside the debounce leaves the newer value in localStorage with nothing on its way to the account,
 * and a record that died with the page would let the next load's fetch write the older value straight
 * back over it — the same loss, one page later. What keeps a key from being refused for the rest of
 * the tab's life is {@link reconcileUnsaved}.
 *
 * @returns What the account is not known to hold, per preference; empty when it is level with this
 *   device or when the record cannot be read.
 */
function readUnsaved(): UnsavedValues {
  try {
    const raw = sessionStorage.getItem(UNSAVED_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    // Every value is `unknown` and stays that way: this record is only ever COMPARED against what the
    // store holds, so a document somebody else wrote can at worst fail to match anything.
    return isUnsavedRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Replace the record of what the account is not known to hold.
 *
 * @param unsaved - The values still owed to it; an empty record removes the entry entirely.
 */
function writeUnsaved(unsaved: UnsavedValues): void {
  try {
    if (Object.keys(unsaved).length === 0) sessionStorage.removeItem(UNSAVED_STORAGE_KEY);
    else sessionStorage.setItem(UNSAVED_STORAGE_KEY, JSON.stringify(unsaved));
  } catch { /* ignore */ }
}

/** Whether a release of the read marks is pending, so a subscriber arriving in time can call it off. */
let releasePending = false;

/**
 * Subscribe to the shared preferences.
 *
 * @param listener - Called whenever the shared state is replaced.
 * @returns The unsubscribe function.
 */
function subscribeToPrefs(listener: () => void): () => void {
  prefsListeners.add(listener);
  // Somebody took the last subscriber's place before the microtask ran, so nothing is finished with
  // the store after all. See the release below for the two commits that do exactly this.
  releasePending = false;
  return () => {
    prefsListeners.delete(listener);
    if (prefsListeners.size > 0) return;
    releasePending = true;
    void Promise.resolve().then(() => {
      if (!releasePending || prefsListeners.size > 0) return;
      releasePending = false;
      loadedFromStorage = false;
      fetchedFromAccount = false;
      // A save already SCHEDULED is left armed on purpose: it is for a change the author made, and it
      // is owed to them whether or not an editor is still open. What it is holding is dropped,
      // because the only thing that reads it is the `pagehide` flush, and that listener went with the
      // last instance.
      //
      // That the change is still owed is NOT dropped with it — see {@link readUnsaved}. Forgetting it
      // here is what let the next mount's account fetch write the older value back over the newer one
      // while the newer one was still on its way to the account.
      pendingPayload = null;
    });
  };
}

/** The shared preferences, as the store currently holds them. */
function readPrefs(): EditorPrefs {
  return sharedPrefs;
}

/** What the server renders with: the defaults, so the hydrating render matches the server HTML. */
function readDefaultPrefs(): EditorPrefs {
  return DEFAULT_PREFS;
}

/**
 * Replace the shared preferences and tell everyone reading them.
 *
 * @param update - Given the current preferences, the ones to hold instead.
 * @returns The preferences now held, which are the previous ones when nothing changed.
 */
function updatePrefs(update: (previous: EditorPrefs) => EditorPrefs): EditorPrefs {
  const next = update(sharedPrefs);
  if (next === sharedPrefs) return sharedPrefs;
  sharedPrefs = next;
  // Over a copy: a listener is free to unsubscribe as it runs (React does exactly that when a
  // notification unmounts a subscriber), and the set it would be removing itself from is this one.
  const notify = [...prefsListeners];
  for (const listener of notify) listener();
  return next;
}

/** Whether a save that failed with this status may succeed if it is simply tried again. */
function isRetriableStatus(status: number): boolean {
  // 5xx is the server having a bad moment, 408 and 429 are it asking for the request again later.
  // Every other refusal is about THIS body or THIS session, and repeating it changes nothing.
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Stop claiming the account's copy of these preferences is out of date.
 *
 * Called where a save STOPS being owed, which is one of two moments: the server answered that it took
 * the record, or it refused in a way that repeating the request cannot change — the point at which the
 * change is dropped, and said. Anything in between (an unreachable network, a 503, a `pagehide` flush
 * that nothing can confirm) leaves the mark where it is, because the account's copy really is older
 * than what is held here until something says otherwise.
 *
 * Value by value, because a preference changed again while this request was in flight has already
 * recorded a newer one, and this answer says nothing about that.
 *
 * @param payload - The body the request carried.
 */
function clearUnsaved(payload: Partial<EditorPrefs>): void {
  const unsaved = readUnsaved();
  let changed = false;
  for (const key of SYNCED_KEYS) {
    if (key in unsaved && payload[key] === unsaved[key]) {
      delete unsaved[key];
      changed = true;
    }
  }
  if (changed) writeUnsaved(unsaved);
}

/**
 * Settle the record of what the account is not known to hold against what it has just answered.
 *
 * Two things happen here, and the second is what stops the first becoming permanent. A value the
 * account turns out to hold after all is no longer owed to it, and neither is one this device no
 * longer holds — the change was replaced, or another tab wrote over it. What is left is a value this
 * device holds, the account contradicts, and nothing is on its way to tell it about: the save that
 * would have done so failed, or was armed by an editor that has since gone. Without saying so now, the
 * merge below would refuse the account's answer for that preference every time it is asked, for as
 * long as the tab is open, while never once telling it anything different.
 *
 * @param unsaved - The record as it was read for this merge.
 * @param data - What the account answered with.
 * @param held - The preferences as the merge settled them.
 * @returns Whether anything is still owed to the account and has to be sent again.
 */
function reconcileUnsaved(unsaved: UnsavedValues, data: Partial<EditorPrefs>, held: EditorPrefs): boolean {
  let owed = false;
  let changed = false;
  for (const key of SYNCED_KEYS) {
    if (!(key in unsaved)) continue;
    // A value this device no longer holds, or one the account turns out to hold as well: either way
    // there is nothing left to be behind on.
    if (unsaved[key] !== held[key] || data[key] === held[key]) {
      delete unsaved[key];
      changed = true;
      continue;
    }
    // An answer that says nothing about a preference is not an answer that disagrees about it. The
    // account is still not known to hold this one, and still has nothing to be told.
    if (data[key] === undefined) continue;
    owed = true;
  }
  if (changed) writeUnsaved(unsaved);
  return owed;
}

/**
 * Save the account-synced preferences, half a second after the last change.
 *
 * @param next - The full preference state to save from.
 */
function schedulePut(next: EditorPrefs): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  // Strip every client-only key from the account payload (no server DTO change needed; the chosen
  // view never leaves this browser). Driven by CLIENT_ONLY_KEYS so a new client-only pref can't leak.
  const serverPayload: Partial<EditorPrefs> = { ...next };
  for (const key of CLIENT_ONLY_KEYS) delete serverPayload[key];
  pendingPayload = serverPayload;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void fetch(`${API_BASE_URL}/auth/me/editor-preferences`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serverPayload),
    })
      .then((response) => {
        if (!response.ok) {
          // `fetch` rejects only when the request never got an answer, so a 400, a 401 and a 500 all
          // arrive HERE, in the success branch. Treating them alike as a save is how a change came to
          // be discarded in silence: an expired session answered 401, the pending payload was cleared
          // as though it had been written, `pagehide` found nothing left to send, and the next sign-in
          // fetched the server's stale value and wrote it back over localStorage.
          //
          // What to do about it is decided by the status rather than by the failure. A transient one
          // is the same situation as an unreachable network — the change may yet be saved — so it
          // stays pending and `pagehide` gets its last attempt at it. Anything else is the server
          // refusing this body or this session, which trying again cannot change; retrying a
          // permanent 400 forever is its own defect. So it is dropped, and SAID, because a preference
          // that silently did not save is the whole shape of this.
          if (isRetriableStatus(response.status)) return;
          if (pendingPayload === serverPayload) pendingPayload = null;
          // Dropped, so it is no longer owed — and the account's answer stops being one to distrust.
          clearUnsaved(serverPayload);
          // eslint-disable-next-line no-console -- a change the account refused must leave a trace.
          console.warn(`The editor preferences could not be saved (HTTP ${response.status}).`);
          return;
        }
        // Cleared HERE, once the request has actually reached the server, and not when it was
        // started. This fetch is not `keepalive`, so a tab closed while it is in flight cancels it;
        // clearing the pending payload first left `pagehide` with nothing to send in its place, and
        // the next load's account fetch then wrote the stale server value back over localStorage —
        // the exact loss the flush was added to prevent, through a window half a second narrower.
        //
        // Compared by identity, not merely nulled: a preference changed while this request was in
        // flight has already replaced the pending payload with a newer one, and clearing that would
        // discard the change that has not been sent instead of the one that has.
        if (pendingPayload === serverPayload) pendingPayload = null;
        // The account now holds these, so its answer to the next GET is no longer the older of the two.
        clearUnsaved(serverPayload);
      })
      .catch(() => {
        // Transient save failure (e.g. offline): the change still applies for the current
        // session (state + localStorage), stays pending so a `pagehide` gets one more attempt at
        // it, and is reconciled on the next successful save.
      });
  }, DEBOUNCE_MS);
}

/**
 * Apply one preference change everywhere it has to go.
 *
 * The update function is pure and the effects happen out here, which is the other half of the fix
 * above: `schedulePut` and the localStorage write used to run INSIDE the `setPrefs` updater, where
 * React is free to call them twice (it does, under StrictMode) or to throw the result away.
 *
 * @param update - Given the current preferences, the ones to hold instead.
 * @param options - Set `sync` for a preference the account carries; client-only ones stay here.
 */
function applyChange(
  update: (previous: EditorPrefs) => EditorPrefs,
  options: { readonly sync: boolean },
): void {
  const previous = sharedPrefs;
  const next = updatePrefs(update);
  if (next === previous) return;
  try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  if (!options.sync) return;
  // Whatever this changed, the account does not hold yet — and will not for at least the half second
  // the save is debounced by, which is longer than an editor sometimes lasts. See {@link readUnsaved}.
  const unsaved = readUnsaved();
  const remember = <K extends keyof EditorPrefs>(key: K): void => { unsaved[key] = next[key]; };
  let owed = false;
  for (const key of SYNCED_KEYS) {
    if (next[key] === previous[key]) continue;
    remember(key);
    owed = true;
  }
  if (owed) writeUnsaved(unsaved);
  schedulePut(next);
}

/** Current editor preferences and their setters, synchronised with localStorage and the API. */
interface UseEditorPreferencesResult {
  fontSize: number;
  theme: EditorThemeValue;
  scrollSyncEnabled: boolean;
  softWrap: boolean;
  previewStyle: PreviewStyleValue;
  spellIgnore: string[];
  spellcheckEnabled: boolean;
  minimapEnabled: boolean;
  privateCommitEmail: boolean;
  leftPanelTab: LeftPanelTab;
  rightPanelTab: RightPanelTab;
  showIncludedFiles: boolean;
  outlineScope: OutlineScope;
  commentsPanelOpen: boolean;
  setFontSize: (size: number) => void;
  setTheme: (theme: EditorThemeValue) => void;
  setScrollSyncEnabled: (enabled: boolean) => void;
  setSoftWrap: (enabled: boolean) => void;
  setPreviewStyle: (style: PreviewStyleValue) => void;
  addSpellIgnore: (word: string) => void;
  setSpellcheckEnabled: (enabled: boolean) => void;
  setMinimapEnabled: (enabled: boolean) => void;
  setPrivateCommitEmail: (enabled: boolean) => void;
  setLeftPanelTab: (tab: LeftPanelTab) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  setShowIncludedFiles: (value: boolean) => void;
  setOutlineScope: (scope: OutlineScope) => void;
  setCommentsPanelOpen: (value: boolean) => void;
}

/** Manages editor font size, theme, and scroll sync preference, persisting to localStorage and API. */
export function useEditorPreferences(): UseEditorPreferencesResult {
  // Read from the shared store rather than from state of this instance's own — see the store above
  // for what two private copies of one preference did to each other.
  //
  // The server snapshot is the DEFAULTS, deliberately: the editor layout is server-rendered and the
  // server has no localStorage, so a persisted non-default value (the chosen left-panel tab, say)
  // would make the client's first render diverge from the server HTML and trip a hydration mismatch
  // (React #418). The stored prefs are read after mount, so the hydrating render matches the server
  // and then settles to the saved values.
  const prefs = useSyncExternalStore(subscribeToPrefs, readPrefs, readDefaultPrefs);

  // Load the persisted prefs from localStorage on the client only, after hydration. Declared before
  // the account-fetch effect so its values are already in place when that async merge resolves.
  //
  // Once per STORE rather than once per instance: a second editor mounting later must not re-read
  // localStorage over state the account fetch has already merged into. The mark is released only when
  // the store's last subscriber has gone and none has replaced it — see the store above — and it is
  // released together with the account mark, so a re-read is always followed by a fresh fetch.
  useBrowserLayoutEffect(() => {
    if (loadedFromStorage) return;
    loadedFromStorage = true;
    updatePrefs(() => loadFromStorage());
  }, []);

  useEffect(() => {
    if (fetchedFromAccount) return;
    fetchedFromAccount = true;
    // What the store held when the request went out, so the merge can tell a preference the author
    // changed WHILE it was in flight from one they did not touch.
    //
    // Without it the server's answer overwrote both alike, and the newer of the two lost: the change
    // was already on its way to the account in an armed PUT, so the record ended up right and the
    // screen ended up wrong — the author watched their font size revert and stay reverted until they
    // reloaded the page. Read here rather than in the merge because "before the request" is the
    // comparison; the localStorage load is a layout effect and has already run by now.
    const atRequest = sharedPrefs;
    void fetch(`${API_BASE_URL}/auth/me/editor-preferences`, { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : Promise.reject(response)))
      .then((data: Partial<EditorPrefs>) => {
        // Read once for the whole merge, and kept for the reconciliation after it. See {@link readUnsaved}.
        const unsaved = readUnsaved();
        const merged = updatePrefs((previous) => {
          /**
           * The value one account-synced preference settles on.
           *
           * Two ways an answer can be older than what is held here, and each needs its own question.
           * The record {@link readUnsaved} returns carries the values the account is not known to hold,
           * across mounts, across the store's teardown and across a reload — which is where a change
           * armed by one editor and inherited by the next was being written over by the very value it
           * was on its way to replace.
           * The comparison against the store as it was when THIS request went out catches the rest: a
           * change whose save was confirmed while the request was open is no longer unsaved, but the
           * answer in flight was composed before it and is stale about it all the same.
           *
           * @param key - Which preference.
           * @param fromServer - What the account answered with, or undefined when it said nothing usable.
           * @returns The server's value, unless what is held here is known to be newer than it.
           */
          const settle = <K extends keyof EditorPrefs>(key: K, fromServer: EditorPrefs[K] | undefined): EditorPrefs[K] =>
            fromServer === undefined || unsaved[key] === previous[key] || previous[key] !== atRequest[key]
              ? previous[key]
              : fromServer;
          return {
            fontSize: settle('fontSize', typeof data.fontSize === 'number' ? data.fontSize : undefined),
            theme: settle('theme', typeof data.theme === 'string' && isEditorThemeValue(data.theme) ? data.theme : undefined),
            scrollSyncEnabled: settle('scrollSyncEnabled', typeof data.scrollSyncEnabled === 'boolean' ? data.scrollSyncEnabled : undefined),
            softWrap: settle('softWrap', typeof data.softWrap === 'boolean' ? data.softWrap : undefined),
            previewStyle: settle('previewStyle', typeof data.previewStyle === 'string' && isPreviewStyleValue(data.previewStyle) ? data.previewStyle : undefined),
            spellcheckEnabled: settle('spellcheckEnabled', typeof data.spellcheckEnabled === 'boolean' ? data.spellcheckEnabled : undefined),
            minimapEnabled: settle('minimapEnabled', typeof data.minimapEnabled === 'boolean' ? data.minimapEnabled : undefined),
            privateCommitEmail: settle('privateCommitEmail', typeof data.privateCommitEmail === 'boolean' ? data.privateCommitEmail : undefined),
            // Client-only keys (see CLIENT_ONLY_KEYS) are never returned by the account API, so always keep
            // the local value — the server response can never overwrite the chosen view or scope.
            //
            // `spellIgnore` is one of them and was going through `settle` instead, which keeps the local
            // value only while the account says nothing about it. That was true of every answer the API
            // can currently give and of nothing else: the day the DTO grows the field, the account's copy
            // — which is empty, because this list is never sent — would be merged over the author's
            // personal dictionary on the next load. The list's only store is this browser.
            spellIgnore: previous.spellIgnore,
            leftPanelTab: previous.leftPanelTab,
            rightPanelTab: previous.rightPanelTab,
            showIncludedFiles: previous.showIncludedFiles,
            outlineScope: previous.outlineScope,
            commentsPanelOpen: previous.commentsPanelOpen,
          };
        });
        // Anything this device holds that the account contradicts, with no save left on its way to tell
        // it so, is sent again now — otherwise the merge above would refuse that answer on every load.
        //
        // A save that is still armed or still unanswered IS that save, carrying these very values, so
        // nothing is scheduled beside it: this is for the change whose page went away before it could
        // be sent, where the record of what is owed outlived the request that owed it.
        if (reconcileUnsaved(unsaved, data, merged) && pendingPayload === null) schedulePut(merged);
      })
      .catch(() => { /* keep localStorage value on error */ });
  }, []);

  // A preference changed and then immediately reloaded, navigated away from or closed used to be
  // LOST, silently and permanently. The save is debounced by half a second; a page that went away
  // inside that window never sent it. localStorage still held the new value, but it does not get the
  // last word — the account fetch above overwrites the local state with whatever the server holds —
  // so the next load restored the stale server value over the author's most recent choice.
  //
  // `pagehide` rather than `beforeunload`: it is delivered for a reload, a navigation and a tab close
  // alike, is not suppressed on mobile, and does not disqualify the page from the back/forward cache.
  // `keepalive` is what makes the request outlive the document — an ordinary fetch started here is
  // cancelled along with the page, which is the very case being fixed.
  //
  // `keepalive` also caps the body at 64 KB and REJECTS anything larger, which is why the payload is
  // kept to bounded fields: see CLIENT_ONLY_KEYS for what used to be in it and why it is not.
  useEffect(() => {
    const flush = (): void => {
      const payload = pendingPayload;
      if (payload === null) return;
      pendingPayload = null;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      void fetch(`${API_BASE_URL}/auth/me/editor-preferences`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch((error: unknown) => {
        // The page is going away and there is nothing left to retry into — but this is the LAST
        // attempt the change gets, so a failure here is the change being lost. Swallowed in silence
        // it looked exactly like a save that worked, which is how a body over the `keepalive` cap
        // came to defeat the whole mechanism without leaving a trace anywhere.
        // eslint-disable-next-line no-console -- the last save attempt failing must leave a trace.
        console.warn('The final editor-preferences save could not be sent.', error);
      });
    };
    globalThis.addEventListener('pagehide', flush);
    return () => globalThis.removeEventListener('pagehide', flush);
  }, []);

  const setFontSize = useCallback((fontSize: number) => {
    applyChange((previous) => ({ ...previous, fontSize }), { sync: true });
  }, []);

  const setTheme = useCallback((theme: EditorThemeValue) => {
    applyChange((previous) => ({ ...previous, theme }), { sync: true });
  }, []);

  const setScrollSyncEnabled = useCallback((scrollSyncEnabled: boolean) => {
    applyChange((previous) => ({ ...previous, scrollSyncEnabled }), { sync: true });
  }, []);

  const setSoftWrap = useCallback((softWrap: boolean) => {
    applyChange((previous) => ({ ...previous, softWrap }), { sync: true });
  }, []);

  const setPreviewStyle = useCallback((previewStyle: PreviewStyleValue) => {
    applyChange((previous) => ({ ...previous, previewStyle }), { sync: true });
  }, []);

  // Client-only setter: `spellIgnore` is a CLIENT_ONLY_KEY, so the payload builder strips it and a
  // save scheduled from here would carry a body describing every OTHER preference and nothing of the
  // word just added. One request per word, to tell the account something it neither stores nor
  // returns. The list's only home on either side of the wire is this browser's localStorage, which
  // `applyChange` writes before this returns.
  const addSpellIgnore = useCallback((word: string) => {
    applyChange(
      (previous) =>
        previous.spellIgnore.includes(word)
          ? previous
          : { ...previous, spellIgnore: [...previous.spellIgnore, word] },
      { sync: false },
    );
  }, []);

  const setSpellcheckEnabled = useCallback((spellcheckEnabled: boolean) => {
    applyChange((previous) => ({ ...previous, spellcheckEnabled }), { sync: true });
  }, []);

  const setMinimapEnabled = useCallback((minimapEnabled: boolean) => {
    applyChange((previous) => ({ ...previous, minimapEnabled }), { sync: true });
  }, []);

  const setPrivateCommitEmail = useCallback((privateCommitEmail: boolean) => {
    applyChange((previous) => ({ ...previous, privateCommitEmail }), { sync: true });
  }, []);

  // Client-only setter (028): persists the chosen view to localStorage but never schedules a PUT, so
  // the value stays on this device and is excluded from the account preferences.
  const setLeftPanelTab = useCallback((leftPanelTab: LeftPanelTab) => {
    applyChange((previous) => ({ ...previous, leftPanelTab }), { sync: false });
  }, []);

  // Client-only setter: the active right-panel view stays on this device, like the left panel's.
  const setRightPanelTab = useCallback((rightPanelTab: RightPanelTab) => {
    applyChange((previous) => ({ ...previous, rightPanelTab }), { sync: false });
  }, []);

  // Client-only setter (029): persists whether to show included files to localStorage but never
  // schedules a PUT, so the value stays on this device and is excluded from the account preferences.
  const setShowIncludedFiles = useCallback((showIncludedFiles: boolean) => {
    applyChange((previous) => ({ ...previous, showIncludedFiles }), { sync: false });
  }, []);

  // Client-only setter (032): persists the outline scope (full / current) to localStorage
  // but never schedules a PUT, so the choice stays on this device.
  const setOutlineScope = useCallback((outlineScope: OutlineScope) => {
    applyChange((previous) => ({ ...previous, outlineScope }), { sync: false });
  }, []);

  // Client-only setter (038): persists whether the review comments panel is shown to localStorage
  // but never schedules a PUT, so the choice stays on this device (Constitution VII).
  const setCommentsPanelOpen = useCallback((commentsPanelOpen: boolean) => {
    applyChange((previous) => ({ ...previous, commentsPanelOpen }), { sync: false });
  }, []);

  return { fontSize: prefs.fontSize, theme: prefs.theme, scrollSyncEnabled: prefs.scrollSyncEnabled, softWrap: prefs.softWrap, previewStyle: prefs.previewStyle, spellIgnore: prefs.spellIgnore, spellcheckEnabled: prefs.spellcheckEnabled, minimapEnabled: prefs.minimapEnabled, privateCommitEmail: prefs.privateCommitEmail, leftPanelTab: prefs.leftPanelTab, rightPanelTab: prefs.rightPanelTab, showIncludedFiles: prefs.showIncludedFiles, outlineScope: prefs.outlineScope, commentsPanelOpen: prefs.commentsPanelOpen, setFontSize, setTheme, setScrollSyncEnabled, setSoftWrap, setPreviewStyle, addSpellIgnore, setSpellcheckEnabled, setMinimapEnabled, setPrivateCommitEmail, setLeftPanelTab, setRightPanelTab, setShowIncludedFiles, setOutlineScope, setCommentsPanelOpen };
}
