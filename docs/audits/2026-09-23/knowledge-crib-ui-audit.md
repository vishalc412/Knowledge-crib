# Knowledge Crib UI audit

**Date:** 2026-09-23

**Product surface:** local `crib viz` web application

**Perspective:** enterprise architecture, task UX, visual system, accessibility, and AI/RAG trust

**Verdict:** the architecture overview and Memory ledger provide a useful foundation, but four observed defects block a reliable release on mobile, in light theme, or for keyboard and assistive-technology users. The primary "Needs review" action also routes to an empty view while reporting 23 items.

## Scope and method

I ran the current application with `crib viz . --port 8765 --no-open` against this repository, then walked the shipped browser UI at 1440 × 900, 375 × 812, and 320 × 700 CSS pixels. I inspected dark and light themes, the architecture overview, module and node focus, Blast, search including zero results, the inspector and source disclosure, and Memory home, detail, Pending, Work, and Needs review. I inspected the accessibility tree and targeted DOM properties, measured one light-theme control's contrast from computed colors, and checked the relevant source. The code graph was refreshed before source inspection. The [benchmark rubric](ui-audit-benchmarks.md) distinguishes WCAG 2.2 AA requirements from design guidance.

**Evidence labels:** **Observed** means reproduced in the running browser. **Source-confirmed** means the implementation explains the observed behavior. **Inference** means a likely design risk requiring further validation. This is a product audit, not a full WCAG conformance assessment or a screen-reader certification. I did not inject server failures, test every browser or assistive technology, or profile runtime performance.

## Executive scorecard

| Dimension | Assessment | Evidence |
| --- | --- | --- |
| Information architecture | **Partial** | Overview → module → symbol is understandable; Memory separates Active, Pending, and history, but some top-level actions and counts do not map clearly to their destination. |
| Core task access | **Fail on mobile and keyboard** | The mobile rail cannot reveal module/type controls; graph nodes, minimap, and search results lack a complete keyboard/semantic path. |
| Visual system | **Partial** | Dark theme has a coherent visual language; light-theme floating controls become nearly illegible, and token use is inconsistent. |
| Accessibility | **Fail on sampled essentials** | Empty document title/language, inaccessible graph content, and a measured 1.03:1 light-theme control. |
| AI/RAG trust | **Partial** | Scope, evidence verdict, anchor state, and history are exposed; primary review routing and source traceability are weak. |
| Enterprise operability | **Partial** | Local, offline-first delivery and health indicators are strong ideas; UI state semantics and recovery journeys need clearer contracts and validation. |

Severity in this report: **P0** blocks a core task for a class of users; **P1** is a major task or trust failure; **P2** causes recurring friction or comprehension errors; **P3** is a polish or consistency issue.

## Prioritized findings

### P0 · The graph has no complete accessible task path

