# frozen_string_literal: true

# Per-chapter contents: a small contents list of a chapter's own subsections, at the start of that
# chapter, in addition to the document-level contents list.
#
# Verified absent from the base converter before being built (FR-032a3 / FR-032d): a book with `:toc:`
# renders exactly ONE document-level contents list, and no `toc.*` theme key produces a per-chapter
# one. `toclevels` changes the DEPTH of the single list, not the number of lists. So this genuinely
# needs converter code rather than theme settings.
#
# == Why this is not simply "ink a list after the title"
#
# `ink_toc_level` prints each entry's page number by reading its `pdf-page-start` attribute, which
# the converter sets when it CONVERTS that section. At the moment a chapter's title is inked, none of
# its subsections have been converted, so a mini contents list drawn there prints `?` for every page
# number — plausible-looking output that is entirely wrong.
#
# The base converter has the same problem for the document-level list and solves it with
# `allocate_toc`: dry-run the list to learn how tall it is, RESERVE that space, convert everything
# else, then go back and ink into the reserved space once the page numbers are known. This extension
# does the same thing per chapter, which is why it straddles two hooks:
#
#   * `ink_chapter_title` — called at exactly the right moment (after the chapter title, before its
#     content) to measure and reserve.
#   * `convert_section` — resumes after the chapter's content has been converted, which is the first
#     moment every subsection's page number exists, and inks into the space reserved above.
#
# Splitting it this way is not decoration: there is no single hook that runs both before the content
# and after it.
#
# == Constraints from the runtime
#
#   * IDEMPOTENT. The wasm VM is warm and never torn down between renders, so this file may be
#     required more than once per process. A second `prepend` would reserve and ink twice.
#   * PLAIN, `-r`-ABLE RUBY. The parity reference is produced by the canonical asciidoctor-pdf CLI
#     loading this same file with `-r`.
module AsciidocollabPdfExtensions
  module PerChapterContents
    # This extension's catalogue id, as the manifest declares it. Pinned by a test, because a drift
    # between the two would leave the extension permanently disabled with nothing to show for it.
    EXTENSION_ID = 'per-chapter-contents'

    # Depth of the per-chapter list, relative to the chapter. 1 covers the chapter's direct
    # subsections, which is what a chapter-opening list is for; deeper nesting reproduces the
    # document-level list inside every chapter.
    DEFAULT_LEVELS = 1

    # Reserve space for this chapter's contents list, immediately after its title.
    def ink_chapter_title node, title, opts = {}
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      super
      return unless _asciidocollab_chapter_toc? node

      entries = get_entries_for_toc node
      return if entries.empty?

      levels = _asciidocollab_chapter_toc_levels node

      # In a SCRATCH render, draw the list inline and stop.
      #
      # The converter renders into a scratch document in several places — `arrange_heading` measuring
      # whether a heading fits, and `allocate_toc` measuring the document-level list. Reserving pages
      # and calling `go_to_page` in those passes corrupts the page state of the real document: the
      # first version of this extension did exactly that, and produced a book whose document-level
      # contents list reported every entry as page 1 and whose chapters overlapped each other.
      #
      # Drawing inline here is not a fallback, it is the correct behaviour for a measuring pass — it
      # makes the chapter's measured height include its contents list, which is the only thing the
      # caller wants to know. Page numbers are not inked in scratch mode anyway.
      if scratch?
        theme_margin :toc, :top
        ink_toc_level entries, levels, _asciidocollab_dot_leader, 0
        theme_margin :block, :bottom
        return
      end

      # Measured with the SAME call that will later do the inking, so the reservation cannot drift
      # from what is drawn into it. `ink_toc_level` writes titles without page numbers during the dry
      # run, but still indents by the page-number placeholder width, so the height it reports is the
      # height the real pass needs.
      start_page = page_number
      start_cursor = cursor
      extent = dry_run onto: self do
        theme_margin :toc, :top
        ink_toc_level entries, levels, _asciidocollab_dot_leader, 0
        theme_margin :block, :bottom
      end

      # Reserve the measured space by walking past it, leaving the cursor where the chapter's content
      # should begin.
      extent.each_page {|first_page| start_new_page unless first_page }
      move_cursor_to extent.to.cursor

      (@asciidocollab_chapter_toc ||= {})[node.object_id] = {
        entries: entries,
        levels: levels,
        page: start_page,
        cursor: start_cursor,
      }
    end

    # After the chapter's content is converted — and only then are its subsections' page numbers
    # known — ink the contents list into the space reserved above.
    def convert_section sect, opts = {}
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      result = super
      reservation = @asciidocollab_chapter_toc&.delete sect.object_id
      return result if reservation.nil?

      # Where the chapter's content actually ended. BOTH of these have to be restored afterwards, and
      # missing either one corrupts the document in its own way:
      #
      #   * The PAGE, because Prawn's `start_new_page` inserts after the CURRENT page rather than
      #     appending — so returning to the wrong page makes the next chapter insert its pages into
      #     the middle of the document.
      #   * The CURSOR, because `go_to_page` resets `@y` to the top of the page. `start_new_chapter`
      #     is `start_new_page unless at_page_top?`, so coming back with the cursor at the top makes
      #     the next chapter believe it is already on a fresh page and draw straight over this one.
      #
      # Both were observed: the first version of this extension produced a book in which chapter two
      # was drawn on top of chapter one and the document-level contents list reported every entry as
      # page 1.
      return_page = page_number
      return_cursor = cursor
      pages_before = page_count

      go_to_page reservation[:page]
      move_cursor_to reservation[:cursor]
      theme_margin :toc, :top
      ink_toc_level reservation[:entries], reservation[:levels], _asciidocollab_dot_leader,
        _asciidocollab_front_matter_pages

      # Inking should fit the space reserved for it, but if it overflowed it pushed pages in ahead of
      # the content, so the page we came from has moved down by however many were added.
      go_to_page return_page + (page_count - pages_before)
      move_cursor_to return_cursor
      result
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

    # Whether this node should carry a contents list of its own.
    #
    # Opt-in per document via `:per-chapter-toc:`, and suppressible on one chapter with
    # `:per-chapter-toc: false`, so a preface or an appendix that reads badly with a list can drop it
    # without disabling the extension for the whole book.
    def _asciidocollab_chapter_toc? node
      return false unless node.context == :section
      return false unless node.sectname == 'chapter' ||
        (node.document.doctype == 'book' && node.level == 1)

      local = node.attr 'per-chapter-toc'
      return false if local.to_s == 'false'
      return true unless local.nil?
      (node.document.attr? 'per-chapter-toc') && (node.document.attr 'per-chapter-toc').to_s != 'false'
    end

    # How deep this chapter's list goes, as the ABSOLUTE document depth `ink_toc_level` expects.
    #
    # The author's setting is relative to the chapter — 1 means "this chapter's own subsections" —
    # but `ink_toc_level` compares its `num_levels` against each entry's absolute level, skipping any
    # entry whose `level + 1` exceeds it. Passing the relative depth straight through therefore
    # silently skips EVERY entry and draws an empty list into the reserved space, which is exactly
    # what the first version of this did: the chapter openings had a blank gap where the list should
    # be, with no error. So the chapter's own level is added here to convert one to the other.
    def _asciidocollab_chapter_toc_levels node
      declared = node.attr 'per-chapter-toclevels', (node.document.attr 'per-chapter-toclevels', nil)
      relative = declared.nil? ? DEFAULT_LEVELS : declared.to_i
      relative = DEFAULT_LEVELS if relative < 1
      node.level + relative
    end

    # Pages before page one, so this list's page numbers agree with the document-level list's and
    # with the numbers printed in the running footer.
    #
    # Without this the list prints PHYSICAL page numbers: a chapter whose footer reads "1" is listed
    # as being on page 3, because the cover and the contents pages are counted. The numbers look
    # entirely reasonable, which is what makes the mistake easy to ship.
    #
    # The converter's own `num_front_matter_pages` is a local variable in `convert_document`, so a
    # hook cannot read it. But it is used to set `@index.start_page_number` to
    # `num_front_matter_pages[1] + 1` immediately BEFORE the body is traversed — so by the time any
    # chapter converts, that attribute carries the same offset, and it is the only observable that
    # does.
    #
    # The one case where this is not exact is a document placing an explicit `toc::[]` macro in the
    # body, which reassigns `@index.start_page_number` as it converts. Such a document gets page
    # numbers offset by its front matter in chapters after the macro. Preferred to the alternative of
    # reaching into the converter's locals, and preferred to printing physical numbers for everyone.
    def _asciidocollab_front_matter_pages
      start = @index&.start_page_number
      start.nil? ? 0 : [start - 1, 0].max
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

    # The dot-leader description `ink_toc_level` expects.
    #
    # Built from the same `toc.dot-leader.*` theme keys the document-level list uses, so a book styles
    # both lists together rather than having to discover a parallel set of keys for this one.
    def _asciidocollab_dot_leader
      theme_font :toc do
        style = (_asciidocollab_theme_value 'toc_dot_leader_font_style')&.to_sym || :normal
        text = (_asciidocollab_theme_value 'toc_dot_leader_content') || '. '
        levels = _asciidocollab_theme_value 'toc_dot_leader_levels'
        spacer_size = @font_size * 0.25
        {
          font_color: (_asciidocollab_theme_value 'toc_dot_leader_font_color') || @font_color,
          font_style: style,
          font_size: (_asciidocollab_theme_value 'toc_dot_leader_font_size') || @font_size,
          levels: (levels == 'none' ? ::Set.new : (levels && levels != 'all' ? levels.to_s.split.map(&:to_i).to_set : nil)),
          text: text,
          width: text.empty? ? 0 : (rendered_width_of_string text),
          spacer: { text: ::Asciidoctor::PDF::Converter::NoBreakSpace, size: spacer_size },
          spacer_width: (rendered_width_of_char ::Asciidoctor::PDF::Converter::NoBreakSpace, size: spacer_size),
        }
      end
    end
  end
end

# Idempotence guard: prepend once per process, however many times this file is required.
unless (Asciidoctor::PDF::Converter.ancestors.include? AsciidocollabPdfExtensions::PerChapterContents)
  Asciidoctor::PDF::Converter.prepend AsciidocollabPdfExtensions::PerChapterContents
end
