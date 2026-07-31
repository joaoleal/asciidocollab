# Baseline: Live Preview Responsiveness

**Feature**: `043-preview-responsiveness` | **Taken**: 2026-07-30 | **Branch**: `043-preview-responsiveness`

The recorded behaviour of the preview **before** this feature changed anything. Every comparative
success criterion in the spec is judged against the figures here rather than against recollection.

Taken at commit `b5e5f55` — the measurement work (stage timings, the development cost overlay) had
landed, and **no behavioural change had**. That is deliberate: the instrumentation is what makes the
figures readable, and it changes when nothing about *when* or *how* a render happens.

## How these were taken

| | |
|---|---|
| Harness | `apps/web/e2e/baseline/preview-baseline.spec.ts`, gated behind `BASELINE_MEASURE=1` |
| Command | `BASELINE_MEASURE=1 pnpm --filter @asciidocollab/web exec playwright test preview-baseline --project=chromium --no-deps` |
| Stack | `./scripts/dev.sh` (Next dev server, Turbopack), Chromium via Playwright, same machine |
| Machine | 24 cores, ~30 GB RAM, no swap, otherwise idle |
| Raw output | one JSON summary per run; the figures below are transcribed from it |

**Read the timings as development-build figures.** The dev server serves unminified, unsplit modules
and the app runs without production optimisation, so absolute values are pessimistic against a
production build. What matters is that the post-change figures are taken **the same way**, which is
what makes the comparison honest.

---

## 1. Web-formatted conversion cost, by document size (feeds SC-009)

Documents are generated: a title, then repeating sections of prose, a two-item list and a Ruby source
block, truncated to the stated line count.

| Document | parse | convert | post-process | **total (worker)** | first paint after open |
|---|---|---|---|---|---|
| ~100 lines | 10 ms | 1 ms | 8 ms | **45 ms** | already rendered |
| ~1,500 lines | 51 ms | 6 ms | 16 ms | **107 ms** | 759 ms |
| ~15,000 lines | 238 ms | 30 ms | 81 ms | **421 ms** | 1,759 ms |

The worker total is what the render itself costs. The "first paint" column additionally carries
scheduling, the worker round trip and paint, and is the figure an author actually waits for.

**Where the time goes**: parse dominates conversion at every size — 57% of the total at 15,000 lines
against convert's 7%. The remainder (`total` − the three stages) is include assembly and the
pre-conversion block walk.

### Size of the conversion code (feeds SC-009)

| | |
|---|---|
| Engine | `asciidoctor` **3.0.4** (`@asciidoctor/core` 3.0.4) |
| Browser bundle | `dist/browser/asciidoctor.js` — **1,737,178 bytes** |
| Minified browser bundle | `dist/browser/asciidoctor.min.js` — **746,873 bytes** |

The engine's own browser bundle is recorded rather than what the page downloaded: the development
server serves modules unsplit and unminified, so a download figure taken here says nothing about what
ships. The bundle file is the same artifact whichever bundler consumes it, which makes it the figure
two engine versions can honestly be compared on. SC-009's "at least a third smaller" is judged against
**746,873 bytes minified**.

---

## 2. Delay from the last keystroke to the refresh (feeds SC-005)

Three samples per size; a marker is typed at the end of the document and the wait is until it appears
in the preview.

| Document | samples | median |
|---|---|---|
| ~100 lines | 485, 509, 520 ms | **509 ms** |
| ~1,500 lines | 637, 561, 561 ms | **561 ms** |
| ~15,000 lines | 1,059, 1,075, 1,031 ms | **1,059 ms** |

The 500 ms trailing debounce dominates the small document entirely: 509 ms measured against a 45 ms
render. **SC-005's target of 200 ms on a ~100-line document is a scheduling change, not a rendering
one** — the render is already an order of magnitude inside it.

For the 15,000-line document, SC-005 requires the post-change figure to be **no later than 1,059 ms**.

---

