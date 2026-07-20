# frozen_string_literal: true

# Paragraph numbering: prefixes each body paragraph with its sequential position in the document.
#
# Adapted from the Asciidoctor PDF "Extended Converter Use Cases" recipes.
#
# Three constraints shape this file, and all three come from the runtime rather than from taste:
#
#   * IDEMPOTENT. The wasm VM is warm and is never torn down between renders, so this file may be
#     required more than once in one process. A second `prepend` of the same module would wrap the
#     converter twice and number every paragraph twice, corrupting every later render in that worker.
#     The `ancestors.include?` guard is what prevents that.
#
#   * PLAIN, `-r`-ABLE RUBY. The reference PDFs the parity suite compares against are produced by the
#     canonical asciidoctor-pdf CLI, which loads this with `-r`. An extension that only worked inside
#     the app's eval'd convert string could never be verified against that oracle.
#
#   * NUMBERS ARE ASSIGNED PRE-RENDER AND NEVER PERSISTED. They are a function of document order at
#     render time, so inserting a paragraph renumbers everything after it. That is why the catalogue
#     entry warns against citing them across revisions: they are positions, not identifiers.
#
# Only document- and section-level paragraphs are numbered. A paragraph inside a table cell, an
# admonition, a sidebar or a list item is excluded — those read as part of their container, and
# numbering them produces a sequence an author cannot follow.
module AsciidocollabPdfExtensions
  module ParagraphNumbering
    # This extension's catalogue id, as the manifest declares it. Pinned by a test, because a drift
    # between the two would leave the extension permanently disabled with nothing to show for it.
    EXTENSION_ID = 'paragraph-numbering'

    # Blocks whose paragraph children are part of a larger unit rather than body prose.
    EXCLUDED_PARENT_CONTEXTS = %i[table_cell admonition sidebar example quote verse listing literal].freeze

    # Contexts whose direct paragraph children ARE body prose.
    #
    # `:preamble` is the one that is easy to miss and was missed: everything between the document
    # title and the first section heading is wrapped in a preamble block, so a document that opens
    # with prose had none of that prose numbered until it was included here.
    NUMBERED_PARENT_CONTEXTS = %i[document section preamble open].freeze

    # Default separation between a margin-placed number and the text it belongs to.
    DEFAULT_MARGIN_GAP = 6

    # Numbers each qualifying paragraph in document order.
    def convert_paragraph node
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      return super unless _asciidocollab_numbered? node

      counter = _asciidocollab_number_for node

      if _asciidocollab_margin_placement?
        if scratch?
          # The scratch pass measures the paragraph's HEIGHT, and a number in the margin does not
          # affect it. Skipping the draw there also keeps the number off the scratch page, where it
          # would be measured as content and widen nothing but the caller's idea of the extent.
          #
          # But ONLY when the number will actually go in the margin. A number that falls back to
          # inline is in the flow and does change the height, so a measuring pass that skipped it
          # measures a paragraph shorter than the one that gets drawn. That gap is invisible until
          # something divides the content by its measured height: with page margins too narrow to
          # hold a number, every paragraph fell back to inline and the multi-column balancer divided
          # a total that was short by one prefix per paragraph — level columns became 70/100.
          return super if _asciidocollab_margin_number_fits? counter
        elsif _asciidocollab_ink_margin_number counter
          return super
        end
        # Fell through: the slot was too narrow to hold the number without overwriting the text
        # beside it. Numbering inline is worse-looking than the margin but still readable, where a
        # clipped number is neither.
      end

      colour = (_asciidocollab_theme_colour 'paragraph_numbering_font_color') || '999999'
      # Wrapped in a `+++` inline passthrough. Without it the markup goes through Asciidoctor's
      # special-characters substitution and the reader sees a literal `<font color="…">` in the PDF —
      # the prefix is inserted into the SOURCE lines, so it is subject to the same substitutions as
      # anything else the author wrote. `font` is one of the tags Asciidoctor-PDF's formatted-text
      # parser accepts; prawn's own `<color>` is NOT, and fails the parse.
      prefix = %(+++<font color="##{colour}">#{counter}.</font>+++&#160;)
      # Prepended to the source lines rather than drawn separately so the number participates in
      # normal inline layout — it wraps, aligns and hyphenates with the paragraph it belongs to.
      numbered = node.dup
      numbered.lines = ([%(#{prefix}#{node.lines.first})] + node.lines.drop(1))
      super numbered
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

    # Whether numbers go beside the text rather than inside it. Margin is the DEFAULT.
    #
    # A number that prefixes the first line indents it and reflows the paragraph around it, which is
    # the thing marginal numbering exists to avoid. So `inline` is the opt-OUT, taken when a theme
    # asks for it by name, or automatically when a slot is too narrow to hold the number.
    #
    # The property that makes margin safe as a default is that it is LAYOUT-NEUTRAL: it draws into a
    # `float`, so a document numbered in the margin paginates identically to the same document with
    # this extension switched off. That is pinned by
    # `tests/integration/column-layout.integration.test.ts`, which renders a 2- and 3-column stress
    # document three ways and asserts margin matches the no-numbering baseline page for page.
    #
    # `inline` does NOT have that property and cannot — it adds text to the flow. It is worth knowing
    # that this cuts both ways: adding the prefix changed a multi-column region's measured height
    # enough to flip `single_page?` and switch column balancing ON, so inline output can be MORE
    # compact than the unnumbered document. Comparing margin against inline therefore proves nothing
    # about margin; the unnumbered render is the only honest baseline.
    def _asciidocollab_margin_placement?
      value = _asciidocollab_theme_value 'paragraph_numbering_placement'
      value.nil? || value.to_s.empty? ? true : value.to_s != 'inline'
    end

    # Draw the number beside the text, returning false if there is no room for it.
    #
    # Which SIDE follows the column the paragraph is in: the rightmost column puts its numbers in the
    # right-hand margin, every other column puts them on its left. For the common two-column region
    # that reads outward — one number in each page margin and nothing in the gutter. For three or
    # four columns the interior ones have only the gutter to work with, which is why this measures
    # rather than assumes.
    def _asciidocollab_ink_margin_number number
      return false unless _asciidocollab_margin_number_fits? number
      label = %(#{number}.)
      gap = (_asciidocollab_theme_value 'paragraph_numbering_gap') || DEFAULT_MARGIN_GAP
      label_width = rendered_width_of_string label
      side, = _asciidocollab_margin_slot
      left, right = _asciidocollab_column_edges
      # Absolute, then made relative: inside a column box `bounds.absolute_left` is the left of the
      # whole BOX, not of the current column, so a position expressed relative to the bounds lands in
      # the same place for every column — which is how the upstream recipe puts all of a region's
      # numbers in the page margin, stacked over one another.
      x = side == :right ? (right + gap) : (left - gap - label_width)
      colour = (_asciidocollab_theme_colour 'paragraph_numbering_font_color') || '999999'
      float do
        bounding_box [x - bounds.absolute_left, cursor], width: label_width do
          ink_prose label, color: colour, align: (side == :right ? :left : :right), margin: 0,
            single_line: true
        end
      end
      true
    end

    # Whether this paragraph's number will go in the margin rather than falling back to inline.
    #
    # Asked by BOTH passes and answered from the live geometry, so the measuring pass and the real
    # one agree about which paragraphs carry an inline prefix. They have to: a margin number is out
    # of flow and must not be measured, an inline one is in the flow and must be — and getting that
    # backwards silently mis-measures every paragraph that falls back.
    #
    # Two ways the margin can be refused, and the first is easy to overlook:
    #
    #   * The first line will not land at the current cursor. The base `convert_paragraph` inks with
    #     `ink_prose`, which FLOWS from wherever the cursor already is — it never relocates a
    #     paragraph and has no orphan control (upstream carries a literal TODO saying so). The one
    #     case where the first line does not land here is when a single line will not fit and Prawn
    #     moves to the next column or page; predicting which without advancing is not worth the
    #     machinery, so those paragraphs number inline.
    #   * The slot is too narrow to hold the label without overwriting the text beside it — a page
    #     margin narrower than the label, or the gutter beside an interior column.
    def _asciidocollab_margin_number_fits? number
      return false if cursor < _asciidocollab_line_height
      gap = (_asciidocollab_theme_value 'paragraph_numbering_gap') || DEFAULT_MARGIN_GAP
      label_width = rendered_width_of_string %(#{number}.)
      _, available = _asciidocollab_margin_slot
      label_width + gap <= available
    end

    # The height of one line of body text — the bar for "will the first line land here".
    #
    # Defined identically in `multi-column-sections`, for the same reason `_asciidocollab_theme_value`
    # is: the registry mounts exactly ONE file per extension, so there is nowhere shared to put it.
    def _asciidocollab_line_height
      line_height = (_asciidocollab_theme_value 'base_line_height') || 1
      (calc_line_metrics line_height).height
    rescue ::StandardError
      0
    end

    # The side this paragraph's number goes on, and how much room there is for it.
    def _asciidocollab_margin_slot
      left, right = _asciidocollab_column_edges
      unless (column_box = _asciidocollab_column_box)
        # Ordinary prose: the left page margin, which is the side a reader expects a marginal number
        # on and the one the upstream recipe uses.
        return [:left, left]
      end
      if column_box.current_column == column_box.last_column
        page_right = (dimensions = page.dimensions)[2] - dimensions[0]
        return [:right, page_right - right]
      end
      return [:left, left] if column_box.current_column == 0
      # An interior column has only the gutter, and it has to share it with the column to its left.
      [:left, column_box.width_of_column - column_box.bare_column_width]
    end

    # The absolute left and right edges of the column the cursor is in.
    #
    # The right edge is computed rather than read from `ColumnBox#right_side`, which is unusable:
    # it derives from `absolute_right`, and `ColumnBox` redefines `width` to mean the width of ONE
    # COLUMN, so `absolute_right` is already the first column's right edge and subtracting the
    # remaining columns from it walks off the left of the page. For a three-column box it reports
    # -134 for the first column. `left_side` is column-aware and correct, so the edge is taken from
    # there plus the column width.
    def _asciidocollab_column_edges
      (column_box = _asciidocollab_column_box) ?
        [(left = column_box.left_side), left + column_box.width] :
        [bounds.absolute_left, bounds.absolute_right]
    end

    # The column box the cursor is inside, or nil when the text is at the full measure.
    def _asciidocollab_column_box
      (::Asciidoctor::PDF::Converter::ColumnBox === bounds) ? bounds : nil
    end

    # This paragraph's position in the document, assigned once and remembered.
    #
    # Keyed by the paragraph rather than counted per conversion because a paragraph can be converted
    # more than once: content is measured by converting it into a scratch document first (`dry_run`),
    # and only then inked. A running counter advanced on every one of those passes, so a paragraph
    # that was measured before it was inked burnt a number and everything after it was numbered one
    # too high — a sequence with a hole in it, which reads as a miscount rather than as a bug.
    #
    # The base converter only ever dry-runs paragraphs in contexts this extension excludes anyway
    # (sidebars, examples, quotes), which is why nothing caught this until `multi-column-sections`
    # began measuring a marked region — the first path that dry-runs BODY prose. Fixed here rather
    # than there, because the next extension to measure something would hit it again.
    #
    # The AST is shared between the real converter and the scratch one, so the paragraph itself is
    # the one identity that survives the round trip. First conversion always happens in document
    # order — a measuring pass runs at the point the block is reached — so insertion order into this
    # map IS document order.
    def _asciidocollab_number_for node
      doc = node.document
      numbers = doc.instance_variable_get :@asciidocollab_paragraph_numbers
      if numbers.nil?
        numbers = {}
        doc.instance_variable_set :@asciidocollab_paragraph_numbers, numbers
      end
      numbers[node.object_id] ||= numbers.size + 1
    end

    # Whether this paragraph is body prose at document or section level.
    def _asciidocollab_numbered? node
      parent = node.parent
      return false if parent.nil?
      return false if EXCLUDED_PARENT_CONTEXTS.include? parent.context
      return false if parent.context == :list_item
      NUMBERED_PARENT_CONTEXTS.include? parent.context
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

    # A theme key holding a colour, normalised without the leading `#` some themes write.
    def _asciidocollab_theme_colour key
      value = _asciidocollab_theme_value key
      value.nil? ? nil : value.to_s.sub(/\A#/, '')
    end
  end
end

# Idempotence guard: prepend once per process, however many times this file is required.
unless (Asciidoctor::PDF::Converter.ancestors.include? AsciidocollabPdfExtensions::ParagraphNumbering)
  Asciidoctor::PDF::Converter.prepend AsciidocollabPdfExtensions::ParagraphNumbering
end
