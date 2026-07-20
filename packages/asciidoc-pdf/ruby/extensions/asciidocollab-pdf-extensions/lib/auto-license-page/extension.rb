# frozen_string_literal: true

# Automatic license page: builds a license and rights page from document attributes, so the text a
# publisher must carry is generated from metadata the document already holds rather than being
# retyped as prose in every document that needs it.
#
#   = A Book
#   :doctype: book
#   :license: Licensed under the Apache License, Version 2.0.
#   :copyright: 2026 The Authors
#   :publisher: Example Press
#   :edition: Second edition
#   :isbn: 978-0-000000-0-0
#
# Only `:license:` switches the page on. Every other attribute is optional and is omitted when
# absent, so a document carrying a licence and nothing else gets a page with just the licence on it.
#
# == Why this needs converter code
#
# There is no native equivalent: the string `license` does not appear anywhere in Asciidoctor-PDF's
# converter, and no theme key generates a page. The theme can only style what something else decides
# to draw.
#
# == Where the page goes, and why here
#
# After all body content, before the back cover. That placement is not a preference — it falls out of
# where the converter offers a usable hook:
#
#   * `ink_title_page` runs inside `perform_on_single_page`, so adding a page there trips the
#     converter's own truncation warning.
#   * Appending after `convert_document`'s work is too late: `ink_cover_page doc, :back` is one of the
#     last things it does, so the licence page would land AFTER the back cover.
#
# `ink_cover_page` is called exactly twice — once for each face — so intercepting the `:back` call and
# drawing before `super` is the one point that is both after the body and before the cover.
#
# The page deliberately carries no running header or footer: `ink_running_content` has already run by
# this point, which matches the convention for a rights page anyway.
#
# == Constraints from the runtime
#
#   * IDEMPOTENT across renders. The wasm VM is warm and never torn down.
#   * IDEMPOTENT within a render too, guarded separately: `ink_cover_page` is called for both faces,
#     and a future converter change could call it again.
#   * PLAIN, `-r`-ABLE RUBY, so the parity reference can be produced by the canonical CLI.
module AsciidocollabPdfExtensions
  module AutoLicensePage
    # This extension's catalogue id, as the manifest declares it. Pinned by a test, because a drift
    # between the two would leave the extension permanently disabled with nothing to show for it.
    EXTENSION_ID = 'auto-license-page'

    # The attribute that switches the page on.
    TRIGGER_ATTRIBUTE = 'license'

    # Attributes rendered beneath the licence text, in this order. Order is fixed rather than
    # following the document, so two documents carrying the same metadata produce the same page.
    DETAIL_ATTRIBUTES = %w[copyright publisher edition isbn].freeze

    # Where this page sits among the back-matter pages. See the protocol note below.
    BACK_MATTER_RANK = 20

    # Register this page with the shared back-matter queue.
    #
    # == The back-matter protocol, and why it exists
    #
    # More than one extension draws a page from the `:back` call to `ink_cover_page` — it is the only
    # hook that is after all body content and before the back cover, so they necessarily share it.
    #
    # Doing the drawing IN that hook makes the page order depend on `prepend` nesting, and therefore
    # on the order the extensions were loaded. That was not a theoretical risk: loading this
    # extension and `colophon-placement` in the two possible orders produced two different documents,
    # which SC-015b forbids.
    #
    # So drawing is separated from ordering. Every participating extension REGISTERS a ranked drawing
    # callback here, during `convert_document`, which runs before any body content and before any
    # cover hook — so by the time the first `:back` hook fires, every participant has registered.
    # That hook then flushes the whole queue in RANK order and consumes it. Whichever extension's
    # hook happens to run first draws everyone's pages, in an order none of them can influence.
    #
    # Ranks are spaced so a future back-matter extension can slot between two existing ones.
    def convert_document doc
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      queue = (@asciidocollab_back_matter ||= [])
      queue << [BACK_MATTER_RANK, :_asciidocollab_ink_license_page] unless
        queue.any? { |rank, _| rank == BACK_MATTER_RANK }
      super
    end

    # Flush the shared back-matter queue before the back cover is drawn.
    def ink_cover_page doc, face
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      _asciidocollab_flush_back_matter doc if face == :back
      super
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

    # Draw every registered back-matter page, in rank order, exactly once.
    #
    # Consuming the queue is what resets it: a second participant's hook finds nothing to do, and the
    # next render in this warm VM starts from an empty queue rather than inheriting this one's.
    # Defined identically in every extension that contributes a back-matter page — the registry mounts
    # one file per extension, so there is nowhere shared to put it.
    def _asciidocollab_flush_back_matter doc
      queue = @asciidocollab_back_matter
      return if queue.nil? || queue.empty?
      @asciidocollab_back_matter = nil
      # Go to the END of the document before drawing anything.
      #
      # Every participant draws with `start_new_page`, which INSERTS after the current page rather
      # than appending, so back matter lands wherever the cursor happens to have been left. Nothing
      # guarantees that is the last page: `additional-contents-entries` finishes its lists by walking
      # the cursor onto reserved pages near the FRONT of the book, and with both extensions enabled
      # the licence and colophon pages were inserted straight after the contents — before the body.
      #
      # Each extension was correct alone. This is the second composition defect this queue exists to
      # absorb (the first was page ORDER depending on load order), and the fix belongs here for the
      # same reason: no participant can know what the others left the cursor on.
      go_to_page page_count
      # Method NAMES, not Method objects: `dry_run` builds its scratch document with `Marshal`,
      # and a Method cannot be dumped — storing one here fails every render with
      # "no _dump_data is defined for class Method".
      queue.sort_by { |rank, _| rank }.each { |_, name| send name, doc }
    end

    # Draw the licence page, once.
    def _asciidocollab_ink_license_page doc
      return if @asciidocollab_license_page_drawn
      return unless doc.attr? TRIGGER_ATTRIBUTE
      licence = (doc.attr TRIGGER_ATTRIBUTE).to_s
      return if licence.empty?

      @asciidocollab_license_page_drawn = true
      start_new_page

      align = ((_asciidocollab_theme_value 'license_page_text_align') || 'left').to_s.to_sym
      colour = _asciidocollab_theme_value 'license_page_font_color'

      theme_font :base do
        options = { align: align, margin_bottom: (@theme.base_line_height_length || 12) }
        options[:color] = colour.to_s.sub(/\A#/, '') unless colour.nil?
        ink_prose licence, options
        DETAIL_ATTRIBUTES.each do |name|
          next unless doc.attr? name
          value = (doc.attr name).to_s
          next if value.empty?
          # `copyright` is the one that reads wrong bare — "2026 The Authors" is not a sentence — so
          # it gets the symbol every rights page carries. The rest stand on their own.
          text = name == 'copyright' ? %(© #{value}) : value
          ink_prose text, options
        end
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
unless (Asciidoctor::PDF::Converter.ancestors.include? AsciidocollabPdfExtensions::AutoLicensePage)
  Asciidoctor::PDF::Converter.prepend AsciidocollabPdfExtensions::AutoLicensePage
end
