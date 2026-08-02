# Upstream report: Asciidoctor.js 4.0.6 emits the obsolete `<col width>` attribute

**Found during**: `043-preview-responsiveness`, upgrading `asciidoctor` 3.0.4 → 4.0.6
**Status**: worked around locally; not yet reported upstream
**Where to report**: <https://github.com/asciidoctor/asciidoctor.js/issues>

## Summary

Converting a table with column widths, 4.0.6 writes the column width as a **presentational HTML
attribute** where every other Asciidoctor writes it as a **style**:

```html
<!-- Asciidoctor.js 3.0.4, and Ruby Asciidoctor 2.0.26 -->
<col style="width: 25%;">

<!-- Asciidoctor.js 4.0.6 -->
<col width="25%">
```

The `width` attribute on `<col>` is obsolete in HTML5 (it is listed among the obsolete presentational
attributes, and the spec's guidance is to use CSS). The same substitution appears on the horizontal
description list's `labelwidth`/`itemwidth` output.

This looks like a porting slip in the JavaScript rewrite rather than a deliberate change of output:
nothing in the 4.0 release notes proposes changing the HTML5 converter's column-width form, and the
version reports core 2.0.26 — the very version that emits the style form.

## Why we are confident it is a regression, not an intended change

Two independent oracles agree *against* 4.0.6, and both are the same engine's own output:

| Toolchain | Output |
|---|---|
| `asciidoctor` (JS) **3.0.4** | `<col style="width: 25%;">` |
| Ruby Asciidoctor **2.0.26** (the core version 4.0.6 itself reports), run in a pinned container | `<col style="width: 25%;">` |
| `asciidoctor` (JS) **4.0.6** | `<col width="25%">` |

That is how we found it: a render-equivalence suite compares our web preview both against fixtures
captured from the previous engine and against a canonical Ruby toolchain rendering the same source.
The upgrade turned both comparisons red, on this and nothing else — across a corpus covering headings,
anchors and cross-references, source blocks, tables, lists, admonitions, footnotes, callouts,
attributes and conditionals, an include tree with `leveloffset`, diagrams, equations and images, every
other byte was identical.

## Reproduction

```adoc
= Table Column Widths

[cols="1,2,1", options="header"]
|===
| Column A | Column B | Column C

| a1 | b1 | c1
|===
```

```js
import { load } from 'asciidoctor';          // 4.0.6
const document_ = await load(source);
console.log(await document_.convert());
// …<colgroup><col width="25%"><col width="50%"><col width="25%"></colgroup>…
```

Against 3.0.4 (`Asciidoctor().load(source).convert()`) the same source yields
`<col style="width: 25%;">` for each column.

## Where it comes from

`@asciidoctor/core` 4.0.6, `src/converter/html5.js` — the table converter's `<col>` branch (around
line 1199 in the published package), and the matching branch that writes a horizontal description
list's label and item widths (around lines 738–746).

## What we did about it, and why

We kept 4.0.6 — the upgrade is 5× faster to convert and 58% smaller — and correct the output back to
the canonical form in our own render worker
(`apps/web/src/workers/asciidoc-render.worker.ts`, `restoreColumnWidthStyles`).

Two things about that choice are deliberate:

- **The correction is in our code, not in the comparison.** Teaching the equivalence gates to accept
  either spelling would have retired their ability to notice a column-width change at all, which is
  most of what those gates are for. The gates still demand the canonical form; our worker produces it.
- **It disappears on its own.** The correction matches only the attribute form, so the day the engine
  emits the style form it becomes a no-op, with no second change needed here and the gates still
  checking.

## Suggested upstream fix

Restore the style form in both branches, matching Ruby Asciidoctor 2.0.26's HTML5 converter, so the
JS and Ruby implementations of the same core version produce the same document.
