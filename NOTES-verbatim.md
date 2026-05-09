# Verbatim — style manipulation reference

Notes from reading `reference-docs/verbatim/desktop/src/` (VBA). Source paths
below are relative to that directory unless stated otherwise.

The headline takeaway for our docx contract: **Verbatim's document model is
*hybrid*** — structural meaning lives in **named Word styles + outline level**,
while emphasis/highlighting is split awkwardly between **named character
styles** AND **direct character formatting**, and the two layers interact.

---

## 1. Style vocabulary (the canonical names)

### Paragraph styles (structural hierarchy)

Each is bound to a specific Word `OutlineLevel`. In OOXML, the style is keyed
by `w:styleId="HeadingN"` with the debate-specific name carried as an
`<w:aliases>` element. Word's UI displays this as the comma-joined string
`Heading N,Alias` and Verbatim's VBA matches against that joined form
(`NameLocal`), but at the docx level the canonical identifier is the styleId.

| Alias       | styleId      | Aliases element        | OOXML outlineLvl | Hotkey | Role                          |
|-------------|--------------|------------------------|------------------|--------|-------------------------------|
| Pocket      | `Heading1`   | `Pocket`               | `0` (Level 1)    | F4     | Top-level section             |
| Hat         | `Heading2`   | `Hat`                  | `1` (Level 2)    | F5     | Subsection                    |
| Block       | `Heading3`   | `Block`                | `2` (Level 3)    | F6     | Sub-subsection                |
| Tag         | `Heading4`   | `Tag`                  | `3` (Level 4)    | F7     | Card label / argument tag     |
| Normal/Card | `Normal`     | `Normal/Card` (display alias) | body text  | —      | Card body (evidence text)     |

(OOXML `outlineLvl` is 0-indexed; Word's `wdOutlineLevelN` is 1-indexed, so
`outlineLvl=3` ↔ `wdOutlineLevel4`.)

Each `HeadingN` also has a linked character style `HeadingNChar`
(`<w:link w:val="HeadingNChar"/>`) so inline application works transparently.

References: `Formatting.bas:648-662` (RemoveExtraStyles allowlist),
`Settings.bas:347-350` (hotkeys), `Debate.dotm:word/styles.xml` lines
396-509 for the canonical definitions.

### Character styles (emphasis)

Same `styleId + aliases` pattern as the headings: the styleId is what
appears in `<w:rStyle>` references in the docx, while the alias is the
short name Verbatim's VBA matches via `NameLocal`. Easy to confuse.

| Alias     | styleId          | Aliases element | Hotkey | Role                                  |
|-----------|------------------|-----------------|--------|---------------------------------------|
| Cite      | `Style13ptBold`  | `Cite`          | F8     | Author/date metadata within a card    |
| Underline | `StyleUnderline` | `Underline`     | F9     | Underlined chunks of evidence text    |
| Emphasis  | `Emphasis`       | (none)          | F10    | High-emphasis chunks (often + yellow highlight) |

So when reading real docx files, expect `<w:rStyle w:val="Style13ptBold"/>`
and `<w:rStyle w:val="StyleUnderline"/>` — the names `Cite` and `Underline`
appear nowhere in the OOXML for these character styles.

References: `Formatting.bas:673-677`, `Settings.bas:256/258/351`,
`Debate.dotm:word/styles.xml:642-668`.

### Legacy / cleanup-only

- `Analytic*` — in **stock** Verbatim, any style whose name starts with
  `analytic` (case-insensitive) is rewritten to `Tag` by
  `ConvertAnalyticsToTags` (`Formatting.bas:604-610`). See §7 below for how
  this project's custom variant repurposes the name.

---

## 2. Direct formatting layered on top

These are **not** styles; they're direct character properties that Verbatim
reads/writes alongside styles:

- **Highlight color** — `range.HighlightColorIndex` (yellow/blue/red/green/teal/…).
  *There is no "Highlighted" style.* All highlighting is direct formatting.
  Color name ↔ enum: `Formatting.bas:193-232`.
- **Font size** — direct override; shrink cycles 11 → 8 → 7 → 6 → 5 → 4 → Normal
  (`Shrink.bas:60-77`).
