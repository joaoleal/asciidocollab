'use client';
import { useCallback, useState, useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import { PREVIEW_DEBOUNCE_MS, PREVIEW_MAX_WAIT_MS } from '@/lib/editor-config';
import { acquireRenderWorker, type RenderWorkerHandle } from '@/lib/create-render-worker';
import { createMaxWaitDebounce, type MaxWaitDebounce } from '@/lib/max-wait-debounce';
import { adaptiveDelayMs } from '@/lib/preview/adaptive-delay';
import { morphPreview } from '@/lib/preview/morph-preview';
import type { RenderRequest, RenderResult, RenderTimings } from '@/workers/render-protocol';

/** Lifecycle state of the preview panel. */
export type PreviewState = 'idle' | 'pending' | 'rendering' | 'up-to-date' | 'error';

/**
 * A scroll request object. Each click in the editor produces a new instance so
 * React always sees a changed value even when the line number is the same.
 *
 * @param line - 1-based line number to scroll the preview to.
 */
export interface ScrollRequest {
  /** 1-based line number to scroll the preview to. */
  line: number;
}

/** Configuration controlling debounce delay and initial content for the AsciiDoc preview. */
export interface UseAsciidocPreviewOptions {
  /** Current AsciiDoc source text. Changing this resets the debounce and transitions state to pending. */
  content: string;
  /** True when the selected file is AsciiDoc and the preview panel is open. False transitions to idle. */
  isEnabled: boolean;
  /** When set, the hook scrolls the preview to the element with the matching data-source-line. */
  scrollToLine: ScrollRequest | null;
  /** Base path Asciidoctor prepends to relative image targets (the project's image endpoint). */
  imagesDir?: string;
  /**
   * Project-relative path of the configured main file. When set with {@link getFiles}, the preview
   * renders the assembled main document (includes inlined, sandbox-confined) instead of `content`.
   * Leave unset to render the open file as-is (exact source-line scroll-sync).
   */
  mainPath?: string;
  /** Returns the path→content snapshot the include assembler needs; read lazily at render time. */
  getFiles?: () => Record<string, string>;
  /**
   * Project main-file path (root) for cross-document attribute resolution: the open
   * file's `{name}` references resolve to the value in effect at its first include-point under this
   * root. `null`/unset ⇒ standalone resolution (the file's own attributes only).
   */
  rootFileId?: string | null;
  /** The previewed open file's path, whose inherited attribute scope the worker seeds. */
  openFileId?: string;
  /** When false (default), the assembler hides included bodies and emits placeholders. */
  showIncludes?: boolean;
  /**
   * Bumps whenever a reachable INCLUDED file's content changes (a collaborator's live edit or save,
   * delivered as a `content-changed` frame) without the open file's own `content` changing. Changing
   * it re-posts a render that reads the fresh {@link getFiles} snapshot, so an included file's new
   * heading level / content propagates into the assembled preview — the preview's counterpart to the
   * outline recomputing on the same signal. Leave unset when the preview has no include dependencies.
   */
  filesVersion?: number;
  /**
   * Project-level render-config attributes (soft-defaulted with a trailing `@`) applied beneath the
   * document's inherited scope and its own header. A stable (memoized) reference; changing it re-posts.
   */
  projectAttributes?: Record<string, string>;
}

/**
 * Sanitized markup and the nodes it describes, taken from one sanitizer call.
 *
 * The sanitizer is asked for NODES, because handing markup to the browser as a string is the parse
 * (and the wholesale DOM rebuild behind it) this hook exists to avoid. The markup is read back out of
 * those nodes rather than obtained from a second sanitizer call, so there is exactly one sanitization
 * per render and no chance of the two disagreeing about what was allowed.
 *
 * Reading markup out of a fragment means putting its nodes somewhere serializable, which MOVES them —
 * so they are moved back into a fresh fragment rather than copied. Moving nodes is a pointer shuffle;
 * copying the tree would cost about as much as the sanitizer's own parse, for a string that nothing on
 * screen depends on.
 *
 * @param sanitized - The sanitizer's output, consumed by this call.
 * @returns The same nodes, in a fragment of their own, alongside the markup they serialize to.
 */
function readMarkupFrom(sanitized: DocumentFragment): { markup: string; nodes: DocumentFragment } {
  const holder = document.createElement('div');
  holder.append(sanitized);
  const markup = holder.innerHTML;
  const nodes = document.createDocumentFragment();
  nodes.append(...holder.childNodes);
  return { markup, nodes };
}

/** Return value of the `useAsciidocPreview` hook. */
export interface UseAsciidocPreviewResult {
  /**
   * Sanitized markup of the latest successful render, or null before the first one.
   *
   * NOT the commit path — the hook commits by patching {@link UseAsciidocPreviewResult.outputRef}
   * itself. This is the render's identity: what was rendered, as opposed to what is currently on
   * screen (which also carries drawn diagrams and typeset expressions the client added afterwards).
   */
  html: string | null;
  /** Current lifecycle state. */
  state: PreviewState;
  /** Error message from the last failed render, or null. */
  error: string | null;
  /** Ref to attach to the preview scroll container. */
  previewRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Ref to attach to the rendered-output element — the element this hook patches each render into.
   * It must be attached before the first render lands, and its contents belong to this hook: a
   * consumer that also writes children into it would have them patched away.
   */
  outputRef: React.RefObject<HTMLDivElement | null>;
  /**
   * True when the latest rendered HTML contains in-effect STEM math. The preview uses this to
   * lazy-load MathJax and typeset the container only when there is math to render.
   */
  mathPresent: boolean;
  /**
   * True when the latest rendered HTML contains ≥1 diagram placeholder. The preview uses this to
   * lazy-load the heavy diagram engines (mermaid/vega/graphviz) only when a diagram is present.
   */
  diagramsPresent: boolean;
  /**
   * What the most recent SUCCESSFUL render cost, by stage, or null before the first one completes.
   *
   * A failed render leaves this at the last successful figures rather than clearing them: it carries
   * no breakdown of its own, and both consumers — the development overlay and the delay derived from
   * measured cost — are better served by the last real measurement of this document than by nothing.
   */
  timings: RenderTimings | null;
  /**
   * True when the render engine died more times in a row than supervision is willing to rebuild
   * automatically. Nothing further will be attempted until {@link UseAsciidocPreviewResult.retryEngine}
   * is called, so a consumer that ignores this shows a preview that silently never updates again.
   */
  engineFailed: boolean;
  /**
   * Ask for another engine after {@link UseAsciidocPreviewResult.engineFailed}, restoring the
   * automatic-rebuild budget and replaying the render that was outstanding. A no-op otherwise.
   */
  retryEngine: () => void;
  /**
   * Bumped once per render actually committed to the output element, and the signal anything that has
   * to run AFTER a commit — typesetting math, drawing diagrams — must depend on.
   *
   * {@link UseAsciidocPreviewResult.html} cannot serve as that signal now that the hook commits by
   * patching the DOM: the same markup can be committed into a different element (open a file, come
   * back to it), and a patch can change the element without producing markup that differs. A pass
   * keyed on the markup would then skip a commit that genuinely needed it, leaving raw delimiters or
   * undrawn placeholders on screen with nothing to trigger a retry. This states the event itself
   * rather than inferring it from a value that merely tends to change alongside it.
   */
  renderNonce: number;
}

/**
 * Manages the Web Worker lifecycle, debounce timer, PreviewState machine, and
 * click-to-scroll.
 */
export function useAsciidocPreview({
  content,
  isEnabled,
  scrollToLine,
  imagesDir,
  mainPath,
  getFiles,
  rootFileId,
  openFileId,
  showIncludes,
  filesVersion,
  projectAttributes,
}: UseAsciidocPreviewOptions): UseAsciidocPreviewResult {
  const [state, setState] = useState<PreviewState>('idle');
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mathPresent, setMathPresent] = useState(false);
  const [diagramsPresent, setDiagramsPresent] = useState(false);
  const [timings, setTimings] = useState<RenderTimings | null>(null);
  const [engineFailed, setEngineFailed] = useState(false);
  const [renderNonce, setRenderNonce] = useState(0);

  // Held in a ref so the debounced render always posts the current base path without
  // re-running the debounce effects when it changes (it is stable per editor session).
  const imagesDirectoryReference = useRef(imagesDir);
  imagesDirectoryReference.current = imagesDir;
  // Include-assembly inputs, read lazily at render time (the files snapshot changes identity often).
  const mainPathReference = useRef(mainPath);
  mainPathReference.current = mainPath;
  const getFilesReference = useRef(getFiles);
  getFilesReference.current = getFiles;
  // Cross-document attribute-scope inputs, read lazily at render time so editing a
  // parent's attribute re-resolves on the next debounced render without re-running the debounce effect.
  const rootFileIdReference = useRef(rootFileId);
  rootFileIdReference.current = rootFileId;
  const openFileIdReference = useRef(openFileId);
  openFileIdReference.current = openFileId;
  const showIncludesReference = useRef(showIncludes);
  showIncludesReference.current = showIncludes;
  const projectAttributesReference = useRef(projectAttributes);
  projectAttributesReference.current = projectAttributes;

  const handleReference = useRef<RenderWorkerHandle | null>(null);
  // Mirrors `engineFailed` for code that runs outside a render (the debounced render below), which
  // would otherwise read the value captured when its closure was created.
  const engineFailedReference = useRef(false);
  const requestIdReference = useRef(0);
  const debounceReference = useRef<MaxWaitDebounce | null>(null);
  if (debounceReference.current === null) {
    debounceReference.current = createMaxWaitDebounce(PREVIEW_DEBOUNCE_MS, PREVIEW_MAX_WAIT_MS);
  }
  /**
   * What the most recent SUCCESSFUL render of this document cost, and the only input the trailing
   * delay is derived from.
   *
   * A ref rather than state on purpose. This value changes on every render that completes, and the
   * only thing that reads it is the schedule — nothing on screen depends on it, so making it state
   * would re-run the debounce effects and re-render the panel for a number no reader can see. Held
   * here, each scheduled render reads whatever the latest measurement is at the moment it is
   * scheduled, which is exactly the moment the delay has to be chosen.
   *
   * Seeded `null` for the genuine gap before the first render completes: nothing has been measured,
   * which is not the same as a measurement of zero, and {@link adaptiveDelayMs} answers it with the
   * fixed delay. A FAILED render leaves it untouched for the same reason — it carries no figures, and
   * clearing it would make a document the author has just broken feel slower to preview until they
   * happened to fix it, on the strength of no measurement at all.
   */
  const lastSuccessfulRenderMsReference = useRef<number | null>(null);
  const previewReference = useRef<HTMLDivElement | null>(null);
  const outputReference = useRef<HTMLDivElement | null>(null);

  // Take a share of the shared render engine for as long as this hook is mounted.
  //
  // The engine is NOT this hook's to destroy: it is started once for the app and deliberately outlives
  // the panel, so that opening another file, switching preview formats or closing and reopening the
  // panel costs nothing rather than paying the engine's start-up again each time. Releasing the share
  // is the whole of the cleanup — the holder decides when, or whether, the worker itself goes away.
  useEffect(() => {
    const handle = acquireRenderWorker({
      onMessage: (event: MessageEvent<RenderResult>) => {
        const result = event.data;
        // Replies reach every consumer of the shared engine, so this guard does two jobs: discarding a
        // render this hook has superseded, and ignoring one it never asked for.
        if (result.requestId !== requestIdReference.current) return; // stale

        if (result.ok && result.html !== null) {
          // The one and only crossing from worker output to the screen. Same sanitizer, same profile,
          // same allow-list as before — it is asked for nodes rather than markup so that nothing
          // downstream ever parses this HTML again, which is also what keeps this the ONLY crossing:
          // there is no sanitized string in flight for another path to pick up and commit.
          const sanitized = DOMPurify.sanitize(result.html, {
            USE_PROFILES: { html: true },
            RETURN_DOM_FRAGMENT: true,
          });
          const { markup, nodes } = readMarkupFrom(sanitized);
          const output = outputReference.current;
          if (output !== null) {
            // Patch what is on screen into the shape of this render instead of replacing it, so the
            // work the client already did on the unchanged parts — diagrams drawn, expressions
            // typeset — and the reader's own position and focus all survive the refresh.
            morphPreview(output, nodes);
            // Only after a commit that actually happened. With no element attached there is nothing on
            // screen to have changed, and announcing one would send the passes that follow a commit
            // over a document that is not there.
            setRenderNonce((previous) => previous + 1);
          }
          setHtml(markup);
          // The worker gates this on the resolved `:stem:`; MathJax delimiters (`\(`, `\[`, `\$`) are
          // plain text and survive DOMPurify, so the sanitized HTML still carries the math to typeset.
          setMathPresent(result.mathPresent === true);
          // The `adc-diagram` placeholders survive DOMPurify (a plain div with data-* attributes), so
          // the sanitized HTML still carries the blocks the lazily-loaded engine will hydrate.
          setDiagramsPresent(result.diagramsPresent === true);
          // Only ever replaced by another successful render's figures — see `timings` on the result type.
          if (result.timings !== undefined) {
            setTimings(result.timings);
            // The same figures also decide how long the next refresh waits, so the schedule paces
            // itself by what this document actually costs instead of by one delay sized for the
            // worst document the editor might ever be given.
            lastSuccessfulRenderMsReference.current = result.timings.totalMs;
          }
          setError(null);
          setState('up-to-date');
        } else {
          setError(result.error);
          setState('error');
        }

        // The render this result belongs to has finished — a failure just as much as a success, since
        // both free the worker. Reporting it releases a refresh the max-wait cap held back rather than
        // starting a second render alongside this one; never reporting it would suppress that refresh
        // for the rest of the session. Reported LAST so the released refresh's own state transition is
        // applied after this result's, and only for a result that passed the staleness guard above: a
        // superseded result says nothing about the render that is actually in flight.
        debounceReference.current?.setInProgress(false);
      },
      onEngineFailed: () => {
        engineFailedReference.current = true;
        setEngineFailed(true);
        // Whatever render was in flight died with the engine, so nothing is left to report that it
        // finished. Saying so here is what stops the max-wait cap waiting forever on a render that no
        // longer exists — which would suppress every refresh even after the engine came back.
        debounceReference.current?.setInProgress(false);
      },
    });
    handleReference.current = handle;

    return () => {
      handle.release();
      handleReference.current = null;
    };
  }, []);

  /** Ask supervision for another engine after it gave up, and start listening for renders again. */
  const retryEngine = useCallback(() => {
    engineFailedReference.current = false;
    setEngineFailed(false);
    // The holder replays the render that was outstanding, so the preview catches up on its own rather
    // than waiting for the author to type something before it shows anything again.
    handleReference.current?.retry();
  }, []);

  // Shared debounce helper — captured in effects via closure over current content. Trailing debounce
  // derived from what this document's last render cost, with a PREVIEW_MAX_WAIT_MS cap so a sustained
  // edit still refreshes the preview. Only the trailing delay follows the measurement: the cap is a
  // promise about the burst as a whole and stays where it was set.
  const scheduleRender = (currentContent: string) => {
    debounceReference.current?.schedule(() => {
      requestIdReference.current += 1;
      setState('rendering');
      // When a main file is configured, assemble its include tree; the worker confines
      // every target via resolveSandboxedPath and renders the assembled document. Only assemble once
      // the root file's content is actually available — otherwise fall back to rendering `content`
      // (the open file = the main file here), so the preview never blanks while the tree loads.
      const mainFilePath = mainPathReference.current;
      const rootId = rootFileIdReference.current;
      const openId = openFileIdReference.current;
      // Always fetch files when any open file has an id (for assembly + scope), not only for main file.
      const needsFiles = openId !== undefined || mainFilePath !== undefined || (rootId != null);
      const files = needsFiles ? getFilesReference.current?.() : undefined;
      // Assemble rooted at the OPEN file for any file: the worker takes openFileId as the
      // root. Assembly runs when the open file's content is in the snapshot (even if it's not main).
      const canAssemble = openId !== undefined && files !== undefined && files[openId] !== undefined;
      // Resolve the inherited scope only when the open file is reachable in the snapshot AND is not
      // itself the root (the root's own attributes Asciidoctor parses from the source). The worker
      // still revalidates and falls back to standalone if these inputs are incomplete.
      const canResolveScope =
        rootId != null && openId !== undefined && openId !== rootId && files !== undefined && files[rootId] !== undefined;
      const handle = handleReference.current;
      handle?.post({
        requestId: requestIdReference.current,
        content: currentContent,
        imagesDir: imagesDirectoryReference.current,
        showIncludes: showIncludesReference.current,
        // The preview navigates by these: `revealLine` below looks the block up with
        // `[data-source-line="N"]`. Stated rather than left to the default, because the export sets it
        // the other way and the pair only makes sense read together.
        sourceLineHints: true,
        ...(projectAttributesReference.current ? { projectAttributes: projectAttributesReference.current } : {}),
        ...(canAssemble ? { files, openFileId: openId } : {}),
        ...(canResolveScope ? { rootFileId: rootId, openFileId: openId, files } : {}),
      } satisfies RenderRequest);
      // A render is now in flight, so the cap holds its next run back instead of stacking a second
      // render on this one. Only when an engine actually took the request: with none — before the
      // share is acquired, or after supervision gave up — nothing would ever report completion, and
      // the flag would suppress every later refresh permanently.
      if (handle !== null && !engineFailedReference.current) {
        debounceReference.current?.setInProgress(true);
      }
    }, adaptiveDelayMs(lastSuccessfulRenderMsReference.current));
  };

  // Handle isEnabled changes.
  useEffect(() => {
    if (!isEnabled) {
      debounceReference.current?.cancel();
      setState('idle');
      return;
    }
    if (!content) return;
    // Re-enabled with current content — start fresh render.
    setState('pending');
    scheduleRender(content);
  }, [isEnabled]);

  // Set when a file switch found the newly opened file's content not yet loaded, and cleared by the
  // content effect below when it arrives. See the file-switch effect for why that is the normal case.
  const openedFileAwaitingContentReference = useRef(false);

  // Debounce content changes.
  //
  // Deliberately WITHOUT a cleanup. React runs an effect's cleanup before every re-run, so cancelling
  // here would cancel on every keystroke — which clears the max-wait cap along with the trailing timer
  // and re-arms it from zero, so the cap could never elapse and the preview never refreshed during
  // sustained typing. It also bought nothing: schedule() already replaces the pending run and restarts
  // the trailing timer, which is all per-edit cancellation was ever achieving. Cancellation belongs to
  // unmount alone, below.
  useEffect(() => {
    if (!isEnabled || !content) return;
    setState('pending');
    scheduleRender(content);
    // This is the content of a file the reader has just opened, arriving after the switch that asked
    // for it. Nothing is being typed, so the trailing delay has nothing to absorb and would only make
    // the previous file's document sit on screen for half a second longer.
    if (openedFileAwaitingContentReference.current) {
      openedFileAwaitingContentReference.current = false;
      debounceReference.current?.flush();
    }
  }, [content]);

  // The previewed file at the last switch, so the effect below can tell an actual change of file from
  // its own first run. Starting it at the current value is what makes the mount pass a no-op: the file
  // that was open when the panel appeared is already being rendered by the effects above.
  const previewedFileReference = useRef(openFileId);

  // Opening a different file.
  //
  // Declared AFTER the content effect because a file switch changes `content` too, so both run in the
  // same commit and this one has to have the last word.
  useEffect(() => {
    if (previewedFileReference.current === openFileId) return;
    previewedFileReference.current = openFileId;

    // A document the reader has not seen starts at the top. Carrying the previous file's offset over
    // drops them at an arbitrary point in a different document.
    if (previewReference.current !== null) previewReference.current.scrollTop = 0;

    if (!isEnabled) return;
    if (!content) {
      // The usual case, not an edge one: the open file changes as soon as it is clicked, while its
      // content is still being fetched, so this effect almost always runs with nothing to render. That
      // is why the immediate render below is not enough on its own — without handing the switch on to
      // the content effect, the file the reader just opened would appear only after the full trailing
      // delay, which is exactly the wait this effect exists to avoid.
      openedFileAwaitingContentReference.current = true;
      return;
    }
    // Render at once instead of waiting out the trailing delay. That delay exists to absorb typing,
    // and opening a file is not typing: there is nothing still arriving to wait for, and waiting would
    // leave the previous file's document on screen for the whole delay with nothing explaining why.
    //
    // The previous file's rendering stays visible meanwhile, marked as rendering, rather than the panel
    // blanking — and the request-id guard discards whatever the previous file's render still owes us.
    scheduleRender(content);
    debounceReference.current?.flush();
  }, [openFileId]);

  // Drop any pending render when the hook goes away, so nothing fires into a torn-down component.
  useEffect(() => () => debounceReference.current?.cancel(), []);

  // Re-render when the assembled-main view is toggled on/off (the open file became, or stopped
  // being, the configured main file) so the preview switches between assembled and open-file modes,
  // and when the project main-file setting changes the resolution root (rootFileId) so an open CHILD
  // file re-resolves its inherited cross-document attribute scope under the new root with no document
  // edit — live re-resolution on main-file change for every open file. `filesVersion` bumps when a
  // reachable INCLUDED file changed (collaborator edit/save) with no open-file edit, so the assembled
  // preview picks up the fresh snapshot — the counterpart to the outline recomputing on that signal.
  useEffect(() => {
    if (!isEnabled || !content) return;
    scheduleRender(content);
  }, [mainPath, rootFileId, showIncludes, filesVersion, projectAttributes]);

  // Scroll to line when scrollToLine changes.
  useEffect(() => {
    if (!scrollToLine || !previewReference.current) return;
    const { line } = scrollToLine;

    // Match on the FILE as well as the line. The rendered document can span several files (an assembled
    // include tree), so a line number alone is ambiguous: the open file's line 5 and an included file's
    // line 5 are different places, and whichever happened to come first in the DOM won. That ambiguity is
    // what made clicking a line scroll to the wrong block — every element now states which file it came
    // from, so the candidates are restricted to the file the editor is actually showing.
    const openPath = openFileIdReference.current;
    // Scope only when THIS render actually carried file provenance. A single-file render states just the
    // line (there is only one file it could mean), so insisting on the attribute would match nothing and
    // silently stop scrolling — worse than the ambiguity being fixed.
    const scoped = openPath === undefined ? '' : `[data-source-file="${CSS.escape(openPath)}"]`;
    const scope =
      scoped !== '' && previewReference.current.querySelector(scoped) !== null ? scoped : '';
    let target = previewReference.current.querySelector<HTMLElement>(
      `${scope}[data-source-line="${line}"]`,
    );
    if (!target) {
      // Nearest preceding block in the SAME file: a click between blocks (a blank line, a line inside a
      // block's body) has no element of its own and should land on the block it belongs to.
      const all = previewReference.current.querySelectorAll<HTMLElement>(`${scope}[data-source-line]`);
      let best: HTMLElement | null = null;
      let bestLine = 0;
      for (const element of all) {
        const elementLine = Number(element.dataset['sourceLine']);
        if (elementLine <= line && elementLine > bestLine) {
          best = element;
          bestLine = elementLine;
        }
      }
      target = best;
    }
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [scrollToLine]);

  return {
    html,
    state,
    error,
    previewRef: previewReference,
    outputRef: outputReference,
    mathPresent,
    diagramsPresent,
    timings,
    engineFailed,
    retryEngine,
    renderNonce,
  };
}
