# `crib viz` visual system

Status: Phase 5 design contract. The semantic `tokens.css` implementation is in the unfinished Phase 1 worktree; this document records the agreed values and usage so Phase 5 controls and later integration use one vocabulary. Full token migration and light-theme verification remain release gates, not claims of completion here.

## Direction

The desktop keeps its low-glare code exploration surface. Layer changes have a visible purpose: page for navigation context, panel for sustained reading, floating for temporary graph controls, and raised for selected or expanded content. Code, knowledge, review, and risk accents name meaning rather than decoration.

## Semantic color tokens

| Role | Dark | Light | Usage |
| --- | --- | --- | --- |
| `--kc-surface-page` | `#0c0f16` | `#f4f6f9` | Graph stage and page background |
| `--kc-surface-panel` | `#12161f` | `#ffffff` | Rail, inspector, Memory panel, result list |
| `--kc-surface-floating` | `#141822` | `#ffffff` | Breadcrumbs, graph controls, popovers |
| `--kc-surface-raised` | `#1b202b` | `#e9edf3` | Selected or expanded content |
| `--kc-text-primary` | `#e8edf5` | `#1e293b` | Primary text and controls |
| `--kc-text-secondary` | `#b3bdcc` | `#475569` | Descriptions, metadata, and dates |
| `--kc-text-interactive` | `#a7beff` | `#284fa5` | Text links and text-only actions |
| `--kc-border-control` | `#64748b` | `#64748b` | Boundaries that identify a control |
| `--kc-border-separator` | `rgba(255,255,255,.12)` | `rgba(15,23,42,.16)` | Decorative separation only |
| `--kc-focus` | `#43d8c9` | `#006c68` | Visible keyboard focus |
| `--kc-code-surface` | `#080b11` | `#e9edf3` | Source excerpts and technical blocks |
| `--kc-code-text` | `#dbe4f0` | `#1e293b` | Code text |

Accents: code `#6e94ff`, knowledge `#43d8c9`, review `#f5b942`, and risk `#fb7b75`. Use accents with an appropriate text or surface pairing; an accent alone is never the status label.

The specified panel pairs have calculated contrast ratios of 15.40:1 / 14.63:1 for primary text and 9.54:1 / 7.58:1 for secondary text (dark / light). Interactive text is 9.87:1 / 7.63:1. The control border against the panel is 3.80:1 / 4.76:1. These values use opaque surfaces; alpha overlays require browser-computed verification after compositing.

## Type and space

- Body: 14px IBM Plex Sans; supporting text and technical metadata: at least 12px; section headings: 16px; page and detail headings: 18–20px.
- Code and IDs: IBM Plex Mono, with wrapping at container boundaries. Long multilingual claims wrap in detail; list previews occupy one visual line and do not replace the full claim.
- Space steps: 4, 8, 12, 16, and 24px. Use the next larger step between unrelated sections rather than adding borders to every row.
- Controls: at least 32 × 32px on desktop, 44 × 44px on touch layouts except documented compact controls that have an equivalent larger target.

## Interaction states

- Hover changes a control's surface or border while retaining its text contrast.
- Selected state uses both a surface change and a text/shape cue; color is not the only indicator.
- Focus uses `--kc-focus` and remains visible in Graph, List, Split, drawers, dialogs, and Memory.
- Loading uses a polite status. A failed request uses a persistent alert naming the action and offering Retry. Successful mutations use a polite status; their domain effect is stated plainly.
- Motion honors `prefers-reduced-motion`. Focus changes do not depend on animation.

## Integration checklist

Phase 1 owns the shell token asset, theme persistence, responsive rail and inspector, and light floating-control repair. Phase 5 migrates shared controls as those features land, verifies computed normal/hover/selected/error pairs in both themes, and keeps technical detail behind disclosure where it interrupts primary tasks. The Phase 6 independent WCAG 2.2 AA assessment decides final conformance.