- **Bold** — direct only; e.g. `FixFakeTags` reclassifies bold body-level text
  bigger than the Underline style's size as a Tag (`Formatting.bas:592-602`).
- **Font.Underline** — both a style (`Underline`) *and* a direct property.
  Comment at `Formatting.bas:19` explicitly notes that style-only checks don't
  work; you must inspect both.
- **Font color** — used for marker annotations (e.g. red "Marked [time]"
  inserted by `Paperless.SendToSpeech`).
- **Pilcrow glyph** — Unicode ¶ (Win char code 182, Mac 166), forced to 6 pt
  non-bold non-underlined; Verbatim uses these to *encode* paragraph breaks
  inside a condensed run while keeping it visually one paragraph
  (`Condense.bas:27-28, 110`).

### Coexistence rules

- Applying the `Underline` style sets `Font.Underline` too (and removing the
  style does not always clear the property — hence the dual checks).
- The `Emphasis` style is sometimes paired with yellow highlight; some cleanup
  paths re-pair them deliberately (`Formatting.bas:826-875`).
- Direct font size overrides whatever the style declares.
- `ClearFormatting()` clears both layers but leaves paragraph style at `Normal`.

---

## 3. Operations catalog (user-facing, ribbon-bound)

Routing happens in `Ribbon.bas:RibbonMain()` which dispatches to
module-level subs. Grouped below by what they touch.

### a) Apply structural styles
- F4 / F5 / F6 / F7 → Pocket / Hat / Block / Tag (`Settings.bas:347-350`)
- F8 → Cite character style (`Settings.bas:351`)

### b) Emphasis & highlighting
- `Formatting.ToggleUnderline` (F9, `Ribbon.bas:256`) — toggle Underline style.
- `Formatting.UnderlineMode` (`Formatting.bas:6`) — interactive "underline as
  you type" loop until toggled off.
- `Formatting.AutoUnderline` (`Formatting.bas:407-506`) — analyzes the *Tag*
  for synonyms, scores chunks of card text, applies `Underline` if score ≥ 0.1
  and (optionally) `Emphasis` if ≥ 0.25.
- `Formatting.AutoEmphasizeFirst` (`Formatting.bas:508-513`) — emphasizes the
  first character of each word in selection.
- `Formatting.UniHighlight` (`Formatting.bas:120-148`) — recolor every
  highlight in the doc to a chosen color.
- `Formatting.UniHighlightWithException` (`Formatting.bas:150-191`) — same,
  but skip one configured color.
- `Formatting.RemoveEmphasis` (`Formatting.bas:515-543`) — find/replace
  Emphasis → Underline (with confirmation).
- `Formatting.RemoveNonHighlightedUnderlining` (`Formatting.bas:987-1029`).

### c) Shrink / condense / expand
- `Shrink.ShrinkAllOrCard` (`Shrink.bas:4`) — cycle font size on current card,
  or whole doc if cursor is in empty area.
- `Shrink.ShrinkAll` / `Shrink.UnshrinkAll` (`Shrink.bas:149-176`).
- `Shrink.ShrinkPilcrows` (`Shrink.bas:178-225`) — force pilcrows to 6pt clean.
- `Condense.CondenseNoPilcrows` / `CondenseWithPilcrows` / `Uncondense`
  (`Condense.bas:20-245`) — collapse a card's whitespace, optionally encoding
  paragraph breaks as 6pt pilcrows.
- `Condense.RemovePilcrows` (`Condense.bas:247-296`).

### d) Structural reorganization
- `Paperless.MoveUp` / `MoveDown` / `MoveToBottom`
  (`Paperless.bas:397-583`) — outline-aware reordering.
- `Paperless.SelectHeadingAndContent` (`Paperless.bas:254-295`) — select a
  heading and everything under it down to the next same-or-larger heading.
- `Formatting.AutoNumberTags` / `DeNumberTags` (`Formatting.bas:545-590`).
- `Formatting.CopyPreviousCite` (`Formatting.bas:84-118`).

### e) Cleanup / normalization
- `Formatting.FixFakeTags` (`592-602`) — bold body text > Underline-style size → Tag.
- `Formatting.ConvertAnalyticsToTags` (`604-610`).
- `Formatting.FixFormattingGaps` (`1031-1093`) — bridge punctuation/space gaps
  in styled runs.
