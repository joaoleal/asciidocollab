# Feature Specification: On-Device Grammar & Spelling Checking

**Feature Branch**: `042-grammar-spell-check`

**Created**: 2026-07-25

**Status**: Draft

**Input**: User description: "Add on-device grammar and spelling checking to the collaborative AsciiDoc editor, powered by Harper. Help authors catch spelling, grammar, and style issues as they write, without ever sending their text off the device and without disrupting real-time collaboration."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See writing issues underlined as I type (Priority: P1)

As an author, I want misspelled and grammatically incorrect words underlined as I type, so I can fix them immediately. Only prose is checked — AsciiDoc structural markup, code blocks, and inline macros are excluded so I am not flooded with false positives.

**Why this priority**: This is the core value of the feature and the minimum viable slice. Without visible, accurate, prose-only feedback there is no writing assistance at all. Everything else (applying, listing, dictionaries) builds on issues being detected and marked.

**Independent Test**: Type a document that mixes prose containing a misspelled word with a code block and an inline macro. The misspelled prose word is visibly marked; the code and markup are not. The editor stays responsive while typing.

**Acceptance Scenarios**:

1. **Given** a document containing a misspelled word in prose, **When** checking runs, **Then** the word is visibly marked in the author's editor view.
2. **Given** a source code block, an attribute entry, a macro, or a cross-reference in the AsciiDoc source, **When** checking runs, **Then** that content is treated as non-prose and is not marked as a writing error.
3. **Given** the grammar engine fails to load, **When** the author opens the editor, **Then** the editor remains fully usable with no blocking error and no marks appear.

---

### User Story 2 - Apply a suggested correction in one action (Priority: P1)

As an author, I want to see a suggested correction for an issue and apply it in one action, so fixing mistakes is fast. Applying a suggestion edits the shared document text like any normal edit and propagates to all collaborators.

**Why this priority**: Detection without an easy fix is only half the value. One-action correction is what turns feedback into a fast writing loop, and it is the only path by which grammar output ever touches the shared document (as a real edit).

**Independent Test**: With a marked issue that has a suggested fix, invoke the fix once; the document text is corrected and the change appears in a second collaborator's view as an ordinary edit.

**Acceptance Scenarios**:

1. **Given** a marked issue with a suggested fix, **When** the author applies the suggestion, **Then** the document text is corrected and the change propagates to all collaborators as a normal edit.
2. **Given** an issue with multiple suggested corrections, **When** the author opens the suggestion affordance, **Then** each candidate is offered and selecting one applies exactly that replacement.
3. **Given** another collaborator is editing the same region, **When** the author applies a suggestion, **Then** the document is not corrupted and neither person's change is lost.

---

### User Story 3 - Keep grammar feedback private to each collaborator (Priority: P1)

As a collaborator, I do not want another person's in-progress writing mistakes cluttering my own view of the document, and as an author I do not want my in-progress mistakes exposed to others. Underlines, issue lists, counts, and tooltips are local to each person's view and are never written into the shared document or synced. Only an author's explicit acceptance of a fix — a real text edit — is shared.

**Why this priority**: This is a non-negotiable privacy and collaboration guarantee, not a nice-to-have. It must hold from the first slice, because a leak of grammar feedback into shared state would violate the product's core privacy promise and pollute every collaborator's view.

**Independent Test**: Two people edit the same document simultaneously, each with issues in their own text. Each sees only their own feedback; neither person's underlines or issue counts appear in shared document content or in the other person's view. Inspecting the shared document state shows no grammar metadata.

**Acceptance Scenarios**:

1. **Given** two people editing the same document simultaneously, each with issues in their own text, **When** checking runs, **Then** each person sees grammar feedback but neither person's underlines or issue counts appear in the shared document content or sync to the other.
2. **Given** an author has flagged issues in their view, **When** the shared document state is inspected, **Then** it contains no underlines, issue lists, counts, or other grammar metadata.

---

### User Story 4 - Review and resolve issues from a panel (Priority: P2)

As an author, I want a panel that lists all current issues so I can review and resolve them systematically, seeing each issue's location, category, and suggested fix.

**Why this priority**: The inline marks (P1) already deliver value, but a consolidated list makes cleanup of a long document practical. It is high-value but depends on detection existing first.

**Independent Test**: Open a document with several prose issues; the panel lists each issue with its context and suggestion, selecting an entry navigates to it, and resolving an issue (fix or ignore) removes it from the list.

**Acceptance Scenarios**:

