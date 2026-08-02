// `asciidoctor` ships a complete set of type declarations but leaves the `types` condition out of the
// `exports` map in its `package.json`, so under `moduleResolution: bundler` (and node16) TypeScript
// resolves the module to JavaScript with no types at all and every call into the engine degrades to
// `any`. This points the compiler at the declarations the package already ships.
//
// It is deliberately a redirection to the REAL declarations rather than a hand-written surface. The
// render worker reads a dynamically shaped document tree — `findBy`, `getLineNumber`, `getStyle`,
// `getSource`, `getId`/`setId`, `getAttribute`, `getLevel`, `getContext`, `convert` — where a method
// renamed or made asynchronous by an engine upgrade is a silent behaviour change rather than a crash.
// Restating that surface here from memory would go on compiling after the engine stopped agreeing with
// it, which is the failure this file exists to prevent. Redirected, `load` carries the engine's own
// `Promise<Document>`, so every one of those calls is checked against the shipped declarations and a
// rename fails the build.
//
// Two forms that look equivalent and are not, so neither is worth rediscovering:
//
//   - `export { load } from '<relative path>'` inside an ambient module block declares the NAME but
//     types it `any`: a relative specifier there is resolved against the ambient module's name, not
//     against this file, so the redirection silently finds nothing. It compiles, and it restores
//     exactly the `any` this file exists to remove. The `typeof import(...)` form below is resolved
//     relative to this file and does carry the types.
//   - A `paths` entry in `tsconfig.json` types the import correctly and breaks the app: Next feeds
//     `compilerOptions.paths` to the bundler as module aliases, so mapping `asciidoctor` there points
//     the app's own imports at a declaration file at RUNTIME and the preview stops rendering. This
//     file is types-only and no bundler ever sees it.
//
// Only what the app imports is declared; importing anything else fails to compile, and the fix is to
// add a line here rather than to widen this into a hand-written stand-in. The path reaches into
// `node_modules` because the specifier the package exports cannot reach its own declarations — that is
// the defect being worked around. Delete this file when the package declares its types in `exports`;
// the import in the worker does not change either way.
declare module 'asciidoctor' {
  export const load: typeof import('../../node_modules/asciidoctor/types/index.js').load;
}
