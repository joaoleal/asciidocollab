# Phase 0 Research: Live Preview Responsiveness

**Feature**: `043-preview-responsiveness` | **Date**: 2026-07-26

All Technical Context unknowns are resolved below. One finding **contradicts an assumption recorded
in the spec** and changes the Tier 2 design — see R2.

---

## R1. DOM morphing: reuse an existing library (Principle IV)

**Decision**: Adopt **`morphdom`** (MIT, v2.7.8) as a new `apps/web` dependency.

**Rationale**: Principle IV (Reuse Before Rebuild) makes this a governance requirement, not a
preference: a maintained, compatibly-licensed library exists for exactly this job, so hand-rolling a
tree-diffing routine is prohibited. Beyond the mandate, `morphdom`'s two extension points map 1:1
onto the requirements:

| Requirement | `morphdom` mechanism |
|---|---|
| FR-013 update only what changed | The library's whole purpose — in-place patch, no full replace |
| FR-014 / FR-015 skip unchanged diagram + math subtrees | `onBeforeElUpdated(fromEl, toEl)` returning `false` skips that element **and its subtree** |
| FR-020a preserve focus | Patching in place leaves the focused node identity intact; the library does not detach nodes it can patch |
| FR-016a redraw a failed diagram | Same `onBeforeElUpdated` hook, returning `true` for a placeholder marked failed |

**Alternatives considered**:

- **`idiomorph`** (0BSD, v0.7.4) — an id-set-based morpher from the htmx team. Rejected: its id-set
  heuristics are tuned for htmx partial swaps and infer intent from id *populations* across subtrees.
  We need explicit, predictable skip decisions on named subtrees, which `morphdom`'s single hook gives
  directly. `idiomorph` remains a reasonable fallback if `morphdom`'s structural walk proves
  inadequate in practice.
- **Hand-rolled morphing** — prohibited by Principle IV while a compatible library exists.
- **React reconciliation** (parse worker HTML into React elements) — rejected: it would put the
  entire rendered document through React's reconciler on every refresh, which is more work than the
  `innerHTML` it replaces, and it would fight the existing `dangerouslySetInnerHTML` contract rather
  than replace it cleanly.

---

## R2. Block identity — a spec assumption that does not hold

**The spec assumes** (Assumptions section):

> The rendered output already carries per-block source-line and source-file provenance, which is
> assumed sufficient to identify blocks when updating only the changed parts of the output.

**This is not sufficient, and using it as the primary key would defeat the feature's own goal.**

**Finding**: block identity in the current output is *derived from line position*, so it is unstable
under exactly the edit that matters most. Two mechanisms, both position-derived:

- `data-source-line="N"` is the block's line number (`asciidoc-render.worker.ts:640-645`).
- Blocks with no author id get a **synthetic** id `__src_<context>_<line>`
  (`asciidoc-render.worker.ts:582`) — the line number is baked into the identifier itself.

Insert one paragraph at the top of a document and every subsequent block's line number shifts, so
every synthetic id and every `data-source-line` changes. A morph keyed on either would treat the
entire remainder of the document as new content — precisely the cascade US5 scenario 6 exists to
prevent, and precisely the case where the diagram/math skip would stop firing.

**Decision**: use a **layered identity strategy**, not a single key.

1. **Expensive subtrees are matched by content, not position.** A `.adc-diagram` placeholder carries
   its own source as escaped text content (`buildDiagramPlaceholder`,
   `asciidoc-render.worker.ts:212-214`). Compare *that* against the already-rendered
   `.adc-diagram-output`'s recorded source: identical source ⇒ skip the subtree, whatever line it now
   sits on. This satisfies FR-014 under insertion, which a positional key would not. The same
   content-addressed comparison applies to typeset math (`mjx-container`).
   This also aligns with Principle XII, which requires derived assets to be **content-addressed**.
2. **Author-supplied and auto-generated ids are stable and are used** — `[[anchor]]` ids and
   auto-generated heading ids derive from *title text*, not position, so they survive insertion and
   make good morph keys via `morphdom`'s `getNodeKey`.
