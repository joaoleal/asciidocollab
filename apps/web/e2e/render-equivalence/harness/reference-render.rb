# frozen_string_literal: true

# Converts the gate's assembled corpus sources with the canonical Asciidoctor, inside the pinned
# image, and reports what it converted.
#
# It is deliberately dumb. Every decision that belongs to the app — which attributes are in effect,
# how includes were assembled, which block styles the preview draws as diagrams — is made on the
# TypeScript side and arrives here as data, because a rule restated in Ruby is a rule that can drift
# away from the one the app actually applies, and the gate would then be comparing the app against a
# second implementation of itself.
#
# Given a work directory it converts every `*.adoc` in it and writes, per document:
#
#   <name>.html    the embedded HTML conversion
#   <name>.json    the verbatim blocks (listing and literal) in document order, each with the style
#                  the author declared and its source text
#
# The second file exists because the declared block style does not survive conversion. Asciidoctor
# with no diagram extension renders `[mermaid]\n----\n…\n----` as an ordinary listing block, and the
# word "mermaid" appears nowhere in its HTML — so the reference side of the diagram comparison
# cannot be built from the reference HTML alone. Reporting the parsed style here is what lets both
# sides be reduced to the same canonical diagram node without either side inventing the type.
#
# Usage: ruby reference-render.rb <work-dir>
#   <work-dir>/attributes.json — the API attributes the app renders with, applied unchanged

require 'asciidoctor'
require 'json'

work = ARGV[0]
abort 'usage: reference-render.rb <work-dir>' if work.nil? || work.empty?

attributes = JSON.parse(File.read(File.join(work, 'attributes.json')))

# Verbatim contexts, in the order a reader meets them. Both are reported because the two are
# interchangeable at the source level for the blocks this matters to: a diagram written with `----`
# parses as a listing and one written with `....` as a literal, and the preview treats them alike.
VERBATIM_CONTEXTS = %i[listing literal].freeze

Dir.glob(File.join(work, '*.adoc')).sort.each do |source_path|
  name = File.basename(source_path, '.adoc')

  # Loaded from the source STRING rather than the file, matching the app: `load_file` additionally
  # seeds `docfile`/`docdir`/`docname`, which the app's render never has.
  document = Asciidoctor.load(
    File.read(source_path),
    safe: :safe,
    standalone: false,
    sourcemap: true,
    attributes: attributes,
  )

  blocks = document.find_by { |block| VERBATIM_CONTEXTS.include? block.context }
  manifest = blocks.map do |block|
    { 'context' => block.context.to_s, 'style' => block.style.to_s, 'source' => block.source }
  end

  File.write(File.join(work, "#{name}.html"), document.convert)
  File.write(File.join(work, "#{name}.json"), JSON.pretty_generate(manifest))
end