**Observed:** at desktop size the overview, cluster cards, graph nodes, and relationship lines are drawn on a canvas. The browser accessibility tree exposes the surrounding buttons and rail but no graph nodes or graph relationships. Search for `isMemoryRecordVersioned` returned `37 matches · 37 related`, yet only the canvas displayed those matches; there was no result list to enter by keyboard. The minimap had an `aria-label` but remained nonfocusable. Clicking a node opened a useful DOM inspector, but reaching that node still depended on the pointer. The graph canvas had no accessible fallback or interactive role and `tabIndex` was `-1` in the inspected DOM. **Source-confirmed:** [canvas and minimap markup](../../../packages/ui/web/index.html#L105-L138) and [global keyboard handler](../../../packages/ui/web/index.html#L1693-L1710) only traverse neighbors after a node is already selected.

**Impact:** keyboard and screen-reader users cannot complete the central browse/search/inspect/blast workflow independently. The toolbar's zoom buttons do not provide a route into a specific graph result. This is relevant to [WCAG 2.2 1.1.1 and 2.1.1](https://www.w3.org/TR/WCAG22/) and the [WAI guidance for complex images](https://www.w3.org/WAI/tutorials/images/complex/).

**Fix:** make the graph a visual companion to an accessible result model. Provide a structured, keyboard-navigable list or tree for overview modules, clusters, symbols, and search results, with the same selection and inspector actions. Present Blast as a ranked, grouped list of impacted symbols with hop count and relationship. Keep canvas pan/zoom as optional spatial controls. Give each search result a name, type, path, and action; announce result counts through a live status region. A short canvas description should explain that an equivalent list follows.

**Acceptance:** from a fresh page using only the keyboard, a user can select a module, find a symbol, inspect its source, open its blast radius, and return to the result set; a screen reader announces each result and relationship without requiring canvas coordinates.

### P1 · Mobile navigation controls are permanently hidden

**Observed:** at 375 and 320 CSS pixels, the rail collapses to a 52-pixel strip. The expand chevron changes state, and the `+22 more modules` control also invokes the rail toggle, but neither reveals modules or node-type filters. **Source-confirmed:** the mobile rule hides `.kc-rail-body` and `.kc-rail-title` for every rail state at widths up to 760 pixels ([source](../../../packages/ui/web/index.html#L79)).

**Impact:** mobile users cannot navigate modules or apply node-type filters. This is a loss of functionality at a reflow size, relevant to [WCAG 2.2 1.4.10](https://www.w3.org/TR/WCAG22/#reflow).

**Fix:** let the expanded rail become a drawer or full-width overlay at the mobile breakpoint; restore its body when open. Give it a clear close action and focus handling. Verify content remains reachable at 320 CSS pixels and 400% zoom.

**Acceptance:** both the rail chevron and overflow control open a visible, scrollable module/filter list at 320 and 375 pixels; all items can be activated by keyboard and touch.

### P1 · Light-theme stage controls fail text contrast

**Observed:** after switching to light theme, the floating Open inspector control and zoom cluster render dark text against a near-black floating surface. The computed inspector foreground was `#1e293b`; the floating surface was `rgba(16,20,28,.9)` over `#f4f6f9`, yielding approximately `#272b32` and **1.03:1** contrast. **Source-confirmed:** the floating surface is hardcoded dark while its text uses theme-dependent foreground ([surface](../../../packages/ui/web/index.html#L50), [control](../../../packages/ui/web/index.html#L125), [palette](../../../packages/ui/web/index.html#L2206-L2208)).

**Impact:** important navigation controls are effectively unreadable in light theme. Normal text falls well below [WCAG 2.2 1.4.3](https://www.w3.org/TR/WCAG22/#contrast-minimum)'s 4.5:1 threshold.

**Fix:** define semantic stage-surface and stage-on-surface tokens for each theme, then audit every text/icon/background pairing including hover, selected, and disabled states. Do not mix a theme-sensitive foreground with a fixed opposite-theme surface.

**Acceptance:** ordinary control labels reach at least 4.5:1 in both themes, and meaningful control outlines/icons reach 3:1 where [1.4.11](https://www.w3.org/TR/WCAG22/#non-text-contrast) applies.

### P1 · “Needs review” leads to an empty stale filter

**Observed:** Memory home reported **23 Needs review**. Activating that card selected **Stale 0** and displayed “No records match this lifecycle view,” with no review queue. The **15 Active** card opened **All 46**, the same destination as **46 History**. **Source-confirmed:** the Needs review handler calls `loadMemory('stale')`, while Active and History both call `loadMemory(null)` ([handler](../../../packages/ui/web/index.html#L1800-L1804)); the home card counts and help text come from different home sections ([view model](../../../packages/ui/web/index.html#L2283-L2299)).

**Impact:** the primary path to inspect degraded evidence is a dead end exactly when the product says review is needed. This can leave stale, moved, or invalid evidence unexamined.

**Fix:** route Needs review to a dedicated queue using the same predicate and count as the home summary. Route Active to the active set, and History to the full ledger. Show the reason each review item needs attention and a direct inspect action. Keep the Stale lifecycle filter as a separate facet.

**Acceptance:** the card count equals the destination's total, and every counted item is reachable there. Exercise a fixture containing stale, moved, degraded, and invalid evidence separately.

### P1 · Evidence exists but is hard to verify at the point of use

**Observed:** a Memory record detail showed the claim, scope/evidence/currentness chips, anchors, lineage, and evidence labels. Anchor IDs such as `sym:...@L...` and evidence labels appeared as plain text without a direct source-opening action in that section. The UI exposed raw memory IDs before the claim. **Source-confirmed:** detail renders `an.ref` and `ev.label` in noninteractive `<span>`/`<div>` elements ([detail template](../../../packages/ui/web/index.html#L610-L662)).

**Impact:** the product distinguishes evidence quality, which is valuable, but a reviewer still has to translate identifiers manually to verify a claim. In a RAG workflow that raises the cost of checking a plausible but wrong answer. The recommendation is an **inference** from the observed detail and [Google PAIR explainability guidance](https://pair.withgoogle.com/chapter/explainability-trust) and [Microsoft HAX's explain-behavior guideline](https://www.microsoft.com/en-us/haxtoolkit/guideline/make-clear-why-the-system-did-what-it-did/); these sources do not mandate a particular layout.

**Fix:** render an evidence panel with a human-readable source title/path, exact anchored span or quote where available, source time/version, and an Open source action. Keep raw IDs in an expandable technical section. Where evidence cannot be opened, say why. Pair `current`, `valid`, `pending`, and `needs review` with a one-sentence explanation of what each axis means and what a user should do.

**Acceptance:** from any returned claim, a reviewer can open at least one supporting source or see an explicit “source unavailable” reason in one action; invalid evidence is unmistakable and is not styled like admissible evidence.

### P2 · Search and empty states do not support recovery

**Observed:** a nonsense query produced an empty graph and a small “No graph matches” floating message. There were no suggested actions, no results list, and no explanation of whether the code index, ledger, or current filters were searched. **Source-confirmed:** the search status is only a count/zero string rendered in a non-live `<div>` ([template](../../../packages/ui/web/index.html#L156-L164), [status construction](../../../packages/ui/web/index.html#L2244-L2247)). The search field relies on placeholder text instead of a persistent visible label ([markup](../../../packages/ui/web/index.html#L159-L163)).

**Fix:** use an accessible search result panel and a dedicated zero state: “No results in the current graph,” show query and filter scope, offer clear filters and a broader search, and distinguish an empty index from a valid zero match. Announce count changes without stealing focus. This follows [Carbon's empty-state guidance](https://carbondesignsystem.com/patterns/empty-states-pattern/) and [WCAG 4.1.3 status messages](https://www.w3.org/TR/WCAG22/#status-messages).

### P2 · The page shell lacks basic document semantics

**Observed:** `document.title` and the root `lang` property were empty in the running page. The initial graph view had no heading structure. **Source-confirmed:** the document starts with `<html><head>` without `lang` or `<title>` ([document head](../../../packages/ui/web/index.html#L1-L12)).

**Fix:** set a descriptive page title, document language, and a real page heading for the current view; update the title when switching to a meaningful Memory detail if useful. The missing title and language correspond to [WCAG 2.4.2 and 3.1.1](https://www.w3.org/TR/WCAG22/).

### P2 · Large focus and Blast views have weak hierarchy

**Observed:** selecting a 66-member cluster produced dense overlapping nodes; focusing one symbol showed 37 neighbors. Blast displayed repeated “breaks if changed” labels and a 147-node impact count on a crowded graph. The inspector contained useful details, but the spatial view made prioritization difficult. The overview's grouping was much clearer than the focused view.

**Fix:** default to direct dependents and a ranked impact table, group deeper hops, collapse repetitive edge labels until hover/selection, and offer filters by module and relationship. Keep graph visualization for topology. For large graphs, progressive disclosure is more useful than simultaneous labels. Make the table the exact textual counterpart required by the P0 finding.

### P2 · The design system is visually coherent but not yet operationalized

**Observed and source-confirmed:** dark mode uses a consistent restrained palette, spacing, and role colors. Yet the [top-level token block](../../../packages/ui/web/index.html#L22-L35) defines four accent variables that are not consumed elsewhere in this file; palette values are also embedded in the [theme functions](../../../packages/ui/web/index.html#L2206-L2208) and many inline styles. The shipped page combines template, styles, and controller in one 2,446-line file. The light-stage contrast defect shows the cost of this drift. Small labels are repeatedly specified at 9.5–11.5 pixels in rails, details, and status areas; at mobile width, long technical strings dominate the hierarchy.

**Fix:** create a small semantic token contract for surface, on-surface, interactive, focus, border, status, graph kind, typography, and spacing; map both themes to it. Extract recurring control styles/states into components or reusable classes. Use a role-based type scale and test real content lengths. Treat [Carbon themes](https://carbondesignsystem.com/elements/themes/overview/) and [USWDS tokens](https://designsystem.digital.gov/design-tokens/color/theme-tokens/) as architecture references, not a requirement to adopt either system.

### P2 · Mobile inspector competes with the graph beneath it

**Observed:** opening the inspector on mobile placed a translucent panel over the graph; graph text remained visibly present behind inspector content. **Source-confirmed:** the mobile inspector shares the stage grid area and uses a translucent panel color ([mobile layout](../../../packages/ui/web/index.html#L79), [theme palette](../../../packages/ui/web/index.html#L2206-L2208)).

**Fix:** present the inspector as an opaque full-screen or side drawer at mobile widths. Keep a visible close/back action, move focus into the drawer, and make the obscured stage inert until the drawer closes.

### P3 · Memory health and work counts need clearer denominators

**Observed:** Memory home displayed **3 Work in progress** while its Work destination showed more rows. The health tile showed **Code index behind HEAD** after the local `crib update`. The CLI status exposed two different signals: `readerFreshness.stale: false` and `freshness.behindHead: true`. The tile appears to reflect the latter, but it does not say which freshness clock or revision it represents. These are **clarity issues, not proven backend defects**.

**Fix:** define each count and freshness check in one projection contract and expose its denominator, checked revision, and timestamp in a tooltip or detail line. Test whether home and destination use the same filtering rules. If the signals are intentionally distinct, label them distinctly.

### P3 · Theme preference resets on reload

**Observed:** after selecting light theme and reloading, the page returned to dark. **Source-confirmed:** initial state is `theme: 'dark'`, and the toggle only changes in-memory component state ([initial state](../../../packages/ui/web/index.html#L813), [toggle](../../../packages/ui/web/index.html#L2046)).

**Fix:** initialize from `prefers-color-scheme` on first use, persist an explicit user choice locally, and make the control label describe the target theme rather than only an icon.

## What the UI already does well

- The dark desktop overview uses the graph's scale well: nine high-level modules provide a more usable entry point than rendering 48,812 nodes and 132,315 edges at once.
- The three-region layout gives persistent orientation (rail), spatial context (stage), and detail (inspector). The inspector exposes signatures, source, and relationship context after selection.
- Memory separates capture/pending/admitted/history concepts and visibly shows evidence verdicts, scope, anchor state, and lineage. Pending actions explain when a check is blocked or CLI-only; this is a sound trust posture.
- The browser bundle loads vendored React for offline use ([source](../../../packages/ui/web/index.html#L6-L12)), which fits a local repository tool.
- Reduced-motion support and visible focus styles are present ([source](../../../packages/ui/web/index.html#L34-L35), [L77](../../../packages/ui/web/index.html#L77)); these should be retained while closing the task-level accessibility gaps.

## Recommended delivery sequence

1. **Restore task access:** fix the mobile rail and Needs review routing; add the accessible graph/result list, including search and Blast. These are functional, testable contracts.
2. **Close contrast and semantics defects:** theme tokens, measured color pairs, title/language/headings, result announcements, and mobile inspector focus behavior.
3. **Improve RAG reviewability:** source-opening evidence, clear status axes, and a review queue whose count and membership agree.
4. **Harden the system:** centralize semantic tokens and view-model contracts, then add browser acceptance checks at 1440, 375, and 320 pixels in both themes, with keyboard-only and screen-reader runs. Include stale, moved, invalid, no result, and server-error fixtures.

The first release gate should be the **five concrete acceptance tests** under P0/P1 above. Beyond that, use a task-based usability test: ask a developer to find a symbol, inspect supporting source, evaluate blast radius, and decide whether one Memory claim can be trusted. Record task completion, misinterpretations, and time to evidence rather than assigning a single aesthetic score.

## Standards and guidance

Accessibility criteria are drawn from [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [WAI's complex-image guidance](https://www.w3.org/WAI/tutorials/images/complex/). Design-system and empty-state recommendations draw from [Carbon](https://carbondesignsystem.com/elements/themes/overview/) and [USWDS](https://designsystem.digital.gov/design-tokens/color/theme-tokens/). AI trust recommendations are product inferences from [Google People + AI](https://pair.withgoogle.com/chapter/explainability-trust), [Microsoft HAX](https://www.microsoft.com/en-us/haxtoolkit/guideline/make-clear-why-the-system-did-what-it-did/), and the [NIST Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf). The [companion rubric](ui-audit-benchmarks.md) lists specific checks and further primary sources.
