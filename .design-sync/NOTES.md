# design-sync notes — asciidocollab

Repo-specific gotchas for future syncs. Read this before re-running.

## Shape & setup
- **Not a packaged design system.** `@asciidocollab/web` is a Next.js *app* (`next build`, no `main`/`module`/`exports`). The DS is ~11 shadcn primitives in `apps/web/src/components/ui/`. This is a **synth-entry (package shape)** sync.
- **`--entry` is required.** In the DS's own repo there is no `node_modules/@asciidocollab/web`, so without `--entry` the build dies reading `node_modules/@asciidocollab/web/package.json`. We hand it a synthetic entry `apps/web/.ds-entry.ts` that `export *`s the ui primitives; the build walks up from it to `apps/web/package.json` and sets PKG_DIR=apps/web.
- **`--node-modules apps/web/node_modules`** — pnpm, non-hoisted; react/radix resolve there, NOT at repo root (repo root has no node_modules).
- **`cfg.tsconfig` is package-relative** → set to `"tsconfig.json"` (means `apps/web/tsconfig.json`). `apps/web/tsconfig.json` would wrongly resolve to `apps/web/apps/web/...`. esbuild also auto-discovers the adjacent tsconfig, so `@/lib/utilities` resolves either way, but keep it explicit.

## CSS (the styling)
- Tailwind v4 (`@import "tailwindcss"` + `@theme` in `apps/web/src/styles/globals.css`). Raw globals.css does NOT style anything — utilities must be compiled.
- **`apps/web/ds-compile-css.mjs`** compiles a static stylesheet: reads globals.css, injects `@source` globs for `./src/components/ui` + `../../.design-sync/previews`, runs it through `@tailwindcss/postcss`, writes `apps/web/ds-compiled.css`. `cfg.cssEntry` points at `ds-compiled.css` (bounded to PKG_DIR).
- The script lives in `apps/web/` so its bare `postcss`/`@tailwindcss/postcss` imports resolve `apps/web/node_modules`. Run from repo root: `node apps/web/ds-compile-css.mjs`.
- **Re-run `ds-compile-css.mjs` after authoring/changing previews** (so their utility classes land in the CSS) and before the final build.

## Playwright / render check
- Cached chromium build is **1223** (`~/.cache/ms-playwright/chromium-1223`). The matching Playwright is **1.60.0** (1.61.1 pins 1228 → would need a download). Install `playwright@1.60.0 playwright-core@1.60.0` into `.ds-sync` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` to reuse the cache.
- `browsers.json` is behind the package `exports` map — read it as a FILE, not `require()`.

## Known render warns
- Floor-card components render small PNGs (`[RENDER_BLANK]`) until their preview is authored — expected, not a failure.

## Re-sync risks
- `apps/web/.ds-entry.ts`, `apps/web/ds-compile-css.mjs`, `apps/web/ds-tailwind-input.css`, `apps/web/ds-compiled.css` are sync scaffolding committed under apps/web — keep them or the build/CSS breaks. If the ui/ component set changes, update `.ds-entry.ts` re-exports AND `componentSrcMap`.
- If the brand tokens in `globals.css` change, re-run `ds-compile-css.mjs`.
