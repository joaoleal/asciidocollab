/**
 * @file The include-resolve pre-processing stage — the first step in the pipeline. It pre-expands the
 * project's `include::` tree into a single sandbox-confined document through the injected
 * {@link IncludeAssembler} port (tag/line/leveloffset filters, conditional include-gating, and the
 * cycle/fan-out guards all live inside the assembler + shared core), writes that fully-inlined
 * document back into the `/project` VFS at the root path so the later Ruby convert sees ONE local
 * document, and turns every directive the assembler could not resolve into a clear, located
 * {@link RenderDiagnostic}. No include is ever silently omitted, and no diagnostic aborts the export.
 *
 * The concrete sandbox path-resolution policy is environment-specific (the web app owns it), so it is
 * injected through the {@link createIncludeResolveStage} factory rather than read off the shared
 * {@link StageContext} — the context intentionally carries no path policy. The worker composition root
 * supplies the concrete {@link IncludeAssembler} on the context and the {@link SandboxPathResolver} to
 * this factory, so this package never imports the web app.
 */

import type { DiagnosticCode, DiagnosticSeverity, RenderDiagnostic } from '../../protocol';
import type { SandboxPathResolver, UnresolvedInclude } from '../../ports/include-assembler';
import type { PipelineStage, StageContext, StageResult } from '../orchestrator';
import { PROJECT_ROOT, SOURCE_PROVENANCE_PATH } from '../../vfs/populate';

/** The environment-specific dependencies the include-resolve stage needs beyond the shared context. */
export interface IncludeResolveDeps {
  /**
   * The sandbox path-resolution policy, supplied by the composition root. It is threaded into the
   * injected assembler so every include target is confined to the project before it is read; this
   * package never encodes a path policy of its own.
   */
  readonly resolveSandboxedPath: SandboxPathResolver;
}

/** The stage's fixed position in the pipeline order. */
const STAGE_KIND = 'include-resolve';
/** Path segment separator for joining a project-relative key onto the VFS mount root. */
const VFS_SEPARATOR = '/';

/** Diagnostic code for a directive that points OUTSIDE the local sandbox and is intentionally skipped. */
const SANDBOX_ESCAPE_CODE: DiagnosticCode = 'remote-skipped';
/** Diagnostic code for an in-sandbox directive that could not be assembled. */
const UNRESOLVED_CODE: DiagnosticCode = 'unresolved-include';

/**
 * Rejection reasons that mean the target resolves OUTSIDE the local sandbox — a remote URL, an
 * absolute path, or a traversal escape. These are deliberate skips → {@link SANDBOX_ESCAPE_CODE}. Any
 * other reason (the target is in-sandbox but not found, or hit a cycle / depth / fan-out bound, or was
 * malformed) means the include could not be assembled → {@link UNRESOLVED_CODE}.
 */
const SANDBOX_ESCAPE_REASONS: ReadonlySet<string> = new Set(['remote', 'absolute', 'traversal']);

/** Join a validated project-relative root path onto the writable `/project` mount root. */
function projectVfsPath(rootPath: string): string {
  return `${PROJECT_ROOT}${VFS_SEPARATOR}${rootPath}`;
}

/** Map a single unresolved directive to a clear, located diagnostic — never a silent omission. */
function toDiagnostic(entry: UnresolvedInclude): RenderDiagnostic {
  const escapesSandbox = SANDBOX_ESCAPE_REASONS.has(entry.reason);
  const code: DiagnosticCode = escapesSandbox ? SANDBOX_ESCAPE_CODE : UNRESOLVED_CODE;
  const severity: DiagnosticSeverity = escapesSandbox ? 'warning' : 'error';
  const message = escapesSandbox
    ? `Skipped include "${entry.target}" referenced from "${entry.from}": it resolves outside the project sandbox (${entry.reason}).`
    : `Could not resolve include "${entry.target}" referenced from "${entry.from}" (${entry.reason}).`;
  return {
    severity,
    code,
    resource: entry.target,
    location: { path: entry.from },
    message,
  };
}

/**
 * Build the include-resolve stage over the injected sandbox path resolver. The stage expands the
 * root document's include tree via the context's {@link IncludeAssembler}, writes the single inlined
 * document into `/project`, and reports every unresolved directive as a diagnostic.
 */
export function createIncludeResolveStage(deps: IncludeResolveDeps): PipelineStage {
  return {
    kind: STAGE_KIND,
    run: (context: StageContext): Promise<StageResult> => {
      const { snapshot } = context.request;
      // Preview renders request the line→source provenance so the source-map hook can stamp each block's
      // exact origin file+line onto its map entry (click-to-source). Exports don't need it.
      const wantsProvenance = context.request.mode === 'preview';
      const assembled = context.includeAssembler.assemble({
        rootPath: snapshot.rootPath,
        readFile: context.readFile,
        resolveSandboxedPath: deps.resolveSandboxedPath,
        options: { seedAttributes: new Map(Object.entries(snapshot.attributes)), withSourceMap: wantsProvenance },
      });
      context.vfs.writeText(projectVfsPath(snapshot.rootPath), assembled.content);
      // Publish (or clear, for exports) the provenance sidecar. Always writing it — as `[]` when absent —
      // guarantees a warm VM never carries a prior preview's provenance into an export render.
      context.vfs.writeText(
        SOURCE_PROVENANCE_PATH,
        JSON.stringify(wantsProvenance && assembled.sourceMap ? assembled.sourceMap.lineToSource : []),
      );
      return Promise.resolve({ diagnostics: assembled.unresolved.map(toDiagnostic) });
    },
  };
}
