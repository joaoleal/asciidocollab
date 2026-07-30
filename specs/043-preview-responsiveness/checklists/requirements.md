# Specification Quality Checklist: Live Preview Responsiveness

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-07-26
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — see the note under Content Quality
      Scope below
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

## Content Quality Scope — what "no implementation details" means here

The two implementation-detail boxes are ticked against **languages, frameworks, APIs and file paths**,
none of which the spec names. The spec does describe *existing mechanisms and defects* in prose — a
report that is discarded rather than surfaced (FR-022), a counter that is a fixed constant rather than
an observed value (FR-022c), a measurement that must reuse the transport a path already has rather
than invent a second (FR-022b), a utility whose documentation and behaviour disagree (FR-026).

These are deliberate and are not what the boxes exclude. Each states an observable property of the
product that a reader can check, and several exist precisely because the requirement is unfalsifiable
without naming the thing being corrected — "report the timings" does not distinguish a real
measurement from a hardcoded zero, which is the defect FR-022c exists to close. Removing the
specificity would leave requirements that any implementation could claim to satisfy.

The line held: no requirement names a language, a framework, a library, a function or a file path.
Those live in `plan.md`, `data-model.md` and `tasks.md`. The separate, larger exception — the
non-normative *Diagnostic Evidence* table at the foot of the spec — is recorded under Notes below.

## Clarification Session — 2026-07-26

Four questions asked and integrated (quota 5; stopped at 4 because remaining candidates were
low-impact or resolvable by documented default):

1. **Engine termination recovery** → supervise and auto-restart, bounded, then manual retry.
   Added FR-012a–FR-012c, US2 scenarios 7–8, SC-004a, two edge cases.
2. **Meaning of "equivalent output"** for the engine upgrade → normalised comparison, with generated
   identifiers required to match exactly. Added FR-024a, revised FR-024/FR-025, US6 scenarios 1–3,
   SC-010/SC-010a. Verified against the existing render-parity suite before answering.
3. **Accessibility of partial refresh** → focus preservation only; announcements deferred.
   Added FR-020a–FR-020d, US5 scenarios 7–8, SC-007a, Out of Scope entry.
4. **Baseline for comparative criteria** → measurement delivered first, baseline recorded before any
   behavioural change. Added FR-023a, US3 scenario 5, explicit delivery order in Dependencies;
   SC-003/SC-005/SC-009 now reference the recorded baseline.

Also closed during integration, without spending a question: FR-016a (a diagram that failed to draw
must not be treated as up-to-date by the skip rule) — the edge case existed with no requirement
backing it. And US4 scenario 1 lost the vague "noticeably sooner" in favour of the quantified 200 ms.

## Architecture-Guard Scan — 2026-07-26

Seven violations detected against the plan artifacts; all seven fixed.

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | Plan gated the v4 upgrade on the page-format parity suite, which never loads the JS engine being upgraded; and justified parity "by construction" from a version string, which Principle XI forbids | High | New FR-025a/FR-025b + SC-010/SC-010a/SC-010b/SC-010c; `contracts/render-equivalence.md`; research R4a; "Principle XI correction" section in plan |
| 2 | SC-010 named a suite that cannot cover the web-format side | Medium | SC-010 rescoped to the new corpus; SC-010c retains the old suite for what it does cover |
| 3 | `RenderResult` declared twice and already drifted over `details`; remediation named no home | Medium | Reconciled to `apps/web/src/workers/render-protocol.ts`, with the reason it is not `packages/shared` |
| 4 | spec.md still asserted the block-identity assumption research R2 disproved | Medium | Assumptions entry rewritten to state the layered strategy and mark the supersession |
| 5 | Module-level worker holder documented with rationale but no rollback plan | Low | 4-step rollback plan with trigger conditions, in plan and research R5 |
| 6 | FR-023a required a baseline with no recorded home | Low | FR-023b names `baseline.md` and its required shape; FR-023c folds fixture capture into the same pass |
| 7 | Constitution Check stated an unverified performance claim as fact, contradicting its own Risks row | Low | Reworded as a hypothesis to be confirmed against the baseline |

Finding 1 is the one that mattered: the named gate would have passed whether the upgrade was correct
or catastrophic, reporting safety that was never tested. Its fix has a timing consequence — the
equivalence reference fixtures can only be captured from the unmodified engine, so that capture moved
into the User Story 3 baseline pass (FR-023c). There is exactly one moment when it is possible.

Requirement count after fixes: 42 functional requirements, 16 success criteria. No duplicate
identifiers.

## Second Architecture-Guard Scan + Scope Decision — 2026-07-26

The follow-up scan found five further violations, two of them defects in the previous round's fixes.
All five resolved, and all deferred work pulled into scope by explicit decision.