- `Formatting.ConvertToDefaultStyles` (`720-941`) — heavy normalize: collapse
  variant style names into canonical ones, unlink linked styles, re-pair
  Emphasis with yellow highlight.
- `Formatting.RemoveExtraStyles` (`612-718`) — keep only canonical + built-in
  styles; hide the rest.
- `Formatting.RemoveBlanks` (`234-246`) — short blank-ish lines → Normal so
  they stop appearing in the nav pane.
- `Formatting.UpdateStyles` (`267-270`) — `ActiveDocument.UpdateStyles` from
  the attached template.
- `Formatting.AutoFormatCite` / `ReformatAllCites` (`303-405`) — author/date
  detection inside a paragraph.
- `Formatting.SelectSimilar` (`272-288`) — wraps `WordBasic.SelectSimilarFormatting`
  with a workaround.

### f) View / paste
- `View.InvisibilityMode` (`View.bas:165-243`) — hide all non-highlighted body
  text (sets `Font.Hidden`) except Cite paragraphs.
- `Formatting.PasteText` (`Formatting.bas:45-69`) — unformatted paste, with
  optional auto-condense.
- `Formatting.RemoveHyperlinks` (`290-301`).

---

## 4. Document-level metadata

Set in `Startup.AutoNew` (`Startup.bas:12-17`) as Word document variables:

- `Creator`, `Team`, `VerbatimVersion`, `OS`, `OSVersion`, `WordVersion`

These are pure metadata, not load-bearing for rendering. Round-trip should
preserve them but we don't have to interpret them.

`RibbonPointer` is a runtime-only document variable (a pointer to the live
`IRibbonUI` object); it has no persistence value and should be ignored on
import.

**No custom XML parts.** Verbatim sticks to native Word styles + variables +
direct formatting. Bookmarks appear in the VirtualTub flow but don't seem to
carry style-relevant info (TODO: confirm if we touch that feature).

---

## 5. Gotchas for our reimplementation

These are the things most likely to bite us:

1. **`Underline` is dual** — both a character style and a direct font property.
   Verbatim's own code commits the dual representation
   (`Formatting.bas:19` comment). Our docx import must read both; our export
   must produce both, otherwise Verbatim's checks will misclassify our text.
2. **Outline level is read directly**, not derived from style name. Many code
   paths use `OutlineLevel < wdOutlineLevel5` to find headings rather than
   matching `Style.NameLocal`. Our exported styles must declare the correct
   outline level — not just have the right name.
3. **`Cite` detection has two modes** — the explicit style (`IdentifyCiteStyle`,
   `Paperless.bas:341-364`) and a heuristic one (`IdentifyCite`,
   `Paperless.bas:297-339`) keyed on `[(<`, URLs, and tokens like
   "omitted/edited/modified/sic". Round-trip should keep the explicit style.
4. **`Emphasis` ↔ yellow highlight pairing** — `ConvertToDefaultStyles`
   (`Formatting.bas:826-875`) re-introduces yellow highlight on Emphasis-styled
   ranges. If we strip highlights on import we'll lose information; if we
   strip on export we may *break* a document on the next "Update Styles" run.
5. **`FixFakeTags` is destructive** — bold body-level text larger than the
   `Underline` style's font size is silently rewritten to `Tag`. Our exports
   should not produce such text accidentally.
6. **Pilcrow encoding is settings-dependent** — whether `^p` becomes a 6pt ¶
   depends on user-side registry settings (`ParagraphIntegrity`, `UsePilcrows`).
   We can't infer "is this doc condensed?" from the doc alone; we must detect
   pilcrows by Unicode/glyph + font size.
7. **`NameLocal` is locale-sensitive** — Verbatim's `RemoveExtraStyles`
   compares `NameLocal` against English strings like `"Heading 1,Pocket"`. On
   a non-English Word install this breaks. We should round-trip by *style ID*
   where possible, not by display name.
8. **Hidden styles are not deleted** — `RemoveExtraStyles` toggles
   `s.Visibility`. Our import must look at hidden styles too.