1. **Given** a document with multiple prose issues, **When** the author opens the issues panel, **Then** every current issue is listed with its location, category, and available suggestion(s).
2. **Given** the issues panel is open, **When** the author resolves an issue (applies a fix or ignores it), **Then** the issue is removed from the panel and its inline mark clears.
3. **Given** the panel is open, **When** the author selects an entry, **Then** the editor navigates to that issue's location in the document.

---

### User Story 5 - Add domain terms to the project dictionary (Priority: P2)

As an author writing technical specifications, I want to add domain terms and acronyms to the project dictionary so they stop being flagged as errors. As a team, we share one project dictionary so every collaborator gets consistent results across all documents in the project.

**Why this priority**: Standards-heavy technical documents contain many valid domain terms and acronyms; without a dictionary, false positives would overwhelm the feature. A single shared project dictionary keeps everyone editing any document in the project consistent.

**Independent Test**: Flag a domain term as a spelling error, add it to the project dictionary, and confirm that term and all future occurrences are no longer flagged for that author and for another collaborator, in the same document and in other documents in the project.

**Acceptance Scenarios**:

1. **Given** a domain term flagged as a spelling error, **When** a collaborator with edit access adds it to the project dictionary, **Then** that term is no longer flagged for that author or for any other collaborator, in that document and in every other document in the project.
2. **Given** a term has just been added to the project dictionary, **When** another collaborator continues editing, **Then** existing and future occurrences of that term stop being flagged in their view without any manual refresh.
3. **Given** a term has been added to the project dictionary, **When** checking re-runs, **Then** a genuinely different misspelling that merely resembles the added term is still flagged.

---

### User Story 6 - Ignore an individual issue (Priority: P2)

As an author, I want to ignore an individual flagged issue I disagree with, so it stops distracting me without changing anyone else's view. My dismissals persist across sessions and devices but remain private to me.

**Why this priority**: Authors will legitimately disagree with some flags. A private per-author dismissal keeps the feature from becoming a nuisance, without imposing that judgment on collaborators or altering shared content.

**Independent Test**: Ignore a specific issue; on re-check (and after reloading on another device) that issue no longer appears for that author, while a collaborator viewing the same text still sees it.

**Acceptance Scenarios**:

1. **Given** an author ignores a specific issue, **When** checking re-runs, **Then** that issue no longer appears for that author.
2. **Given** an author ignores a specific issue, **When** a collaborator views the same text, **Then** the collaborator's view is unaffected and still shows the issue (subject to that collaborator's own dictionary/ignore state).

---

### User Story 7 - Enforce the project's configured English dialect (Priority: P3)

As an author, I want checking to enforce the English dialect already configured in the project's settings, so feedback matches the document's intended audience without a separate per-document choice.

**Why this priority**: Dialect correctness matters for audience fit but is a refinement on top of a working checker. The project already defines its language, so this story is about honoring that existing setting rather than introducing a new choice.

**Independent Test**: Set the project language to British English; dialect-specific British spellings are treated as correct and their American equivalents are flagged. Change it to American English and the reverse holds.

**Acceptance Scenarios**:

1. **Given** a project whose configured language is British English, **When** checking runs, **Then** dialect-specific British spellings are treated as correct and their American equivalents are flagged.
2. **Given** a project whose configured language is American English, **When** checking runs, **Then** dialect-specific American spellings are treated as correct and their British equivalents are flagged.
3. **Given** a project whose configured language is not English, **When** documents in that project are edited, **Then** grammar checking is not active.

---

### Edge Cases

- **Very large documents**: Checking must not freeze typing. Feedback for edited regions should appear promptly while the rest of a large document is checked without blocking input.
- **Rapid typing**: Fast, continuous edits must not produce flickering marks or stale suggestions; feedback settles to reflect the current text rather than an intermediate keystroke.
- **Concurrent edit while applying a fix**: Applying a suggestion while another collaborator edits the same region must not corrupt the document or lose either change.
- **Look-alike terms**: A word added to a dictionary must not un-flag genuinely different misspellings that merely resemble it.
- **Engine load failure**: If the grammar engine cannot load, the editor stays fully usable with no blocking error; grammar features are silently unavailable until it can load.
- **Offline**: All functionality works with no network connectivity.
- **Text that shifts position**: When collaborators insert or delete text above a marked issue, the mark and its suggestion stay anchored to the correct words.

## Requirements *(mandatory)*

### Functional Requirements

**Checking & marking**