3. **Synthetic `__src_*` ids are deliberately excluded from keying.** Passing them to `getNodeKey`
   would be worse than passing nothing: `morphdom` would treat a renumbered id as a *different node*
   and force a replace, whereas with no key it falls back to structural position matching and patches
   in place. `getNodeKey` must therefore return `undefined` for synthetic ids.

**Consequence for the spec**: the Assumptions entry was too strong. It is not wrong that provenance
exists — it is wrong that provenance is *sufficient as an identity key*. FR-013/FR-014/FR-015 remain
exactly as written; only the mechanism changes.

**Status: the spec has been corrected.** The Assumptions entry now states the layered strategy and
records that it supersedes the earlier claim. (Left stale in the first revision of these artifacts;
flagged by the architecture-guard scan as an intent divergence, since the spec is the contract a
future reader implements against and research notes are not.)

**Alternative considered and rejected**: making the worker emit a stable per-block identity (e.g. a
content hash) so positional keys become unnecessary. Rejected for this feature as scope inflation —
it changes the worker's output contract, touches the export path, and the layered strategy above
achieves the required behaviour without it. Worth revisiting if morph quality proves insufficient.

---

## R3. Sanitisation under a fragment return (Principles VIII + IX)

**Decision**: keep the identical sanitiser and identical configuration, adding only
`RETURN_DOM_FRAGMENT: true`:

```
DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true })
```

**Rationale**: Principle VIII permits feeding *more* content through the existing boundary but
forbids weakening, widening, or forking it. `RETURN_DOM_FRAGMENT` changes only the **return type** —
the same parse, the same profile, the same allow-list, the same hooks. Nothing about what is
permitted changes. It removes one parse+serialize round trip because DOMPurify already builds a DOM
internally and currently serialises it back to a string purely so `innerHTML` can re-parse it.

The four sanitiser call sites are unchanged in policy; only `use-asciidoc-preview.ts:175` changes its
return mode. `asciidoc-paste.ts:40`, `use-html-export.ts:317` and `render-diagrams.ts:122` are
untouched.

**Verification obligation**: Principle VIII requires the sanitisation seam to be proven un-regressed.
A test MUST assert that a payload rejected under the string mode is rejected identically under the
fragment mode — same input, same verdict, different return type.

---

## R4. Asciidoctor.js v4 migration

**Decision**: target **`asciidoctor@4.0.6`** (current; the spec cited 4.0.5, released since).
Sequenced last, as User Story 6.

**Findings**:

- v4.0.0 removed the Opal runtime for a native JS implementation. `@asciidoctor/core@4.0.6` is MIT.
- The API is now **async**: `load`/`convert` return Promises. The worker's `onmessage` handler is
  currently fully synchronous (`asciidoc-render.worker.ts:415-672`) and becomes an async handler.
  The `postMessage` staleness protocol is unaffected — `requestId` already guards ordering.
- `getCoreVersion()` reports 2.0.26, the same Asciidoctor version vendored in the PDF wasm. This is a
  reason to *expect* preview/export agreement to survive — it is **not evidence of it**, and an
  earlier revision of this document wrongly treated it as parity "preserved by construction".
  Principle XI forbids exactly that inference: parity "MUST be verified against reference output,
  never assumed from code inspection". See R4a.
- Reported gains: end-to-end 65.3 → 25.9 ms, convert 20.3 → 1.3 ms, bundle 1.74 MB → 865 KB. These
  are the *supplied* figures and are treated as hypotheses to be confirmed against the FR-023a
  baseline, not as facts.

**Risk**: the worker calls several APIs on the loaded document — `findBy`, `getSourceLocation`,
`getStyle`, `getSource`, `setId`, `getAttribute`, `convert`. Each must be re-verified against v4;
any rename is a silent behaviour change, not a compile error, because the objects are dynamically
typed at that boundary. This is why User Story 6 is sequenced last and gated on R4a.

---

