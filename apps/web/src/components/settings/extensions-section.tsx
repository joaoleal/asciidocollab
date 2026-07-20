'use client';

/**
 * @file The PDF Extensions section of the project options page: which PDF converter extensions this
 * project applies.
 *
 * The catalogue is fetched (the server merges the shipped set with the administrator's folder and
 * resolves what is still available); the SELECTION is part of the shared render-config draft, so
 * saving here sends the merged whole and cannot wipe the Rendering or PDF sections.
 *
 * Three things are surfaced rather than hidden, because each one is a state an author or an
 * administrator can only fix if they are told about it: an enabled extension that no longer exists
 * (FR-030), a manifest the server refused (FR-033d), and two sources claiming the same id (FR-033e).
 */
import { AlertTriangle, Package, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRenderConfigDraft } from '@/components/render-config-settings';
import { usePdfExtensions } from '@/hooks/use-pdf-extensions';

/** The PDF Extensions section of the project options page. */
export function ExtensionsSection(): React.JSX.Element {
  const { projectId, canEdit, saving, saved, error, loading, loaded, draft, set, save } =
    useRenderConfigDraft();
  const { catalogue, loading: catalogueLoading, error: catalogueError } = usePdfExtensions(projectId);

  if (loading || catalogueLoading) {
    return <p className="text-sm text-muted-foreground">Loading extensions…</p>;
  }

  // Same rule as the other sections: this Save sends the WHOLE config, not just the extension list,
  // so offering it over a draft that could not be read would erase everything else the project has.
  if (!loaded) {
    return (
      <div role="alert" className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">
        {error ?? 'Render options could not be loaded.'} Reload the page to try again — extensions
        are not shown here because saving them now would overwrite the settings already stored.
      </div>
    );
  }

  const enabled = draft.extensions?.enabled ?? [];
  const entries = catalogue?.entries ?? [];
  const available = entries.filter((entry) => entry.available);

  /** Enable or disable one extension in the shared draft, keeping the stored order deterministic. */
  function toggle(id: string, next: boolean): void {
    const updated = next
      ? [...new Set([...enabled, id])].toSorted((a, b) => a.localeCompare(b))
      : enabled.filter((candidate) => candidate !== id);
    // An empty selection is stored as no `extensions` key at all rather than an empty array, so a
    // project that never enabled anything carries nothing in its config.
    set('extensions', updated.length === 0 ? undefined : { enabled: updated });
  }

  return (
    <div className="space-y-6">
      {(error ?? catalogueError) !== null && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error ?? catalogueError}
        </div>
      )}
      {saved && (
        <div className="rounded-md border p-3 text-sm border-[hsl(var(--success-border))] bg-[hsl(var(--success-bg))] text-[hsl(var(--success))]">
          Extensions saved.
        </div>
      )}

      {catalogue !== null && catalogue.staleSelections.length > 0 && (
        <div
          role="status"
          className="space-y-1 rounded-md border p-3 text-sm border-[hsl(var(--warning-border))] bg-[hsl(var(--warning-bg))] text-[hsl(var(--warning))]"
        >
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            This project enables extensions this deployment no longer offers
          </p>
          <p>
            They are not applied. Ask an administrator to restore them, or remove them from this
            project.
          </p>
          {/*
            The control lives HERE, beside the names, rather than in the list below: an extension
            this deployment no longer offers has no entry in that list to untick — it is filtered out
            as unavailable — so the banner used to tell the reader to turn it off "below" and leave
            them nothing to do it with. Meanwhile the id stayed in the draft and was re-sent by every
            save, making the warning permanent.
          */}
          <ul className="space-y-1 pl-1">
            {catalogue.staleSelections.map((id) => (
              <li key={id} className="flex items-center gap-2">
                <code>{id}</code>
                {canEdit && (
                  <button
                    type="button"
                    className="underline underline-offset-2 disabled:no-underline disabled:opacity-60"
                    disabled={saving}
                    onClick={() => toggle(id, false)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <fieldset className="space-y-3" disabled={!canEdit || saving}>
        {available.length === 0 && (
          <p className="text-sm text-muted-foreground">
            This deployment offers no converter extensions. An administrator can add them to the
            extensions folder without rebuilding the application.
          </p>
        )}

        {available.map((entry) => {
          const { manifest } = entry;
          const isEnabled = enabled.includes(manifest.id);
          return (
            <label
              key={manifest.id}
              className="flex cursor-pointer gap-3 rounded-md border p-3 hover:bg-accent/30"
            >
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 rounded border-input"
                checked={isEnabled}
                onChange={(event) => toggle(manifest.id, event.target.checked)}
              />
              <span className="min-w-0 space-y-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{manifest.displayName}</span>
                  <span
                    className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs text-muted-foreground"
                    title={
                      entry.origin === 'shipped'
                        ? 'Ships with the application'
                        : 'Provided by an administrator of this deployment'
                    }
                  >
                    {entry.origin === 'shipped' ? (
                      <Package className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <Server className="h-3 w-3" aria-hidden="true" />
                    )}
                    {entry.origin === 'shipped' ? 'Built in' : 'Administrator'}
                  </span>
                </span>
                <span className="block text-sm text-muted-foreground">{manifest.description}</span>
                {manifest.targeting !== '' && (
                  // What the author WRITES to direct this extension. Without it, enabling an
                  // extension that only acts on marked content looks like it did nothing.
                  <span className="block text-xs text-muted-foreground">
                    Applies to content marked with <code>{manifest.targeting}</code>
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>

      {catalogue !== null && catalogue.conflicts.length > 0 && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p className="font-medium">Duplicate identifiers</p>
          <ul className="list-disc pl-5">
            {catalogue.conflicts.map((conflict) => (
              <li key={conflict.id}>
                <code>{conflict.id}</code> — {conflict.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {catalogue !== null && catalogue.excluded.length > 0 && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p className="font-medium">Not offered</p>
          <ul className="list-disc pl-5">
            {catalogue.excluded.map((exclusion) => (
              <li key={exclusion.source}>
                <code>{exclusion.source}</code> — {exclusion.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {canEdit && (
        <div className="flex justify-end">
          <Button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save extensions'}
          </Button>
        </div>
      )}
    </div>
  );
}
