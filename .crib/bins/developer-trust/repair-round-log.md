# Developer-trust bin — repair rounds

This file logs the repair rounds run against the enhancement layer
(`.crib/memory/enhancement/`) and the developer-trust bins, and it closes the round that just
finished: what it applied, what it declined, and why. It is a work log, not a judgement: no memory
record's trust, evidence, applicability or lifecycle verdict is restated, confirmed or contradicted
here. Those live in the record and in the enhancement layer's own contract.

The counts below are ones I took myself — from the workflow journal for this session's repair run and
from direct measurement of the tree — not from a paraphrase of either. Where a number came from the
journal rather than from the repository, it says so, because the journal is a session artifact and no
revision holds it.

---

## The closing round's counts (read from the run's journal, not from notes)

- **13** repairs were applied.
- **14** defects were introduced by those repairs — a repair that fixed one thing and broke another
  counts in both columns.
- **15** defects survived the round unrepaired, as reported by the verifiers.
- **3** verifier verdicts were fully clean.

An earlier count taken from this session's own notes read 12 / 12 / 11 and was wrong. It was
discarded and re-counted by reading the journal; the journal also carries a 13th repair and a 13th
verifier that the notes omitted entirely, and a `bin-b5-update-visibility` verifier that reported 0
introduced and 3 residual defects — a combination the notes had no record of at all.

**The loop is not convergent.** The round introduced 14 defects while applying 13 repairs, so a
further blanket pass over the same surface would be expected to leave the surface no cleaner than it
found it. Every round logged in this file behaved the same way. The closing decision was therefore to
repair only what could be sourced from the tree by direct measurement, and to stop — not to run
another sweep.

---

## A defect in this bin's own manifest, of exactly the class this bin exists to catch

`index.json`'s `codeHeadNote` read "…`open-blockers.md:101` calls `:3933` the freshness-status line".
The citation is at `open-blockers.md:100` — `:101` is the continuation of that sentence
(`` `crib freshness worker`. ``), and the two are one paragraph apart in reading only. A reader who
checked `:101` would find no freshness-status line and no `:3933`; a reader who trusted the number
would never check. `packages/cli/src/cli.ts:3933` is the line the note means, and it holds
`` `freshness mode: ${modeLabel}… ``. The note now cites `:100`.

This is the same failure the corrections-log's rule section describes: a citation that resolves but
points at the wrong thing. It was found by re-reading the manifest's own anchors rather than by any
verifier.

---

## Applied in the closing round (5 fixes, each with the measurement it rests on)

| # | File and anchor | What changed | What justified it |
|---|---|---|---|
| 1 | `gates-and-ci.md:89` | The §9.4 heading now points at `docs/program/evidence-register.md:2163-2173` instead of `:2137` | `:2137` is the section *heading* (`### 9.4 Test-suite re-baseline against WP0`); the eight values the section tabulates are the table at `:2163-2173` — core `432`/`+15` at `:2166`, memory `1,171`/`+62` at `:2167`, ui `42`/`+17` at `:2169`, mcp `490`/`+22` at `:2170`, cli `662`/`+31` at `:2172`, total `3,607`/`+147` at `:2173` |
| 2 | `gates-and-ci.md:68` | `"not needed"` and `"skipped because something above it failed"` are no longer in quotation marks | The register contains neither string. They are this file's own gloss, so the quotation marks attributed them to a source that never said them |
| 3 | `environment-findings.md:136` | The quoted call is now `git(['ls-files', '-z'])` | `scripts/credential-check.mjs:139` reads `listed = git(['ls-files', '-z']).split('\0').filter(Boolean);` — the quote had dropped the space after the comma |
| 4 | `b5-update-visibility.md:18` | The row label is now "Method as `docs/bench/perf-gates.md:43-44` states it" | The register states no method (`warmup` / `warm-up` / `warm iter` occur nowhere in it); the method is at `docs/bench/perf-gates.md:43-44`, which the row's own anchor already named |
| 5 | `open-blockers.md:192` | The "Run serially … `mcp` (490/490) clear outright" clause is marked as `:2129`'s pre-fix half, superseded for `mcp` by the row's own correction | `docs/program/evidence-register.md:2129` corrects exactly this: with `workspace-concurrency=1` verified in effect by tool, `mcp` still exited 1 on `onTaskUpdate` while reporting `490 passed` — and the row says the claim is corrected there rather than left to be quoted |