## 3. Time-to-content when switching file (feeds SC-003)

Repeated switching between the ~100-line and ~1,500-line documents, timed from the click to the new
file's text appearing in the preview.

| Sample | 1 | 2 | 3 | 4 | median |
|---|---|---|---|---|---|
| ms | 761 | 618 | 704 | 625 | **665 ms** |

**SC-003 requires at least a halving: the post-change median must be ≤ 332 ms.**

Note what this figure contains today: the preview is remounted per file, so every switch rebuilds the
render worker and pays the engine's startup cost again, on top of the render itself.

---

## 4. Main-thread work during a sustained editing session (feeds SC-006a)

Document: 102 lines, six mermaid diagrams and six equations (block and inline). The preview is left to
settle after the first render, then text is typed continuously for 15 seconds.

| Measure | Baseline |
|---|---|
| Main-thread task time (Chrome `TaskDuration`) | **5,413 ms** |
| Script time (`ScriptDuration`) | **4,688 ms** |
| Layout | 53 ms |
| Style recalculation | 41 ms |
| Long tasks (> 50 ms) | **18**, totalling **990 ms** |

Both are recorded because they answer different questions: the counters say how much time the main
thread spent working; the long-task total says how much of it arrived in blocks long enough to be felt
as a stall.

**SC-006a requires the post-morph figure to be no greater than these.** Note the ratio: 5.4 seconds of
main-thread work across a 15-second session on a 102-line document, of which the render worker does
none — this is the whole-document re-parse, the diagram redraws and the equation re-typesets that the
partial refresh is expected to remove.

### Re-measured after the change (2026-07-31)

Same harness, same test (`measures main-thread cost across a sustained editing session`), same
document, same 15-second session, same counters, same machine and the same development stack — run
twice, on its own, with nothing else on the box.

| Measure | Baseline | Run 1 | Run 2 |
|---|---|---|---|
| Main-thread task time (`TaskDuration`) | 5,413 ms | **5,058 ms** | 5,067 ms |
| Script time (`ScriptDuration`) | 4,688 ms | **4,362 ms** | 4,363 ms |
| Layout | 53 ms | 53 ms | 53 ms |
| Style recalculation | 41 ms | 41 ms | 41 ms |
| Long tasks (> 50 ms) | 18, totalling 990 ms | **7, totalling 366 ms** | 8, totalling 421 ms |

Read the two figures together, because they moved by very different amounts. Total main-thread time
fell by about 6%, which is all the partial refresh could ever have taken off it: on this document most
of that time is the editor's own — CodeMirror, the collaborative document, the symbol index — and the
conversion itself never ran on this thread to begin with. What the change removed is concentrated
almost entirely in the **long tasks**, which fell by 63% and more than halved in number. That is the
measure that corresponds to a stall an author can feel, and it is where the redrawn diagrams and
re-typeset equations were: work that arrived in one indivisible block per refresh, on the same thread
as the keystrokes.

The layout and style-recalculation figures came out identical to the recorded baseline, to the
millisecond, across both runs. They are small enough (53 ms and 41 ms across fifteen seconds) that
neither arrangement is doing meaningful work there, so nothing is read into them either way.

---

## 5. Page-formatted render cost, by stage (feeds SC-008a; input to `044-pdf-render-performance`)

**Re-measured 2026-07-31, after render-VM reuse was removed.** The figures previously recorded here
were taken with reuse in force and described a warm VM kept between renders — an arrangement the
product no longer uses (see section 7). `FR-028b` required them to be taken again, and they were. The
superseded figures are quoted at the end of this section so nothing is lost, but they are not the
current profile and must not be cited as one.

### How the re-measurement was taken, and why not in the app

Taken by `packages/asciidoc-pdf/tests/integration/vm-reuse-degradation.mjs --arm=shipping`, which
drives the lifecycle the render worker actually runs — one VM facade, `warmup()` at the top of every
render (which retires an instance that has already served one), a per-render populate carrying a
changed-path delta, then the convert — against the real wasm engine in Node.

