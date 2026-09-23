# `crib viz` visual system

Status: the contract for `packages/ui/web/tokens.css`, which is the only palette source for the DOM and the canvas. Every value below is taken from that file. The contrast ratios are computed from those values on opaque surfaces. `web-assets.test.ts` enforces that both themes define the same token names. The Phase 6 audit (`phase-6-a11y-audit.browser.ts` and `phase-5-matrix.browser.ts`) samples the composited result in the browser.

## Direction

The desktop keeps its low-glare code exploration surface. Each layer has a purpose:
- **page:** navigation context
- **panel:** sustained reading
- **floating:** temporary graph controls
- **raised:** selected or expanded content

The code, knowledge, review and risk accents name meaning, not decoration.

## Semantic tokens (per theme)

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--kc-surface-page` | `#0c0f16` | `#f4f6f9` | Graph stage and page background; canvas background |
| `--kc-surface-panel` | `#12161f` | `#ffffff` | Rail, inspector, Memory, result list |
| `--kc-surface-floating` | `#141822` | `#ffffff` | Breadcrumbs, graph controls, popovers, tooltip, canvas overview cards |
| `--kc-surface-raised` | `#1b202b` | `#e9edf3` | Selected or expanded content |
| `--kc-text-primary` | `#e8edf5` | `#1e293b` | Primary text and controls |
| `--kc-text-secondary` | `#b3bdcc` | `#475569` | Descriptions, metadata, dates |
| `--kc-text-interactive` | `#a7beff` | `#284fa5` | Text links and text-only actions |
| `--kc-text-knowledge` | `#43d8c9` | `#0f766e` | Memory accents rendered as text |
| `--kc-text-positive` | `#34d399` | `#065f46` | Current, valid, ready |
| `--kc-text-review` | `#f5b942` | `#92400e` | Degraded, pending, moved |
| `--kc-text-risk` | `#fb7b75` | `#b91c1c` | Invalid, stale, blocked, errors |
| `--kc-border-control` | `#64748b` | `#64748b` | Boundaries that identify a control |
| `--kc-border-separator` | `rgba(255,255,255,.12)` | `rgba(15,23,42,.16)` | Decorative separation only |
| `--kc-fill` | `rgba(255,255,255,.06)` | `rgba(15,23,42,.05)` | Neutral chip and control fill |
| `--kc-focus` | `#43d8c9` | `#006c68` | Visible keyboard focus |
| `--kc-code-surface` / `--kc-code-text` | `#080b11` / `#dbe4f0` | `#e9edf3` / `#1e293b` | Source excerpts and technical blocks |
| `--kc-canvas-dot`, `-label`, `-pill`, `-node-stroke` | see `tokens.css` | see `tokens.css` | Canvas grid, labels, label pills, node outlines |

## Shared tokens (theme-independent)

| Token | Value | Use |
| --- | --- | --- |
| `--kc-accent-code` / `-knowledge` / `-positive` / `-review` / `-risk` | `#6e94ff` / `#43d8c9` / `#34d399` / `#f5b942` / `#fb7b75` | The single source for each hue |
| `--kc-tint-*` | `color-mix()` of the accent, 12–16% | Status backgrounds (banners, chips, open Memory button) |
| `--kc-edge-*` | `color-mix()` of the accent, 45–50% | Status borders |
| `--kc-state-hover` / `--kc-state-selected` | `color-mix()` of text-primary, 10% / 14% | Hover and selected surfaces |
| `--kc-selected-surface` / `--kc-selected-text` | `#3d63dd` / `#ffffff` | Pressed segment and presentation buttons |
| `--kc-scrollbar-thumb` | `color-mix()` of text-secondary, 40% | Scrollbars |
| `--kc-font-body` / `-support` / `-section` / `-heading` | 14 / 12 / 16 / 20 px | Type scale |
| `--kc-space-1…6` | 4 / 8 / 12 / 16 / 24 px | Spacing steps |
| `--kc-target-desktop` / `-touch` | 32 / 44 px | Minimum control size |

Tints and edges are derived rather than restated. Changing an accent therefore changes every status surface of that hue, with no second copy to drift.

## Contrast pairings (computed from `tokens.css`)

| Foreground | Background | Dark | Light |
| --- | --- | ---: | ---: |
| text-primary | surface-panel | 15.40:1 | 14.63:1 |
| text-secondary | surface-panel | 9.54:1 | 7.58:1 |
| text-secondary | surface-page | 10.10:1 | 7.00:1 |
| text-interactive | surface-panel | 9.87:1 | 7.63:1 |
| text-knowledge | surface-panel | 10.26:1 | 5.47:1 |
| text-positive | surface-panel | 9.41:1 | 7.68:1 |
| text-review | surface-panel | 10.26:1 | 7.09:1 |
| text-risk | surface-panel | 7.06:1 | 6.47:1 |
| code-text | code-surface | 15.35:1 | 12.45:1 |
| border-control (non-text) | surface-panel / page | 3.80 / 4.03:1 | 4.76 / 4.40:1 |
| focus (non-text) | surface-panel / page | 10.26 / 10.87:1 | 6.28 / 5.80:1 |
| selected-text | selected-surface | 5.21:1 | 5.21:1 |

Translucent tints change the effective background. The browser suites therefore sample text *after* compositing every ancestor layer, in normal, hover, selected, focus and error states, in both themes, at 320, 375, 768, 1280 and 1440 px.

## Type and space

- Body text is 14 px. Supporting text and technical metadata are at least 12 px. Section headings are 16 px, and page and detail headings 18–20 px. Every family stack ends in system fallbacks, because IBM Plex is not bundled.
- IDs and code use the mono stack and wrap at container boundaries. Long multilingual claims wrap in detail. List previews are clamped to one visual line and never replace the full claim.
- Spacing uses the 4 / 8 / 12 / 16 / 24 px steps.

## Interaction states

- **Hover** uses `--kc-state-hover` on a surface or border and keeps the text contrast.
- **Selected** uses a surface change (`--kc-state-selected` or `--kc-selected-surface`) together with `aria-pressed`. Colour is never the only cue.
- **Focus** uses a 3 px `--kc-focus` outline in Graph, List, Split, drawers, dialogs and Memory.
- **Loading** is a polite `role="status"`.
- **Failure** is a persistent `role="alert"` that names the failed action and offers Retry. This applies to the graph, Memory, Pending, record detail, source preview and evidence.
- **Successful mutations** use a polite status message that states their domain effect plainly.
- **Motion** honours `prefers-reduced-motion`. Focus changes never depend on animation.

## Documented exceptions

- **Categorical canvas palettes** (`KIND`, `REL`, `DEPTH_COLORS` and the Memory group swatches) are data-visualization colours drawn on the canvas or on small swatches beside text. They never carry meaning alone: a text label always accompanies them, and the List presentation is the text equivalent.
- **Elevation shadows** use literal black alpha. They are decorative depth, not state.
- **Canvas labels** scale with zoom and may render below 12 px when zoomed out. The List presentation and the inspector carry the same text at full size.
- **Compact controls:** inline text actions in dense rows may be 24 px tall on desktop (WCAG 2.5.8 minimum). Touch layouts (≤760 px) keep 44 px.

## Ownership

Phase 1 introduced the token sheet and theme. Phase 5 migrated shared controls and states. The UI remediation audit (`docs/audits/2026-09-24/ui-remediation-audit.md`) finished the migration: it moved status tints, edges and interaction states onto tokens, removed the duplicate canvas palette, and documented the exceptions above. The independent WCAG 2.2 AA assessment decides final conformance.
