# frozen_string_literal: true

# Colophon placement: moves a `[colophon]` section to the back of the book and renders it as back
# matter — after every chapter, carrying no page number, and absent from the contents list.
#
#   [colophon]
#   == Colophon
#
#   This book was set in Noto Serif.
#
# == What is already native, and what is not
#
# `[colophon]` is a standard AsciiDoc section style and Asciidoctor-PDF already renders it — as an
# ordinary chapter, wherever the author wrote it, numbered and listed in the contents.
#
# So the part that is NOT achievable by other means is precisely the part this extension does.
# Reordering the source moves the section but leaves it a numbered chapter in the contents list; no
# theme key controls section placement or excludes a section from the contents. Being back matter —
# after the body, unnumbered, unlisted — is the whole content of the entry.
#
# Set `:colophon-placement: document` to keep the section exactly where it was written, which makes
# this extension inert for that document without having to disable it for the project.
#
# == Interaction with `auto-license-page`
#
# Both extensions draw a back-matter page from the same hook — the `:back` call to `ink_cover_page`,
# which is the only point that is after all body content and before the back cover. When both are
# enabled the order is deterministic, not incidental: the registry loads extensions by id, so
# `auto-license-page` is prepended before `colophon-placement`, which puts `colophon-placement`
# outermost in the ancestor chain. Its hook therefore runs first and the colophon precedes the
# licence page. Verified with both loaded together, and pinned by a parity fixture.
#
# They are separate extensions rather than one because they answer different questions — this one
# places a section the AUTHOR wrote, the other generates a page from metadata — and a project
# wanting a colophon usually does not want a generated licence page as well.
#
# == Constraints from the runtime
#
#   * IDEMPOTENT across renders — the wasm VM is warm and never torn down.
#   * Per-render state is reset when a document begins.
#   * PLAIN, `-r`-ABLE RUBY, so the parity reference can be produced by the canonical CLI.
module AsciidocollabPdfExtensions
  module ColophonPlacement
    # This extension's catalogue id, as the manifest declares it. Pinned by a test, because a drift
    # between the two would leave the extension permanently disabled with nothing to show for it.
    EXTENSION_ID = 'colophon-placement'

    # The section style this acts on.
    SECTION_NAME = 'colophon'
    # Attribute value that leaves the section where the author wrote it.
    IN_PLACE = 'document'

    # Where this page sits among the back-matter pages: before the licence page, which is the
    # conventional order — the colophon belongs with the book, the rights page after it.
    BACK_MATTER_RANK = 10

    # Reset per-document state, and register this page with the shared back-matter queue.
    #
    # == The back-matter protocol, and why it exists
    #
    # More than one extension draws a page from the `:back` call to `ink_cover_page` — it is the only
    # hook that is after all body content and before the back cover, so they necessarily share it.
    #
    # Doing the drawing IN that hook makes the page order depend on `prepend` nesting, and therefore
    # on the order the extensions were loaded. That was not a theoretical risk: loading this
    # extension and `auto-license-page` in the two possible orders produced two different documents,
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

      @asciidocollab_colophon = nil
      queue = (@asciidocollab_back_matter ||= [])
      queue << [BACK_MATTER_RANK, :_asciidocollab_ink_colophon] unless
        queue.any? { |rank, _| rank == BACK_MATTER_RANK }
      super
    end

    # Hold the colophon back rather than rendering it in place.
    def convert_section sect, opts = {}
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      return super unless _asciidocollab_deferred_colophon? sect

      @asciidocollab_colophon = sect
      # Hide it from the contents list. Emptying `numbered_title` is the converter's own idiom for
      # this — `ink_toc_level` skips an entry whose title is empty, and `convert_section` uses exactly
      # this trick to keep an empty index section out of the contents.
      sect.define_singleton_method :numbered_title, ->(*) { '' }
      nil
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

    # Whether this section is a colophon that should be moved to the back.
    def _asciidocollab_deferred_colophon? sect
      return false if scratch?
      return false unless sect.context == :section && sect.sectname == SECTION_NAME
      return false if @asciidocollab_colophon # only the first, so a second stays where it was written
      (sect.document.attr 'colophon-placement', '').to_s != IN_PLACE
    end

    # Draw the colophon as back matter.
    def _asciidocollab_ink_colophon _doc = nil
      sect = @asciidocollab_colophon
      return if sect.nil?
      @asciidocollab_colophon = nil

      start_new_page
      # The title is inked directly rather than through `convert_section`, which would re-enter the
      # hook above and hold the section back a second time.
      theme_font :heading, level: 2 do
        ink_general_heading sect, sect.title, align: (@theme.heading_h2_text_align&.to_sym || :left),
          level: 2, outdent: true
      end
      traverse sect
    end
  end
end

# Idempotence guard: prepend once per process, however many times this file is required.
unless (Asciidoctor::PDF::Converter.ancestors.include? AsciidocollabPdfExtensions::ColophonPlacement)
  Asciidoctor::PDF::Converter.prepend AsciidocollabPdfExtensions::ColophonPlacement
end
