# Independent WCAG 2.2 AA assessment — assessor brief

This brief is for the accessibility assessor who signs off `crib viz` for release. The assessor must be **outside the implementation team**. That team includes the AI agents that wrote the code, so the release gate refuses an assessment recorded by Claude, Codex, GPT, Copilot, Cursor, or any agent. The automated suite in this repository is supporting evidence. It is not the assessment.

## Scope

Assess the whole local `crib viz` application (`packages/ui/web`, served by `crib viz`) against [WCAG 2.2](https://www.w3.org/TR/WCAG22/) Levels A and AA. Include every state below, in both themes.

| Area | States |
| --- | --- |
| Shell | Overview; search with results; search with no results; Help popover; theme switch; navigation rail (desktop) and navigation drawer (≤760px) |
| Graph | Node selected, with the inspector, source preview, Horizon hops and Blast; hover tooltip; zoom and fit |
| Memory | Home tiles; Active, Needs review and History views with paging; record detail; each of the five evidence kinds opened with Inspect; Report a concern (empty submit, success); Pending queue (Admit, Dismiss, Re-check); Resumable work (detail, Resume, Mark done, Cancel) |
| Modals | Memory, the phone navigation drawer, and the phone inspector. Assess each against the [WAI-APG modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) |

Start the application against a disposable memory store:

```bash
KCRIB_MEMORY_DIR=$(mktemp -d) KCRIB_REGISTRY_DIR=$(mktemp -d) node packages/cli/dist/cli.js viz --no-open
```

The browser suite's backend (`packages/cli/test/browser/backend.ts`, options `evidenceKinds` and `reviewClaims`) seeds a repository that reaches every state listed above.

## Environment matrix

| Assistive technology | Browser | Platform |
| --- | --- | --- |
| Keyboard only | Chrome, Firefox, Safari | macOS and Windows |
| VoiceOver | Safari | macOS; iOS (touch) |
| NVDA | Chrome | Windows |
| JAWS | Edge | Windows |
| TalkBack | Chrome | Android (touch) |

Also cover:
- reflow at 320 CSS px
- 200% text resize
- 400% zoom
- WCAG 1.4.12 text-spacing overrides
- `prefers-reduced-motion`
- Windows forced colours / high contrast

## Tasks, from Phase 5 step 5, to repeat after remediation

1. Find a named symbol.
2. Inspect its source.
3. Assess what breaks if it changes (Blast).
4. Decide whether a Memory claim can be used, from its evidence.

For each task, record:
- whether it was completed without a pointer
- whether any invalid or degraded evidence was mistaken for valid
- whether any item a tile counted could not be reached
- the time taken to reach the evidence

## Recording results

1. **Issues.** Add or update entries in `issue-log.json`. Each entry needs:
   - id
   - WCAG criterion
   - level (`A`, `AA` or `best-practice`)
   - title
   - reproduction steps
   - severity (`critical`, `serious`, `moderate` or `minor`)
   - owner
   - status

   Only the assessor sets `verified`, and only after an independent retest.
2. **Assessment.** Write `assessment.json`:

   ```json
   {
     "standard": "WCAG 2.2 AA",
     "assessor": { "name": "…", "organization": "…", "independent": true },
     "completedAt": "YYYY-MM-DD",
     "versions": { "app": "<git sha>", "browsers": {}, "assistiveTechnology": {} },
     "methods": ["manual keyboard", "screen reader", "automated (axe-core 4.13)"],
     "result": "conforms | does-not-conform",
     "retestedIssueIds": ["A11Y-002"],
     "limitations": "…"
   }
   ```
3. **Tasks.** Write `ux-tasks.json` as `{ "reviewedBy": "…", "tasks": [{ "id", "completedWithoutPointer", "evidenceMistakenForValid", "countedItemUnreachable", "timeToEvidenceSeconds" }] }`.
4. **Gate.** Run `corepack pnpm@9.15.0 run ui:gate`. It exits 0 on PASS, 1 on FAIL, and 2 on UNAVAILABLE. Release only on PASS.

## What the implementation team already verified (supporting evidence only)

- `phase-6-a11y-audit.browser.ts`: axe-core 4.13 WCAG 2.0–2.2 A/AA rules, composited text contrast, and target size. It covers 20 states × 2 themes at 1280 px and 375 px, with reduced motion on.
- `phase-6-keyboard.browser.ts`:
  - every tab stop shows a visible focus indicator that is not obscured
  - focus order matches the visual order
  - focus stays contained in Memory and the drawer
  - a full Memory review can be completed without a pointer
  - reduced motion is honoured
  - the hover tooltip meets 1.4.13
  - single-key shortcuts can be turned off (2.1.4)
  - the live search status meets 4.1.3
- `phase-1-shell.browser.ts`, `phase-2-memory.browser.ts` and `phase-4-evidence.browser.ts`: the per-phase acceptance cases.
