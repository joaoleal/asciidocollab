# frozen_string_literal: true

# Title-block document details: a block of labelled document details on the title page, one per line.
#
#   = A Report
#   :doctype: book
#   :document-id: DOC-2026-0042
#   :classification: Internal
#   :title-block-details: Document ID=document-id, Classification=classification
#
# == The narrow scope, and why it is narrow
#
# Most of what this catalogue entry sounded like it should do is ALREADY achievable through theme
# settings, and under FR-032a3 that part must ship as theme settings rather than as code. Verified
# against the real toolchain:
#
#   title-page:
#     authors:
#       content:
#         with_email: '{author} — {organization}, {document-id}'
#
# `title-page.authors.content.*` is passed through `apply_subs_discretely` with
# `drop_lines_with_unresolved_attributes`, so ANY document attribute can be interpolated into the
# title block from the theme alone, and attributes the document does not set disappear cleanly.
#
# What is NOT reachable that way is LAYOUT. `ink_prose` is called with `normalize: true`, so a
# template spanning several lines collapses onto one; a YAML block scalar with real newlines, an
# AsciiDoc ` +` hard break and an inline `<br>` were each tried and each produced one run-on line
# (the last two rendering their markup literally). A formal cover page wants a details BLOCK — one
# labelled line per detail — and no combination of theme keys produces one.
#
# So this extension does exactly that and nothing more. **If you only need values interpolated onto a
# single line, use the theme key above and leave this disabled** — it exists for the multi-line case.
#
# == Constraints from the runtime
#
#   * IDEMPOTENT across renders — the wasm VM is warm and never torn down.
#   * The details are drawn inside `ink_title_page`, which the converter runs inside
#     `perform_on_single_page`. A details block long enough to overrun the page is therefore truncated
#     with the converter's own warning, exactly as an over-long title already is.
#   * PLAIN, `-r`-ABLE RUBY, so the parity reference can be produced by the canonical CLI.
module AsciidocollabPdfExtensions
  module TitleBlockDocumentDetails
    # This extension's catalogue id, as the manifest declares it. Pinned by a test, because a drift
    # between the two would leave the extension permanently disabled with nothing to show for it.
    EXTENSION_ID = 'title-block-document-details'

    # The document attribute listing which details to show.
    SPECIFICATION_ATTRIBUTE = 'title-block-details'
    # Separates one detail from the next.
    ENTRY_SEPARATOR = ','
    # Separates a label from the attribute name it reads.
    LABEL_SEPARATOR = '='

    # Draw the details block beneath the rest of the title page.
    def ink_title_page doc
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      super
      details = _asciidocollab_details doc
      return if details.empty?

      move_down (_asciidocollab_theme_value 'title_block_details_margin_top') || 12
      align = ((_asciidocollab_theme_value 'title_block_details_text_align') ||
        @theme.title_page_text_align || 'center').to_s.to_sym
      colour = _asciidocollab_theme_value 'title_block_details_font_color'

      theme_font :title_page do
        options = { align: align, margin: 0, normalize: false }
        options[:color] = colour.to_s.sub(/\A#/, '') unless colour.nil?
        details.each do |label, value|
          # The label is emphasised rather than the value: the value is the information, and bolding
          # it would make a page of details read as a page of headings.
          text = label.empty? ? value : %(<strong>#{label}:</strong> #{value})
          ink_prose text, options
        end
      end
    end

    private

    # Whether THIS render selected the extension identified by `id`.
    #
    # `Module#prepend` cannot be undone and the wasm VM is warm and never torn down, so sitting in
    # the converter's ancestor chain says only that SOME render in this session wanted this
    # extension — never that the current one does. Gating on being loaded therefore cannot express a
    # render that does not want it, which is what SC-015a (disabling returns the unextended document)
    # and FR-031b1 (preview the sample without one extension) both need. Every hook below asks this
    # first and defers to `super` when it is false, leaving the document exactly as the unextended
    # converter would have drawn it.
    #
    # THE ID IS AN ARGUMENT, AND MUST STAY ONE. Every extension in this gem prepends onto the SAME
    # class, so all nine copies of this method sit in one ancestor chain and a call finds whichever
    # copy is earliest — not the one lexically beside the caller. An earlier version read
    # `EXTENSION_ID` from the method body instead, which meant a hook could end up asking whether a
    # DIFFERENT extension was enabled and act on the answer. It failed exactly as quietly as that
    # implies: `narrow-contents` narrowed the contents list of a render that had only enabled
    # `per-chapter-contents`, because its gate resolved that extension's id. Passing the constant in
    # keeps the resolution lexical (at the call site, in the caller's own module) and makes all nine
    # copies genuinely interchangeable, which is what the duplication has always assumed.
    #
    # A nil set means "everything loaded is enabled". That is not a fallback for the application,
    # which always publishes a set (an empty array when it selected nothing); it is the canonical
    # `asciidoctor-pdf -r <file>` contract, where requiring a file IS the selection — and that is how
    # the parity references are produced from this very source.
    #
    # Defined identically in every extension in this gem, for the same reason
    # `_asciidocollab_theme_value` is: the registry mounts exactly ONE file per extension into the VM
    # (`/extensions/<origin>/<id>.rb`), so there is nowhere shared to put a helper without widening
    # the contract that confines each extension's code to a single deployment-controlled path.
    def _asciidocollab_extension_enabled? id
      enabled = $__asciidocollab_enabled_extensions
      enabled.nil? || (enabled.include? id)
    end

    # The label/value pairs to draw, in the order the author listed them.
    #
    # A detail whose attribute the document does not set is omitted rather than drawn empty, matching
    # how the converter's own templated content drops unresolved attributes.
    def _asciidocollab_details doc
      specification = (doc.attr SPECIFICATION_ATTRIBUTE, '').to_s
      return [] if specification.empty?

      specification.split(ENTRY_SEPARATOR).filter_map do |entry|
        label, _, name = entry.strip.rpartition LABEL_SEPARATOR
        name = name.strip
        next if name.empty?
        next unless doc.attr? name
        value = (doc.attr name).to_s
        next if value.empty?
        # `Label=attribute` gives an explicit label; a bare `attribute` gives none, so a detail can be
        # shown as a plain line when a label would only repeat what the value already says.
        [label.strip, value]
      end
    end

    # Read a theme key, tolerating a converter that does not expose the theme and a key that is unset.
    #
    # Defined identically in every extension in this gem. The duplication is deliberate and forced:
    # the registry mounts exactly ONE file per extension into the VM (`/extensions/<origin>/<id>.rb`),
    # so there is nowhere shared to put a helper without widening the contract that confines each
    # extension's code to a single deployment-controlled path. Reading `@theme` directly also works,
    # but fails differently depending on how the converter was constructed, so every theme read in
    # this gem goes through this one shape rather than each file inventing its own.
    def _asciidocollab_theme_value key
      theme = (respond_to? :theme) ? self.theme : nil
      return nil if theme.nil?
      theme.respond_to?(key) ? (theme.public_send key) : nil
    end
  end
end

# Idempotence guard: prepend once per process, however many times this file is required.
unless (Asciidoctor::PDF::Converter.ancestors.include? AsciidocollabPdfExtensions::TitleBlockDocumentDetails)
  Asciidoctor::PDF::Converter.prepend AsciidocollabPdfExtensions::TitleBlockDocumentDetails
end
