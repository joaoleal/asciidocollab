/**
 * @file `@asciidocollab/asciidoc-pdf` — the browser-only leaf capability package that renders an
 * AsciiDoc project to a print-ready PDF entirely in the client via the real Asciidoctor-PDF Ruby
 * gem compiled to WebAssembly (CRuby `wasm32-wasip1`) inside a long-lived Web Worker.
 *
 * It houses the environment-agnostic engine: the worker message protocol, the warm-VM lifecycle,
 * the WASI VFS population contract, the pre-processing pipeline orchestrator (includes, citations,
 * diagrams, math, image guarding), and the Ruby convert invocation — all injected via interfaces so
 * they are unit-testable with in-memory fakes. The DOM-bound rendering shims and UI stay in the web
 * app, which supplies the concrete adapters at the composition root.
 *
 * This package depends inward on `@asciidocollab/asciidoc-core` only. It MUST NEVER be imported by
 * the domain, application, or infrastructure rings, nor may it import from any app — it is a
 * one-directional browser leaf.
 */
export * from './protocol';
export * from './ports/include-assembler';
export * from './ports/shim';
export * from './vm/wasi-bridge';
export * from './vm/ruby-pdf-vm';
export * from './vfs/populate';
export * from './cache/content-address';
export * from './pipeline/orchestrator';
export * from './pipeline/document-size-limit';
export * from './pipeline/stages/include-resolve';
export * from './pipeline/stages/citations';
export * from './pipeline/stages/diagrams-math';
export * from './pipeline/stages/image-guard';
export * from './pipeline/stages/mount-assets';
export * from './convert/invoke';
export * from './convert/normalize-pdf';
export * from './extensions/registry';
export * from './extensions/mount';
