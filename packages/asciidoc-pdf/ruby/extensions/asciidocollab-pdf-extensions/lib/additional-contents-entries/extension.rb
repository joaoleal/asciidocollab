# frozen_string_literal: true

# Additional contents entries: a List of Figures and a List of Tables, as their own lists after the
# main contents, each entry carrying the page its figure or table appears on.
#
#   = A Book
#   :doctype: book
#   :toc:
#   :list-of-figures:
#   :list-of-tables:
#
# Only captioned blocks are listed. A figure or table with no title has nothing to list it BY, so it
# is skipped rather than given a generated label an author never wrote and cannot search for.
#
# == Why this needs converter code
#
# There is no native equivalent: `get_entries_for_toc` returns `node.sections` and nothing else, and
# there is no `list_of` anything anywhere in the converter. No theme key generates a list.
#
# == How the page numbers come out right
#
# This is the part that decides the whole design. `ink_toc` is called TWICE:
#
#   1. Inside `allocate_toc`, in a dry run, purely to measure how much space the contents need.
#   2. For real, at the end of `convert_document` — crucially AFTER `traverse doc` has converted the
#      body, which is why the main contents list can print page numbers at all.
#
# Extending `ink_toc` therefore gets both halves for free: the dry run measures the extra lists and
# reserves pages for them, and the real pass runs at a point where every figure's page is already
# known. No reserve-then-backfill machinery is needed here, unlike `per-chapter-contents`, whose
# lists sit at the START of a chapter and so cannot wait for its content.
#
# The page numbers themselves come from a map this extension fills in as blocks convert, rather than
# from `pdf-page-start`: the converter sets that attribute on SECTIONS, not on image and table blocks,
# so reading it here would yield nothing for most entries.
#
# During the measuring pass that map is still empty, so entries are measured with a placeholder of
# the same digit width. The COUNT of entries is what determines the height, and that comes from
# `find_by` in both passes, so the measurement and the real inking agree.
#
# == Constraints from the runtime
#
#   * IDEMPOTENT across renders — the wasm VM is warm and never torn down.
#   * Per-render state is reset when a document begins, so a second render in the same VM does not
#     inherit the previous document's figures.
#   * PLAIN, `-r`-ABLE RUBY, so the parity reference can be produced by the canonical CLI.
module AsciidocollabPdfExtensions
  module AdditionalContentsEntries
    # This extension's catalogue id, as the manifest declares it. Pinned by a test, because a drift
    # between the two would leave the extension permanently disabled with nothing to show for it.
    EXTENSION_ID = 'additional-contents-entries'

    # The lists this extension can produce: the attribute that enables each, its heading, and the
    # block context whose captioned instances it lists.
    LISTS = [
      { attribute: 'list-of-figures', title: 'List of Figures', context: :image },
      { attribute: 'list-of-tables', title: 'List of Tables', context: :table },
    ].freeze

    # Width of the placeholder used while measuring, in digits. Three covers any document whose
    # figures do not run past page 999, and over-measuring by a digit costs nothing. Only a fallback:
    # `toc-max-pagenum-digits` is what the contents list uses, and these lists follow it.
    PLACEHOLDER_DIGITS = 3

    # Prefix of the ids assigned to captioned blocks that have none, so a list entry has somewhere to
    # link to. Namespaced so it cannot collide with an id an author wrote.
    SYNTHETIC_ID_PREFIX = '_asciidocollab-list-entry'

    # Reset per-document state so a warm VM does not carry one render's figures into the next.
    def convert_document doc
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      @asciidocollab_entry_pages = {}
      @asciidocollab_entry_sequence = 0
      super
    end

    # Record the page a captioned image lands on, and make sure it can be linked to.
    def convert_image node
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      _asciidocollab_prepare_entry node
      super
    end

    # Record the page a captioned table lands on, and make sure it can be linked to.
    def convert_table node
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      _asciidocollab_prepare_entry node
      super
    end

    # Correct a tracked entry's page to the one the converter actually anchors the block on.
    #
    # `_asciidocollab_prepare_entry` has to run BEFORE `super` — it assigns the synthetic id that
    # makes the block anchorable at all, and by the time `super` returns the converter has already
    # decided whether to register a destination. But the page it can see at that moment is only the
    # page the block is ABOUT to be drawn on, and something may still move it:
    #
    #   * `large-table-page-size` starts a fresh, wider page for a wide table, from its own
    #     `convert_table` wrapper. Both extensions prepend onto the same class, so whether that
    #     happens before or after the page is recorded is fixed by which module was `require`d first
    #     — in a warm VM, by the first render of the session rather than by this render's selection.
    #     One order cites the table's real page in the List of Tables, the other cites the page
    #     before it.
    #   * Pagination alone does it too, with no extension involved: a table that does not fit in the
    #     remaining space is drawn on the next page, and the entry pointed at the previous one.
    #
    # `add_dest_for_block` is where the converter anchors the block, which is by definition the page
    # the block starts on and after any such move. Recording there is both the fix for the ordering
    # defect and the fix for the plain pagination one, and it cannot itself be order-dependent: no
    # other extension touches this hook, and `page_number` reads the same either side of `super`.
    #
    # Only ever CORRECTS an entry already being tracked, so this stays confined to the blocks this
    # extension put in the map; and the eager record remains the fallback for any path that anchors
    # no destination.
    def add_dest_for_block node, id: nil, y: nil
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      result = super
      return result if scratch?

      pages = @asciidocollab_entry_pages
      pages[node.object_id] = page_number if pages&.key? node.object_id
      result
    end

    # Ink the extra lists after the main contents list.
    def ink_toc doc, num_levels, toc_page_number, start_cursor, num_front_matter_pages = 0
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      result = super
      lists = _asciidocollab_lists_for doc
      return result if lists.empty?

      # `super` ends with `go_to_page page_count` in the real pass, which would put these lists after
      # the whole body. The contents' own last page is where they belong, and `result` is the page
      # range super just inked, so its end is that page.
      go_to_page result.end unless scratch?
      # Drawn in whatever measure a contents list goes in, rather than in whatever measure `super`
      # happened to leave open — see `_asciidocollab_apply_contents_measure`.
      lists.each do |list|
        _asciidocollab_apply_contents_measure do
          _asciidocollab_ink_list list, num_front_matter_pages
        end
      end
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

    # Note which page a captioned block converted onto, and give it an anchor to link to.
    #
    # == Why an id is assigned here
    #
    # An entry in the contents list is clickable because the converter registered a PDF destination
    # for its section, and it did that because every section HAS an id — Asciidoctor generates one.
    # Image and table blocks do not: they only get an id when the author writes `[[figure-1]]`. So
    # `add_dest_for_block node if node.id` — which is what `convert_image` and `convert_table` both
    # call — does nothing for an ordinary captioned figure, and there is no destination for a list
    # entry to point at.
    #
    # Assigning an id BEFORE `super` lets the converter's own machinery register the destination, with
    # the geometry it would use for any other anchored block, rather than this extension computing a
    # position and getting `block-anchor-top` or a column offset subtly wrong.
    #
    # The id is a document-order counter rather than anything derived from the node, because a PDF
    # must be reproducible: `object_id` varies between runs and would change the file's bytes without
    # changing the document.
    def _asciidocollab_prepare_entry node
      return if scratch?
      return unless node.title?
      (@asciidocollab_entry_pages ||= {})[node.object_id] = page_number
      return unless node.id.nil? || node.id.empty?
      @asciidocollab_entry_sequence = (@asciidocollab_entry_sequence || 0) + 1
      node.id = %(#{SYNTHETIC_ID_PREFIX}-#{@asciidocollab_entry_sequence})
    end

    # The lists this document asks for that actually have entries.
    #
    # A list with no entries is omitted rather than drawn empty: a page reading "List of Tables" over
    # blank space tells a reader the document has tables somewhere they failed to find.
    def _asciidocollab_lists_for doc
      LISTS.filter_map do |list|
        next unless doc.attr? list[:attribute]
        entries = doc.find_by(context: list[:context]) { |node| node.title? }
        next if entries.nil? || entries.empty?
        list.merge(entries: entries)
      end
    end

    # Draw `block` in the measure a contents list goes in, whatever that is for this render.
    #
    # These lists sit BESIDE the document's contents list and a reader reads them as the same kind of
    # thing, so they have to follow the same measure. That measure is not this extension's to decide:
    # `narrow-contents` exists precisely to narrow it, and when both extensions are enabled a list of
    # figures at full page width beside a narrowed contents list is visibly wrong.
    #
    # The obvious way to get it — wrap `super` and let whatever `narrow-contents` opened still be in
    # scope — DOES NOT WORK, and the reason is worth stating because it is not visible from this file.
    # Both extensions prepend onto the same class, so which one wraps the other is fixed by which was
    # `require`d first; the VM is warm and never torn down, so that is decided by the first render of
    # the session rather than by this render's selection. One order draws these lists inside
    # `narrow-contents`'s `indent`, the other draws them after it has unwound — two different
    # documents from one selection, and nothing here can observe which one it is in.
    #
    # So the measure is ASKED FOR by name instead. Ordinary dispatch searches the whole ancestor chain
    # from the front, so it finds `narrow-contents`'s definition wherever that module sits, in either
    # order; and that definition is re-entrant, so the order where it has already opened an `indent`
    # around this call yields plainly rather than narrowing twice. Both orders draw one narrowing.
    #
    # The fallback is the point of the `respond_to?`: this extension must not require, or even
    # suggest, that `narrow-contents` is present. When nothing provides the protocol the measure is
    # the full page, which is exactly what these lists used before it existed. That is the dependency
    # pointing at the abstraction rather than at the other extension.
    def _asciidocollab_apply_contents_measure &block
      return _asciidocollab_contents_measure(&block) if respond_to? :_asciidocollab_contents_measure
      block.call
    end

    # Ink one list on a page of its own.
    #
    # The entry layout deliberately MIRRORS `ink_toc_level` rather than approximating it: the same
    # placeholder width, the same fragment-position walk to find where the caption's last line ends,
    # and the same dot leader drawn from the same `toc.dot-leader.*` theme settings. A reader sees
    # these lists beside the contents list, and a first version that simply floated a right-aligned
    # page number produced entries with no dots at all — visibly a different kind of list, and one
    # that stopped responding to the theme keys an author had already set for their contents.
    def _asciidocollab_ink_list list, num_front_matter_pages
      _asciidocollab_start_list_page
      theme_font_cascade [[:heading, level: 2], :toc_title] do
        ink_general_heading nil, list[:title], level: 2, outdent: true
      end

      dot_leader = _asciidocollab_dot_leader
      hanging_indent = (_asciidocollab_theme_value 'toc_hanging_indent').to_f
      line_metrics = calc_line_metrics @base_line_height

      theme_font :toc do
        toc_font = font
        # `@toc_max_pagenum_digits` is set from the `toc-max-pagenum-digits` attribute when the
        # document is set up, so the lists reserve the same width for a page number as the contents
        # list does and the two line up down the page.
        placeholder_width = rendered_width_of_string '0' * (@toc_max_pagenum_digits || PLACEHOLDER_DIGITS)
        list[:entries].each do |entry|
          _asciidocollab_ink_entry entry, num_front_matter_pages, dot_leader, hanging_indent,
            line_metrics, placeholder_width, toc_font
        end
      end
    end

    # Ink one entry: its caption, a dot leader, and the page it appears on.
    def _asciidocollab_ink_entry entry, num_front_matter_pages, dot_leader, hanging_indent,
        line_metrics, placeholder_width, toc_font
      # `captioned_title` carries the "Figure 1. " label the body prints, which is how a reader
      # matches a list entry to the figure itself. The caption is assigned during conversion, so in
      # the measuring pass it is still absent and the title alone is measured — that changes the
      # width of a line, never the NUMBER of lines, so the reservation still holds.
      title = (entry.respond_to? :captioned_title) ? entry.captioned_title : entry.title
      return if title.nil? || title.empty?

      # In the measuring pass only the title is drawn, exactly as `ink_toc_level` does: the page
      # numbers do not exist yet, and drawing dots to a placeholder would measure a line the real
      # pass never produces.
      if scratch?
        indent 0, placeholder_width do
          ink_prose title, normalize: false, hanging_indent: hanging_indent,
            normalize_line_height: true, margin: 0
        end
        return
      end

      label = _asciidocollab_page_label entry, num_front_matter_pages
      # Both the caption and the page number carry the anchor, exactly as a contents entry does, so a
      # reader can click either one. `pdf-anchor` is what the converter records when it registers the
      # destination; `id` is the fallback for a block that carried one of its own.
      anchor = (entry.attr 'pdf-anchor') || entry.id
      start_page_number = page_number
      start_cursor = cursor
      start_dots = nil

      indent 0, placeholder_width do
        inherited = { color: @font_color }
        inherited[:anchor] = anchor unless anchor.nil? || anchor.empty?
        fragments = text_formatter.format title, inherited: inherited
        positions = []
        fragments.each do |fragment|
          positions << (position = ::Asciidoctor::PDF::FormattedText::FragmentPositionRenderer.new)
          (fragment[:callback] ||= []) << position
        end
        typeset_formatted_text fragments, line_metrics, hanging_indent: hanging_indent,
          normalize_line_height: true
        # Where the caption's LAST line ends is where the dots begin, so a caption that wraps gets
        # its dots on the final line rather than running them from the right of the first.
        last = positions.select(&:page_number)[-1]
        unless last.nil?
          start_dots = last.right + hanging_indent
          last_cursor = last.top + line_metrics.padding_top
          if last.page_number > start_page_number || (start_cursor - last_cursor) > line_metrics.height
            start_cursor = last_cursor
          end
        end
      end
      return if start_dots.nil?

      end_cursor = cursor
      move_cursor_to start_cursor
      if dot_leader[:width] > 0
        label_width = rendered_width_of_string label
        label_settings = { color: @font_color, font: font_family, size: @font_size, styles: font_styles }
        label_settings[:anchor] = anchor unless anchor.nil? || anchor.empty?
        save_font do
          # The same font is used for dot leaders throughout, matching the contents list.
          set_font toc_font, dot_leader[:font_size]
          font_style dot_leader[:font_style]
          num_dots = [
            ((bounds.width - start_dots - dot_leader[:spacer_width] - label_width) / dot_leader[:width]).floor,
            0,
          ].max
          typeset_formatted_text [
            { text: dot_leader[:text] * num_dots, color: dot_leader[:font_color] },
            dot_leader[:spacer],
            ({ text: label }.merge label_settings),
          ], line_metrics, align: :right
        end
      else
        # `toc.dot-leader.content: ''` switches leaders off for the contents list; these lists honour
        # the same setting rather than drawing dots the author asked not to have.
        bare_label = { text: label, color: @font_color }
        bare_label[:anchor] = anchor unless anchor.nil? || anchor.empty?
        typeset_formatted_text [bare_label], line_metrics, align: :right
      end
      move_cursor_to end_cursor
    end

    # The dot leader these lists draw, built from the SAME `toc.dot-leader.*` theme settings the
    # contents list reads, so one set of theme keys styles all three lists.
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

    # Move to the page this list should start on.
    #
    # In the measuring pass a new page is simply started — it is a scratch document and the point is
    # only to count how much room the lists need. In the real pass those pages ALREADY EXIST, blank,
    # because the measuring pass caused `allocate_toc` to reserve them; so the cursor is moved onto
    # the next reserved page instead. Calling `start_new_page` there would insert a page rather than
    # use a reserved one, shifting every body page and invalidating the page numbers just inked into
    # the main contents list.
    def _asciidocollab_start_list_page
      if scratch?
        start_new_page
      else
        go_to_page page_number + 1
      end
    end

    # The page label for one entry, formatted exactly as the contents list formats its own.
    #
    # `num_front_matter_pages` is the converter's own count, handed down through `ink_toc`, so this
    # follows whatever the document actually resolved: `page-numbering-start-at` (cover, title, toc,
    # after-toc, body, or an explicit page number), whether the doctype produced a title page at all,
    # whether the contents sit at the top, and whether there is a front cover. Recomputing any of that
    # here would be a second implementation of a decision the converter has already made — and the one
    # place these lists sit beside the contents list is exactly where a disagreement would show.
    #
    # A page BEFORE the numbering start is labelled with a lowercase Roman numeral of its physical
    # position, which is what `ink_toc_level` does; an earlier version printed the physical arabic
    # number, so a figure in the front matter cited a page number that appears nowhere in the book.
    def _asciidocollab_page_label entry, num_front_matter_pages
      physical = (@asciidocollab_entry_pages || {})[entry.object_id]
      # Matches the contents list's own label for an entry whose page could not be determined, rather
      # than inventing a number that would look right and be wrong.
      return '?' if physical.nil?
      virtual = physical - num_front_matter_pages
      (virtual < 1 ? (::Asciidoctor::PDF::RomanNumeral.new physical, :lower) : virtual).to_s
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
unless (Asciidoctor::PDF::Converter.ancestors.include? AsciidocollabPdfExtensions::AdditionalContentsEntries)
  Asciidoctor::PDF::Converter.prepend AsciidocollabPdfExtensions::AdditionalContentsEntries
end