All five edits preserve their file's line count, so no inbound anchor in this bin moved. Earlier in
the same round, 8 further fixes were applied on the same rule — a re-measured store count at
`environment-findings.md:68`, a section lead made to agree with its own body at `gates-and-ci.md:121`,
the register's verbatim wording for the named error at `open-blockers.md:9`, the C7 quote attribution
at `corrections-log.md:177`, the C2 counted population at `corrections-log.md:218`, and three
deletions in two enhancement files (`45338390…`, `bab1095d…`) of prose that was neither in the record
nor a resolving pointer.

---

## Declined in the closing round, with the reason (rule 5)

- **An eighth corrections-log entry (C8).** It would extend the log's scope from the program documents
  it declares at `corrections-log.md:209-211` to this bin's own manifest, and it would need two edits
  to existing prose (the "Six of the seven" count and its exception clause). The corrected fact is
  already fully sourced in the live manifest and in `README.md`, so no truth is hidden by leaving it
  out. Adding prose is also the defect class this round's verifiers flagged most often.
- **Normalising the line-5 separator in three enhancement files** (`bab1095d…`, `c7616aa2…`,
  `e0b02057…`). Nothing parses that bullet — no code reads the string, and the manifest's `enhanced[]`
  entries carry no per-file hash — so `; ` versus ` ` is stylistic variance, not a contract breach.
  Each file carries its freshness statement. Editing three verified files to change punctuation is
  churn.
- **Adding `implementations/` to the store-root table in `environment-findings.md`.** The directory
  exists and the table does not name it, but the table makes no exhaustiveness claim, so this is a gap
  rather than a false statement. Adding a row would shift every later line in the file, and
  `index.json`'s `codeHeadNote` cites `environment-findings.md:79` — which would then point one line
  early. **Recorded as a gap; not fixed.**
- **Two verifier residuals I judged to be false positives** rather than defects: one cites
  `.crib/bins/README.md`, which is uncommitted by design and which this bin's own
  `anchorDriftAtHead` already classifies as `notInStamp`; the other differs from the source only by a
  sentence-initial capital.

---

## Where a verifier's verdict is bounded, and why I did not adopt it

**One verdict rests on a code graph this repository's own on-disk index contradicts.** The MCP server
resolves `buildVectors@L482` and returns NOT_FOUND for `buildVectors@L554`, while the repo-root index
at `.crib/index/crib.sqlite` carries the `@L554` row and no `@L482` row; the same server reports
`indexedHead` at the bins' earlier stamp with `stale=true`. Two agents can therefore reach opposite
conclusions about one claim without either making a mistake — by reading two different graphs. Any
finding derived from that source is bounded by it, and a refresh (`crib update`) was declined during
this session, so nothing here has been re-checked against a refreshed graph.

**One residual is left open because deciding it changes the manifest, not the prose.**
`dd162a2d…`'s residual `[1]` may be a rule-2 roster requirement that the repair under-declared rather
than a defect the repair introduced. Either reading is defensible and the two lead to different
manifest edits, so it is recorded here and left to the owner rather than resolved unilaterally.

**`git diff` on `.crib/` is not attributable to one round.** Every file in this bin shows as
staged-add plus worktree-modified, because it was `git add`ed at some intermediate point in the
session. `corrections-log.md` is the clearest case: the live file is longer than its staged blob by
the whole `## What this file does NOT claim` section, which the closing round's own disposition claims
only three line-preserving edits to. **A blanket revert of `git diff` hunks on `.crib/` is therefore
unsafe** — it would delete work no round in this session performed. The diff is used here as evidence
of *what differs*, never as evidence of *who changed it*.

---

## Open decisions this file does not take

- **A supersession in the memory ledger, not executed here.** Record `7238293f…` is to be replaced
  rather than left as-is; the mechanism is the `memory` tool's `supersede` operation, which requires
  the record id, an `actor`, and either a successor id or a new `claim`. It is not executed because it
  changes what recall returns for every agent on this repository, which is the owner's call and not a
  repair. The full id is in the ledger; the prefix above is not enough to act on.
