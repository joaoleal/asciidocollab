# frozen_string_literal: true

# Alternate page geometry for a wide table: renders a marked table on its own page at a different
# size or orientation, then returns the document to its normal geometry.
#
#   [.wide-page]
#   |===
#   | a very wide table
#   |===
#
#   [.wide-page, page-size=A3]
#   |===
#   | a table wider still
#   |===
#
# == Why this is not covered by an existing setting
#
# The theme's `page.size` and `page.layout` are DOCUMENT-WIDE — no theme key gives one block a
# different page geometry, so this passes the FR-032a3 / FR-032d test.
#
# It is worth being precise about what is genuinely new, because the converter is not empty-handed
# here: `convert_page_break` already honours a `[landscape]` or `[portrait]` role on an explicit page
# break, so an author can ALREADY get a landscape table by hand:
#
#   [landscape]
#   <<<
#   |===
#   ...
#   |===
#   [portrait]
#   <<<
#
# What this extension adds over that is (a) marking the table itself rather than fencing it between
# two manual page breaks, which is what makes it survive the table moving, and (b) a genuine page
# SIZE change — `advance_page` accepts `size:`, but no author-facing markup reaches it.
#
# == Precedence against multi-column (FR-031c)
#
# The open edge case tasks.md assigns to this task. When a marked table sits inside a
# `[.multi-column]` region, MULTI-COLUMN WINS and the page geometry is left alone.
#
# The rule is not arbitrary. A column box is a bounding box computed from the current page's
# geometry; changing the page size underneath it does not re-flow the columns, it leaves them
# measured against a page that no longer exists, which draws text off the edge of the sheet. Refusing
# is the only outcome that is both predictable and correct, so the check is a guard rather than a
# preference — and it is the same guard `multi-column-sections` uses to refuse nesting.
#
# == Constraints from the runtime
#
#   * IDEMPOTENT. The wasm VM is warm and never torn down between renders.
#   * PLAIN, `-r`-ABLE RUBY, so the parity reference can be produced by the canonical CLI.
module AsciidocollabPdfExtensions
  module LargeTablePageSize
    # This extension's catalogue id, as the manifest declares it. Pinned by a test, because a drift
    # between the two would leave the extension permanently disabled with nothing to show for it.
    EXTENSION_ID = 'large-table-page-size'

    # The role an author marks a table with.
    ROLE = 'wide-page'
    # Orientation used when the author marks a table but does not name one. Landscape is the point of
    # the exercise: a table too wide for the measure is nearly always a table wanting more width.
    DEFAULT_LAYOUT = :landscape
    # Orientations the converter accepts.
    LAYOUTS = %i[portrait landscape].freeze

    # Render a marked table on a page of its own geometry, then restore the document's.
    def convert_table node
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      return super unless _asciidocollab_wide_page? node

      previous_layout = page.layout
      previous_size = page.size
      previous_margin = page_margin

      _asciidocollab_advance_to (_asciidocollab_layout node), (_asciidocollab_size node)
      result = super
      # Restored on a fresh page rather than in place: the table just changed the geometry of the
      # page it is on, so the content after it cannot share that page.
      _asciidocollab_advance_to previous_layout, previous_size, previous_margin
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

    # Whether this table asks for a page of its own geometry.
    def _asciidocollab_wide_page? node
      # Multi-column wins — see the precedence note above. A column box is measured against the
      # current page, so changing the page size underneath it draws text off the sheet.
      return false if ::Asciidoctor::PDF::Converter::ColumnBox === bounds
      (node.role? ROLE) || (node.attr? ROLE)
    end

    # The orientation this table asks for.
    def _asciidocollab_layout node
      declared = (node.attr 'page-layout', nil) || (node.roles.map(&:to_sym) & LAYOUTS)[-1]
      return DEFAULT_LAYOUT if declared.nil?
      candidate = declared.to_sym
      (LAYOUTS.include? candidate) ? candidate : DEFAULT_LAYOUT
    end

    # The page size this table asks for, or nil to keep the document's.
    #
    # An unrecognised size is ignored rather than guessed at, so a typo produces the document's normal
    # page rather than a page of some size the author did not ask for.
    def _asciidocollab_size node
      declared = node.attr 'page-size', nil
      return nil if declared.nil_or_empty?
      candidate = declared.to_s.upcase
      (::PDF::Core::PageGeometry::SIZES.key? candidate) ? candidate : nil
    end

    # Move to a new page with the given geometry, carrying the margin the converter computed for it.
    def _asciidocollab_advance_to layout, size, margin = nil
      options = { layout: layout }
      options[:size] = size unless size.nil?
      options[:margin] = margin || @page_margin[layout][page_side nil, @folio_placement[:inverted]]
      advance_page options
    end
  end
end

# Idempotence guard: prepend once per process, however many times this file is required.
unless (Asciidoctor::PDF::Converter.ancestors.include? AsciidocollabPdfExtensions::LargeTablePageSize)
  Asciidoctor::PDF::Converter.prepend AsciidocollabPdfExtensions::LargeTablePageSize
end