- **FR-001**: System MUST check prose in the document being edited and visibly mark spelling, grammar, and available style issues in the author's editor view.
- **FR-002**: System MUST exclude AsciiDoc structural markup, code/listing blocks, attribute entries, macros, and cross-references from checking, so only prose is evaluated.
- **FR-003**: System MUST update marks as the author edits, reflecting the current document text and removing marks for text that has been corrected or deleted.
- **FR-004**: System MUST keep the editor responsive during checking, never blocking or freezing typing, including in very large documents.
- **FR-005**: System MUST avoid flickering and stale suggestions during rapid typing, settling feedback to the current text.

**Corrections**

- **FR-006**: System MUST present, for a marked issue, the suggested correction(s) offered by the grammar engine.
- **FR-007**: Users MUST be able to apply a suggested correction in a single action.
- **FR-008**: System MUST apply an accepted correction as an ordinary edit to the shared document so it propagates to all collaborators through normal real-time editing.
- **FR-009**: System MUST preserve document integrity and both parties' changes when a correction is applied while another collaborator edits the same region.

**Privacy & collaboration isolation**

- **FR-010**: System MUST run all checking entirely on the author's device and MUST make no network request that carries document text; the feature MUST function fully offline.
- **FR-011**: System MUST keep grammar feedback (marks, issue lists, counts, tooltips) local to each collaborator's view and MUST never write it into the shared document or synchronize it to other collaborators.
- **FR-012**: System MUST ensure the only grammar-related change ever shared is an author's explicit acceptance of a fix, expressed as a real text edit.

**Issues panel**

- **FR-013**: System MUST provide a panel listing all current issues in the author's view, each with its location, category, and available suggestion(s).
- **FR-014**: Users MUST be able to navigate from a panel entry to the corresponding location in the document.
- **FR-015**: System MUST remove an issue from the panel and clear its inline mark when the issue is resolved (fixed or ignored).

**Dictionaries**

- **FR-016**: System MUST provide a single project-scoped dictionary of accepted terms; there is no per-author personal dictionary. Accepted terms apply to every collaborator and to every document in the project.
- **FR-017**: Any collaborator with edit access to a document MUST be able to add a flagged term to the project dictionary, after which that term is no longer flagged for anyone in the project.
- **FR-018**: System MUST persist the project dictionary in server-side project storage (separate from the realtime collaboration document) and MUST propagate additions to all current and future collaborators of the project without requiring a manual refresh.
- **FR-019**: System MUST ensure that adding a term to the project dictionary does not suppress genuinely different misspellings that merely resemble the added term.

**Ignoring issues**

- **FR-020**: Users MUST be able to ignore an individual flagged issue such that it no longer appears for that author on subsequent checks, including after reloading or switching devices.
- **FR-021**: System MUST keep an ignored-issue decision private to the author who made it, leaving other collaborators' views unaffected.
- **FR-022**: System MUST persist each author's ignored-issue decisions server-side, scoped to that user and that document, and MUST NOT expose them to other collaborators.

**Dialect & enablement**

- **FR-023**: System MUST enforce the English dialect configured in the project's settings, treating that dialect's spellings as correct while flagging the opposing dialect's equivalents; there is no separate per-document or per-author dialect choice.
- **FR-024**: System MUST provide a per-project configuration that enables or disables grammar checking, and MUST only make checking available when the project's configured language is English; for non-English projects the feature is inactive.

**Offline delivery & graceful degradation**

- **FR-025**: System MUST make the grammar engine and English language data available offline from first use (bundled with or precached by the app), so checking functions with no network connectivity and no text-carrying request is ever required to obtain them.
- **FR-026**: System MUST degrade gracefully: if the grammar engine fails to load, the editor remains fully usable with no blocking error and grammar features are simply unavailable.

**Rule configuration & view scope**

- **FR-027**: Users MUST be able to configure which lint rules/categories are active — via presets (e.g. "spec prose", "relaxed", "spelling only") and individual rule toggles. Rule configuration is view-local (per author) and MUST NOT alter shared content or another collaborator's view.
- **FR-028**: Users MUST be able to switch the scope of displayed issues between the whole document and only their own prose, as a per-view filter that never changes what is checked for other collaborators.

### Key Entities *(include if feature involves data)*