## R4a. The parity gate for the engine upgrade (corrects R4)

**Finding**: the existing page-format reference-parity suite **cannot** gate the v4 upgrade. Verified,
not inferred:

- The JS `asciidoctor` package has exactly one non-build importer in the repository:
  `apps/web/src/workers/asciidoc-render.worker.ts:1`. It serves the **web-formatted preview only**.
- `apps/web/e2e/pdf-parity/pdf-parity-render.spec.ts` imports `@asciidocollab/asciidoc-pdf` and its
  own harness (`:23-27`), renders through ruby.wasm, and compares PDF text layers (`:158`) and page
  counts (`:223`). It never loads the JS engine.

Therefore that suite would pass unchanged whether the upgrade were correct or catastrophic. Naming it
as the gate would have produced confident, worthless green.

**Decision**: three new comparisons, plus the old suite retained for what it genuinely covers.

| Gate | Compares | Requirement |
|---|---|---|
| **Canonical web-format reference build** | In-app web output vs the reference Asciidoctor toolchain's HTML, with intended divergences enumerated | FR-025c, FR-025d, SC-010d |
| **Web-format render-equivalence corpus** | Current engine's captured output vs upgraded engine's output, over a fixed corpus | FR-025a, SC-010, SC-010a |
| **Cross-format agreement** | Web-formatted preview output vs page-formatted export output, on what both media express: block text sequence, heading hierarchy and numbering, cross-reference targets | FR-025b, FR-025e, SC-010b, SC-010e |
| Existing page-format parity suite | In-app PDF vs external reference build (unchanged) | SC-010c — evidence the *other* path was undisturbed |

**A second correction, from the follow-up scan.** An earlier revision of this document proposed only
the middle gate and treated it as satisfying the fidelity-verification principle. It does not: that
principle explicitly excludes "a snapshot of the in-app output against itself", which is exactly what
comparing a new engine against fixtures captured from the old one is. The regression gate is
necessary — it isolates *this upgrade's* effect in a way an external comparison cannot — but only the
canonical reference build supplies external truth. Both are kept, with distinct jobs.

The deeper problem it exposed: **the web-formatted preview has never had an external oracle at all.**
The constitution defines a reference build only for the page-formatted toolchain, so any long-standing
web-format rendering defect has been unfalsifiable. FR-025c closes that gap permanently, which is
worth more than the engine upgrade that prompted it.

**Cost, stated honestly**: the reference toolchain must render the *assembled* source with the same
attributes, and the app's own post-conversion passes must each be normalised or enumerated (FR-025d).
Expect the first run to fail on divergences that predate this feature. A clean first run is more
likely evidence of over-permissive normalisation than of a perfect renderer.

**Timing constraint**: the equivalence corpus needs reference output from the **unmodified** engine.
That can only be captured before any change lands, so it is folded into the User Story 3 baseline pass
(FR-023c) rather than left to User Story 6, which is too late.

**Alternative considered**: comparing the upgraded engine against the ruby.wasm PDF engine directly
instead of against captured v3 output. Rejected — the two produce different media, so any comparison
is limited to what both express (which is what the cross-format gate does). It cannot detect a
web-format-only regression such as a changed class name or a dropped attribute, which is precisely
what a version bump is most likely to cause.

---

## R4b. Pinning the HTML oracle (added by the post-task analysis)

**Finding**: R4a specified *that* a canonical HTML reference build is needed but never said which
toolchain, at which version, pinned how. "The reference Asciidoctor toolchain" is a role, not a
specification — and an oracle that resolves differently on two machines cannot answer "does this match
the reference?". Principle XII's determinism is a precondition for Principle XI's parity, so an
unpinned oracle breaks both at once.

**Decision**: reuse the page-formatted path's existing mechanism (Principle IV), which already solves
every part of this: a digest-pinned `ruby@sha256:…` base rather than a moving tag, a `Gemfile` +
`Gemfile.lock` installed `--frozen` so a disagreeing lock fails the build, an image tag derived from a
**hash of the definition files** so a stale image cannot be silently reused, a fixed
`SOURCE_DATE_EPOCH`, and explicit locale/TZ. See `e2e/pdf-parity/tools/Dockerfile.reference` and
`tools/reference-image.mjs`.

