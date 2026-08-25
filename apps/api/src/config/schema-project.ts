import type convict from 'convict';

/** Project-scoped rate limiting configuration. */
export interface ProjectConfig {
  /** Set-main-file rate limiting configuration. */
  mainFile: {
    /** Maximum set-main-file requests per user/IP per window. */
    rateLimitMax: number;
    /** Set-main-file rate limit window in milliseconds. */
    rateLimitWindow: number;
  };
  /**
   * Administrator-provided PDF converter extensions: where they live, and the bounds on reading them.
   *
   * `maxExtensions` and `maxSourceBytes` are what make the folder scan BOUNDED work rather than work
   * an outside party influences — the folder's contents are not under the application's control, so
   * without them a deployment could be slowed by dropping in a large or numerous set of files.
   * `scanCacheTtl` turns FR-033b's "takes effect without a redeployment" into a stated interval
   * rather than a vague promise, while keeping repeated catalogue reads cheap.
   */
  pdfExtensions: {
    /** Filesystem path of the administrator drop-folder (bind-mounted, outside the image). */
    path: string;
    /** Maximum catalogue entries read from the folder; beyond this the scan stops and reports. */
    maxExtensions: number;
    /** Maximum bytes of a single extension source; a larger file is excluded and reported. */
    maxSourceBytes: number;
    /** How long a folder scan is reused, in milliseconds. */
    scanCacheTtl: number;
    /** Maximum catalogue reads per user/IP per window. */
    rateLimitMax: number;
    /** Catalogue read rate limit window in milliseconds. */
    rateLimitWindow: number;
    /** Maximum extension-source reads per user/IP per window. */
    sourceRateLimitMax: number;
    /** Extension-source read rate limit window in milliseconds. */
    sourceRateLimitWindow: number;
  };
  /**
   * Project cloning rate limiting configuration. A clone copies a whole project
   * per request — the heaviest project operation in the system — so its budget
   * is deliberately the smallest of the project routes. The one-clone-at-a-time
   * guard bounds *concurrent* cost; this bounds *sustained* cost.
   */
  clone: {
    /** Maximum clone requests per user/IP per window. */
    rateLimitMax: number;
    /** Clone rate limit window in milliseconds. */
    rateLimitWindow: number;
  };
  /** Project render-config (get/save) rate limiting configuration. */
  renderConfig: {
    /** Maximum render-config requests per user/IP per window. */
    rateLimitMax: number;
    /** Render-config rate limit window in milliseconds. */
    rateLimitWindow: number;
  };
  /** Project owner-gated git-ignore-patterns (get/save) rate limiting configuration. */
  gitIgnorePatterns: {
    /** Maximum git-ignore-patterns requests per user/IP per window. */
    rateLimitMax: number;
    /** Git-ignore-patterns rate limit window in milliseconds. */
    rateLimitWindow: number;
  };
  /** Cross-file refactoring (find-usages/rename-symbol) rate limiting configuration. */
  refactoring: {
    /** Maximum refactoring requests per user/IP per window. */
    rateLimitMax: number;
    /** Refactoring rate limit window in milliseconds. */
    rateLimitWindow: number;
    /**
     * Maximum read-only symbol-usages requests per user/IP per window for the
     * proactive rename-suggestion detection path. Sized higher than the apply
     * budget because detection auto-fires as the author edits a symbol.
     */
    suggestionRateLimitMax: number;
    /** Detection (symbol-usages) rate limit window in milliseconds. */
    suggestionRateLimitWindow: number;
  };
  /** Collaborative-document-info read (GET .../files/:id/collab) rate limiting configuration. */
  fileContent: {
    /** Maximum collab-info read requests per user/IP per window. */
    rateLimitMax: number;
    /** Collab-info read rate limit window in milliseconds. */
    rateLimitWindow: number;
  };
  /**
   * Project-wide find/replace configuration. Search and replace both fan out
   * over every text-decodable file in the project, so both are rate-limited and
   * budget-bounded (mandatory for amplifying routes; user-supplied patterns are
   * untrusted input).
   */
  search: {
    /** Maximum project-wide search (read) requests per user/IP per window. */
    rateLimitMax: number;
    /** Search rate limit window in milliseconds. */
    rateLimitWindow: number;
    /** Maximum project-wide replace (write) requests per user/IP per window. */
    replaceRateLimitMax: number;
    /** Replace rate limit window in milliseconds. */
    replaceRateLimitWindow: number;
    /** Maximum matches returned to the client (the true total is still reported). */
    maxMatchesReturned: number;
    /** Maximum accepted search-pattern length (bounds a user-supplied regex). */
    maxPatternLength: number;
    /** Per-file match-evaluation time budget in milliseconds. */
    perFileTimeBudgetMs: number;
    /** Files larger than this (bytes) are skipped for match evaluation and reported. */
    maxFileBytes: number;
  };
  /**
   * Review comments/tasks (feature 038) rate limiting. Mutating routes (create,
   * reply, react, single delete, and — especially — bulk delete) are abuse-prone
   * or amplifying, so each is limited; the GET list/thread reads skip the limit
   * (cheap, tenant-scoped). Bulk delete is sized lowest as it is the most
   * destructive amplifying write.
   */
  review: {
    /** Maximum create/reply/convert/assign/status/reanchor requests per user/IP per window. */
    rateLimitMax: number;
    /** Review write rate limit window in milliseconds. */
    rateLimitWindow: number;
    /** Maximum reaction-toggle requests per user/IP per window (sized higher — cheap, high-frequency). */
    reactionRateLimitMax: number;
    /** Reaction-toggle rate limit window in milliseconds. */
    reactionRateLimitWindow: number;
    /** Maximum bulk-delete requests per user/IP per window (sized lowest — most destructive). */
    bulkDeleteRateLimitMax: number;
    /** Bulk-delete rate limit window in milliseconds. */
    bulkDeleteRateLimitWindow: number;
  };
}

