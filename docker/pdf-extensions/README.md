# Administrator PDF extension folder

Drop an Asciidoctor-PDF converter extension in this directory and the deployment offers it to every
project, without rebuilding an image. Projects opt in individually; adding a file here never changes
what an existing project renders until someone enables it in that project's options.

This directory is bind-mounted read-only into the `api` service at the path
`ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_PATH` (default `/data/pdf-extensions`). The api serves the
catalogue and the extension source over its authenticated routes; nothing here is a public static
asset.

## These extensions carry the same trust as the application's own code

An extension placed here **runs inside every project member's browser, on the application's origin**,
with the same reach as the shipped code — including the JavaScript bridge the rendering VM exposes.
There is no sandbox between an extension and the session of the member previewing the document.

That is acceptable only because writing to this folder already requires control of the deployment:
anyone who can put a file here could equally change the served application. It is emphatically **not**
a place to put code from an untrusted source. Review an extension exactly as you would review a patch
to this repository.

This is also why projects cannot supply their own extensions. A `.rb` file in a project's file tree
is mounted as inert data and is never loaded.

## Adding an extension

1. Copy the `.rb` file into this directory.
2. Restart is not required — the api rescans on a short cache interval
   (`ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_SCAN_CACHE_TTL`).
3. Enable it per project under **Project options → Extensions**.

Each file declares its own manifest (id, display name, description, targeting markup, contributed
theme keys). A file whose manifest is malformed is excluded from the catalogue and reported rather
than failing the whole scan; two files declaring the same id are reported as a conflict.

Removing a file makes it unavailable. Projects that still have it enabled are shown the stale
selection rather than having it silently dropped.

## Constraints

- **Pure Ruby.** The renderer runs in a WASI sandbox with no compiler, no subprocess and no sockets.
- **Idempotent.** The rendering VM is warm and reused across renders, so a `prepend` that applies
  twice corrupts every later render in that worker. Guard with an `ancestors.include?` check.
- **`-r`-able by the canonical CLI**, so the extension can be verified against reference output.

## Debugging a misbehaving extension

The convert runs synchronously inside the worker (`vm.eval`, not `evalAsync` — see the comment in
`packages/asciidoc-pdf/src/convert/invoke.ts`). An extension that hangs therefore blocks the worker's
event loop entirely: it cannot process a cancel message, and the preview stalls rather than reporting
an error. If previews stop completing after you add an extension, remove the file and reload — that
is the fastest way to confirm which one is responsible.

Extension source is also documented in [`../../CONFIGURATION.md`](../../CONFIGURATION.md).
