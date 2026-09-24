# Open Knowledge Crib `crib viz` task study

Status: ready for voluntary participation; no participant results have been collected yet. The project owner opened participation to any developer using Knowledge Crib on their own project. This study is part of the Phase 5 UX gate and should run again after Phase 6 accessibility remediation.

## Who and setup

- Participants should be unfamiliar with the current `crib viz` UI. Prior CLI use is fine.
- Use a local project that the participant is authorized to inspect. Do not submit source text, claim text, secrets, screenshots of private code, or raw Memory IDs with results.
- Record the Knowledge Crib commit/version, OS, browser, viewport, chosen theme, input method, and whether the project has a populated Memory ledger. Run `crib viz` locally; no hosted service is needed.
- A moderator may observe with the participant's consent. Do not explain where a control is until the participant declares the task blocked; record any hint as assistance.

## Tasks, in order

1. **Find a symbol.** Choose a real function or class in the participant's project. Starting at the overview, locate it and state its module and path. Record time to correct symbol, wrong turns, presentation used, and any help.
2. **Inspect source.** From that symbol, open its current indexed source excerpt. State whether the excerpt is available and whether its file and span match the intended symbol. Record time and any mistaken source interpretation.
3. **Assess Blast.** Show the symbol's reverse dependencies. Name one directly affected symbol and one module, or correctly state that none were discovered. State whether a canvas cap or traversal limit is disclosed. Record any assumption that the visible canvas is the full impact set.
4. **Decide whether to use a Memory claim.** Choose a claim with evidence in the participant's authorized Memory ledger. State its lifecycle, evidence verdict, applicability, and whether it is recall-eligible or needs review. Open detail and inspect the available basis. Record any invalid or degraded evidence mistaken for valid evidence. If the project has no such claim, mark this task unavailable and do not invent one.

The participant may use Graph, List, or Split and may switch presentations. Repeat the four tasks with keyboard only for at least one participant before the final gate. Phase 6 adds the full independent assistive-technology assessment; this study does not replace it.

## Record one row per task

| Participant code | Project type | Version | Browser / viewport / theme | Task | Completed without help? | Seconds | Wrong turns or mistaken interpretation | Assistance given | Recovery used |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| P01 |  |  |  |  |  |  |  |  |  |

Use a random participant code, not a name. A facilitator should summarize recurring misunderstandings and exact copy or hierarchy changes made in response. Keep the raw study rows local to the project team; commit only anonymized findings and the resulting design decisions.

## Gate interpretation

Review task completion, time to evidence, and mistaken interpretations together. A task counts as completed only when the participant reaches the correct item and can explain its meaning; a click alone is insufficient. Any invalid evidence treated as valid, counted Memory item that cannot be opened, or essential task that needs pointer coordinates is a release issue to fix and retest. Record skipped tasks separately from failures.