- **Issue**: A single flagged span in a specific author's local view — its location in the document, its category (spelling/grammar/style), a human-readable message, and zero or more suggested corrections. Exists only in the local view; never part of shared document state.
- **Suggestion**: A candidate replacement text for an issue that, when accepted, becomes a real edit to the shared document.
- **Project dictionary**: The single, server-stored, project-scoped set of accepted terms that suppresses matching flags for every collaborator across every document in the project. Any collaborator with edit access can add to it. There is no per-author personal dictionary.
- **Ignored-issue record**: A per-author decision to dismiss a specific issue, persisted server-side scoped to that user and document, private to that author.
- **Project language / dialect setting**: The existing per-project language configuration; when it is an English dialect, it both enables the feature and determines the dialect enforced.
- **Project grammar-checking configuration**: The per-project switch that enables or disables checking (only meaningful when the project language is English).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: No document text ever leaves the device — zero network requests carrying document content are produced by the feature, and the feature works with networking fully disabled.
- **SC-002**: In a two-author session where each author has issues in their own text, neither author's marks, counts, or tooltips ever appear in the other's view or in shared document state (0 leaks across repeated trials).
- **SC-003**: Typing remains responsive in a large document (on the order of tens of thousands of words) — input latency stays imperceptible (target: under ~50 ms per keystroke) and typing never freezes while checking runs.
- **SC-004**: An author can go from seeing a marked issue to a corrected document in a single action, and the correction appears in a collaborator's view as a normal edit within the usual real-time sync latency.
- **SC-005**: Adding a domain term to the project dictionary removes all current and future flags of that exact term for every collaborator across every document in the project (propagating without a manual refresh) while continuing to flag look-alike misspellings.
- **SC-006**: Prose issues are detected while structural markup, code blocks, attributes, macros, and cross-references produce no writing-error flags (no false positives from non-prose in a representative technical document).
- **SC-007**: When the grammar engine cannot load, the editor opens and remains fully usable with no blocking error in 100% of such cases.
- **SC-008**: Checking works with no network connectivity on first use — with networking disabled from the start, the engine and English data load and produce feedback.

## Assumptions

- **Prose extraction reuses existing structure awareness**: The product already distinguishes AsciiDoc prose from markup, code, attributes, and macros for other editor features; that structural understanding is the basis for restricting checking to prose.
- **One project dictionary, server-stored**: There is a single project-scoped dictionary of accepted terms held in server-side project storage (separate from the realtime collaboration document). Any collaborator with edit access can add to it, and it applies to all collaborators and all documents in the project. There is no per-author personal dictionary.
- **Ignored issues are per-author, server-persisted**: Each author's ignored-issue decisions are stored server-side scoped to that user and document, private to that author, and survive reloads and device changes.
- **Engine ships offline-first**: The grammar engine and English language data are bundled with (or precached by) the app so checking works fully offline from the first use.
- **Dialect comes from project settings**: The enforced English dialect is the project's already-configured language; there is no new per-document or per-author dialect control.
- **Enablement is per-project and English-gated**: A per-project configuration enables/disables checking, and checking is only available when the project's configured language is English; non-English projects never activate the feature.
- **Checking scope is the whole document**: Every author checks the full prose of the document (feedback still stays private per FR-011), rather than only checking their own contributions.
- **English only**: Only English (its dialects) is in scope; other languages are out of scope.
- **Editing experience only**: The feature concerns the live editing experience; rendered/exported output is not checked.
- **Project membership already exists**: The concept of a project and its collaborators already exists and can carry the shared project dictionary.

## Out of Scope

- Style rewriting beyond what the grammar engine offers (no tone adjustment, summarization, or generative rewriting).
- Languages other than English.
- Checking of rendered or exported output (e.g., generated PDF/HTML); this feature is about the editing experience only.

## Clarifications

### Session 2026-07-25

- **Q: How should the custom dictionary and ignored-issue list be scoped?** → A: The dictionary is a single project-scoped dictionary (see refined answers below); the ignored-issue list stays per-author and private.
- **Q: Is the document's English dialect per-document or per-author?** → A: Neither — the enforced dialect comes from the project's already-configured language setting.
- **Q: What prose does checking evaluate by default?** → A: The whole document for every author (feedback still stays private per-author).
- **Q: Should checking be always-on or toggleable?** → A: A per-project configuration enables/disables it, and it only becomes enabled when the project's configured language is English.
- **Q: Where is the shared dictionary stored and how does it reach collaborators?** → A: In server-side project storage, delivered separately from the realtime prose channel (not inside the collaboration document).
- **Q: Is there a per-author personal dictionary?** → A: No — the dictionary is project-scoped only (one per project, applying to all documents and collaborators); there is no per-author personal dictionary.
- **Q: Who may add terms to the project dictionary?** → A: Any collaborator with edit access to a document.
- **Q: Must checking work fully offline from first use?** → A: Yes — the engine and English language data are bundled/precached with the app.
- **Q: Where does each author's private ignored-issue list persist?** → A: Server-side, scoped per user and per document, private to that author.
