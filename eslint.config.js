const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const jsdoc = require('eslint-plugin-jsdoc');
const unicorn = require('eslint-plugin-unicorn').default;
const nextPlugin = require('@next/eslint-plugin-next');
const redos = require('eslint-plugin-redos');
const security = require('eslint-plugin-security');
const globals = require('globals');

module.exports = tseslint.config(
  // Design-sync working artifacts (also .gitignored): generated .jsx/CSS not part of any tsconfig
  // project, so linting them errors out. Keep in sync with the design-sync entries in .gitignore.
  { ignores: ['**/dist/**', '**/*.generated.ts', 'node_modules/**', '**/coverage/**', '**/*.js', '**/*.cjs', '**/*.mjs', '**/*.d.ts', '**/specs/**', '**/.next/**', '**/.next-dev/**', '**/next-env.d.ts', '**/prisma.config.ts', '**/scripts/**', '.claude/**', 'ds-bundle/**', '.ds-sync/**', '.design-sync/**'] },

  eslint.configs.recommended,

  ...tseslint.configs.recommended,

  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: {
      '@next/next': nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  jsdoc.configs['flat/recommended-typescript'],

  unicorn.configs['flat/recommended'],

  // ReDoS detection (recheck engine) — catches polynomial/exponential regex backtracking.
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: { redos },
    rules: { 'redos/no-vulnerable': 'error' },
  },

  // Security heuristics — high-signal subset only. The blunt heuristics below are disabled:
  // they lack taint tracking and fire on legitimate code (the filesystem store's own I/O, client
  // string compares, internally-built regexes). Semgrep's taint analysis covers real path-injection
  // with precision, and `redos` (recheck) is the authority on regex safety — so the weaker
  // `safe-regex`-based rules here are redundant.
  security.configs.recommended,
  {
    rules: {
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-possible-timing-attacks': 'off',
      'security/detect-non-literal-regexp': 'off',
      'security/detect-unsafe-regex': 'off',
    },
  },

  {
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.json',
          './packages/asciidoc-core/tsconfig.eslint.json',
          './packages/domain/tsconfig.eslint.json',
          './packages/shared/tsconfig.eslint.json',
          './packages/db/tsconfig.json',
          './packages/infrastructure/tsconfig.eslint.json',
          './packages/testing/tsconfig.json',
          './apps/api/tsconfig.eslint.json',
          './apps/collab/tsconfig.eslint.json',
          './apps/web/tsconfig.eslint.json',
        ],
        tsconfigRootDir: __dirname,
      },
    },
  },

  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-deprecated': 'error',
      'no-console': 'warn',

      'unicorn/filename-case': 'error',
      'unicorn/no-null': 'off',
      'unicorn/no-useless-undefined': 'off',
      'unicorn/prefer-module': 'off',
      'unicorn/prefer-node-protocol': 'off',
      'unicorn/prefer-top-level-await': 'off',
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/no-process-exit': 'off',

      'jsdoc/require-jsdoc': ['error', {
        publicOnly: true,
        require: {
          ClassDeclaration: true,
          ClassExpression: true,
          MethodDefinition: true,
          FunctionDeclaration: true,
          FunctionExpression: false,
          ArrowFunctionExpression: false,
        },
        contexts: [
          'TSInterfaceDeclaration',
          'TSTypeAliasDeclaration',
          'TSMethodSignature',
          'TSPropertySignature',
          'TSEnumDeclaration',
        ],
      }],
      'jsdoc/require-param': ['error', { checkConstructors: true }],
      'jsdoc/require-hyphen-before-param-description': ['error', 'always'],
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-returns-description': 'error',
      'jsdoc/require-throws': 'error',
      'jsdoc/sort-tags': ['error', {
        tagSequence: [
          { tags: ['param', 'returns', 'throws'] },
        ],
      }],
      'jsdoc/tag-lines': ['error', 'any', { startLines: 1 }],
      'jsdoc/require-description': 'error',
      'jsdoc/require-description-complete-sentence': 'error',
      'jsdoc/no-blank-blocks': 'error',
      'jsdoc/informative-docs': ['error', {
        uselessWords: [
          'a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'so', 'yet',
          'interface', 'type', 'class', 'hook', 'function', 'method',
          'handler', 'component', 'helper', 'utility', 'service', 'manager',
          'object', 'result',
        ],
      }],
      'jsdoc/check-tag-names': ['error', { definedTags: ['invariant'] }],
      'jsdoc/no-types': 'error',
    },
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    settings: {
      jsdoc: {
        contexts: [
          'TSInterfaceDeclaration',
          'TSTypeAliasDeclaration',
          'TSMethodSignature',
          'TSPropertySignature',
        ],
        definedTags: ['invariant'],
      },
    },
  },

  {
    files: ['**/*.tsx'],
    rules: {
      'unicorn/prevent-abbreviations': ['error', {
        checkProperties: false,
        allowList: {
          props: true,
          ref: true,
        },
        replacements: {
          // "AsciiDoc" is a brand name, not an abbreviation of "AsciiDocument"
          doc: false,
        },
      }],
    },
  },

  {
    files: ['**/components/ui/**'],
    rules: {
      'unicorn/filename-case': 'off',
      'jsdoc/require-jsdoc': 'off',
    },
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/tests/**/*.ts', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-description-complete-sentence': 'off',
      'jsdoc/informative-docs': 'off',
      'jsdoc/require-throws': 'off',
      'jsdoc/no-blank-blocks': 'off',
      'jsdoc/require-description': 'off',
      // Test doubles/fixtures intentionally use throwaway regexes on tiny literal inputs.
      'redos/no-vulnerable': 'off',
    },
  },

  // Import-boundary: the browser-only PDF leaf must stay inward-only. It may depend on the
  // shared asciidoc-core primitive and external libraries, but must NEVER reach outward into an
  // application/delivery package (web/api/collab) or any code under apps/ — app-specific wiring
  // (concrete assemblers, workers) is supplied by the app at its composition root, not imported
  // back into the environment-agnostic engine. Type-aware linting is owned by the package's own
  // tsconfig; here we only need syntactic import analysis, so the shared type-checked project set
  // (which does not list this package) is switched off to avoid a parse error.
  {
    files: ['packages/asciidoc-pdf/**/*.ts'],
    languageOptions: { parserOptions: { project: false } },
    rules: {
      '@typescript-eslint/no-deprecated': 'off',
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@asciidocollab/web', '@asciidocollab/api', '@asciidocollab/collab'],
            message:
              'The browser-only asciidoc-pdf leaf must not depend on an application package; wire app-specific code in the app at its composition root instead.',
          },
          {
            group: ['**/apps/*', '**/apps/*/**'],
            message:
              'The browser-only asciidoc-pdf leaf must not import application/delivery code under apps/; wire app-specific code in the app at its composition root instead.',
          },
        ],
      }],
    },
  },

  // The typed wasm/WASI bridge adapter is the single, deliberately-contained boundary where the
  // untyped `@ruby/wasm-wasi` + `@bjorn3/browser_wasi_shim` interop is reconciled to the package's
  // narrow internal types. Those `as unknown as ConstructorParameters<…>` reconciliations cannot be
  // expressed cast-free (the libraries expose structurally-wider opaque descriptors), so the global
  // no-assertions rule is relaxed HERE ONLY — every other source file in the leaf stays cast-free.
  {
    files: ['packages/asciidoc-pdf/src/vm/wasi-bridge.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
    },
  },

  // Import-boundary: the domain / application / infrastructure rings must never pull in the
  // browser-only PDF leaf. PDF rendering is a delivery-layer concern instantiated only inside the
  // web app; letting an inner ring import it would drag browser-only runtime into environment-
  // agnostic code and invert the inward-only dependency rule.
  {
    files: [
      'packages/domain/**/*.ts',
      'packages/shared/**/*.ts',
      'packages/infrastructure/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@asciidocollab/asciidoc-pdf', '@asciidocollab/asciidoc-pdf/**'],
            message:
              'The domain/application/infrastructure rings must not import the browser-only asciidoc-pdf leaf; PDF rendering is wired only in the web app.',
          },
          {
            group: ['**/asciidoc-pdf/src/**'],
            message:
              'The domain/application/infrastructure rings must not import the browser-only asciidoc-pdf leaf; PDF rendering is wired only in the web app.',
          },
        ],
      }],
    },
  },
);
