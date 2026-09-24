# `.crib/bins/` — the bin convention

A **bin** is a named, self-contained directory of durable knowledge that belongs to the
repository, sits next to `.crib/memory/`, and is **not** a memory record.

```
.crib/
  bins/                    # this directory — peers of memory, ignored by default (see Tracking)
    <bin-name>/
      README.md            # required — what this bin is for, and an index of its files
      index.json           # required — machine-readable manifest of the bin's files
      *.md | *.json        # the knowledge itself
  memory/
    policy.json            # unmodified
    team/                  # the committed, team-shared memory LEDGER (claims + trust + evidence)
    enhancement/           # agent-authored ENHANCEMENT of ledger records (see its own README)
```

## Why bins exist (and why not just use memory)

The memory ledger holds **claims**: one proposition each, carrying a trust tier, admissible
evidence, a freshness verdict, and a lifecycle. That shape is a promise, and it is what makes a
record recallable and disputable. It is also narrow. A lot of durable knowledge produced by real
work does not fit it:

| Knowledge | Ledger record? | Bin file? |
|---|---|---|
| "This instrument's p95 is 2405.9 ms at n=5 on a 786k-LOC copy" | yes — a measurement claim | yes, with the invocation and the logs |
| "The 2 s and 5 s bounds are in conflict and a principal must choose" | no — an open decision, not a fact | yes |
| "I fabricated p50 values once and caught it; here is the procedure that caught it" | no — a correction with a procedure attached | yes |
| "The global `crib` shim points at a stale sibling clone" | no — environment state, not a claim about this repo | yes |
| "WP3-H7 is blocked on B11/B13; WP6 is externally blocked on B8" | no — program state | yes |
| The instrument's flags, constants and negative control | partially | yes |

So the split is by **shape**, not by importance:

- **`.crib/memory/`** answers *"what is claimed, how strongly, on what evidence, and is it still
  true?"* It is a queryable substrate with a lifecycle. Verdicts on it are computed by the
  freshness engine from evidence — never asserted by an agent.
- **`.crib/bins/<name>/`** answers *"what did this piece of work establish, leave open, and get
  wrong?"* It is a work-product dossier. It is read by humans and agents, and it has no trust
  lifecycle — which is precisely why a bin must never be cited where a *trusted claim* is
  required.

A bin is not a third memory store and must not be used as a side-channel to evade the ledger:
anything reusable that *is* a claim belongs in memory, with evidence. A bin file may **point at**
memory ids; it may not adjudicate or restate their verdicts.

## Not to be confused with

| Path | What it is | Tracked? |
|---|---|---|
| `.crib/bins/` | this directory — durable work-product knowledge | **yes**, via an explicit negation (below) |
| `.crib/memory/` | the committed team-shared memory ledger | yes |
| `.crib/memory/enhancement/` | agent-authored enhancement of ledger records | yes (inherits `!.crib/memory/`) |
| `.crib/dossiers/`, `.crib/index/`, `.crib/embeddings/` | generated build output, reproducible with `crib index .` | no — gitignored |
| `~/.crib/memory/` | the machine-local, private ledger | n/a — outside the repo |
| `docs/` | human-facing documentation | yes |
| `.crib/memory/policy.json` | memory verification policy | yes |

## Tracking

`.gitignore` excludes `.crib/*` and re-includes `.crib/memory/` by name. `bins/` is re-included
the same way:

```gitignore
.crib/*
!.crib/memory/
!.crib/bins/
```

Two consequences a bin author must know:

1. **A bin is scanned by the credential gate.** `scripts/credential-check.mjs` lists files with
   `git ls-files`, so once a bin is tracked its contents are in scope for
   `entropy-assignment`-class findings. Do not paste a secret-shaped string into a bin, and
   re-run `node scripts/credential-check.mjs` **after** `git add` — a PASS taken before staging
   describes the old tree.
2. **No merge driver applies.** `.gitattributes` binds `.crib/**/*.jsonl` to the `kcrib` merge
   driver and `.crib/memory/team/**/*.jsonl` to `kcrib-memory`. Bin files use `.md` and `.json`,
   so they merge with ordinary git semantics. Keep a bin file single-writer per line range, or
   expect conflicts.

## Rules for a bin

1. One bin per **unit of work**, named after it in kebab-case (`developer-trust`). Not one bin per
   agent, session, or day — those fragment the knowledge and are the failure mode this convention
   is meant to avoid.
2. Every bin has `README.md` and `index.json`. The README is the human index; `index.json` is the
   machine one and must list every file in the bin with a one-line purpose.
3. **Anchors must be verifiable.** A bin file that cites a path or a line number is asserting that
   the anchor resolves. Line numbers rot; when you cite one, cite the *row it names* too, so a
   stale number is detectable rather than silently wrong. (See
   `developer-trust/corrections-log.md` for why this rule is written down here.)
4. **Separate measurement from intent.** A bin file reports what was run and what came out; it
   does not convert that into a verdict about whether the product is good. Where a number does not
   decide a question, say so.
5. **Record what was refused.** The most expensive knowledge to re-derive is the work that was
   deliberately *not* done and why. A bin with no "what this does not claim" section is
   incomplete.
6. Never move a bin file's line numbers without re-checking the anchors that point into it.

## Current bins

| Bin | Subject |
|---|---|
| [`developer-trust/`](developer-trust/README.md) | The developer-trust program (WP0–WP6): its measurements, its corrections, and its open residue |