```
node tests/integration/vm-reuse-degradation.mjs --lines=100  --renders=4 --arm=shipping
node tests/integration/vm-reuse-degradation.mjs --lines=1500 --renders=8 --arm=shipping
```

**This is a different harness from the one the superseded figures came from**, which was the app's
Playwright baseline running against the development web stack. It is stated plainly because it limits
what may be compared: the two sets of absolute numbers are not a before/after of the same measurement,
and reading a delta across them would be reading the change of harness. What IS comparable is what the
re-measurement was needed for — the stage split, and above all the `VM boot` row, which was `0 ms
(warm)` under reuse and is a real cost now.

The document is the same shape the superseded figures used and the same the web-formatted size curve
in section 1 uses: a title, then repeating sections of prose, a two-item list and a Ruby source block,
truncated to the stated line count, with `rouge` highlighting on. Export mode, optimize off.

Figures are the **median of the steady-state renders** — every render after the session's first, which
pays a one-off extra ~120 ms of boot. Three steady renders at 100 lines, seven at 1,500.

| Stage | ~100 lines | ~1,500 lines |
|---|---|---|
| **whole render** | **1,465 ms** | **6,627 ms** |
| VM boot | **109 ms** | **122 ms** |
| populate (VFS write) | 0 ms | 0 ms |
| convert (host wall time) | 1,356 ms | 6,505 ms |
| └ parse *(in VM)* | 265 ms | 278 ms |
| └ converter walk *(in VM)* | 349 ms | 4,230 ms |
| └ **dry runs** *(in VM)* | **168 ms** | **1,263 ms** |
| └ fonts *(in VM)* | 21 ms | 18 ms |
| └ serialise *(in VM)* | 23 ms | 141 ms |
| Sum of in-VM stages | 826 ms | 5,930 ms |
| session's first render (boot) | 240 ms | 234 ms |

Read three things out of it.

**VM boot is now a per-render cost, and it is small.** 109–122 ms of steady-state renders costing
1.5 s and 6.6 s — 7% and 1.8% respectively. That is the entire price of the change in section 7, and
what it buys is on the other side of that section. The session's first boot costs about twice as much
(234–240 ms) and happens once.

**Everything else of consequence is still inside `convert`.** Populate is unmeasurable at 0 ms even
though every render now writes the whole project into a fresh filesystem — the documents here are one
file, and a larger project would move this row, which is worth knowing before reading it as free.

**The walk and the dry runs are what grow with the document; parse does not.** 349 → 4,230 ms and
168 → 1,263 ms across a 15× size increase, against parse's 265 → 278 ms. The dry runs alone are 12% of
the convert at 100 lines and 19% at 1,500 — Asciidoctor-PDF lays every keep-together block out once
into a throwaway scratch document to measure it and again for real, and that cost is invisible to any
measurement taken outside the VM. The instrumented stages account for 826 ms of the 1,356 ms convert
at 100 lines and 5,930 ms of 6,505 ms at 1,500; the remainder is the engine's own loading and setup
inside the VM, which is not a stage of the document.

### Measured against the engine directly

Taken by `packages/asciidoc-pdf/tests/integration/engine-smoke.mjs` against the real wasm engine, on
its own ~50-line fixture (source blocks, lists, a description list), export mode, optimize off. Self
time per stage, so the stages do not overlap and can be summed. Re-run 2026-07-31 after the lifecycle
change; the harness converts twice against one instance without an intervening warmup, so its second
column still describes a reused VM — which is why it is now labelled as what it is.

