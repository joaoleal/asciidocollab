# frozen_string_literal: true

# Narrow contents: draws the document's contents list in a narrower measure than the page, so entries
# and their page numbers sit closer together instead of being separated by the full width of the page.
#
# == Why this survived the theme-settings test
#
# tasks.md flagged this entry as the one most likely to dissolve into theme settings, because the
# `toc.*` family already exists. It does not dissolve, and the reason is specific: `toc.indent` is
# applied by `ink_toc_level` around NESTED levels only —
#
#     indent @theme.toc_indent do
#       ink_toc_level (get_entries_for_toc entry), ...
#     end
#
# — so raising it pushes subsections further right while top-level entries still span the full
# measure, and the right edge never moves at all. Verified by rendering with `toc.indent: 72`: the
# sub-entries indent, the chapter entries do not, and every dot leader still runs to the page edge.
# There is no theme key that narrows the list as a whole.
#
# This extension therefore CONTRIBUTES the two keys that were missing, rather than reimplementing
# anything: `narrow-contents.left` and `narrow-contents.right`, both measurements in points. They are
# applied to `ink_toc` itself, which means the dry run inside `allocate_toc` measures the same
# narrowed list that is later inked into the space it reserved — the two cannot disagree.
#
# == Constraints from the runtime
#
#   * IDEMPOTENT. The wasm VM is warm and never torn down between renders.
#   * PLAIN, `-r`-ABLE RUBY, so the parity reference can be produced by the canonical CLI.
module AsciidocollabPdfExtensions
  module NarrowContents
    # This extension's catalogue id, as the manifest declares it. Pinned by a test, because a drift
    # between the two would leave the extension permanently disabled with nothing to show for it.
    EXTENSION_ID = 'narrow-contents'

    # Indent applied to each side when the theme does not say otherwise. One inch, which visibly
    # narrows the list on every standard page size without crowding a deeply nested entry.
    DEFAULT_INDENT = 72

    # Draw the contents list inside a narrower measure.
    # The gate is repeated here even though `_asciidocollab_contents_measure` asks the same question
    # and yields plainly when the answer is no. Every hook in this gem opens with this exact line, and
    # a test enforces it — a hook whose gate is one delegation away is a hook a reader has to follow
    # somewhere else to be sure it is gated at all, and the invariant is worth more than the line.
    def ink_toc doc, num_levels, toc_page_number, start_cursor, num_front_matter_pages = 0
      return super unless _asciidocollab_extension_enabled? EXTENSION_ID

      _asciidocollab_contents_measure { super }
    end

    # THE CONTENTS-MEASURE PROTOCOL. Run `block` in the measure a contents list is drawn in.
    #
    # This is the one method in this gem that another extension calls BY NAME, and it exists because
    # `super` is the wrong mechanism for composing two extensions that draw into the same list.
    #
    # `additional-contents-entries` also overrides `ink_toc`, and also wraps `super`. Both modules are
    # prepended onto the SAME class, so which one wraps the other is decided by which was `require`d
    # first — and in a warm VM that is the order the FIRST render in the session happened to select,
    # not the id order the registry loads in. The two orders do not draw the same document:
    #
    #   * narrow-contents outermost — the extra lists are inked inside this `indent`, so they are
    #     narrowed too. Prawn carries indentation across page breaks on purpose
    #     (`generate_margin_box` re-applies `total_left_padding`), so starting each list on its own
    #     page does not escape it.
    #   * narrow-contents innermost — `super` returns and unwinds this `indent` before the extra
    #     lists are drawn, so they land at full page measure beside a narrowed contents list.
    #
    # Two documents from one selection, decided by session history. Making the ancestor order
    # deterministic is not available to us: `Module#prepend` cannot be undone and the VM is never torn
    # down, so the cheap fixes (sort the requires, discard the VM) either do not bind or cost a VM per
    # render. The fix is to stop depending on the order at all.
    #
    # ORDINARY DISPATCH IS ORDER-INDEPENDENT; `super` IS NOT. A call to this method by name searches
    # the whole ancestor chain from the front and finds this definition wherever this module happens
    # to sit, so a consumer gets the same measure in either order. That inverts the dependency the
    # right way round: `additional-contents-entries` no longer depends on out-wrapping or being
    # out-wrapped by this extension, only on the abstract question "what measure do contents go in?",
    # which this extension answers and which has a safe default (the full page) when it is absent.
    #
    # Re-entrant, which is what makes both orders converge on ONE narrowing rather than none or two:
    # when this extension is outermost the consumer's own call lands inside the `indent` already open
    # here and must not open a second one, and the flag is how it can tell. It is an instance
    # variable rather than a local because the caller is in another module; the dry run inside
    # `allocate_toc` is safe on the same flag because `dry_run` runs the entire `ink_toc` chain on one
    # scratch instance via `instance_exec`.
    def _asciidocollab_contents_measure
      return yield if @_asciidocollab_narrowing_contents
      return yield unless _asciidocollab_extension_enabled? EXTENSION_ID

      left = _asciidocollab_indent 'narrow_contents_left'
      right = _asciidocollab_indent 'narrow_contents_right'
      return yield if left.zero? && right.zero?

      @_asciidocollab_narrowing_contents = true
      begin
        # `indent` narrows `bounds`, which is what `ink_toc_level` measures its dot leaders and its
        # right-aligned page numbers against, so both follow the narrowed measure without being told.
        indent left, right do
          yield
        end
      ensure
        @_asciidocollab_narrowing_contents = false
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

    # Read one side's indent as a non-negative measurement.
    #
    # A negative value would widen the list past the page margin and draw the page numbers off the
    # sheet, so it is clamped rather than obeyed.
    def _asciidocollab_indent key
      declared = _asciidocollab_theme_value key
      value = declared.nil? ? DEFAULT_INDENT : declared.to_f
      value.negative? ? 0 : value
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
unless (Asciidoctor::PDF::Converter.ancestors.include? AsciidocollabPdfExtensions::NarrowContents)
  Asciidoctor::PDF::Converter.prepend AsciidocollabPdfExtensions::NarrowContents
end