/** Convict schema fragment for the project-scoped (main-file, refactoring) domain. */
export const projectSchema: convict.Schema<ProjectConfig> = {
  mainFile: {
    rateLimitMax: {
      doc: 'Maximum set-main-file requests per user/IP per window.',
      format: 'integer',
      default: 50,
      env: 'ASCIIDOCOLLAB_PROJECT_MAIN_FILE_RATE_LIMIT_MAX',
    },
    rateLimitWindow: {
      doc: 'Set-main-file rate limit window in milliseconds.',
      format: 'integer',
      default: 3_600_000,
      env: 'ASCIIDOCOLLAB_PROJECT_MAIN_FILE_RATE_LIMIT_WINDOW',
    },
  },
  pdfExtensions: {
    path: {
      doc: 'Directory administrators drop PDF converter extensions into. Bind-mounted from outside the image so an extension can be added without a rebuild.',
      format: String,
      default: '/data/pdf-extensions',
      env: 'ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_PATH',
    },
    maxExtensions: {
      doc: 'Maximum extensions read from the drop-folder. Beyond this the scan stops and reports what it excluded.',
      format: 'integer',
      default: 50,
      env: 'ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_MAX',
    },
    maxSourceBytes: {
      doc: 'Maximum bytes of a single extension source file (256 KiB). A larger file is excluded and reported.',
      format: 'integer',
      default: 262_144,
      env: 'ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_MAX_SOURCE_BYTES',
    },
    scanCacheTtl: {
      doc: 'How long a drop-folder scan is reused, in milliseconds. Bounds how long a newly added extension takes to appear.',
      format: 'integer',
      default: 30_000,
      env: 'ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_SCAN_CACHE_TTL',
    },
    rateLimitMax: {
      doc: 'Maximum extension-catalogue reads per user/IP per window.',
      format: 'integer',
      default: 120,
      env: 'ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_RATE_LIMIT_MAX',
    },
    rateLimitWindow: {
      doc: 'Extension-catalogue read rate limit window in milliseconds.',
      format: 'integer',
      default: 3_600_000,
      env: 'ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_RATE_LIMIT_WINDOW',
    },
    sourceRateLimitMax: {
      doc: 'Maximum extension-source reads per user/IP per window. Higher than the catalogue budget because a render fetches one source per enabled extension.',
      format: 'integer',
      default: 240,
      env: 'ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_SOURCE_RATE_LIMIT_MAX',
    },
    sourceRateLimitWindow: {
      doc: 'Extension-source read rate limit window in milliseconds.',
      format: 'integer',
      default: 3_600_000,
      env: 'ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_SOURCE_RATE_LIMIT_WINDOW',
    },
  },
  clone: {
    rateLimitMax: {
      doc: 'Maximum project-clone requests per user/IP per window. Sized below the refactoring budget: a clone copies an entire project.',
      format: 'integer',
      default: 20,
      env: 'ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_MAX',
    },
    rateLimitWindow: {
      doc: 'Project-clone rate limit window in milliseconds.',
      format: 'integer',
      default: 3_600_000,
      env: 'ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_WINDOW',
    },
  },
  renderConfig: {
    rateLimitMax: {
      doc: 'Maximum render-config (get/save) requests per user/IP per window.',
      format: 'integer',
      default: 120,
      env: 'ASCIIDOCOLLAB_PROJECT_RENDER_CONFIG_RATE_LIMIT_MAX',
    },
    rateLimitWindow: {
      doc: 'Render-config rate limit window in milliseconds.',
      format: 'integer',
      default: 3_600_000,
      env: 'ASCIIDOCOLLAB_PROJECT_RENDER_CONFIG_RATE_LIMIT_WINDOW',
    },
  },
  gitIgnorePatterns: {
    rateLimitMax: {
      doc: 'Maximum owner-gated git-ignore-patterns (get/save) requests per user/IP per window.',
      format: 'integer',
      default: 120,
      env: 'ASCIIDOCOLLAB_PROJECT_GIT_IGNORE_PATTERNS_RATE_LIMIT_MAX',
    },
    rateLimitWindow: {
      doc: 'Git-ignore-patterns rate limit window in milliseconds.',
      format: 'integer',
      default: 3_600_000,
      env: 'ASCIIDOCOLLAB_PROJECT_GIT_IGNORE_PATTERNS_RATE_LIMIT_WINDOW',
    },
  },
  refactoring: {
    rateLimitMax: {
      doc: 'Maximum cross-file refactoring requests (find-usages/rename-symbol) per user/IP per window.',
      format: 'integer',
      default: 60,
      env: 'ASCIIDOCOLLAB_PROJECT_REFACTORING_RATE_LIMIT_MAX',
    },
    rateLimitWindow: {
      doc: 'Refactoring rate limit window in milliseconds.',
      format: 'integer',
      default: 3_600_000,
      env: 'ASCIIDOCOLLAB_PROJECT_REFACTORING_RATE_LIMIT_WINDOW',
    },
    suggestionRateLimitMax: {
      doc: 'Maximum read-only symbol-usages (rename-suggestion detection) requests per user/IP per window.',
      format: 'integer',
      default: 600,
      env: 'ASCIIDOCOLLAB_PROJECT_REFACTORING_SUGGESTION_RATE_LIMIT_MAX',
    },
    suggestionRateLimitWindow: {
      doc: 'Rename-suggestion detection (symbol-usages) rate limit window in milliseconds.',
      format: 'integer',
      default: 3_600_000,
      env: 'ASCIIDOCOLLAB_PROJECT_REFACTORING_SUGGESTION_RATE_LIMIT_WINDOW',
    },
  },
  fileContent: {
    rateLimitMax: {
      doc: 'Maximum collaborative-document-info read requests per user/IP per window.',
      format: 'integer',
      default: 600,
      env: 'ASCIIDOCOLLAB_PROJECT_FILE_CONTENT_RATE_LIMIT_MAX',
    },
    rateLimitWindow: {
      doc: 'Collaborative-document-info read rate limit window in milliseconds.',
      format: 'integer',
      default: 3_600_000,
      env: 'ASCIIDOCOLLAB_PROJECT_FILE_CONTENT_RATE_LIMIT_WINDOW',
    },
  },
  search: {
    rateLimitMax: {
      doc: 'Maximum project-wide search (read) requests per user/IP per window.',
      format: 'integer',
      default: 120,
      env: 'ASCIIDOCOLLAB_PROJECT_SEARCH_RATE_LIMIT_MAX',
    },
    rateLimitWindow: {
      doc: 'Project-wide search rate limit window in milliseconds.',
      format: 'integer',
      default: 3_600_000,
      env: 'ASCIIDOCOLLAB_PROJECT_SEARCH_RATE_LIMIT_WINDOW',
    },
    replaceRateLimitMax: {
      doc: 'Maximum project-wide replace (write) requests per user/IP per window.',
      format: 'integer',
      default: 30,
      env: 'ASCIIDOCOLLAB_PROJECT_SEARCH_REPLACE_RATE_LIMIT_MAX',
    },
    replaceRateLimitWindow: {
      doc: 'Project-wide replace rate limit window in milliseconds.',
      format: 'integer',
      default: 3_600_000,
      env: 'ASCIIDOCOLLAB_PROJECT_SEARCH_REPLACE_RATE_LIMIT_WINDOW',
    },
    maxMatchesReturned: {
      doc: 'Maximum matches returned to the client (the true total is still reported).',
      format: 'integer',
      default: 1000,
      env: 'ASCIIDOCOLLAB_PROJECT_SEARCH_MAX_MATCHES_RETURNED',
    },
    maxPatternLength: {
      doc: 'Maximum accepted search-pattern length (bounds a user-supplied regex).',
      format: 'integer',
      default: 1000,
      env: 'ASCIIDOCOLLAB_PROJECT_SEARCH_MAX_PATTERN_LENGTH',
    },
    perFileTimeBudgetMs: {
      doc: 'Per-file match-evaluation time budget in milliseconds.',
      format: 'integer',
      default: 250,
      env: 'ASCIIDOCOLLAB_PROJECT_SEARCH_PER_FILE_TIME_BUDGET_MS',
    },
    maxFileBytes: {
      doc: 'Files larger than this (bytes) are skipped for match evaluation and reported.',
      format: 'integer',
      default: 2_000_000,
      env: 'ASCIIDOCOLLAB_PROJECT_SEARCH_MAX_FILE_BYTES',
    },
  },
  review: {
    rateLimitMax: {
      doc: 'Maximum review write (create/reply/convert/assign/status/reanchor) requests per user/IP per window.',
      format: 'integer',
      default: 240,
      env: 'ASCIIDOCOLLAB_PROJECT_REVIEW_RATE_LIMIT_MAX',
    },
    rateLimitWindow: {
      doc: 'Review write rate limit window in milliseconds.',
      format: 'integer',
      default: 3_600_000,
      env: 'ASCIIDOCOLLAB_PROJECT_REVIEW_RATE_LIMIT_WINDOW',
    },
    reactionRateLimitMax: {
      doc: 'Maximum reaction-toggle requests per user/IP per window.',
      format: 'integer',
      default: 600,
      env: 'ASCIIDOCOLLAB_PROJECT_REVIEW_REACTION_RATE_LIMIT_MAX',
    },
    reactionRateLimitWindow: {
      doc: 'Reaction-toggle rate limit window in milliseconds.',
      format: 'integer',
      default: 3_600_000,
      env: 'ASCIIDOCOLLAB_PROJECT_REVIEW_REACTION_RATE_LIMIT_WINDOW',
    },
    bulkDeleteRateLimitMax: {
      doc: 'Maximum bulk-delete requests per user/IP per window (most destructive amplifying write).',
      format: 'integer',
      default: 20,
      env: 'ASCIIDOCOLLAB_PROJECT_REVIEW_BULK_DELETE_RATE_LIMIT_MAX',
    },
    bulkDeleteRateLimitWindow: {
      doc: 'Bulk-delete rate limit window in milliseconds.',
      format: 'integer',
      default: 3_600_000,
      env: 'ASCIIDOCOLLAB_PROJECT_REVIEW_BULK_DELETE_RATE_LIMIT_WINDOW',
    },
  },
};