- **The register, left unrepaired.** `docs/program/evidence-register.md` is the source of record this
  bin is verified *against*, so editing it inside the round that checks the bin against it is
  circular. Observations made earlier in the session, carried here as observations and re-measured
  only where the wording below says so: the §4.4 run count at `:667-668` reads 99 against a live
  total of 208; row B6's `1,527` for the x-dc payload measures 1,642 content lines; row B5's bare
  `perf-gates.md` line has drifted. Two were re-measured here. Row B16's
  `packages/cli/src/cli.ts:3929` is the stamp-era freshness-status line — at `3434c19f` that text is
  at `packages/cli/src/cli.ts:3933`, and `:3929` holds `const modeLabel = status.modeExplicit` — so
  that row is correct against `060898de` and stale against HEAD. Row B14's
  `packages/ui/web/index.html:1805-1806` is a different kind of defect: it names the obfuscated pair
  at **no** revision, because index.html is byte-identical at `060898de`, `cdc04bfc` and `3434c19f`
  (2,371 lines each, sha256 `a2a975bf9e9f63b4`) and `:1805`/`:1806` hold the `closeIntake` doc comment
  and signature at all three, while the pair the row describes sits at `:1855`/`:1856`. That is the
  same measured finding as `corrections-log.md` C3, not an independent one. All are left to the owner.
- **The dead `on.push` trigger in `.github/workflows/ci.yml`.** Offered, not applied. The consequence
  is stated in this bin at `gates-and-ci.md:86-87`: the green check on a PR describes
  `pull_request` only, and is not evidence that anything ran on a push to the default branch.

---

## The verification round after the closing round (4 defects, all in this bin's own manifest)

An independent verification pass followed the closing round: six re-derivations of named claims, each
with its own evidence, then a coverage scan. **Four of the six returned a result; two did not**
(`verify:no-verdict-restatement`, `verify:self-consistency`), so this round says nothing about the two
dimensions those covered and is not a clean bill of health on them. Of the four that returned, two
were fully confirmed and two carried refutations that I re-measured myself — items 1 and 3 survived
that re-measurement, and item 2 was found while re-measuring item 1. All four are in `index.json`'s
**generated** fields rather than in a prose file, so none of them moved a line of prose. Item 4 was
found later still, by running the committed generator from outside the repository after the commit —
it is the defect that committing this bin created.

**1. `bareLineTokens` was counting a file this bin does not contain.** The field reported **247** bare
`:NNNN` tokens "in these files". That was not a count of the files. The generator read `index.json`
through the anchor pass's `textOf`, which re-serializes it with **compact** `JSON.stringify` after
deleting two generated fields — and compact JSON writes `"lines":2329` where the file on disk holds
`"lines": 2329`. The bare-token regex matches the first and not the second, so the count **added 18
structural JSON values that are not citations at all** and **dropped 8 prose ones** that lived in the
deleted fields: net +10. Counted instead over the bin's `.md` files read exactly as they sit on disk,
the class was **228** at the run that found the defect — README 3, b5-update-visibility 44,
corrections-log 64, environment-findings 26, gates-and-ci 13, open-blockers 57, repair-round-log 21 —
and `notCoveredByAnyCount` was 227. Both figures are dated by construction: the count is a property of
these files, and this section is one of them, so writing this paragraph moved them —
`bareLineTokens.totalInMdFiles` and `notCoveredByAnyCount` now read 230 in the manifest. The per-file
breakdown came from a separate audit run rather than from the committed generator, so it is not
re-runnable from this bin; the *total* is, and `bareLineTokens.totalInMdFiles` is where a reader can
dispute it. `index.json` is now excluded from the count explicitly, and the field says so; that also
stops the manifest from counting its own description of itself.

The direction of the error is worth naming: it made the coverage bound look **wider** than it is,
because 18 of the 19 extra tokens were not citations. A bound that overstates the work still to do is
a defect of the same class as one that understates the work already done.

**2. `distinctCitations` was presented as the token regex's output, and it is not.** At the run that
found this it read **84** while the declared regex produced **83**. The 84th is
`packages/mcp/src/verbs.ts:3034`, which reached the set by *reading the row it names* —
`environment-findings.md:80` cites it as a bare `:3034` — and the manifest already disclosed that entry
under `bareLineTokens.included` with its `resolvedBy`. What it did not do was say the headline count
includes it. The gap is one token wide and invisible to anyone who read only `distinctCitations`. Both
numbers are now carried: `distinctCitationsByTokenRegex` and `distinctCitationsResolvedByReading`.
**The token is kept, not dropped** — it is an anchor this bin genuinely cites, and excluding it would
undercount in order to make the method sentence tidier.

