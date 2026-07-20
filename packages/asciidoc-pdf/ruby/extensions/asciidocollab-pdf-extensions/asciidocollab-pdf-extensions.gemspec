# Local, pure-Ruby gem carrying the first-party Asciidoctor-PDF converter extensions.
#
# Each extension is an independently loadable file under lib/: plain Ruby that a project may enable
# per-project, loaded into the warm wasm VM between the shim block and the convert call. The same
# files must also be `-r`-able by the canonical asciidoctor-pdf CLI, because the reference PDFs the
# parity suite compares against are produced by that toolchain — an extension that only works inside
# our eval'd convert string could never be verified against the fidelity oracle.
#
# Two constraints follow from the runtime and bind every file here:
#
#   * Pure Ruby, no native extension. The wasm build fails closed on any `*.so`/`extconf.rb` in the
#     vendored tree, so this gem passes that gate by construction.
#   * Idempotent. The VM is warm and never torn down between renders, so a `prepend` that runs twice
#     corrupts every later render in that worker. Guard with an `ancestors.include?` check, the same
#     discipline the SOURCEMAP_SHIM already follows.
#
# ── Attribution ───────────────────────────────────────────────────────────────────────────────────
#
# Several extensions here are adapted from the converter-customisation recipes published in the
# Asciidoctor PDF documentation, principally its Extended Converter Use Cases page:
#
#   https://docs.asciidoctor.org/pdf-converter/latest/extend/use-cases/
#
# Those recipes are the upstream project's own worked examples of the hooks these files override —
# `allocate_toc`/`ink_toc` for per-chapter contents, `column_box` for multi-column regions,
# `convert_paragraph` for paragraph numbering. There is no
# packaged community gem carrying them; they exist as documentation examples, which is why each is
# re-implemented here rather than depended upon. Re-implementation is also forced by the two runtime
# constraints above: the upstream examples assume a fresh process per render and so carry no
# idempotency guard, and none of them ship a catalogue manifest or a parity fixture.
#
# Asciidoctor PDF is MIT-licensed (see `s.licenses` in its own gemspec, vendored under
# .wasm-build/vendor/); this repository is Apache-2.0. MIT permits the adaptation, and the two are
# compatible in this direction, but the MIT copyright and permission notice must be retained for the
# portions actually derived from upstream. So: where a file here is a close derivative of a published
# example, say so at the top of THAT file and reproduce the MIT notice there. A blanket note in this
# gemspec does not discharge that obligation for an individual file — it only records why the
# obligation exists and where the material came from.
Gem::Specification.new do |s|
  s.name        = "asciidocollab-pdf-extensions"
  s.version     = "0.0.0"
  s.summary     = "First-party Asciidoctor-PDF converter extensions selectable per project"
  s.authors     = ["asciidocollab"]
  # The gem as a whole follows the repository's licence; individual files adapted from the
  # MIT-licensed upstream examples carry their own notice, per the attribution note above.
  s.licenses    = ["Apache-2.0"]
  s.files       = Dir["lib/**/*.rb"]
  s.require_paths = ["lib"]
end