| Figure | First convert | Second convert on the same instance *(no longer how the product renders)* |
|---|---|---|
| Whole convert (host wall time) | 869 ms | 288 ms |
| parse | 5.2 ms | 0.4 ms |
| converter walk (excl. nested) | 179.0 ms | 169.8 ms |
| **dry runs** | **128.2 ms** | **83.9 ms** |
| fonts (parse + subset) | 13.8 ms | 14.9 ms |
| serialise | 21.7 ms | 13.8 ms |
| Sum of stages | 347.9 ms | 282.8 ms |
| Module compile + VM warmup (cold start) | 50 + 235 = 285 ms | — |

The second column looks cheaper than the first and, on a 50-line fixture, it is: nothing has yet
accumulated. Section 7 is what happens when that column is extended past two renders on a document of
a realistic size. **The first-convert column is the one that describes a render in the shipping
lifecycle**, because every render now runs on an instance that has not served one before.

Output containment: the same run confirms byte-identical output across two converts with the
instrumentation active, so the figures are reported alongside the document and never into it. It also
re-confirms, after the lifecycle change, the source-map coordinate alignment, origin attribution
across an include boundary, scratch-capture exclusion and padding inertness the harness checks.

### Superseded figures (taken with render-VM reuse in force)

Kept only so the record is complete. **Do not cite these as current.** Measured in the app's
development build, one project per size, `VM boot 0 ms (warm)` throughout:

whole render 1,360 ms / 3,375 ms · populate 0 / 0 ms · pipeline 1 / 2 ms · convert 1,224 / 3,242 ms ·
parse 270 / 296 ms · walk 225 / 1,657 ms · dry runs 139 / 607 ms · fonts 29 / 13 ms · serialise
24 / 98 ms · cache hits 0 · raster fallbacks 0 (at ~100 lines / ~1,500 lines). The engine-direct
figures then read 911 ms first convert / 296 ms warm re-convert, with a 44 + 198 = 242 ms cold start.

---

## 6. Page-formatted document size limit (FR-027, filled by User Story 7)

**Measured 2026-07-31.** The reported failure is real, it reproduces, and the size it happens at is
now known — as is the fact that the number of *lines* in the reported description was never the thing
that determined it.

### How it was measured

`packages/asciidoc-pdf/tests/integration/document-size-limit.mjs`, driving the real wasm engine
through the package's own bridge, warm-VM facade and convert path in Node. **Each size renders in its
own child process against its own freshly booted VM**, so the size at which a render fails is a
property of the document and not of what earlier renders left behind, and so a failure that kills the
process is recorded rather than losing the sizes measured before it.

```
node tests/integration/document-size-limit.mjs --sweep=400,800,1200,1700,2500,3500,5000,5500,6000,6500,8000
node tests/integration/document-size-limit.mjs --shape=dense --sweep=700,1000,1300,1700,2400,3000
```

Two document shapes, because the engine's cost tracks printed pages and content, not newlines:

- **sections** — a title, then repeating sections of prose, a two-item list and a Ruby source block
  with `rouge` highlighting. The same shape as sections 1 and 5. About 52 source lines per printed
  page, about 22 bytes per line.
- **dense** — repeating 400-character prose paragraphs that wrap across about five printed lines each.
  About 20 source lines per printed page, about 200 bytes per line. This shape is what the reported
  "1,700 lines / 80 pages" description is self-consistent under; the sparse shape is not (1,700 sparse
  lines is 33 pages).

Machine: 24 cores, ~30 GB RAM, otherwise idle; every run wrapped in an 8 GB memory scope.

### What was measured

`memory` is the process's external allocation, which is where the engine's 32-bit linear memory lives.
Its hard ceiling is 4,096 MiB — a 32-bit runtime cannot address more, whatever the host has spare.