9. **Linked styles** — `ConvertToDefaultStyles` explicitly unlinks via
   `s.LinkStyle = "Normal"` (`Formatting.bas:830`). If we preserve links
   we'll cause cleanup churn next time the user runs it.
10. **`Normal` style is load-bearing** — every shrink/unshrink op falls back
    to `Styles("Normal").Font.size`. Documents we produce must have a `Normal`
    with a sensible default size (Verbatim assumes ~11pt).

---

## 6. Real-world observations from working documents

Findings from surveying three of the project owner's actual working files
(`reference-docs/example docs/`). These are facts about how Verbatim docs
get serialized in practice — distinct from how the source code suggests
they "should" look.

### Body paragraphs have no `pStyle`

Confirmed across all three example docs: paragraphs that the user thinks
of as "Normal/Card body" emit no `<w:pStyle>` at all. Word omits the
default style by convention. **Importer rule**: a `<w:p>` with no
`<w:pStyle>` is a body paragraph, not malformed.

### Multiple "files" coexist in one .docx

`DA - Reconciliation.docx` contains both the disad (Reconciliation DA)
and a counterplan (Fixed Price Schedule PIC) in a single file. The
boundary is just an empty `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr></w:p>`
followed by a new top-level Heading1 paragraph. No page break, no
comment, no special markup. This pattern is normal — the docx root is
effectively a *sequence of pocket-like sections*, not "the document."

### "Patch Notes" is the project owner's personal cutting-board convention

All three example docs lead with a `Heading3` titled "Patch Notes" used
as a version-log / cutting board. **This is the project owner's personal
convention, not a community-wide debate practice** — don't generalize
from it. We should not auto-classify "Patch Notes" headings as anything
special on import for arbitrary users; the schema admits the loose
paragraphs they contain as ordinary block-level content. In
`Aff - Merp!.docx` the project owner's "Patch Notes" block additionally
skips an outline level (Heading1 → Heading3 with no Heading2).

### Pocket-level structure is optional

`CP - Bifurcation PIC vs Fed Workers.docx` (252 KB) has zero Heading1
paragraphs. It opens at `Heading3` ("Patch Notes") and has only two
`Heading2` sections. **Schema implication**: don't require Pocket at the
root.

### Outline-level skips happen, especially around cutting-board regions

The "Patch Notes" → first real card transition routinely jumps levels.
Real docs are not guaranteed to have contiguous heading levels. Our
schema accepts skips directly — heading nodes are flat paragraphs whose
hierarchy is implicit in document order, not enforced by containment.

### Paragraph-mark formatting in `<w:pPr>/<w:rPr>` does NOT propagate to runs

This was misread during the original survey. Real Word docs sometimes
contain `<w:pPr><w:rPr>...</w:rPr></w:pPr>` with formatting on it, but
per OOXML 17.7.5.10 that describes only the formatting of the
*paragraph-mark glyph* (the ¶), NOT the runs in the paragraph. Runs
take their formatting from their own `<w:rPr>` plus the paragraph's
`<w:pStyle>`'s linked character style. They do NOT inherit from
`<w:pPr>/<w:rPr>`.

When real-doc users do mass-formatting operations (Verbatim's
`UniHighlight` etc.), Word actually applies the formatting to every
run individually. The pPr/rPr is incidental noise that affects only
the paragraph-mark glyph. **Importer rule**: ignore pPr/rPr; parse
each run's rPr independently.

### Run-level rPr churn is normal

Every Word edit creates a new run. Real paragraphs contain dozens of
adjacent `<w:r>` elements with identical `<w:rPr>`. Importer needs an
adjacent-runs-with-same-formatting → merge pass to normalize.

### Direct-formatting prevalence (real numbers)

Aff / DA / CP from the survey:

| Pattern                              | Aff   | DA    | CP   | Notes |
|--------------------------------------|-------|-------|------|-------|
| `<w:color w:val="555555"/>` runs     | 2,736 | 1,269 | 0    | The "for reference, do not read" sentinel; ubiquitous in working docs. |
| `<w:shd w:fill="D2D2D2"/>` runs      |   684 |   411 | 0    | The protected-highlight (`HighlightToBackgroundColor`) shading. |
| 6pt pilcrow (`¶` chars sized down)   |     0 |     0 | 0    | Not used in working drafts; only present in `Condense`-processed docs. |
| `StyleUnderline` rStyle uses         |16,211 |14,039 |1,590 | Heavy. The everyday emphasis mark. |
| `Emphasis` rStyle uses               |14,212 |10,625 |1,495 | Comparable to Underline. |
| `Style13ptBold` rStyle uses (= Cite) |   387 |   363 |   52 | Citation metadata bolded inline. |
| `Heading1` (Pocket)                  |     7 |     6 |   0  | |
| `Heading2` (Hat)                     |    29 |    21 |   2  | |
| `Heading3` (Block)                   |   162 |   136 |  26  | |
| `Heading4` (Tag)                     |   362 |   321 |  50  | |
| `Analytic`                           |    38 |    68 |  34  | Heavy use; not a niche feature. |
| `Undertag`                           |     1 |     2 |   4  | Rare. |

### Stylepox is a real, ambient threat

The user has separately documented the "stylepox" phenomenon — random
custom styles that propagate via copy-paste — and built a Stylepox
Cleaner utility that normalizes infected docs. Reported infection rate:
~62% of open-source college policy docs. One artifact appears in our
samples: `AAAUNDERLINEKEYBOARD` (9 instances in Aff only). Treat it as
an ambient hazard the import normalizer must handle.

Reference: `https://debate-decoded.ghost.io/leveling-up-your-debate-software-3-curing-stylepox/`.

---

## 7. Advanced Verbatim — this project's target variant

We're not targeting stock Verbatim. The project owner maintains and
disseminates **Advanced Verbatim**, a forked Verbatim build with two extra
styles, which any document we import/export may legitimately contain. Our
docx contract must round-trip them losslessly even though stock Verbatim
does not know about them.

Reference for the fork's documented features:
`https://debate-decoded.ghost.io/leveling-up-verbatim/`.

### Custom styles — verified against `Debate.dotm`

Both customs ship as **linked paragraph+character pairs**. The paragraph form
applies to whole paragraphs; the linked `*Char` character form is what Word
applies automatically when the user selects an inline run. Round-trip must
preserve both halves.

#### Analytic (paragraph) + AnalyticChar (character)

`Debate.dotm:word/styles.xml:870-895`

```xml
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Analytic">
  <w:name w:val="Analytic"/>
  <w:basedOn w:val="Heading4"/>
  <w:link w:val="AnalyticChar"/>
  <w:autoRedefine/>
  <w:uiPriority w:val="5"/>
  <w:qFormat/>
  <w:rPr>
    <w:color w:val="1F3864" w:themeColor="accent1" w:themeShade="80"/>
  </w:rPr>
</w:style>
<w:style w:type="character" w:customStyle="1" w:styleId="AnalyticChar">
  <w:name w:val="Analytic Char"/>
  <w:basedOn w:val="DefaultParagraphFont"/>
  <w:link w:val="Analytic"/>
  <w:rPr>
    <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" .../>
    <w:b/>
    <w:color w:val="1F3864" w:themeColor="accent1" w:themeShade="80"/>
    <w:sz w:val="26"/>     <!-- 13pt -->
  </w:rPr>
</w:style>
```

- **Inheritance**: paragraph form is `basedOn="Heading4"`, so it inherits Tag's
  outline level (`outlineLvl=3` = `wdOutlineLevel4`), `keepNext`/`keepLines`,
  bold (`<w:b/>`), 13pt size. The override is just the dark-blue color.
- **Color**: `#1F3864` (theme `accent1` shade `80`).
- **AnalyticChar** redeclares font/bold/color/size explicitly rather than
  relying on inheritance — typical Word linked-style boilerplate.

#### Undertag (paragraph) + UndertagChar (character)

`Debate.dotm:word/styles.xml:838-869`

