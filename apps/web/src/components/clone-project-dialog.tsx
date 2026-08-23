"use client";

import { useRef, useState } from "react";
import type { RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { projectsApi } from "@/lib/api";
import type { Project } from "@/lib/api";
import { ApiError } from "@/lib/api/transport";

/**
 * Longest name the clone endpoint accepts. The suggestion is truncated to it as a whole, so a very
 * long source name cannot push the prefix past the limit and turn the pre-filled value into an
 * instant server-side rejection.
 */
const CLONE_NAME_MAX_LENGTH = 100;

const NAME_FIELD_ID = "clone-project-name";
const NAME_PROBLEM_ID = "clone-project-name-problem";

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
    return "Failed to clone project.";
  }
  if (caught.code === "CLONE_IN_PROGRESS") {
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
  return caught.message;
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
  /**
   * Receives the created copy so the caller can show it without a follow-up fetch.
   *
   * @param project - The project the server just created.
   */
  onCloned: (project: Project) => void;
}

/**
 * The dialog's interactive body. It lives in its own component so that Radix unmounting the portal
 * on close discards the typed name, the busy flag and any failure message — reopening then starts
 * from a fresh suggestion rather than from whatever the last attempt left behind.
 */
function CloneProjectForm({
  nameFieldReference,
  projectId,
  projectName,
  onOpenChange,
  onCloned,
}: CloneProjectFormProperties) {
  const [name, setName] = useState(() => suggestCloneName(projectName));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const trimmedName = name.trim();
  const nameIsMissing = trimmedName.length === 0;
  const canSubmit = !nameIsMissing && !pending;

  const handleClone = async () => {
    if (!canSubmit) return;
    setPending(true);
    setFailure(null);
    try {
      const response = await projectsApi.clone(projectId, trimmedName);
      onCloned(response.data);
      onOpenChange(false);
    } catch (caughtError) {
      // Deliberately leaves the typed name alone: the dialog stays open on the same attempt so the
      // user can fix the name or simply retry.
      setFailure(cloneFailureMessage(caughtError));
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
        <div
          role="progressbar"
          aria-label="Cloning project"
          className="mt-4 h-1 w-full overflow-hidden rounded-full bg-secondary"
        >
          {/* No aria-valuenow: the server reports no progress, so the bar is deliberately indeterminate. */}
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        </div>
      )}

      {failure && (
        <div role="alert" className="mt-3 rounded-md bg-destructive/10 p-2 text-sm text-destructive">
          {failure}
        </div>
      )}

      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
          Cancel
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
   * Receives the created copy so the caller can show it without a follow-up fetch.
   *
   * @param project - The project the server just created.
   */
  onCloned: (project: Project) => void;
}

/**
 * Asks for a name and copies a project under it, keeping the user where they are: on success it
 * closes and hands the created project to its caller instead of navigating, and on failure it stays
 * open with the typed name intact and an explanation chosen from the server's error code.
 */
export function CloneProjectDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  onCloned,
}: CloneProjectDialogProperties) {
  const nameFieldReference = useRef<HTMLInputElement>(null);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-lg bg-background p-6 shadow-lg"
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
            onCloned={onCloned}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