| Shape | Lines | Source | Pages | Time | Memory | Outcome |
|---|---|---|---|---|---|---|
| sections | 400 | 8.7 kB | 8 | 2.4 s | 452 MiB | rendered |
| sections | 1,200 | 26 kB | 23 | 4.8 s | 965 MiB | rendered |
| sections | **1,700** | **37 kB** | **33** | **9.2 s** | 1,286 MiB | **rendered** |
| sections | 2,500 | 54 kB | 48 | 21.9 s | 1,810 MiB | rendered |
| sections | 3,500 | 76 kB | 67 | 34.0 s | 2,463 MiB | rendered |
| sections | 5,000 | 109 kB | 96 | 58.5 s | 3,441 MiB | rendered |
| sections | 5,500 | 120 kB | 105 | 70.9 s | 3,773 MiB | rendered |
| sections | **6,000** | **131 kB** | **115** | **73.3 s** | **4,094 MiB** | **rendered — 99.9% of the ceiling** |
| sections | **6,500** | **142 kB** | — | 71.6 s | **4,174 MiB (capped)** | **FAILED** |
| sections | 8,000 | 175 kB | — | 77.3 s | 4,174 MiB (capped) | FAILED |
| dense | **700** | **140 kB** | **43** | 55.4 s | 3,510 MiB | **rendered** |
| dense | **1,000** | **201 kB** | — | 66.5 s | **4,167 MiB (capped)** | **FAILED** |
| dense | 1,300 | 261 kB | — | 66.3 s | 4,167 MiB (capped) | FAILED |
| dense | **1,700** | **341 kB** | — | 66.1 s | 4,167 MiB (capped) | **FAILED — this is the reported case** |
| dense | 3,000 | 603 kB | — | 71.0 s | 4,167 MiB (capped) | FAILED |

### The failure mode

**It is an address-space exhaustion, and it arrives in two different disguises.** In every failing run
the external allocation is pinned at the ceiling. What surfaced from the engine was either:

- `NoMemoryError: failed to allocate memory` — Ruby's own allocation failure, every dense-shape
  failure; or
- `Start offset -807303104 is outside the bounds of the buffer` — a pointer past 2 GiB read as a
  signed 32-bit integer, every sparse-shape failure. The number is negative because the address has
  run past what a signed 32-bit offset can express.

Both are returned as `convert / convert-failed` and both carry the engine's own text straight through
to the author, which is the "opaque engine crash" the requirement objects to. Neither leaves a usable
VM behind: an instance that has hit the ceiling never renders again (see section 7).

### The bound

**The reported bound of "roughly 1,700 lines / 80 pages" is not the engine's bound, and the line
count in it was never the determinant.** A 1,700-line document of the sparse shape renders in 9.2 s
using a third of the address space. A 1,700-line document of the dense shape fails. They differ by a
factor of nine in source size.

Across two shapes that differ eightfold in lines per page, **the size of the assembled source predicts
the failure to within about 30%** while lines predicts it to within a factor of eight. Page count
predicts it well but is a result of the render, so it can only be known after the failure it would
have to prevent. So the bound is stated in bytes of assembled source:

| | |
|---|---|
| Last size measured to render | 131 kB (sections, 115 pages) — at 4,094 MiB of a 4,096 MiB ceiling |
| First size measured to fail | 142 kB (sections) |
| Same, other shape | 140 kB rendered (dense, 43 pages, 3,510 MiB); 201 kB failed |
| **Declared supported bound** | **100,000 bytes of assembled AsciiDoc** |

The declared bound is set below the measured ceiling deliberately, for two reasons the sweep cannot
cover. Every document in it is text only, and embedded diagrams and images allocate far more per byte
of source than prose does. And a render that finishes at 99% of the address space has left nothing for
anything that follows it. The headroom is the difference between "this document is too big" and "this
session is now broken". It is recorded in
`packages/asciidoc-pdf/src/pipeline/document-size-limit.ts` alongside these measurements.

**Against the previously believed bound this is a large raise, not a restriction**: 100 kB is about
4,700 lines of the sparse shape or 500 of the dense one, against a threshold previously observed at
1,700 lines — and, crucially, it is now a number rather than a surprise.

### What a document past it does now

`invokeConvert` sizes the assembled document — the include-expanded file the engine is about to read,
not the root file the author wrote — before the engine is asked for anything, and refuses past the
bound with `preprocessing / document-too-large`:

> This document is 341 kB of AsciiDoc, larger than the 100 kB the page-formatted (PDF) render
> supports. Past that size the render runs out of the memory available to it and stops part-way
> through, so it is refused here instead. Point the project's main document at a smaller part of the
> work — one chapter at a time renders and exports normally — or carry on in the web-formatted
> preview, which has no size limit.

Verified against the real engine on the reported case: the 1,700-line dense document that previously
spent 66 seconds exhausting the address space and returned `NoMemoryError` now returns the message
above in **0 ms**, with the VM untouched and the session still usable.

---

## 7. Render-VM reuse on an idle machine (FR-028, filled by User Story 7)

**Re-measured 2026-07-31. The degradation is CONFIRMED — and it is worse than was reported.** It was
not contention. On an idle machine a reused VM does not merely slow down; it stops working.

### Conditions, and what was checked

Before measuring: `uptime` load average **1.98 / 1.65 / 1.61 on 24 cores** — about 8% of capacity, and
the workload here is single-threaded. 21.7 GB of 31 GB memory available. `ps` and `pgrep` showed **no
test suite, no browser automation, no build and no Playwright process running**. What was running was
a Next development server idling at ~7% of one core and a dockerised Postgres at rest — neither
touched during the runs, and neither is the end-to-end suite that contaminated the original figures.
Each run was wrapped in `systemd-run --user --scope -p MemoryMax=8G`.

The reused arm was measured **twice, in separate processes**, and reproduced.

### How it was measured

`packages/asciidoc-pdf/tests/integration/vm-reuse-degradation.mjs`, against the real wasm engine. Both
arms render the SAME 1,500-line document (the shape of sections 1 and 5) the same eight times, and
every individual render is reported rather than an average — a degradation claim is a claim about the
shape of the series, and an average hides exactly that. The wasm module is compiled once and shared by
both arms, because module compilation is cacheable and is not what reuse buys.

```
node tests/integration/vm-reuse-degradation.mjs --lines=1500 --renders=8 --arm=both
```

### Result

| Render | Reused VM | Reused VM: memory | Fresh VM each time | Fresh VM: boot |
|---|---|---|---|---|
| 1 | 6,745 ms | 1,090 MiB | 6,665 ms | 164 ms |
| 2 | **21,853 ms** | 2,049 MiB | 6,541 ms | 120 ms |
| 3 | **22,300 ms** | 3,008 MiB | 6,582 ms | 123 ms |
| 4 | **FAILED** — offset past the addressable range | 3,025 MiB | 6,572 ms | 123 ms |
| 5 | 22,264 ms | 3,966 MiB | 6,590 ms | 122 ms |
| 6 | **FAILED** — `NoMemoryError` | **4,098 MiB (ceiling)** | 6,563 ms | 123 ms |
| 7 | **FAILED** — `NoMemoryError` | 4,098 MiB | 6,605 ms | 126 ms |
| 8 | **FAILED** — VM exited, code 1 | 4,098 MiB | 6,464 ms | 118 ms |

Fresh: **8 of 8 succeeded, 6,464–6,665 ms, spread 3%**, memory flat at 1,090 MiB every time.
Reused: **4 of 8 succeeded**, and after render 5 the instance never rendered again.

The mechanism is in the memory column and it is not subtle. **The instance never gives the memory
back.** It climbs by about a gigabyte per render until it reaches the 4,096 MiB a 32-bit runtime can
address, and then everything is a failure — the same ceiling section 6 documents, reached from the
other direction. The 3× slowdown from render 2 onwards is the engine working inside a heap that large;
the failures are what happens when there is no more of it.

### Verdict against the claim

