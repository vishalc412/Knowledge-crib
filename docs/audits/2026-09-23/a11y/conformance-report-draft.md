# Accessibility conformance report — DRAFT, not an independent assessment

| | |
| --- | --- |
| Product | Knowledge Crib `crib viz` (local web UI, `packages/ui/web`) |
| Standard | WCAG 2.2 Level A and AA (4.1.1 Parsing is obsolete in 2.2 and omitted) |
| Version assessed | Branch `claude/ui-remediation-phase-6`, stacked on Phases 0, 1, 2 and 4 |
| Prepared by | The implementation team, using automated checks and code/keyboard review |
| Status | **Provisional.** Every "Supports" below needs confirmation from the independent assessor ([assessor-protocol.md](assessor-protocol.md)). No screen reader, forced-colours or touch-AT testing has been done. |

Phase 3 (the textual Graph/List/Split explorer) is deferred, and Phase 5 is in progress in another environment. The criteria marked "Does not support" depend on Phase 3.

Legend:
- **Supports (provisional)**: automated and keyboard evidence found no failure; independent confirmation is required.
- **Partially supports**: some content fails.
- **Does not support**: an open A/AA issue.
- **Not evaluated**: requires assistive technology or manual judgement not yet performed.
- **N/A**: the product has no content the criterion applies to.

## Level A

| Criterion | Status | Notes |
| --- | --- | --- |
| 1.1.1 Non-text Content | Does not support | A11Y-012: the canvas has only an interim label; the graph has no text equivalent until Phase 3 |
| 1.2.1–1.2.3 Time-based media | N/A | No audio or video |
| 1.3.1 Info and Relationships | Partially supports | Landmarks, headings, lists, labelled forms and ARIA states are in place. Canvas relationships exist only for the selected node (A11Y-012) |
| 1.3.2 Meaningful Sequence | Supports (provisional) | DOM order now matches the visual order (A11Y-007) |
| 1.3.3 Sensory Characteristics | Supports (provisional) | Colour swatches always sit beside text labels |
| 1.4.1 Use of Color | Partially supports | DOM states use text, `aria-pressed` and strike-through. Canvas node kinds and Blast depth are colour-coded; the inspector lists them as text |
| 1.4.2 Audio Control | N/A | |
| 2.1.1 Keyboard | Does not support | A11Y-001: canvas node selection, Focus and Blast need a pointer. Memory, the rail, Help, the theme toggle and search are fully keyboard-operable (tested) |
| 2.1.2 No Keyboard Trap | Supports (provisional) | Escape leaves every layer; Tab wraps inside modals by design (A11Y-008) |
| 2.1.4 Character Key Shortcuts | Supports (provisional) | F and M can be turned off in Help; modifier combinations never trigger them (A11Y-016) |
| 2.2.1 Timing Adjustable | Supports (provisional) | No time limits |
| 2.2.2 Pause, Stop, Hide | Not evaluated | The canvas layout animates briefly as it settles. The assessor should confirm it stops within 5 s and honours reduced motion |
| 2.3.1 Three Flashes | Supports (provisional) | No flashing content |
| 2.4.1 Bypass Blocks | Supports (provisional) | `header`, `main` and labelled `aside` landmarks |
| 2.4.2 Page Titled | Supports (provisional) | "Knowledge Crib — Knowledge graph" |
| 2.4.3 Focus Order | Supports (provisional) | Visual order; modal containment and return (A11Y-007, A11Y-008) |
| 2.4.4 Link Purpose (In Context) | N/A | Controls are buttons; no links |
| 2.5.1 Pointer Gestures | Supports (provisional) | Wheel and pinch zoom have button equivalents |
| 2.5.2 Pointer Cancellation | Supports (provisional) | Canvas selection completes on pointer-up; controls are native buttons |
| 2.5.3 Label in Name | Not evaluated | Icon buttons have names; the assessor should confirm the visible-label match with speech input |
| 2.5.4 Motion Actuation | N/A | |
| 3.1.1 Language of Page | Supports (provisional) | `lang="en"` |
| 3.2.1 On Focus / 3.2.2 On Input | Not evaluated | Typing a search re-arranges the canvas (content update, not navigation); needs the assessor's judgement |
| 3.2.6 Consistent Help | Supports (provisional) | The Help control is always in the top bar |
| 3.3.1 Error Identification | Supports (provisional) | Concern and resume errors are text in `role="alert"` regions |
| 3.3.2 Labels or Instructions | Supports (provisional) | Search, concern reason, resume note and gate profile are labelled |
| 3.3.7 Redundant Entry | Supports (provisional) | No repeated entry |
| 4.1.2 Name, Role, Value | Supports (provisional) | Dialogs, switch, pressed and expanded states exposed (A11Y-009); axe clean in 40 state/theme runs |

## Level AA

| Criterion | Status | Notes |
| --- | --- | --- |
| 1.2.4–1.2.5 Media | N/A | |
| 1.3.4 Orientation | Supports (provisional) | No orientation lock |
| 1.3.5 Identify Input Purpose | N/A | No personal-data inputs |
| 1.4.3 Contrast (Minimum) | Partially supports | All sampled DOM text reaches ≥4.5:1 in both themes (A11Y-002…005, 011, 018). Canvas-drawn labels are not sampled |
| 1.4.4 Resize Text | Supports (provisional) | Reflow verified at 400% zoom (320 × 256 CSS px) |
| 1.4.5 Images of Text | Not evaluated | Canvas labels are drawn text; the assessor should decide how the criterion applies |
| 1.4.10 Reflow | Supports (provisional) | 320 px and 400% zoom, no horizontal scroll (tested) |
| 1.4.11 Non-text Contrast | Partially supports | Control borders ≥3.8:1 and focus ring tokens verified; canvas node colours not measured |
| 1.4.12 Text Spacing | Not evaluated | Some labels truncate with an ellipsis by design; the assessor should test the override |
| 1.4.13 Content on Hover or Focus | Supports (provisional) | The tooltip can be dismissed (Escape), hovered, and stays until dismissed (A11Y-010) |
| 2.4.5 Multiple Ways | N/A | Single-view application |
| 2.4.6 Headings and Labels | Supports (provisional) | Ordered outline (tested) |
| 2.4.7 Focus Visible | Supports (provisional) | Every tab stop checked (tested) |
| 2.4.11 Focus Not Obscured (Minimum) | Supports (provisional) | Every tab stop checked in the shell, Memory and the drawer |
| 2.5.7 Dragging Movements | Does not support | A11Y-014: panning the canvas requires dragging |
| 2.5.8 Target Size (Minimum) | Supports (provisional) | ≥24 px desktop and ≥44 px phone in all 40 audited runs |
| 3.1.2 Language of Parts | N/A | English UI; code excerpts are not natural language |
| 3.2.3 Consistent Navigation / 3.2.4 Consistent Identification | Supports (provisional) | |
| 3.3.3 Error Suggestion | Supports (provisional) | "Describe what is wrong before submitting." |
| 3.3.4 Error Prevention (Legal, Financial, Data) | Supports (provisional) | Concern reports explain their effect before submit and change no lifecycle; memory actions are append-only |
| 3.3.8 Accessible Authentication (Minimum) | N/A | No authentication |
| 4.1.3 Status Messages | Supports (provisional) | Search count and Memory outcomes use polite live regions (A11Y-017) |

## Summary

This draft does **not** claim conformance. The product cannot conform while A11Y-001, A11Y-012 and A11Y-014 are open, and `crib viz`'s release gate (`pnpm run ui:gate`) reports FAIL until they are resolved. It will report UNAVAILABLE until an independent assessment and the task review are recorded.