Those three figures are dated too, and how they moved is itself the demonstration. Writing this
paragraph spells `packages/mcp/src/verbs.ts:3034` in full, so the token regex now reaches that anchor
unaided and the hand entry adds nothing to the set: `distinctCitationsResolvedByReading` went **1 → 0**
and `distinctCitationsByTokenRegex` **83 → 86** — the token that had been the hand-resolved one, plus
the two anchors this section itself introduces. The manifest does not assume either regime now:
`bareLineTokens.ofWhichAddedAsDistinctCitation` reports whether the hand entry actually added a
citation on this run, and the coverage arithmetic uses that computed value rather than the count of
hand entries, so a re-run cannot report a token as enumerated when the regex already reached it.

**3. A guard that does no work was described as if it did.** The overlap exclusion in the bare-token
scan was commented as preventing one citation from being counted twice. Measured with and without it,
the count was 228 either way at that run: none of these files quotes a `path:line` inside backticks. It
is kept — that is the shape which would defeat a naive scan — but the comment now says it is a no-op on
these files instead of claiming a job.

**4. Committing the bin made two of the manifest's own bounds false, and neither was computed.** The
generator had asserted that "the files in this bin are staged but not committed, so they exist in no
revision" and that the `.crib/` anchors "are uncommitted and so present in no revision". Both were true
of the tree they were measured on and became false the moment the bin was committed — at which point
19 anchors that the manifest still labelled `notInStamp` did resolve at HEAD, because the tree that
lacked them was the *stamp*, not HEAD. Found by running the committed generator from outside the
repository after the commit, which is the one check that exercises the file a reader actually gets. The
manifest now asks HEAD's tree directly (`git cat-file -e HEAD:<path>`) instead of inferring commit state
from the index, reports which of the two trees lacks an anchor rather than letting one label stand for
both, and carries the distinction in `anchorDriftAtHead.cribPathRevisions`.

A fifth consequence of committing, named rather than repaired: `head` in the manifest is where HEAD
stood when the measurement ran, and a commit cannot contain its own hash — so the committed bin's `head`
trails the commit that carries it, by construction. That is now stated in the manifest (fourth bound,
`anchorDriftAtHead.headBound`) rather than left for a reader to notice as an inconsistency.

### One register observation taken in this round, not repaired

The live `mcp` suite reports **491** passed (491) on this tree, where register row B11 and the §9.4
table at `docs/program/evidence-register.md:2170` both read **490**. The row's *corrected* half — that
`mcp` exits 1 on an `onTaskUpdate` worker timeout while reporting a full pass, with
`workspace-concurrency=1` verifiably in effect — reproduces exactly. Only the count moved, and it moved
because a test was added to the tree after the row was measured. The register is the source of record
this bin is verified against, so it is left unedited, as the open-decisions section above says.

**What this round did NOT do.** It did not re-open the closing round's 15 unrepaired residuals, did not
re-check anything against a refreshed code graph, and did not re-measure the register except where the
paragraph above says so.

---

## What this file does NOT claim

- **Not a claim that the enhancement layer is clean.** 15 residual defects survived the closing round
  and were not repaired.
- **Not a claim that the repair loop has converged.** The closing round introduced 14 defects while
  applying 13 repairs; that ratio is the reason it was stopped, not evidence that it finished.
- **Not a claim about any memory record.** No record's trust tier, evidence, applicability, freshness
  or lifecycle is restated, confirmed, contradicted or adjudicated here. Record ids appear in this
  file only as pointers to files that exist.
- **Not a claim that the counts are reproducible from the repository.** The 13 / 14 / 15 / 3 counts
  were read from this session's workflow journal, which is a session artifact and is held by no
  revision.
- **Not a claim that the register was verified in the closing round.** The register findings above were
  observed earlier in the session; rows B16 and B14 alone were re-measured, and that bullet says which.
- **Not a claim that the verification round cleared this bin.** It is not a clean bill of health on the
  dimensions it covered: two of its six re-derivations never returned a result, and two of the four
  that did returned refutations. Those refutations became the two repairs in its section above; the two
  silent dimensions were neither checked nor cleared.
- **No claim about the content of `.crib/` artifacts across revisions.** They are uncommitted and so
  exist in no revision; `anchorDriftAtHead` in `index.json` states the same bound.