**Constraint on the reuse**: `referenceImageTag()` hashes its `DEFINITION_FILES`, so adding the HTML
backend's gems to the *shared* lock would re-tag the PDF image and put the committed page-format
corpus in question — the corpus SC-010c depends on. The HTML oracle therefore gets its own definition
set, and `reference-image.mjs` is generalised to build *a* definition set with the PDF one remaining
the default, so its tag stays byte-identical.

**Alternative considered**: installing `asciidoctor` from npm and calling it in-process as the
"reference". Rejected — that is the same JS engine the feature is upgrading, so it would compare the
new engine against itself. The oracle has to be the external Ruby toolchain, exactly as it is for the
page-formatted path.

---

## R5. Worker lifetime, ref counting, and supervision

**Decision**: a module-level, ref-counted worker holder in `apps/web/src/lib/`, with supervision.

- Ref count is incremented by each consuming hook instance and decremented on unmount. **Reaching zero
  arms an idle-retention timer rather than terminating**; `acquire` cancels it, and termination happens
  only when the timer expires with the count still at zero.
- **The retention is the load-bearing part, and the first revision of this document got it wrong.** It
  said the worker is "terminated only at zero" and claimed that satisfied FR-006 *and* FR-007 with one
  mechanism. It does not. `useAsciidocPreview` has exactly one caller
  (`asciidoc-preview.tsx:203`), inside a component rendered as
  `previewMode === 'html' ? <AsciiDocPreview/> : <PdfPreviewPanel/>` and gated by
  `showPreview && previewOpen` (`project-editor-layout.tsx:1391`). Switching to the page format,
  closing the panel, or hiding the preview each unmount the worker's *only* consumer, so the count
  reaches zero on precisely the transitions FR-007 and FR-007a exist to protect. Terminating there
  satisfies FR-006 and fails FR-007 — and would have done so behind a fully green test suite, since
  nothing tested asserted a *surviving* worker across an unmount. Found by the post-task analysis
  pass; recorded rather than edited away, because the mechanism read as obviously correct.
- `usePdfPreview` is unaffected: it is hoisted to the layout (`:991`) and never unmounts with the
  panel, so the page-formatted path already survives format switches.
- Supervision (FR-012a–FR-012c) attaches to the worker's `error` event and to an unexpected close:
  rebuild, re-issue the latest request, count the rebuild. On exceeding the bound, stop and surface.
- **Not a service locator.** The architecture constitution forbids static singletons at the
  *composition root for domain wiring*; this is a browser resource pool for a UI-layer worker, the
  same pattern the render worker already uses internally for its Asciidoctor processor
  (`asciidoc-render.worker.ts:407-413`). It injects no domain dependency and crosses no layer
  boundary.

**Alternative considered**: hoisting the worker into React context. Rejected — it would couple worker
lifetime to a provider's position in the tree, which is what the remount key already got wrong, and
it does not survive the HTML↔PDF switch unless the provider sits above both.

**Rollback plan** (required by Architecture Constitution › Refactor & Drift Handling for any accepted
deviation; omitted from the first revision):

1. Consumers see only `acquireRenderWorker(handlers) → { post, release, retry }` and never touch
   module state, so the holder is replaceable without touching call sites.
2. Reimplement `acquireRenderWorker` to construct a worker per call and terminate on `release()`.
   That restores today's per-mount lifetime with no consumer change.
3. Doing so regresses FR-006/FR-007 and disables supervision (FR-012a–FR-012c) — a deliberate trade,
   not a free revert. The e2e specs asserting no "preview not available" flash would fail, which is
   the intended alarm rather than a nuisance.
4. Trigger conditions: worker leakage across sessions that supervision cannot contain, or a
   cross-tab / multi-project isolation defect traced to shared worker state.

---

## R6. Development-only measurement surface