| # | Finding | Severity | Resolution |
|---|---|---|---|
| 1 | The render-equivalence gate added in round 1 is a self-snapshot, which Principle XV excludes from counting as a comparison test — while plan.md claimed it was not one | High | **Canonical web-format reference build** added (FR-025c, FR-025d, SC-010d, gate G0). The regression corpus is retained as G1 with its role corrected: necessary, but explicitly not what discharges XV |
| 2 | FR-025b required extracting cross-reference targets from page-formatted output; the harness exposes page counts, text and ink only | Medium | FR-025e makes the link-destination extraction part of the work (SC-010e) |
| 3 | data-model.md did not record the protocol-type reconciliation | Low | `render-protocol.ts` named, with the reason it is not `packages/shared` |
| 4 | US6's Independent Test predated the gates it should describe | Low | Rewritten to name all three comparisons |
| 5 | quickstart heading said "Five things" over six items | Low | Corrected |

**Scope decision — nothing deferred.** Both previously-deferred items are now in scope:

- **User Story 7 / FR-027–FR-027a** — the page-format render's unbounded out-of-memory failure past
  ~1,700 lines. The original exclusion reasoning (a performance feature should not absorb a
  correctness defect on another path) is **retained in Out of Scope rather than deleted**, because it
  remains a fair description of the size trade-off accepted here.
- **FR-028–FR-028a** — the reused-engine degradation is re-measured on an idle machine and the result
  recorded either way, closing the question instead of leaving it circulating.

**The most valuable outcome is incidental to the upgrade that prompted it.** Finding 1 exposed that
the web-formatted preview has never had an external fidelity oracle at all — the constitution defines
a reference build only for the page-formatted toolchain, so any long-standing web-format rendering
defect has been unfalsifiable. FR-025c closes that permanently.

**Expect G0's first run to fail.** It compares against external truth for the first time, so
divergences predating this feature will surface. A clean first run is more likely evidence that the
FR-025d normalisation is too permissive than that the renderer is perfect.

Counts after this round: **49 functional requirements, 20 success criteria, 7 user stories.** No
duplicate identifiers.

## Cross-Artifact Analysis (post-`/speckit-tasks`) — 2026-07-26

Nineteen findings, three of them CRITICAL. All resolved. Two of the three describe requirements that
were written in a form **nothing could have satisfied**, which is the pattern worth carrying forward:
both would have shipped behind a fully green test suite.

| # | Finding | Severity | Resolution |
|---|---|---|---|
| 1 | The worker holder released at zero consumers — but the web-formatted preview is its *only* consumer, so a format switch or panel close drops it to zero on exactly the transitions FR-007 protects. Satisfies FR-006, **provably fails FR-007** | Critical | **FR-007a** added; zero consumers now arms an idle-retention timer (`RENDER_WORKER_IDLE_RETENTION_MS`) instead of terminating. Corrected in `contracts/refresh-schedule.md` §S4, data-model, research R5, plan (deviation + risk), quickstart trap 0, task T017 |
| 2 | tasks.md prescribed test file names throughout — Constitution §Implementation Discipline forbids it ("MUST NOT prescribe test file names") | Critical | All ~19 occurrences removed; tasks name source paths only, and Path Conventions states the mapping the `/tdd` skill applies |
| 3 | A separate task revised the hook's 1062-line suite for the commit change implemented in another — a test/implementation split of one deliverable, also forbidden | Critical | Folded into T028; the revision happens inside its red phase |
| 4 | The plan required main-thread cost to be *confirmed* against the baseline, but nothing captured a main-thread figure and nothing checked one | High | FR-023a's baseline extended; **SC-006a** added; T011 captures, T031 confirms |
| 5 | FR-025c required a canonical HTML reference build but never named the toolchain, version, or pinning — an unpinned oracle answers differently per machine, breaking XII and therefore XI | High | **FR-025c-i** added; reuses the PDF path's digest-pinned base, `--frozen` lock and definition-hash tag (research R4b), with its own definition set so the PDF image's tag and committed corpus stay untouched |
| 6 | SC-004 ("startup once per editing session") contradicted FR-012a, which mandates rebuilds — and a rebuild is a startup | High | SC-004 now counts only startups attributable to switching/closing/opening, excluding supervised recovery |
| 7 | `pnpm gate` reports Job 6 SKIPPED when poppler or the wasm engine are absent, so SC-010c could go green having compared nothing (`pdf-parity.sh` itself correctly refuses to skip; `gate.sh:47-53` wraps it) | High | A skip counts as a failure for this feature — T038 and T046 require the job to actually run |
| 8 | `MAX_ENGINE_REBUILDS` was described as "a named constant" in four artifacts and given a value in none | High | Fixed at **3**, alongside `RENDER_WORKER_IDLE_RETENTION_MS` at **60_000** — both recorded as chosen, not derived |
| 9 | "Engine" named three different things: the preview's render worker, the web-format conversion library, and the page-format execution VM | Medium | FR-028/FR-028a say "page-format render VM" and name the other two apart |
| 10 | US7 may change page-format VM reuse *after* SC-010c was checked in US6, though SC-010c says "throughout this feature" | Medium | **T043** re-verifies parity after T041; recorded in spec §Dependencies and gate G3 |
| 11 | The `corpus/` directory tasks.md relies on was absent from plan.md's structure | Medium | Added, along with the harness's own pinned definition set |
| 12 | The FR-025d diagram row read "normalised to match" — an intention, not a rule, and the row most likely to be widened until the suite passes | Medium | Concrete rule: both sides reduce to a canonical `<adc-diagram type="TYPE">SOURCE</adc-diagram>` node |
| 13 | spec §Dependencies delivery order stopped at US6, omitting US7 | Medium | Extended, with US7's one dependency and one obligation stated |
| 14 | The "closing and reopening the preview panel" edge case had no requirement and no task | Medium | Covered by FR-007a, US2 scenario 9, and T021 |
| 15 | Story-level e2e specs read as verification split from the implementation they verify | Medium | Reframed as each story's acceptance deliverable |
| 16–19 | FR-025b defined after FR-025c/d; FR-023a/b near-duplication; "materially faster" unquantified in US6 AS4; plan's test-tree listing incomplete | Low | Reordered; duplication kept deliberately (the spec justifies it); cross-referenced to SC-009; resolved by finding 2 |

