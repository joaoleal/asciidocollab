import {
  RENDER_PHASES,
  RENDER_ERROR_PHASES,
  DIAGNOSTIC_CODES,
  isProgressMessage,
  isResultMessage,
  isErrorMessage,
  isFatalPhase,
  isDiagnosticCode,
  type FromWorker,
  type RenderResult,
  type RenderError,
  type RenderRequest,
  type GeneratedAsset,
  type ProjectSnapshot,
} from '../src/protocol';

describe('render phase constants', () => {
  it('enumerates the worker→main phases in stage order', () => {
    expect([...RENDER_PHASES]).toEqual([
      'vm-init',
      'preprocessing',
      'citations',
      'diagrams-math',
      'converting',
      'optimizing',
      'done',
    ]);
  });

  it('is frozen so the ordered contract cannot be mutated at runtime', () => {
    expect(Object.isFrozen(RENDER_PHASES)).toBe(true);
  });

  it('enumerates only the phases where a whole-render failure is reported', () => {
    expect([...RENDER_ERROR_PHASES]).toEqual([
      'vm-init',
      'preprocessing',
      'convert',
      'read-output',
    ]);
    expect(Object.isFrozen(RENDER_ERROR_PHASES)).toBe(true);
  });

  it('enumerates every diagnostic code', () => {
    expect([...DIAGNOSTIC_CODES]).toEqual([
      'remote-skipped',
      'unsupported-image',
      'missing-glyph',
      'font-unavailable',
      'diagram-unsupported',
      'malformed-diagram',
      'malformed-math',
      'malformed-citation',
      'unresolved-include',
      'optimize-unavailable',
    ]);
    expect(Object.isFrozen(DIAGNOSTIC_CODES)).toBe(true);
  });
});

describe('FromWorker discriminant guards', () => {
  const progress: FromWorker = {
    type: 'progress',
    requestId: 'r1',
    phase: 'converting',
    pct: 42,
  };
  const result: FromWorker = {
    type: 'result',
    result: {
      requestId: 'r1',
      mode: 'export',
      pdf: {} as unknown as Blob,
      diagnostics: [],
      stats: { renderMs: 1, cacheHits: 0, rasterFallbacks: 0 },
    } satisfies RenderResult,
  };
  const error: FromWorker = {
    type: 'error',
    error: {
      requestId: 'r1',
      phase: 'convert',
      code: 'empty-root',
      message: 'no content to export',
    } satisfies RenderError,
  };

  it('isProgressMessage narrows only progress messages', () => {
    expect(isProgressMessage(progress)).toBe(true);
    expect(isProgressMessage(result)).toBe(false);
    expect(isProgressMessage(error)).toBe(false);
    if (isProgressMessage(progress)) {
      expect(progress.phase).toBe('converting');
    }
  });

  it('isResultMessage narrows only result messages', () => {
    expect(isResultMessage(result)).toBe(true);
    expect(isResultMessage(progress)).toBe(false);
    expect(isResultMessage(error)).toBe(false);
    if (isResultMessage(result)) {
      expect(result.result.mode).toBe('export');
    }
  });

  it('isErrorMessage narrows only error messages', () => {
    expect(isErrorMessage(error)).toBe(true);
    expect(isErrorMessage(progress)).toBe(false);
    expect(isErrorMessage(result)).toBe(false);
    if (isErrorMessage(error)) {
      expect(error.error.phase).toBe('convert');
    }
  });
});

describe('render request pre-seeded assets', () => {
  const snapshot: ProjectSnapshot = {
    files: { 'main.adoc': '= Doc' },
    binaryAssets: {},
    rootPath: 'main.adoc',
    openPath: 'main.adoc',
    fontPaths: [],
    attributes: {},
  };

  it('remains valid without any pre-seeded generated assets', () => {
    const request: RenderRequest = {
      requestId: 'r1',
      mode: 'export',
      snapshot,
      optimize: true,
    };
    expect(request.generatedAssets).toBeUndefined();
  });

  it('carries pre-seeded generated assets, each with derived alt text', () => {
    const asset: GeneratedAsset = {
      sourceHash: 'abc123',
      kind: 'diagram',
      format: 'svg',
      bytes: Uint8Array.of(1, 2, 3),
      rasterFallback: false,
      altText: 'sequence diagram of the login flow',
    };
    const request: RenderRequest = {
      requestId: 'r2',
      mode: 'preview',
      snapshot,
      optimize: false,
      generatedAssets: [asset],
    };
    expect(request.generatedAssets).toHaveLength(1);
    expect(request.generatedAssets?.[0]?.altText).toBe(
      'sequence diagram of the login flow',
    );
  });
});

describe('isFatalPhase', () => {
  it('accepts every phase that carries a fatal failure', () => {
    for (const phase of RENDER_ERROR_PHASES) {
      expect(isFatalPhase(phase)).toBe(true);
    }
  });

  it('rejects progress-only phases and unknown strings', () => {
    expect(isFatalPhase('converting')).toBe(false);
    expect(isFatalPhase('done')).toBe(false);
    expect(isFatalPhase('citations')).toBe(false);
    expect(isFatalPhase('not-a-phase')).toBe(false);
  });
});

describe('isDiagnosticCode', () => {
  it('accepts every enumerated code', () => {
    for (const code of DIAGNOSTIC_CODES) {
      expect(isDiagnosticCode(code)).toBe(true);
    }
  });

  it('rejects unknown codes', () => {
    expect(isDiagnosticCode('totally-made-up')).toBe(false);
    expect(isDiagnosticCode('')).toBe(false);
  });
});