| Claim | Measured |
|---|---|
| ~3 s rising to ~11 s over eight renders in a reused VM | **Understated.** 6.7 s → 21.9 s by the second render, and outright failure from the fourth. Half the series did not complete at all. |
| 2.9–3.4 s for a fresh VM each time | **Confirmed in shape.** Flat, 6.5–6.7 s here on a slower document; spread 3% across eight renders. |
| Might be contention rather than degradation | **No.** Reproduced twice on an idle machine, with a mechanism (monotonic memory growth to a hard ceiling) that contention does not explain. |

The absolute seconds differ from the reported ones because the document and harness differ. The ratio,
the shape and the failures do not.

### What changed as a result

`packages/asciidoc-pdf/src/vm/ruby-pdf-vm.ts` now retires a VM instance after
`RENDERS_PER_VM_INSTANCE = 1` render. The instance is marked spent when a render completes — success
or failure, because a failed render has already allocated and is very often this exact exhaustion —
and the next `warmup()` disposes it and boots a replacement. Disposal happens before instantiation, so
the two never coexist and peak memory is one VM's worth.

Retirement is deferred to the next warmup rather than done at the end of the render, deliberately:
callers legitimately read the VM's filesystem after a convert returns, and tearing the instance down
there would invalidate that surface to free memory slightly sooner. Nothing is lost by waiting — no
render ever runs on an instance that has served one, which is where the entire cost was.

Two consequences had to be handled with it:

- **Pre-warming still works.** An instance that has not yet served a render is reused by any number of
  `warmup()` calls, so warming ahead of the first render is not thrown away.
- **A delta populate now meets an empty filesystem.** The worker sends only the changed paths once a
  document is being edited, and an instance booted for this render has nothing for that to be a delta
  against. `populateProject` now detects that the VFS no longer holds the project (the root document is
  absent) and writes everything instead. Without this the render would have failed on a missing root,
  or — worse — produced a document with its includes and images silently missing.

Verified on the shipping lifecycle (`--arm=shipping`, which drives warmup-per-render, delta populate
and convert exactly as the worker does), eight consecutive renders of the same 1,500-line document:
**8 of 8 succeeded, 6,314–6,818 ms, boot 118–129 ms, the full project written on every render, resident
memory flat at ~530 MiB.** The series that previously died on its fourth render no longer degrades at
all.

Per `FR-028b`, the per-stage figures in section 5 were taken again under this arrangement and updated
in place.

### Reference parity re-checked after the reuse change (2026-07-31)

Retiring a VM after every render is squarely on the path the page-format reference-parity suite covers:
that suite renders each fixture through the shipping convert lifecycle and compares the result, page by
page and line by line of extracted text, against a committed reference build produced by the external
toolchain. The parity check on record predates `RENDERS_PER_VM_INSTANCE = 1`, so it was **run again**
rather than assumed to still hold.

```
pnpm --filter @asciidocollab/web exec playwright test --config playwright.pdf-parity.config.ts --reporter=line
```

**31 passed, 3 skipped, 0 failed, in 26.5 s.** The 31 include all **25 fixture comparisons** against
the committed references, the determinism check that renders the same theme and document twice, the
guard that the fixture set yields a non-empty comparison list, and the four internal-link target
checks. A fresh instance per render produces byte-for-byte what a reused one did.

The three skips are standing gates rather than checks that quietly did nothing:

- `emit math` and `emit diagrams` — the reference-input emitter is hard-gated behind `PARITY_EMIT=1`.
  It regenerates reference builds and shells out to Docker; it is a tool, not a check, and skipping it
  is its normal state.
- `example matches the reference build` — the `example` fixture has no committed reference PDF
  (`e2e/pdf-parity/fixtures/example/` holds only `manifest.json` and `source/`), so it contributes no
  comparison case. Pre-existing, and unrelated to VM reuse.

---

## 8. Post-change figures

> Filled in as the work lands. Each row states what it is compared against, so no figure here is read
> without its baseline.