Counts after this round: **51 functional requirements, 21 success criteria, 7 user stories, 47
tasks.** No duplicate identifiers; every FR/SC referenced across the artifact set resolves to a
definition in spec.md (FR-020d is referenced nowhere by design — it is the requirement that *no*
live-region behaviour is required).

## Gap Review & Analysis Round — 2026-07-30

Two passes. First, an incremental-PDF-rendering proposal was checked against this spec; only its
measurement gap was taken in scope, and the rest became `044-pdf-render-performance`. Second,
`/speckit-analyze` was run over the amended artifacts and its eleven findings were all resolved.

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | The page-format per-stage figures are captured with render-VM reuse in force, but FR-028a may remove that reuse later in the same feature — and VM boot is one of the stages reported. The recorded profile would silently stop describing the shipped system, while remaining the input the follow-up feature is gated on | High | **FR-028b** added; SC-012 extended; US3 scenario 8; T041 re-measures in place; T011 marks the figures as reuse-dependent; sequencing rule 10 |
| 2 | The in-VM instrumentation task named no verification gate, in the one place a red phase can pass having measured nothing — the smoke harness exits successfully when the wasm engine is absent | High | T006c now names both gates explicitly, requires `build:wasm` first, and records that a `{ ran: false }` exit counts as a failure for the same reason a SKIPPED Job 6 does; sequencing rule 9 |
| 3 | US3 acceptance scenario 2 still said "already-computed", the pre-FR-022a scope | Medium | Scenario rewritten to require the stage breakdown, not only the surfacing |
| 4 | FR-022a's "at minimum" stage list omitted the dry runs that FR-022b calls the whole point — an implementation could satisfy it literally and skip the number the change exists for | Medium | Dry runs and font parse/subset added to FR-022a's minimum list |
| 5 | FR-022a–FR-022c had no acceptance scenario | Medium | US3 scenarios 7 and 8 added |
| 6 | The dev overlay must render two structurally different shapes; T007 predated FR-022a and said nothing about it | Medium | T007 states the two-shape requirement and the design consequence |
| 7 | T011's dependency on the stage-timing tasks was implied in its prose but absent from the explicit sequencing rules | Medium | Sequencing rule 8 |
| 8 | plan.md Scale/Scope undercounted source files | Low | Corrected to ~20 |
| 9 | T006 bundled two deliverables against the one-deliverable-per-task rule | Low | Split: T006 surfaces the discarded report, T006a corrects the fabricated counter |
| 10 | "No implementation details" ticked while requirements describe existing mechanisms | Low | Content Quality Scope section added above, stating what the box excludes and why the prose is deliberate |
| 11 | Forward reference to `044-pdf-render-performance` could read as a dependency of this feature | Low | Out of Scope now states the dependency runs one way only |

Counts after this round: **55 functional requirements, 22 success criteria, 7 user stories, 50
tasks.** Requirement coverage 54/55 (FR-020d excepted by design); success-criteria coverage 22/22.

## Notes

- **Clarification resolved (2026-07-26)**: FR-004 asked whether the guaranteed-refresh interval
  applies unchanged to the page-formatted preview, whose renders take roughly 3 s against a 2 s
  guarantee. Resolved as: one interval for both formats, with the guarantee suppressed while a refresh
  is already in progress and re-armed when it completes (FR-004, FR-004a). Chosen over a separate
  longer interval because it needs no new configured value and no measurement input, which keeps User
  Story 1 independent of User Story 3. FR-004b requires the documented contract to be updated to
  match. All other gaps were resolved with documented assumptions.
- **Watch item for planning**: the re-arm in FR-004a is the failure point. A guarantee that fires once
  and then lapses is the same defect class this feature exists to fix, so it needs its own test
  (User Story 1, scenarios 5 and 6; SC-001a).
- **Deliberate exception to "no implementation details"**: the final *Diagnostic Evidence* section
  records where each defect was confirmed in the current code. It is explicitly marked non-normative
  and describes the present state, not the required solution — the requirements above it remain the
  contract. It exists so planning does not repeat an investigation that is already complete. Reviewers
  who want a stakeholder-only document can read everything above that section and lose nothing.
- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`.
