# Specification Quality Checklist: PDF Theme Editing & Sectioned Project Options

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-07-18
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

- Iteration 1: three [NEEDS CLARIFICATION] markers raised (theme editor modality, theme storage
  location, extension catalogue scope) — all scope-defining with materially different
  implementations.
- Iteration 2: all three resolved by the user. Theme editor = YAML text editor with completion for
  known settings and inline colour/font previews, PDF sample preview alongside. Theme storage = a
  file in the project's own file tree. Extensions = toggle shipped extensions **and** allow
  project-supplied Ruby extension files. Spec updated; all checklist items pass.

- Clarification session 2026-07-18: 5 questions asked and answered. Two materially reshaped the
  feature — the theme editor moved **out of project options** into the editing surface as a
  file-type editor (resolving a permissions contradiction between US1 and US2), and US3 **grew** to
  include bundling new extensions into the renderer rather than only toggling existing ones.

### Resolved during planning

- ~~**Project-supplied extensions execute project-authored code in every member's browser.**~~
  **Resolved — capability removed.** Planning found that the renderer's Ruby VM bundles the ruby.wasm
  JavaScript host bridge (`gem "js"`, vendored as `js-2.9.4`), which exposes `JS.global` — the Web
  Worker's entire JavaScript scope. Project-authored Ruby could therefore reach the network through
  JavaScript, bypassing the inert socket shims and the WASI preopen list entirely, breaching the
  **non-waivable Principle X**. Worse, it would run in other members' browsers on our origin, so a
  credentialed `fetch` would carry their session. The gem also ships `JS::RequireRemote`, which
  defeats content-digest approval outright.

  Hardening was rejected as unsound (Ruby's reflectiveness makes "no path reaches a JS binding" a
  negative that cannot be proven, and would need re-proving on every ruby.wasm bump). FR-033–FR-040
  were replaced with an administrator-controlled deployment folder: the same Ruby, but supplied by
  someone who already controls the served application and therefore gains no new privilege.

  This removed three of the plan's four Constitution violations — the Principle IX execution
  exception, the absent bounded-execution mechanism, and the warm-VM state leak.
- ~~Bibliography extension may duplicate existing capability.~~ **Resolved — excluded.** Investigated
  2026-07-18: bibliography is a complete citation-js/CSL implementation in the web worker shim, wired
  into the orchestrator, and parity-tested against the real asciidoctor-bibtex gem across four
  style/order variants with committed reference PDFs. The gem would duplicate it and its BibTeX
  parser is racc-generated, risking the no-native-extension gate. Removed from the catalogue.
- **"Extension" was redefined after clarification.** US3 originally meant third-party Asciidoctor
  gems. It now means PDF *converter customisations* written for this application — the model the PDF
  converter's own extension documentation describes. This shrinks the sourcing/vetting risk (no
  third-party supply chain, no gem bundle growth) and couples US3 to US2, since extensions configure
  themselves through theme settings that the theme editor must complete (FR-031a/b, SC-014a).
- **Shipped set is fixed at 12 extensions** (FR-032a), delivered in three tiers: review and
  navigation (4), layout (4), front and back matter (4). The styling group from the source catalogue
  was deliberately excluded — themed admonitions, custom thematic breaks, code-block language labels,
  page borders and role-based table theming all look achievable through theme settings alone, which
  FR-032a3 requires be delivered as settings rather than extensions. FR-032f requires each shipped
  extension to be loadable by the canonical CLI toolchain so the Principle XI reference build is
  possible — this constrains how they may be written.
- **⚠ US3 remains the largest story in the feature, at P3, by explicit decision.** Twelve extensions,
  each needing its own reference-parity coverage (FR-032e) and size measurement (FR-032h), plus the
  catalogue UI and the administrator extension folder. Scope was raised in the 2026-07-18 session and the user
  chose to keep all three tiers in this feature. FR-032a2 keeps the tiers independently releasable so
  the work can still land incrementally.
- **Two behavioural questions on the shipped set remain open** and are recorded as edge cases: how
  competing layout extensions resolve (large table demanding an alternate page size inside a
  multi-column section), and the no-logo case for the custom title page. Both are narrower than the
  ones resolved this session.

### Resolved in clarification session 2 (2026-07-18)

- **Extension configuration was contradictory** — FR-031a required all extension settings to be theme
  settings, but targeting ("this section is multi-column") cannot be expressed in a theme. Split by
  concern: appearance in the theme (FR-031a), targeting via document block attributes and roles
  (FR-031a1), with targeting markup required to be inert when its extension is off (FR-031a2).
- **Change bars removed** (FR-032a5) — deferred until version history exists, rather than shipping a
  markup-driven substitute that would later be replaced. Catalogue went 13 → 12.
- **Paragraph numbering pinned to the reference implementation** (FR-032a4a–c) — sequential in
  document order, assigned pre-render, not persisted, document/section-level paragraphs only. Checked
  against the PDF converter's published use-case implementation; structural or persistent numbering
  would have diverged from the canonical toolchain and breached FR-032e / Principle XI.
- **Sample preview gained a comparison toggle** (FR-031b1–3) — renders with and without a selected
  enabled extension, changing nothing else, so an extension's effect is seen by comparison. This
  obliges the sample document to contain content every shipped extension acts on (FR-011a), while
  remaining a coherent document rather than a fragment catalogue (FR-011b).
- **Bundle-size cost is unquantified.** FR-032f requires each shipped extension's download-size cost
  to be measured against the pre-feature baseline, and SC-016 requires an agreed per-extension
  budget. That budget has not been set and is a planning input.
