"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { projectsApi } from "@/lib/api";
import type { Project } from "@/lib/api";
import { CLONE_IN_PROGRESS_CODE } from "@/lib/api/projects";
import { ApiError } from "@/lib/api/transport";

/**
 * Longest name the clone endpoint accepts. The suggestion is truncated to it as a whole, so a very
 * long source name cannot push the prefix past the limit and turn the pre-filled value into an
 * instant server-side rejection.
 */
const CLONE_NAME_MAX_LENGTH = 100;

const NAME_FIELD_ID = "clone-project-name";
const NAME_PROBLEM_ID = "clone-project-name-problem";

/** Said when the server offered no usable explanation of its own. */
const GENERIC_CLONE_FAILURE = "Failed to clone project.";

/** A refused copy, as it reaches whatever is still on screen once the dialog itself has gone. */
export interface CloneFailure {
  /** The sentence to show the user. */
  message: string;
  /**
   * The server's machine-readable refusal code, absent when the request never reached an answer it
   * could carry one in. A caller keeps its own notices truthful from this rather than by matching
   * the prose above, which is written for the reader and free to change.
   */
  code?: string;
}

/** Builds the pre-filled suggestion, capped so the whole string fits the server's maximum. */
function suggestCloneName(sourceName: string): string {
  return `Copy of ${sourceName}`.slice(0, CLONE_NAME_MAX_LENGTH);
}

/**
 * Turns a rejected clone request into the sentence shown in the dialog. The branch is chosen by the
 * machine-readable response code rather than the status text, so a reworded server message never
 * silently changes which advice the user gets. Codes the client has no better wording for fall
 * through to the server's own message.
 */
function cloneFailureMessage(caught: unknown): string {
  if (!(caught instanceof ApiError)) {
    return GENERIC_CLONE_FAILURE;
  }
  if (caught.code === CLONE_IN_PROGRESS_CODE) {
    return "A clone is already running. Wait for it to finish, then try again.";
  }
  if (caught.code === "RATE_LIMITED" || caught.status === 429) {
    return "You have started too many clones recently. Try again later.";
  }
  if (caught.code === "LIVE_CONTENT_UNAVAILABLE") {
    const path = caught.details?.path;
    const named = typeof path === "string" ? ` of ${path}` : "";
    return `Could not read the current content${named}. Nothing was copied — try again.`;
  }
  if (caught.code === "FORBIDDEN") {
    return "You no longer have access to that project.";
  }
  // The server's own wording is the last resort, and an empty one reaches here unchanged: the
  // transport preserves whatever the body carried. Substituting the generic sentence keeps the
  // dialog from dropping back to idle having explained nothing.
  return caught.message.trim().length > 0 ? caught.message : GENERIC_CLONE_FAILURE;
}

/**
 * Pairs that sentence with the code it was chosen from. The wording alone is enough for the dialog's
 * own message area, which is only ever read by a person, but a caller that outlives the dialog has
 * to decide later whether the refusal is still true — and the code is the only part of a refusal
 * that can be reasoned about instead of read.
 */
function describeCloneFailure(caught: unknown): CloneFailure {
  return {
    message: cloneFailureMessage(caught),
    code: caught instanceof ApiError ? caught.code : undefined,
  };
}

interface CloneProjectFormProperties {
  /** Points at the name field so the dialog can select its contents when it opens. */
  nameFieldReference: RefObject<HTMLInputElement | null>;
  /** Identifier of the project to copy. */
  projectId: string;
  /** Name of the project being copied, used to seed the suggestion. */
  projectName: string;
  /**
   * Asks the surrounding dialog to close, which the form does once the copy exists.
   *
   * @param open - The visibility being requested; the form only ever asks for `false`.
   */
  onOpenChange: (open: boolean) => void;
  /** Announces that a request has just been sent, superseding whatever the caller last reported. */
  onCloneStarted: () => void;
  /**
   * Receives the created copy so the caller can show it without a follow-up fetch.
   *
   * @param project - The project the server just created.
   */
  onCloned: (project: Project) => void;
  /**
   * Receives the explanation for a copy that failed after the dialog was already gone.
   *
   * @param failure - The sentence to show in the caller's own notice area, and the code it came from.
   */
  onCloneFailed: (failure: CloneFailure) => void;
}

/**
 * The dialog's interactive body. It lives in its own component so that Radix unmounting the portal
 * on close discards the typed name, the busy flag and any failure message — reopening then starts
 * from a fresh suggestion rather than from whatever the last attempt left behind.
 *
 * That same unmounting is why a failure has two destinations: the request outlives the form, so once
 * the form is gone its own message area is a place nobody can look, and the outcome has to be handed
 * back to the caller instead.
 */