```xml
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Undertag">
  <w:name w:val="Undertag"/>
  <w:link w:val="UndertagChar"/>
  <w:autoRedefine/>
  <w:uiPriority w:val="5"/>
  <w:qFormat/>
  <w:pPr>
    <w:spacing w:after="0"/>
  </w:pPr>
  <w:rPr>
    <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" .../>
    <w:i/>
    <w:iCs/>
    <w:color w:val="385623" w:themeColor="accent6" w:themeShade="80"/>
    <w:sz w:val="24"/>     <!-- 12pt -->
  </w:rPr>
</w:style>
<w:style w:type="character" w:customStyle="1" w:styleId="UndertagChar">
  <w:name w:val="Undertag Char"/>
  <w:basedOn w:val="DefaultParagraphFont"/>
  <w:link w:val="Undertag"/>
  <w:rPr>
    <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" .../>
    <w:i/>
    <w:iCs/>
    <w:color w:val="385623" w:themeColor="accent6" w:themeShade="80"/>
    <w:sz w:val="24"/>
  </w:rPr>
</w:style>
```

- **Inheritance**: paragraph form has no `basedOn` → defaults to `Normal`,
  i.e. body-text outline level.
- **Color**: `#385623` (theme `accent6` shade `80`, dark forest green).
- **Italic**: declared on both halves via `<w:i/>` and `<w:iCs/>`.
- **Spacing**: paragraph form sets `spacing after = 0`.

#### Quick-reference summary

| Alias    | styleId    | Linked char styleId | Type        | Outline level         | Visual                           |
|----------|------------|---------------------|-------------|-----------------------|----------------------------------|
| Analytic | `Analytic` | `AnalyticChar`      | linked pair | `wdOutlineLevel4` (inherited from `Heading4`) | Tag-like, color `#1F3864` |
| Undertag | `Undertag` | `UndertagChar`      | linked pair | body text             | TNR 12pt italic, color `#385623` |

### What the user's fork actually changes

Confirmed by the project owner: the fork **does not modify** any of
`ConvertAnalyticsToTags`, `RemoveExtraStyles`, `ConvertToDefaultStyles`, or
`FixFakeTags`. The fork only adds:

- New code in the dedicated **Custom section** (`Custom.bas`) of the VBA.
- Modifications to `InvisibilityOn` / `InvisibilityOff` in `View.bas`.

When we move on to bucket-3 (functionality replication), those two scopes
are where the fork's behavior diverges from upstream and will need separate
inspection.

### Latent collision risks (deliberate-invocation only)

The cleanup ops below *would* clobber `Analytic` and `Undertag` on a stock
Verbatim install, but in practice none of them auto-run — they're all
behind explicit ribbon buttons. The user's workflow simply doesn't press
those buttons, which is why their fork works without patching them.

For our exports, the implication is: docs we produce are safe to open in
stock Verbatim, but a user who explicitly hits "Convert to Default Styles"
or "Remove Extra Styles" on the Format menu will silently degrade them.
This is a documentation-and-warnings problem, not a docx-format problem.

- **`ConvertAnalyticsToTags`** (`Formatting.bas:604-610`) — prefix-matches
  `analytic` (via `LCase$(Left$(p.Style, 8))`) and rewrites to `Tag`. The
  string `Analytic` matches exactly, so this *would* destroy the style if
  invoked. Just doesn't get invoked.
- **`RemoveExtraStyles`** (`Formatting.bas:612-718`) — keeps only an
  allowlist of canonical names + Word built-ins; would hide both customs.
- **`ConvertToDefaultStyles`** (`Formatting.bas:720-941`) — would collapse
  variants into canonical names.
- **`FixFakeTags`** (`Formatting.bas:592-602`) — rewrites bold body-level
  text bigger than the Underline-style size into `Tag`. Since `Analytic`
  inherits Heading4's outline level (4) and is *not* body-level, it would
  not be affected. `Undertag` is body-level but italic-not-bold, so also
  unaffected.

### Round-trip implication

Documents from this ecosystem may contain any of seven paragraph-or-character
styles relevant to us:

- Paragraph: `Pocket`, `Hat`, `Block`, `Tag`, `Analytic` (custom),
  `Normal/Card`
- Character: `Cite`, `Underline`, `Emphasis`, `Undertag` (custom)

Our ProseMirror schema needs first-class support for both customs.

---

## 8. Schema design implications

This section moved to [`ARCHITECTURE.md`](./ARCHITECTURE.md), which is now
the source of truth for editor design decisions. This file stays focused on
documenting Verbatim's data model and the docx contract.
