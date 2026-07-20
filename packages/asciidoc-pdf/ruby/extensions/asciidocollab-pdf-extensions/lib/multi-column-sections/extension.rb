# frozen_string_literal: true

# Multi-column regions: renders a marked open block's content in two or more columns.
#
# Verified to need converter code before being built (FR-032a3 / FR-032d). The theme has exactly one
# column setting, `page.columns`, and it applies to the WHOLE DOCUMENT — there is no theme key that
# columnises one region and leaves the rest of the page single-column. So a marked region genuinely
# requires a converter hook.
#
# Targeted by block attribute rather than applied to whole sections, because a section's heading
# should span the full measure while its body is columnised; wrapping the section would pull the
# heading into the first column. An author marks the region they want columnised:
#
#   [.multi-column]
#   --
#   Content laid out in columns.
#   --
#
#   [.multi-column, columns=3]
#   --
#   Content laid out in three columns.
#   --
#
# == Constraints from the runtime
#
#   * IDEMPOTENT. The wasm VM is warm and never torn down between renders, so this file may be
#     required more than once per process; a second `prepend` would nest column boxes.
#   * PLAIN, `-r`-ABLE RUBY. The parity reference is produced by the canonical asciidoctor-pdf CLI
#     loading this same file with `-r`.
module AsciidocollabPdfExtensions
  module MultiColumnSections
    # This extension's catalogue id, as the manifest declares it. Pinned by a test, because a drift
    # between the two would leave the extension permanently disabled with nothing to show for it.
    EXTENSION_ID = 'multi-column-sections'

    # The role an author marks a block with.
    ROLE = 'multi-column'
    # Columns used when the author marks a block but does not say how many.
    DEFAULT_COLUMNS = 2
    # Upper bound. Beyond this the measure is too narrow for prose at any sensible font size, and the
    # result is unreadable rather than merely ugly — so this clamps instead of obeying.
    MAX_COLUMNS = 4
    # How many times the balanced column height may be re-measured before the region is drawn. Each
    # pass is a full conversion of the region's content in the scratch document, so this is a real
    # cost paid on every marked region; three is where the columns stop moving by a visible amount.
    REFINEMENTS = 3

    # Render a marked open block's content inside a column box.
    def convert_open node
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      return super unless _asciidocollab_multi_column? node

      columns = _asciidocollab_column_count node
      # `reflow_margins` keeps the columns inside the page margins on every page the block spans, and
      # the gap comes from the same `page.column-gap` key the document-wide setting uses, so a theme
      # styles both the same way.
      options = {
        columns: columns, width: bounds.width, reflow_margins: true,
        spacer: ((_asciidocollab_theme_value 'page_column_gap') || (_asciidocollab_theme_value 'index_column_gap')),
      }
      # NEVER open the box in a sliver of space at the foot of a page.
      #
      # A column box takes the room that is left, and when that is a couple of points it cannot fit a
      # single line. Prawn does not report this: the region renders as BLANK PAPER, with the prose
      # before and after it intact, and the paragraph numbers stepping straight over the content that
      # was silently dropped (11, then 13). It reached a user as "columns completely missing".
      #
      # This is why it stayed hidden: the cursor has to land within a line of the page foot exactly
      # where a region begins, so it depends on the theme's metrics, on what sits above the region,
      # and on which extensions shifted the pagination. The same document renders perfectly under the
      # default theme, and under the reference toolchain, whose font metrics put the cursor elsewhere.
      advance_page if cursor < (_asciidocollab_line_height * 2)

      origin = [bounds.left, cursor]
      plan = _asciidocollab_balance_plan node, columns, options
      # A region that ends on the page it began on is balanced by the box's own height. One that
      # spans pages cannot be: `reset_top` restores the full page height every time the box reaches
      # a new page, so a height given here would apply to the FIRST page only — which is the one
      # page that must stay full. Those regions carry the height on the box instead, and it is
      # installed at the moment the final page is entered.
      options[:height] = plan[:height] if plan && (plan[:at]).zero?
      # A FRESH point per call: `column_box` maps its origin to absolute coordinates in place, so
      # handing the same array to a second call translates it twice and draws the region above where
      # it belongs, on top of the preceding paragraph.
      ended_at = nil
      column_box origin.dup, **options do
        if plan && (plan[:at]) > 0
          bounds.asciidocollab_balance_at = plan[:at]
          bounds.asciidocollab_balance_height = plan[:height]
        end
        add_dest_for_block node if node.id
        _asciidocollab_ink_column_content node
        # Captured INSIDE the box. On the way out Prawn leaves the cursor at the box's foot, so by
        # the time `column_box` returns, where the content actually stopped is no longer knowable.
        ended_at = [bounds.current_column, y]
      end
      _asciidocollab_resume_below ended_at
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

    # Put the cursor back to where the content actually stopped, when the columns left room below it.
    #
    # A column box always leaves the cursor at its own foot, because that is where the last column
    # ends. For a region that filled its columns that is exactly right. For one whose final page used
    # only the FIRST column — every region that spans a page break and then stops early — it is the
    # bottom of the page, so everything after the region was pushed onto a fresh page and most of the
    # region's last page was left blank.
    #
    # Only safe when the first column is the one that ran out: if any later column was in use, every
    # column before it is full down to the foot, and the foot really is the bottom of the region.
    def _asciidocollab_resume_below ended_at
      return if ended_at.nil?
      column, content_y = ended_at
      return unless column == 0
      # Never downwards: moving the cursor DOWN here would silently drop content out of the page.
      self.y = content_y if content_y > y
    end

    # The block's own content, drawn identically by the measuring pass and the real one.
    #
    # Shared rather than duplicated because a difference between the two would be measured against
    # content that is not what gets inked, and the columns would divide at the wrong point.
    def _asciidocollab_ink_column_content node
      ink_caption node, labeled: false if node.title?
      traverse node
    end

    # How to balance the region's FINAL page, or nil to let the content flow naturally.
    #
    # A column box with no explicit height is as tall as the rest of the page, and Prawn fills one
    # column to the bottom before beginning the next. On every page but the last that is exactly
    # right. On the last it is not: the content runs out partway through, so the columns before it
    # stand full to the page foot while the one it stops in is half empty and the ones after it are
    # blank. A region short enough to fit one column is the extreme case of the same thing — EVERY
    # line lands in the first column and the rest of the region is white paper, which an author
    # reasonably reads as the extension not working at all.
    #
    # So the region is measured first, and the final page is given a column height equal to the
    # content's share of it. Returns `at`, the number of page transitions after which the box stands
    # on its final page, and `height`, the column height to give that page.
    #
    # The measurement flows the content through a REAL column box in the scratch document rather
    # than through `dry_run`. `dry_run` narrows its copy of the bounds to a single column
    # (`single_file`), which measures the total height correctly but destroys the very thing this
    # needs: which column the content stopped in, and on which page. That is also why the previous
    # version of this method could only balance a region shorter than one column — the single-file
    # flow spilled onto a second scratch page and `single_page?` gave up, leaving every taller
    # region ragged whether or not it spanned pages.
    def _asciidocollab_balance_plan node, columns, options
      return nil if scratch?
      return nil unless (natural = _asciidocollab_column_flow node, options)
      pages, last_column, last_cursor, last_height = natural
      return nil unless last_height && last_height > 0
      # What the content used on its final page: every column it passed through stands full, and the
      # one it stopped in is filled from the top down to where it stopped.
      used = ((last_column + 1) * last_height) - last_cursor
      return nil unless used > 0
      share = _asciidocollab_share used, columns
      # Nothing to gain once a share is as tall as the page — those columns already stand full.
      return nil if share >= last_height
      plan = nil
      candidate = { at: pages, height: share }
      # MEASURED TO A FIXPOINT, because one pass cannot get this right. A column is abandoned as soon
      # as the next paragraph will not fit, so a full column is not a full column's worth of text —
      # it holds whatever fits above that break, and the gap below it is dead space. Reading the
      # first pass literally therefore counts each abandoned column as full and overstates the
      # content, giving a first column still visibly deeper than the last. Re-measuring at the
      # candidate height shrinks the dead space and yields a truer share; two or three passes settle.
      REFINEMENTS.times do
        shape = _asciidocollab_column_flow node, options, candidate
        # VERIFIED, not merely computed. Content does not break at arbitrary heights: a line, an
        # image and a table are each atomic, so a share can leave the last column a line short and
        # push the region onto one page MORE than it needs. An extra page is a far worse regression
        # than a ragged foot — it is the failure this feature already shipped once — so a candidate
        # is adopted only once it has been shown to paginate exactly as the natural flow did.
        break if shape.nil? || shape[0] != pages
        plan = candidate
        refined = _asciidocollab_share (((shape[1] + 1) * shape[3]) - shape[2]), columns
        # Settled: another pass would move the columns by less than a line.
        break if refined >= candidate[:height] - _asciidocollab_line_height
        candidate = { at: pages, height: refined }
      end
      plan
    end

    # One column's share of a measured height, rounded up by a line.
    #
    # The extra line is deliberate slack: a box a fraction of a line too short pushes one line into a
    # further column, which is far more visible than a last column one line shorter than the rest.
    def _asciidocollab_share used, columns
      (used / columns.to_f) + _asciidocollab_line_height
    end

    # Flow the region's content through a column box in the scratch document and report where it
    # ended, as `[page transitions, column, cursor, column height]`.
    #
    # Runs on the scratch document rather than the real one so the measuring pass cannot move the
    # page the region is about to be drawn on. `scratch` is the same document `dry_run` measures in,
    # and it is a converter, so the region's own content hooks apply to it unchanged.
    def _asciidocollab_column_flow node, options, plan = nil
      scratch_pdf = scratch
      scratch_pdf.start_new_page layout: page.layout, margin: page_margin
      saved_bounds = scratch_pdf.bounds
      start_cursor = cursor
      box_options = plan && (plan[:at]).zero? ? (options.merge height: plan[:height]) : options
      shape = nil
      begin
        _asciidocollab_without_document_side_effects node.document do
          scratch_pdf.move_cursor_to start_cursor
          start_page = scratch_pdf.page_number
          # The scratch document carries its OWN font state, and every line break — so the whole
          # measurement — depends on it. Left unsynced it measures the region in whatever face and
          # size the scratch was last used with, and reports an end position the real render never
          # reaches: the columns then balance against a document that does not exist. `dry_run`
          # syncs the same four values for the same reason.
          scratch_pdf.font font_family, size: font_size, style: font_style do
            prev_font_scale, scratch_pdf.font_scale = scratch_pdf.font_scale, font_scale
            begin
              scratch_pdf.instance_exec do
                column_box [bounds.left, cursor], **box_options do
                  if plan && (plan[:at]) > 0
                    bounds.asciidocollab_balance_at = plan[:at]
                    bounds.asciidocollab_balance_height = plan[:height]
                  end
                  _asciidocollab_ink_column_content node
                  # Captured INSIDE the box, for the same reason the real pass captures it there: on
                  # the way out Prawn leaves the cursor at the box's foot.
                  shape = [(page_number - start_page), bounds.current_column, cursor, bounds.height]
                end
              end
            ensure
              scratch_pdf.font_scale = prev_font_scale
            end
          end
        end
      rescue ::StandardError
        # Balancing is cosmetic. A measuring pass that cannot complete must not take the render down
        # with it — the region still has a correct, if ragged, natural flow to fall back on.
        shape = nil
      ensure
        scratch_pdf.bounds = saved_bounds
      end
      shape
    end

    # Run a measuring pass without letting it leave anything behind on the document.
    #
    # A scratch conversion gets its own converter but shares the DOCUMENT, and converting a paragraph
    # applies inline substitutions — which register footnotes and bump counters as a side effect. So
    # measuring content that carries a `footnote:[]` registered it twice: the reader saw two
    # identical footnotes at the foot of the page and a reference pointing at the second one.
    #
    # Restored rather than suppressed, because the measuring pass genuinely needs the footnote laid
    # out — a paragraph carrying one is taller than the same paragraph without it, and measuring the
    # shorter version would divide the columns at the wrong point.
    #
    # Only the two pieces of state a conversion actually mutates are saved: the footnote catalogue
    # and the counters. Reference registration (`@catalog[:refs][id] ||=`) is already idempotent, and
    # everything else `register` touches is gated behind `catalog_assets`, which the render does not
    # set.
    def _asciidocollab_without_document_side_effects doc
      footnotes = doc.footnotes.dup
      counters = doc.counters.dup
      # `Document#counter` MIRRORS each value into the document attributes and increments from the
      # mirror, so restoring the counters alone leaves the measuring pass's value in place and the
      # real pass carries on from it — the footnote came out numbered 2 with no 1 anywhere.
      mirrored = {}
      counters.each_key { |name| mirrored[name] = doc.attributes[name] }
      yield
    ensure
      doc.footnotes.replace footnotes
      (doc.counters.keys - counters.keys).each { |name| doc.attributes.delete name }
      mirrored.each { |name, value| value.nil? ? (doc.attributes.delete name) : (doc.attributes[name] = value) }
      doc.counters.replace counters
    end

    # The height of one line of body text, used as the rounding slack above.
    def _asciidocollab_line_height
      line_height = (_asciidocollab_theme_value 'base_line_height') || 1
      (calc_line_metrics line_height).height
    rescue ::StandardError
      0
    end

    # Whether this block is marked for column layout.
    def _asciidocollab_multi_column? node
      # Nested column boxes are not supported by Prawn and produce a broken page rather than an
      # error, so a marked block inside a column box is rendered normally.
      return false if ::Asciidoctor::PDF::Converter::ColumnBox === bounds
      (node.role? ROLE) || (node.attr? ROLE)
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

    # Gives the region's final page a shorter column height, so its columns end level.
    #
    # Deliberately NOT gated on `_asciidocollab_extension_enabled?`, unlike every converter hook in
    # this gem. This is prepended onto `Prawn::Document::ColumnBox`, which the base converter also
    # uses (for the index), so it does run when this extension is disabled — but it is inert by
    # construction there. Both overrides act only on `@asciidocollab_balance_at` /
    # `@asciidocollab_balance_height`, which nothing but the gated `convert_open` path ever sets, so
    # with the extension off `reset_top` returns `super`'s value untouched and `single_file` nils two
    # already-nil ivars. Gating it would need the enabled check duplicated into a class that is not
    # ours, to buy nothing.
    #
    # Prepended to the column box rather than passed to it, because a column box does not keep the
    # height it was built with: `reset_top` restores the full page height every time the box reaches
    # a new page. A region that spans pages therefore has no way to say "this height, but only at
    # the end" other than to set it as that page is entered, which is what this does.
    module BalancedFinalPage
      # The number of page transitions after which this box stands on its final page, and the column
      # height to give that page. Both set by the converter once the flow has been measured.
      attr_accessor :asciidocollab_balance_at, :asciidocollab_balance_height

      def reset_top parent_ = @parent
        # `reset_top` RETURNS the new top, and a caller in asciidoctor-pdf assigns the document's
        # cursor from it, so the value has to survive.
        top = super
        entered = (@asciidocollab_pages_entered = (@asciidocollab_pages_entered || 0) + 1)
        if (at = @asciidocollab_balance_at) && entered == at && (height = @asciidocollab_balance_height)
          @height = height
        end
        top
      end

      # A single-file copy measures a DIFFERENT geometry — the whole region as one column — so a plan
      # computed for the real box does not describe it. Cleared rather than carried, because
      # `dry_run` dups the live bounds, and content nested inside the region dry-runs while the plan
      # is set; without this the copy would balance its own measuring pass and report a wrong extent.
      def single_file
        @asciidocollab_balance_at = @asciidocollab_balance_height = nil
        super
      end
    end

    # How many columns this block asks for, clamped to something readable.
    def _asciidocollab_column_count node
      declared = (node.attr 'columns', nil) || (node.attr ROLE, nil)
      count = declared.to_s.to_i
      return DEFAULT_COLUMNS if count < 2
      count > MAX_COLUMNS ? MAX_COLUMNS : count
    end
  end
end

# Idempotence guard: prepend once per process, however many times this file is required.
unless (Asciidoctor::PDF::Converter.ancestors.include? AsciidocollabPdfExtensions::MultiColumnSections)
  Asciidoctor::PDF::Converter.prepend AsciidocollabPdfExtensions::MultiColumnSections
end

# Prepended AFTER asciidoctor-pdf's own column-box patch, so that `super` reaches the `reset_top` and
# `single_file` this relies on — neither exists in stock Prawn.
unless (Prawn::Document::ColumnBox.ancestors.include? AsciidocollabPdfExtensions::MultiColumnSections::BalancedFinalPage)
  Prawn::Document::ColumnBox.prepend AsciidocollabPdfExtensions::MultiColumnSections::BalancedFinalPage
end