**Decision**: gate on `process.env.NODE_ENV !== 'production'`.

**Rationale**: Next.js statically replaces `process.env.NODE_ENV` at build time, so the production
bundle dead-code-eliminates the overlay entirely — satisfying FR-023's "MUST NOT be presented to
authors in production" as a build-time guarantee rather than a runtime check that could be flipped.
There is no existing `NODE_ENV` precedent in `apps/web/src`, so this establishes one.

The *timings themselves* are always computed and always returned on the render result — they are
cheap (two `performance.now()` reads) and User Story 4's adaptive wait consumes them in production.
Only the **overlay** is development-only. FR-023 constrains presentation, not measurement.

**Styling**: the overlay is app chrome, so Principle V applies — design tokens only, correct in light
and dark mode. It renders outside `.asciidoc-preview-content` so Principle VI scoping is untouched.

---

## R7. Adaptive wait and determinism (Principle XII)

**Decision**: `delay = clamp(lastRenderMs × 2, 120, 500)`, held in a ref, seeded with 500 until the
first render completes.

**Principle XII check**: XII requires *output* to be independent of wall-clock time and ambient
machine state. The adaptive wait makes **when** a render is scheduled depend on a measured duration,
but **what** the render produces is a pure function of the document source and attributes — unchanged
by this feature. No timing value reaches the rendered output. The debounce is explicitly sanctioned by
Principle XIII ("updates MAY be coalesced/debounced").

**Test consequence**: because the delay is now derived rather than constant, tests must control it.
The existing suite already injects `PREVIEW_DEBOUNCE_MS: 100` via a module mock
(`use-asciidoc-preview.test.tsx:66`), so the seam exists; the adaptive computation must be a pure,
separately testable function rather than inline arithmetic in an effect.

---

## R8. Existing test surface and refactor exposure

**Findings**:

- **No snapshot files exist anywhere in the repository.** Nothing asserts whole rendered output
  byte-for-byte. (Confirmed during clarification; it is what makes the normalised-equivalence
  decision in FR-024 consistent with existing practice rather than a relaxation.)
- **~23 preview e2e specs** exist (`preview-*.spec.ts`, `editor-preview-*.spec.ts`,
  `collab-consistency-preview.spec.ts`, `project-preview.spec.ts`). They assert against the rendered
  **DOM**, not against the hook's `html` string, so a correct morph keeps them passing. They are the
  primary regression net for Tier 2 and MUST all be run before User Story 5 is considered done.
- **`apps/web/tests/hooks/use-asciidoc-preview.test.tsx` (1062 lines)** asserts on the `html` string.
  This is the real refactor surface the spec's Dependencies section flags.
- **`apps/web` jest is transpile-only and `tsc` excludes `tests/`**, so a test can pass with an
  unfaithful fixture or wrong argument order. Any new test asserting the worker↔hook contract must
  use the real exported types, and the contract change must be verified by `pnpm typecheck` on source
  rather than trusted to a green test run.

---

## Resolved Technical Context

| Unknown | Resolution |
|---|---|
| Morphing approach | `morphdom` 2.7.8 (MIT), per Principle IV |
| Block identity key | Layered: content for diagrams/math, stable ids where real, no key for synthetic ids (R2) |
| Sanitiser change | Same call, same profile, `RETURN_DOM_FRAGMENT: true` only |
| Conversion engine target | `asciidoctor@4.0.6`, async API, sequenced last |
| Worker lifetime | Module-level ref-counted holder with **idle retention** (zero consumers ≠ terminate) and supervision |
| HTML reference oracle | Pinned + content-addressed, reusing `e2e/pdf-parity/tools/reference-image.mjs` with its own definition set (R4b) |
| Dev-only gating | `process.env.NODE_ENV`, build-time eliminated |
| Adaptive delay formula | `clamp(lastRenderMs × 2, 120, 500)`, pure function |
| Performance tests | Explicitly requested by the spec (SC-003/005/009 + FR-023a), so in scope under Principle II's opt-in clause |
