# Specification Quality Checklist: PDF-Look HTML Preview Style ("Print")

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-09
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- **Iteration 1** (`/speckit-specify`) — three [NEEDS CLARIFICATION] markers open.
- **Iteration 2** (`/speckit-specify`) — page-like frame / preview only / theme colours always.
  All markers closed; scope bounded by a new **Out of Scope** section.
- **Iteration 3** (`/speckit-clarify`, 5 questions) — typefaces, fidelity oracle, diagnostics
  surface, narrow-pane behaviour, and the style's name and stored token. Effects:
  - Q1 → FR-027–FR-029 (Typefaces), US2 scenarios 2–3 and 9, and the assumption that the renderer's
    code font must be made available to the browser.
  - Q2 → SC-002/SC-003 restated as measured comparison against a rendered PDF over an anchor set,
    plus SC-004 for theme-value breadth.
  - Q3 → FR-032–FR-036 (Reporting appearance problems), US2 scenarios 6, 11 and 12, SC-012.
  - Q4 → FR-013–FR-016, US1 scenarios 6–8, SC-007 qualified to the default zoom.
  - Q5 → FR-001–FR-002, canonical name "Print" adopted throughout, token added to Key Entities.
- Requirements were renumbered to stay sequential in document order (now FR-001–FR-039); all
  in-document cross-references were shifted with them and re-verified.
- **Iteration 4** (`/speckit-analyze`, remediation) — the renumbering above turned out to have been
  applied to `spec.md` only. `plan.md`, `research.md`, `data-model.md`, all four contracts, and two
  of this checklist's own Q-ranges still cited the pre-renumber numbers, so roughly thirty
  cross-references pointed at the wrong requirement (C4 → "FR-024" for value rejection, F4 →
  "FR-028" for no-egress, and so on). `tasks.md`, written after the renumber, was already correct.
  Every reference in every artifact has now been checked against the requirement's actual text —
  not corrected by a blanket offset, since the drift was not uniform. Also in this pass:
  - **FR-012** (continuous flow; no page breaks, headers, footers or page numbers) had no task at
    all — it is the requirement the renumbering inserted, and it propagated into neither plan nor
    tasks. Now asserted in T015.
  - **FR-039** added: the accessibility expectations were living in Assumptions, where nothing
    gated them, while T034 tested them anyway.
  - **FR-005** and **FR-020** dropped "at minimum" and are now closed enumerations, which is what
    SC-002's anchor set and SC-004's "zero claimed but unasserted" already assumed.
  - **SC-006** now names the measurement and thresholds it inherits
    (`preview-adaptive-delay.spec.ts`) instead of "no measurable regression", which had no pass
    condition anywhere in the artifacts.
  - **SC-011** was an unrunnable user study ("an author asked … identifies the new style
    correctly"); T035 had quietly substituted a design review. Restated as the two interface
    conditions T035 actually checks.
  - The **CSS custom-property vocabulary** is now fixed in `contracts/print-appearance.md` with a
    test (V5) asserting the writer's and stylesheet's property sets are equal — it was an unowned
    agreement between two tasks marked parallel.
  - The **catalogue font scope** was narrowed to "M+ 1mn only, Noto Serif is already served via
    `next/font`". That is a different build of the family with different metrics, on the default
    theme's body face — research R3's own rejected-alternatives list already ruled it out. All
    families the default theme references are now converted (F7).
- Two details remain deliberately at planning altitude, recorded as assumptions rather than
  requirements: which documents compose the SC-002/SC-003 anchor set with what tolerances, and the
  measured bundle cost of making the renderer's code font available to the browser.
