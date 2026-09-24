# `.crib/memory/enhancement/` — the enhancement layer over the memory ledger

An **enhancement** is one file per memory record that adds what the record's own schema has no
field for, **without changing the record**. The ledger keeps the claim; this directory keeps the
context around it.

```
.crib/memory/
  policy.json          # unmodified
  team/                # the committed team-shared ledger (records, shards, JSONL)
  enhancement/
    README.md          # this file — the contract
    index.json         # record id -> enhancement file, with a ledger status snapshot
    <mem-id>.md        # ONE per recallable record, named by its full record id
    pending-captures.md # the untrusted capture outbox, kept out of the ledger by design
```

## Why this layer exists

A memory record is deliberately narrow. Its shape — claim, trust tier, evidence items, freshness
verdict — is what makes it recallable, disputable, and supersedable, and it is why the freshness
engine can derive a verdict instead of an agent asserting one. But five things that make a claim
*usable* have nowhere to live in it:

1. **How to apply it.** A record states a fact; it rarely states the action the fact implies.
   `applyTo` exists but is a path list, not a procedure.
2. **What would falsify it.** A record carries evidence *for* the claim and nothing about what
   would overturn it. A claim with no stated falsifier cannot be re-tested, only re-read.
3. **Where it sits among its neighbours.** Records are retrieved individually. The relations
   between them — this one supersedes that one, these two describe the same boundary from two
   sides, these three are all instances of one failure mode — are invisible to a single recall.
4. **What it deliberately does not claim.** The most-misread records are the ones whose scope is
   narrower than their subject. The record's `claim` text usually does say so; a reader under
   retrieval pressure usually does not notice.
5. **Its verification state in prose.** `evidence: degraded`, `applicability: current` and
   `freshness: fresh` are machine verdicts. *Why* one evidence item is degraded is not in the
   record.

An enhancement supplies exactly those five, and nothing else.

## Hard rules

1. **An enhancement never restates a verdict as its own.** Trust, evidence, applicability,
   lifecycle and freshness are derived by the freshness engine from the record and its evidence.
   An enhancement may *quote* the record's current verdicts (stamped with the reading that
   produced them) and must never compute or upgrade one. Writing "this is verified" in an
   enhancement is a defect.
2. **An enhancement never contradicts its record.** If the record is wrong, the fix is a
   superseding record (`memory op=supersede`), not an enhancement that argues with it. A
   correction recorded here is a *pointer to* that supersession, not a substitute for it.
3. **No new claims.** Every factual statement in an enhancement is either (a) already in the
   record, (b) a pointer to a file and line that resolves, or (c) an explicit procedural
   instruction. An enhancement is not a place to introduce a finding that was never admitted as a
   record — that goes to the ledger, with evidence.
4. **One file per record, named by the full record id.** `<mem-id>.md` where `<mem-id>` is the id
   with the `mem:` prefix stripped. No short names: the id is the only key guaranteed unique, and
   it is what a reader arriving from a recall result will have in hand.
5. **Missing file is a legitimate state.** A ledger record with no enhancement file is
   *unenhanced* — normal, and not an error. `index.json` distinguishes enhanced from unenhanced
   explicitly so the gap is visible rather than inferred.
6. **Enhancements are not recallable.** Nothing in this directory is served by `brief`,
   `memory_recall` or `memory op=search`. It is read by a human or an agent that already has the
   record id. It is not a memory tier, and it must not be treated as one.

## File format

```markdown
# <record subject>

- **record**: `mem:<id>`
- **kind**: fact | procedure | decision | pitfall | convention
- **ledger verdicts at reading** (read <ISO date>, codeHead `<sha>`): trust=… evidence=…
  applicability=… lifecycle=… freshness=…
- **enhanced**: <ISO date>

## The claim, in one line
<the record's own subject, quoted — not paraphrased>

## How to apply it
<the action the fact implies; imperative; names the command or the file>

## What would falsify it
<the observation that should make a reader supersede this record>

## Relations
<[[mem:…]] links with the relation named: supersedes / corroborates / same-boundary-as /
instance-of / contradicts>

## Scope — what this does NOT claim
<the reading the record is most likely to be over-extended into>

## Verification state, in prose
<which evidence item is degraded and why; what was re-read and when>
```

Bracketed links use the record id verbatim so they are greppable:
`[[mem:7238293f…]]`. A link to a record that does not exist yet is allowed and is a marker for
work not done, not an error.

## Relationship to `crib enrich`

`crib enrich` drives the **semantic layer over code** (path-prefix scopes, symbol/file/cluster/
system layers) and is authored through the MCP server, which validates and persists it. This
directory is the **same idea aimed at the memory ledger instead of the code graph**, kept on disk
so it is reviewable in a pull request and shared with the repository. They are complementary and
do not overlap: `enrich` answers "what is this code for", this answers "what does this claim
imply, and what would overturn it".
