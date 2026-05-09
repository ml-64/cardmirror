# Decisions log

Append-only log of implementation decisions and their rationale. Each
entry has a date, a one-line summary, and the reasoning.

## 2026-05-08: TypeScript + raw ProseMirror + Vite + Vitest

**Stack:**
- **TypeScript 5.x** — universal for ProseMirror projects; strong
  typing helps with schema correctness.
- **Raw ProseMirror** (not TipTap) — direct schema control matters here
  because we have non-trivial schema requirements (custom node types,
  stable heading IDs, scratchpad nesting, link marks). TipTap is a
  productive wrapper but adds a layer of indirection we don't need.
- **Vite** — modern, fast, works for both library and app builds.
- **Vitest** — first-class TS support, integrates with Vite, fast.

**Rejected alternatives:**
- TipTap: see above.
- Webpack: heavyweight; Vite is the default for greenfield TS projects.
- Jest: slower than Vitest for TS, more config friction.

## 2026-05-08: jszip + fast-xml-parser for OOXML

**Stack:**
- **jszip** — well-known, mature, isomorphic (browser + Node).
- **fast-xml-parser** for parsing — fast, returns plain JS objects
  rather than DOM, easy to traverse.
- **Hand-rolled emission** for writing — OOXML output is templated and
  we control all the namespaces and formatting; a heavy XML lib adds
  more friction than it removes for our specific patterns.

**Rejected alternatives:**
- `@xmldom/xmldom`: full DOM API, but heavier than we need.
- `xmlbuilder2`: nice fluent emit API, but two-libs-one-job feels
  unnecessary when we control all the patterns.
- `xml2js`: older, less performant.

## 2026-05-08: Single package, monorepo deferred

Starting with a single package containing schema + import + export +
(eventually) editor. We'll split into a monorepo (`@prosemirror-debate/schema`,
`@prosemirror-debate/docx-converter`, etc.) only if web/desktop divergence
or external publication forces it. YAGNI for v0.

## 2026-05-08: Stable heading IDs via crypto.randomUUID()

Per `ARCHITECTURE.md §4`, every heading-level node gets an `id` attr.
Generated with `crypto.randomUUID()` (Node-built-in, no extra dep).
Round-tripped to docx as bracketing `<w:bookmarkStart w:name="..."/>` /
`<w:bookmarkEnd/>` markers around the heading paragraph.

The bookmark name pattern is `pmd-heading-<uuid>` — the `pmd-` prefix
namespaces our bookmarks so we can distinguish them from existing
Verbatim bookmarks (e.g., the VirtualTub flow uses bookmarks for its own
purposes per `NOTES-verbatim.md §4`).

## 2026-05-08: Inline node IDs not initially required

Heading IDs are required for transclusion targeting. Inline runs and
non-heading paragraphs do not need stable IDs in v0 — there's no feature
yet that targets them.

## 2026-05-08: Schema marks vs nodes for Cite/Analytic/Undertag

Per `ARCHITECTURE.md §4`, Cite/Analytic/Undertag are linked
paragraph+character pairs in OOXML. We model each as **both a block
node and a mark**:
- `<w:pStyle w:val="Analytic"/>` on a paragraph → block node `analytic`
- `<w:rStyle w:val="AnalyticChar"/>` on a run → mark `analytic_mark`
- Same for Undertag and Cite.

Export reverses: block-node → pStyle on the paragraph; mark → rStyle on
the run. This matches how Word's linked styles actually work and keeps
both representations available without forcing a one-shape-fits-all
decision.

## 2026-05-08: Direct-formatting marks chosen explicitly

Direct formatting captured as marks, not node attributes:
`bold`, `italic`, `font_color`, `font_size`, `highlight`, `shading`,
`link`, plus the named-style emphasis marks (cite_mark, underline_mark,
emphasis_mark, undertag_mark, analytic_mark).

Reasoning: marks compose freely on text ranges; attributes on nodes
would make sub-paragraph formatting awkward. ProseMirror's mark system
is exactly designed for this.

## 2026-05-08: "underline_mark" emits both rStyle AND direct underline

Per `NOTES-verbatim.md §5` gotcha #1, Verbatim's own code commits the
dual representation. Our exporter emits both `<w:rStyle w:val="StyleUnderline"/>`
*and* `<w:u w:val="single"/>` for any text carrying `underline_mark`.
Importer recognizes either form (style ref OR direct prop) as the mark.

