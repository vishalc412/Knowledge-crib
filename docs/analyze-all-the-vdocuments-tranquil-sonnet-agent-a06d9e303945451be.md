# Adversarial verification: grammars-v4 coverage claim

## Claim
"RPG, Natural, PL/I, MUMPS, ACE, PowerBuilder, Clarion, Progress OpenEdge ABL were not found in the visible repository listing, indicating either thin/absent ANTLR coverage or that they fall below the truncation point and require dedicated confirmation."

## Method
- WebFetch of grammars-v4 root page: listing truncates at `gff3` (alphabetical, ~half of 314 dirs).
- Direct GitHub API (mcp__github__get_file_contents on `/`): 314 dirs total.
- Direct path probes for each language dir.

## Results (definitive, GitHub API)
| Language | dir exists? | notes |
|---|---|---|
| rpg | NO | genuinely absent |
| natural | NO | genuinely absent |
| pli / pl1 | NO | genuinely absent |
| **mumps** | **YES** | `mumps/mumps.g4` — "An ANTLR4 grammar for MUMPS files" |
| ace | NO | genuinely absent |
| **powerbuilder** | **YES** | `powerbuilder/PowerBuilderLexer.g4` + `PowerBuilderParser.g4`; plus `powerbuilderdw` (DataWindow) |
| clarion | NO | genuinely absent |
| progress / openedge | NO | genuinely absent |

## Verdict: REFUTED
Supporting quote marks MUMPS and PowerBuilder as "❌ Not visible" — both are contradicted by primary evidence (real grammars exist). 2/8 entries are factually wrong; the "thin/absent ANTLR coverage" implication fails for those two.