function CloneProjectForm({
  nameFieldReference,
  projectId,
  projectName,
  onOpenChange,
  onCloneStarted,
  onCloned,
  onCloneFailed,
}: CloneProjectFormProperties) {
  const [name, setName] = useState(() => suggestCloneName(projectName));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Whether this form is still on screen. Dismissing the dialog mid-copy unmounts it while the
  // request carries on, and the failure branch below needs to know which of the two message
  // surfaces the user can still see.
  const onScreen = useRef(true);
  useEffect(() => {
    // Set on each setup so React StrictMode's setup→cleanup→setup (the dev default) leaves it true;
    // a mount-only cleanup would run once and never restore it, marking a live form as off screen.
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  const trimmedName = name.trim();
  const nameIsMissing = trimmedName.length === 0;
  const canSubmit = !nameIsMissing && !pending;

  const handleClone = async () => {
    if (!canSubmit) return;
    setPending(true);
    setFailure(null);
    onCloneStarted();
    try {
      const response = await projectsApi.clone(projectId, trimmedName);
      onCloned(response.data);
      if (!onScreen.current) {
        // Dismissed while the copy ran. The copy is real and the caller has to hear about it, but
        // this form no longer owns what is on screen: any dialog up now belongs to a later attempt,
        // and closing it would take that attempt's half-typed name with it.
        return;
      }
      onOpenChange(false);
    } catch (caughtError) {
      const failure = describeCloneFailure(caughtError);
      if (!onScreen.current) {
        // The user closed the dialog while the copy was running. Reporting into this form now would
        // write the only account of the failure into something nobody can see, so the caller — which
        // is still on screen — is told instead.
        onCloneFailed(failure);
        return;
      }
      // Deliberately leaves the typed name alone: the dialog stays open on the same attempt so the
      // user can fix the name or simply retry.
      setFailure(failure.message);
      setPending(false);
    }
  };

  return (
    <>
      <Dialog.Title className="text-lg font-semibold">Clone project</Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-muted-foreground">
        Creates an independent copy of <strong>{projectName}</strong> that you own. The original is
        left untouched.
      </Dialog.Description>

      <div className="mt-4 space-y-2">
        <Label htmlFor={NAME_FIELD_ID}>Name for the copy</Label>
        <Input
          id={NAME_FIELD_ID}
          ref={nameFieldReference}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={CLONE_NAME_MAX_LENGTH}
          autoComplete="off"
          disabled={pending}
          aria-invalid={nameIsMissing}
          aria-describedby={nameIsMissing ? NAME_PROBLEM_ID : undefined}
        />
        {nameIsMissing && (
          <p id={NAME_PROBLEM_ID} className="text-sm text-destructive">
            Enter a name for the copy.
          </p>
        )}
      </div>

      {pending && (
        // A live region, because nothing that appears here can be reached any other way: the button
        // that was pressed goes disabled and drops focus, the bar carries no text, and the sentence
        // below it — the only place the dismissal is explained — is never visited. Announcing
        // politely waits for the user to pause rather than cutting across them.
        <div role="status" className="mt-4 space-y-2">
          <div
            role="progressbar"
            aria-label="Cloning project"
            className="h-1 w-full overflow-hidden rounded-full bg-secondary"
          >
            {/* No aria-valuenow: the server reports no progress, so the bar is deliberately indeterminate. */}
            <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
          </div>
          {/* Says what leaving actually does. A copy already in flight cannot be called back — the
              server finishes it either way — so the way out is honest about being a dismissal and
              not an abort. */}
          <p className="text-xs text-muted-foreground">
            The copy will finish on its own. Closing this leaves it running.
          </p>
        </div>
      )}

      {failure && (
        <div role="alert" className="mt-3 rounded-md bg-destructive/10 p-2 text-sm text-destructive">
          {failure}
        </div>
      )}

      <div className="mt-6 flex justify-end gap-3">
        {/* Never disabled: a modal that blocks Escape and outside clicks is the only way out, and
            taking it away for the length of a copy would leave the user with no way out at all. */}
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {pending ? "Close" : "Cancel"}
        </Button>
        <Button onClick={handleClone} disabled={!canSubmit}>
          {pending ? "Cloning…" : "Clone"}
        </Button>
      </div>
    </>
  );
}

interface CloneProjectDialogProperties {
  /** Whether the dialog is currently shown. */
  open: boolean;
  /**
   * Called whenever the dialog asks to open or close, so the caller can track its visibility.
   *
   * @param open - The visibility being requested.
   */
  onOpenChange: (open: boolean) => void;
  /** Identifier of the project to copy. */
  projectId: string;
  /** Name of the project being copied, used to seed the suggestion. */
  projectName: string;
  /**
   * Announces that a request has just been sent, so the caller can retire whatever it is still
   * saying about an earlier attempt.
   */
  onCloneStarted: () => void;
  /**
   * Receives the created copy so the caller can show it without a follow-up fetch.
   *
   * @param project - The project the server just created.
   */
  onCloned: (project: Project) => void;
  /**
   * Receives the explanation for a copy that failed after the dialog was already dismissed, so the
   * caller can report it where the user is now.
   *
   * @param failure - The sentence to show in the caller's own notice area, and the code it came from.
   */
  onCloneFailed: (failure: CloneFailure) => void;
}

/**
 * Asks for a name and copies a project under it, keeping the user where they are: on success it
 * closes and hands the created project to its caller instead of navigating, and on failure it stays
 * open with the typed name intact and an explanation chosen from the server's error code — unless it
 * was dismissed while the copy ran, in which case the outcome only travels to the caller and the
 * dialog on screen, which belongs to a later attempt, is left alone.
 */
export function CloneProjectDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  onCloneStarted,
  onCloned,
  onCloneFailed,
}: CloneProjectDialogProperties) {
  const nameFieldReference = useRef<HTMLInputElement>(null);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-lg bg-background p-6 shadow-lg"
          // Stray clicks and stray Escapes never discard a half-typed name, in copy as in the
          // repository's other confirmation dialogs. The deliberate way out is the button below,
          // which stays enabled even mid-copy so this guard can never become a trap.
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            // Replace Radix's plain focus with focus-and-select, so the suggested name is highlighted
            // and the first keystroke replaces it rather than appending to it.
            event.preventDefault();
            nameFieldReference.current?.focus();
            nameFieldReference.current?.select();
          }}
        >
          <CloneProjectForm
            nameFieldReference={nameFieldReference}
            projectId={projectId}
            projectName={projectName}
            onOpenChange={onOpenChange}
            onCloneStarted={onCloneStarted}
            onCloned={onCloned}
            onCloneFailed={onCloneFailed}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