## 2026-05-08: Node.js v24.15.0 LTS, installed user-local

Installed Node.js LTS to `~/.local/opt/node-v24.15.0-linux-x64/`,
symlinked binaries into `~/.local/bin/`. No system-wide install (no
sudo available). This affects only the project owner's user account.

## 2026-05-08: Schema design — heading-level nodes are flat paragraphs

Initial schema design had pocket/hat/block as tree containers with
their `inline` content nested inside. But docx represents these as
*paragraphs with Heading1-3 styles in document order*, with hierarchy
implicit via outline level — there is no docx-level "Pocket contains
Hat" containment. Round-tripping the tree-container model would
require synthesizing/dropping container boundaries on import/export,
which is awkward.

Resolution: pocket / hat / block / analytic / undertag are flat
paragraph nodes with `inline*` content. Card *is* a tree container
because the user values cards as objects (move-card, send-to-speech).
The "Pocket contains the following Hats and Blocks" tree-shaped view
is built dynamically by the navigation panel, not stored in the
schema.

Trade-off: the schema doesn't enforce well-formed outline hierarchy
(can't say "a Block inside a Pocket can't have a Hat between them").
That validation, if needed, lives at a higher layer.

## 2026-05-08: Cite paragraph classification on import is heuristic

When the importer sees `Tag → Normal → Normal → ...`, it classifies
the FIRST Normal as `cite_paragraph` and subsequent Normals as
`card_body`. Real docs always or nearly-always have this shape, so
the heuristic is fine for v0. A smarter classifier (text-shape based)
can replace it later if we encounter mis-classifications.

## 2026-05-08: Reverted paragraph-default rPr inheritance entirely

User flagged that an analytic paragraph with `<w:pPr><w:rPr><w:u/></w:rPr></w:pPr>`
was rendering ALL of its text underlined when only some runs should be.
Inspecting the OOXML spec (17.7.5.10):

> The rPr element ... when it is the child of a pPr element, the run
> properties are applied to the glyph used to represent the physical
> location of the paragraph mark.

So `<w:pPr>/<w:rPr>` defines the formatting of the paragraph-mark glyph
(the ¶), not the runs in the paragraph. Runs are formatted by their
own `<w:rPr>` and the `<w:pStyle>`'s linked character style. They do
NOT inherit from `<w:pPr>/<w:rPr>`.

Earlier in this session I had introduced inheritance of `<w:pPr>/<w:rPr>`
onto runs, motivated by a (mis-)reading of the survey notes about
"mass highlighting affecting pPr/rPr." That's now reverted. The
importer reads each run's own rPr only and ignores pPr/rPr's run
properties.

Round-trip impact: mark counts on Aff went from ~17,791 underline_marks
(inflated by bogus inheritance) down to 16,311, matching the survey's
ground-truth count of 16,211 StyleUnderline rStyle uses + ~100 runs
that have direct `<w:u>` (no rStyle). Round-trip remains lossless.

## 2026-05-08: Named-style marks override paragraph-default font_size on import (now obsolete)

(This decision rests on paragraph-default rPr inheritance, which was
reverted above. Both this and the inheritance behavior are gone.)

User feedback while reviewing the v0 playground: in shrunk imported
docs (where the shrink macro sets paragraph-default `<w:sz w:val="16"/>`
to render the body at 8pt), underlined/emphasized text was rendering
at 8pt instead of staying at the canonical 11pt. The user expected
contrast — small body, full-size underline.

Root cause: my `mergeMarks` was inheriting paragraph-default font_size
onto every run, including runs that have a named-style mark
(underline_mark / emphasis_mark / cite_mark / etc.). Per OOXML's
character-style cascade, the named character style's implicit font
size declaration (e.g., StyleUnderline → sz=22 / 11pt) overrides the
paragraph default. Word renders accordingly.

Fix: in `mergeMarks`, skip inheriting `font_size` from defaults when
the run has any named-style mark. The run renders via its CSS class's
inherited size (typically 11pt from #editor). An explicit run-level
`<w:sz>` still applies (becomes a font_size mark on the run, wins via
inline style on the inner span).

Round-trip remains lossless — the fix changes what marks get attached
on import, but per-run explicit sizes are still preserved both ways.

## 2026-05-08: Undertags absorbed into cards (don't end card boundary)

User feedback while reviewing the v0 playground: an undertag paragraph
following a tag was breaking the card's hover-bar continuity, because
the undertag wasn't included in the card's content expression and ended
up as a sibling of the card.

Schema fix: card content expression is now
`tag undertag* (cite_paragraph | analytic)? card_body*`. Undertags
attached to a tag belong inside the same card.

Importer also updated: after consuming the tag, the card-grouping pass
absorbs any number of undertags before looking for cite/analytic/body.
Standalone undertags (between cards) are still legal at doc-level
positions, just not orphaned within a card sequence.

## 2026-05-08: Paragraph-default rPr inheritance with named-style guard

Real docx files (per `NOTES-verbatim.md §6`) put mass-applied
formatting on a paragraph's default run properties (`<w:pPr><w:rPr>`),
not per-run. Runs inherit these unless they specify a conflicting
property.

Subtle bug discovered during round-trip testing: named-style marks
(cite_mark, underline_mark, emphasis_mark, undertag_mark, analytic_mark)
all map to the same OOXML slot — `<w:rStyle>`. A run can only carry
one rStyle. If the paragraph default has rStyle=StyleUnderline and a
run has rStyle=Style13ptBold, naive merging gives the run BOTH marks
in our schema, but on re-export only one rStyle is emitted, silently
dropping the other.

Fix: in `mergeMarks`, named-style marks are treated as a single slot.
If a run has any named-style mark, ALL named-style marks from
defaults are dropped (run wins). Other mark types (highlight, bold,
font_color, etc.) merge normally.

Round-trip on real docs confirmed: all 126 tests pass with the merge
fix in place.

## 2026-05-09: Retired the `scratchpad` node

Originally introduced as a "schema escape hatch" for messy or
unstructured regions when the schema was a strict tree
(`pocket → hat → block → card`). After the 2026-05-08 refactor making
heading-level nodes flat paragraphs, the doc's `BLOCK_CONTENT` became
permissive enough to accept loose paragraphs, headings, cards, and
analytic_units in any order at any position. A `<div class="pmd-scratchpad">`
wrapper with the same content model added no structural value — every
real use case (bridge text between cards, "Patch Notes" notes, loose
paragraphs under a Block heading) is already handled by plain
`paragraph` blocks at doc level.

Considered repurposing it for nav-pane suppression (headings inside a
scratchpad would be skipped from the outline) but the project owner
doesn't want that behavior — existing docs use heading-styled scratch
content (the "Patch Notes" pattern) and *do* want it visible in the
nav.

Changes:
- Removed `scratchpad` from `nodes.ts` and from `BLOCK_CONTENT`.
- Importer's three scratchpad fallback paths (failed analytic_unit
  construction, failed card construction, failed top-level doc) now
  emit children directly into the doc, coercing tags/analytics into
  their required wrappers via `coerceToDocChild` (renamed from
  `coerceToScratchpadChild`).
- Exporter no longer treats `scratchpad` as a transparent container.
- Editor starter doc, CSS, and tests updated.

All 137 tests pass.

## 2026-05-09: Paragraph absorption rule for loose paragraphs after a card

Settles one of the §14 editing-semantics open questions. The rule: a
top-level `paragraph` whose immediate previous sibling is a `card` or
`analytic_unit` is auto-absorbed into that container as a `card_body`.
A heading (Pocket / Hat / Block) breaks the absorption zone, so the
escape mechanism for "I want loose paragraphs after this card" is to
insert a heading first.

Why not encode this in the schema: ProseMirror content expressions are
context-free, so they can't say "paragraph is illegal after a card but
legal after a heading." Two alternatives both fail in different ways:
- Drop `paragraph` from the doc content entirely → kills the legitimate
  Block → paragraph → Tag pattern (loose bridge text between a section
  heading and its cards).
- Wrap headings in a `section` container that owns its loose paragraphs
  → much bigger refactor of the doc shape, gains little.

Implementation: `src/editor/absorb-plugin.ts`, an `appendTransaction`
plugin that runs after every doc-changing transaction. Walks doc-level
children once, rebuilds any card / analytic_unit that needs to grow,
and replaces doc content with the new fragment. Returns null (no
transaction) when the doc already complies, so steady-state edits are
free.

The rule matches what the importer already produces — `Importer`'s
card-grouping pass greedily absorbs Normal paragraphs after a tag as
`card_body` until the next heading. The plugin is the runtime
counterpart that prevents users from constructing the same broken state
mid-edit.

Starter doc updated: the demo "loose paragraph" was moved to between
the Block heading and the first card, so it sits in a position the
absorption rule preserves rather than auto-absorbing on first edit.