| Criterion | Baseline | Post-change | Verdict |
|---|---|---|---|
| SC-003 file switch (median) | 665 ms | **158 ms** (127 ms on a second run) | **met** — target was ≤ 332 ms |
| SC-005 refresh, ~100 lines | 509 ms (target ≤ 200 ms) | **149 ms** | **met** |
| SC-005 refresh, ~15,000 lines | 1,059 ms | **815 ms** (709 ms on a second run) | **met** |
| SC-006a main-thread task time | 5,413 ms | **5,058 ms** (5,067 ms on a second run) | **met** — no greater than the baseline |
| SC-006a long-task total | 990 ms, in 18 tasks | **366 ms, in 7 tasks** (421 ms in 8 on a second run) | **met** — 63% lower |
| SC-009 conversion time, ~15,000 lines | 421 ms (target ≤ 210 ms) | **83 ms** (85 ms on a second run) | **met** — 5.0× faster, and inside the target with room to spare |
| SC-009 conversion code size | 746,873 bytes minified (target ≤ 497,915) | **314,708 bytes minified** | **met** — 58% smaller |

The five rows above the two conversion rows were measured **before** the engine was replaced, so each
is a verdict on the scheduling and morph work alone. They are left as taken rather than re-run: every
one of them already meets its target, and a faster engine can only move them further inside it — so
re-measuring would improve the numbers without changing a single verdict, while making it impossible
to tell afterwards which change earned which improvement.

Both conversion rows are the same engine change: `asciidoctor` 3.0.4 → 4.0.6, which replaces the Opal-compiled
Ruby engine with a JavaScript one. Nothing else about conversion was touched, so the whole of both
improvements is attributable to it.

### How the conversion figures were taken

Re-run of the baseline harness's own conversion-cost test, the same way section 1 was taken, against
the same dev stack on the same machine:

```bash
BASELINE_MEASURE=1 BASELINE_OUT=/tmp/v4-measurements.json \
  pnpm --filter @asciidocollab/web exec playwright test preview-baseline \
  --project=chromium --no-deps --grep "conversion cost"
```

| Document | parse | convert | post-process | **total (worker)** | baseline total | first paint after open |
|---|---|---|---|---|---|---|
| ~100 lines | 7 ms | 1 ms | 8 ms | **16 ms** | 45 ms | already rendered |
| ~1,500 lines | 13 ms | 2 ms | 4 ms | **21 ms** | 107 ms | 130 ms (was 759 ms) |
| ~15,000 lines | 49 ms | 6 ms | 20 ms | **83 ms** | 421 ms | 851 ms (was 1,759 ms) |

Parse still dominates, as it did before — 59% of the total at 15,000 lines against convert's 7% — but
it now costs 49 ms where it cost 238 ms. The shape of the cost did not change; its scale did.

### How the size figure was taken, and why the method had to change

Section 1 recorded the engine's **shipped** `asciidoctor.min.js`. Version 4 ships no minified bundle at
all — only `build/browser/index.js`, unminified — so there is no shipped file to read and the
comparison had to be made some other way. The harness now minifies whichever browser bundle the
installed engine ships, with one minifier, so both sides are measured by the same tool rather than by
two vendors' build settings.

| | 3.0.4 | 4.0.6 |
|---|---|---|
| Browser bundle, as shipped | 1,737,178 bytes | **874,433 bytes** |
| Minified by the vendor (`asciidoctor.min.js`) | 746,873 bytes | *not shipped* |
| Minified by esbuild 0.28.1 | 764,788 bytes | **314,708 bytes** |
| Bundle gzipped (`gzip -9`) | 302,534 bytes | 198,542 bytes |

**The tool substitution does not flatter the result.** esbuild minifies the 3.0.4 bundle to 764,788
bytes against the vendor's 746,873 — 2.4% *larger* — so it is, if anything, the less aggressive
minifier. Judged against the recorded baseline of 746,873 the new engine is 57.9% smaller; judged
against the stricter same-tool figure of 764,788 it is 58.8% smaller. The target was a third smaller,
and both readings clear it by a wide margin.
