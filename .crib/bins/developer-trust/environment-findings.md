# Environment findings

Machine and tooling state discovered while doing this work. None of this is a claim about the
repository's code; all of it is state a reader will otherwise re-derive by hand, usually by
losing an hour to it.

---

## E1 — The global `crib` shim is broken; use the repo-local CLI (OPEN — not fixed)

`which crib` → `/Users/vishalchawla/Library/pnpm/crib`. That shim resolves to a **stale sibling
checkout** — a directory named `Knowlege-crib` (missing the `d`) — which no longer has the
modules the shim asks for. Every invocation dies with `ERR_MODULE_NOT_FOUND`.

**What to do instead:** the repository-local CLI works and is current:

```
node packages/cli/dist/cli.js <verb>
```

**Consequence for reading this repository's docs.** Any instruction of the form `crib update`,
`crib index`, `crib status` must be run through the repo-local path, or it will fail with a
module error that looks like the command does not exist. Several procedures in the program's own
docs are written against the bare `crib` name and will appear broken on this machine for this
reason alone.

**This is also a pending capture** with **zero evidence** — `cap:23cb26ad8570`, "crib on PATH
resolves to a sibling checkout, not this repo". It cannot be admitted to the ledger as it stands
(see `../../memory/enhancement/pending-captures.md`): a claim with no admissible evidence is a lead,
not a record, however obviously true it looks from the shell.

---

## E2 — There is no `bin` primitive in crib (why a bin is a convention)

A **bin** is an on-disk convention defined by `.crib/bins/README.md`, not a feature of the
memory substrate. Crib's real partitions are:

| Partition | Values |
|---|---|
| directories | `memory/`, `dossiers/`, `index/`, `embeddings/`, `graph/`, `schema/`, `intelligence/` |
| ledger `source` | `team` \| `local` \| `global` |
| `scopeBoundary` | `repo` \| `global` |
| memory `kind` | `fact` \| `procedure` \| `decision` \| `pitfall` \| `convention` |
| the enrichment layer | `crib enrich` — the semantic layer over **code**, not memory |

There is no verb that lists, validates, or queries a bin. Nothing enforces its shape. The
`README.md` + `index.json` requirement, the rule set, and the "not recallable" property are all
conventions that this repository maintains by reading them.

**What this means practically:** a bin cannot be looked up by a tool. It is found by a human or
an agent that knows the path. Its integrity depends entirely on the rules being written down and
followed, which is why `.crib/bins/README.md` is load-bearing rather than decorative.

---

## E3 — The store layout, and how to enumerate records without truncation

**Local (machine-private) store root:**
`~/.crib/memory/repos/31fec5e7-5a85-497a-9cf6-3d2e98e08e5b/` — `31fec5e7-…` is this repository's
id.

| Path | Contents |
|---|---|
| `active/` | 15 `.jsonl` shards: `01, 10, 3e, 41, 65, 76, 8f, 98, 99, a3, bf, cd, ee, f7, fe` — **1:1 with the 15 records** |
| `candidates/` | 31 |
| `decisions/` | 1 |
| `intakes/` | 31 shard files (re-measured 2026-09-24) |
| `outbox/` | 32 shard files holding **33** capture objects — `32.jsonl` holds two lines |
| `vectors/`, `fts.gen`, `store.gen`, `stop-nudge.json` | derived |

**Team store root** is `<cribDir>/memory/team` — the `teamStoreRoot` body at
`packages/memory/src/paths.ts:46` — and **`.crib/memory/team/` does not exist here**, so there are
**zero team records**. All 15 records are `source: local`. `.crib/memory/` holds only
`enhancement/` and `policy.json`.

**The enumeration problem and its solution.** `memory op=search` returns `truncated: true` at
its defaults, and the binding lever there is the **token budget**, not the hit **`limit`**
(`packages/mcp/src/verbs.ts:3047` `args.maxTokens === undefined ? 2000` is the default budget,
`:3034` `capInt(args.limit, 5, 20)` the default limit; re-measured 2026-09-24, `memory op=search`
q=`crib` at `limit: 20` alone still returns `truncated: true`): 13 of the 15
records are eligible, so the default cut. Passing `limit: 20` with `maxTokens: 30000` returns
`truncated: false` with all 13 eligible records whole. What no search returns is the two
**non-eligible** records (the superseded v1 `mem:8de72df0…` and its v2 successor
`mem:686d520d…`), so when completeness means *all 15*, read the shards directly:

```
jq -c . ~/.crib/memory/repos/31fec5e7-*/active/*.jsonl
```

That yields all 15 records with full subject, claim, evidence and verdicts. **Use this whenever
completeness matters** — a short search result was cut by the default budget or limit, not by an
empty store.

**Arithmetic that closes** (from `memory op=status`): 15 total = 13 eligible + 1 superseded v1
(`mem:8de72df0…`, valid evidence, local) + 1 v2 successor (`mem:686d520d…`, empty evidence,
candidate). `trust` local:14 + candidate:1; `evidence` valid:13 + degraded:1 + invalid:1;
`lifecycle` active:14 + superseded:1.

**The one degraded-evidence record** — `memory op=status` reports `evidence` degraded:1 — is
`mem:83b3f3292f436a11164cbd8effdd67be71fe434789635e90a62f561fb53b9ccf`.

**The pending captures count as 19, not 18.** A naive `grep -l '"status":"pending"'` undercounts,
because `outbox/32.jsonl` holds two JSON lines. Reconcile with
`jq -c 'select(.status=="pending")' ~/.crib/memory/repos/31fec5e7-*/outbox/*.jsonl` → **19**
pending, matching the `pending: 19` that `memory op=status` reports (33 objects = 19 pending + 14
done).

---

## E4 — `.crib/` tracking: what is ignored, and why

The root `.gitignore` carries the pattern `.crib/*` (`:71`), then `!.crib/memory/` (`:72`) and
`!.crib/bins/` (`:73`), with an explanatory comment block at `:52`–`:70`. The pattern is `.crib/*`
**with negations**, not `.crib/` — git will not descend into an excluded *directory*, so a bare
`.crib/` plus negations would not work.

`git check-ignore -v .crib/bins/README.md` prints nothing and exits 1 (no ignore rule matches),
and `git ls-files .crib/bins/` lists the bin files — so `bins/` is **tracked**. These are
working-tree line numbers: the same pattern sits six lines lower here than in the `HEAD` blob,
where `.crib/*` is `:65`, `!.crib/memory/` is `:66` and the comment block ends at `:64` (the
six-line `.crib/bins/` comment block was inserted at `:65`–`:70`).

**`.crib/.gitignore` is not the relevant file** — it exists but contains only `index/` and
`embeddings/`.

| Path | Tracked? |
|---|---|
| `.crib/bins/` | yes (`!.crib/bins/` at `.gitignore:73`) |
| `.crib/memory/` | yes (`!.crib/memory/` at `.gitignore:72`) |
| `.crib/memory/enhancement/` | yes (inherits the above) |
| `.crib/dossiers/`, `.crib/index/`, `.crib/embeddings/` | no — generated build output |
| `~/.crib/memory/` | n/a — outside the repo |

**Credential-gate consequence.** `scripts/credential-check.mjs` lists files with `git ls-files`
(`:118` `let via = 'git ls-files';`, `:139` `listed = git(['ls-files', '-z']).split('\0')…`). So when
the checked root is the work tree top it scans **tracked** files only, and it scans its own
allowlist — the other branch (`:136`
`realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== realpathSync(REPO)`) falls back to
a directory walk (`:141` `via = 'directory walk (not a git work tree root)'`). A **PASS taken before
`git add` describes the old tree**; re-run it after staging. Never paste a secret-shaped string into a bin.

**Merge-driver consequence.** `.gitattributes` binds `.crib/**/*.jsonl` to `kcrib` and
`.crib/memory/team/**/*.jsonl` to `kcrib-memory`. Bin files are `.md`/`.json`, so **no merge
driver applies** — ordinary git semantics.

---

## E5 — Nothing in this work perturbs a receipt or the linter

Two checks, both negative, both worth not re-running:

- **Receipts.** `scripts/client-certify.mjs:1707` sets `cribMemoryDir: join(cribHome, 'memory')`,
  and `:166` hashes the **path string**, not the tree — `sha256` takes a `String(value)` while the
  file-reading `sha256File` sits at `:167`–`:168`. Neither a new `bins/` directory nor a new
  `memory/enhancement/` directory changes any receipt.
- **Lint.** `biome.json:9` **ignores `.crib/**`**. No file under `.crib/` is linted, so nothing
  written there can turn `biome check .` red.

---

## What this file does NOT claim

- **Not a verdict on the product.** E1 records that one PATH entry resolves to a stale sibling
  clone; that is a fact about this machine's `crib` shim, not evidence about the CLI's
  correctness, and pointing at `node packages/cli/dist/cli.js` is not a claim that a published
  package works.
- **Not a claim about the repository's code.** E2's partition table and E3's counts describe the
  store layout of *one machine* on one day. A different `~/.crib/` will differ; nothing here says
  what the substrate ought to contain.
- **No credential-gate verdict.** E4 records that `scripts/credential-check.mjs` lists files with
  `git ls-files` and therefore scans tracked files only. It does not claim a PASS, does not claim
  the bin's current contents are clean, and "re-run after `git add`" is a procedure, not a result.
  No credential gate was run for this file.
- **No merge-behaviour measurement.** E4's merge-driver point is read from `.gitattributes`
  (`:9`–`:10`); it says which driver *would* bind, not that a merge was attempted. No conflict was
  simulated.
- **No whole-tree lint result.** E5's lint sentence was re-derived by running `biome check` on
  `.crib/bins/developer-trust/index.json` and `.crib/memory/enhancement/index.json` (both
  "Checked 0 files") against a control that was linted (`.crib`-external `biome.json`, "Checked 1
  file") — not by running the whole-tree `biome check .` E5 names.
- **Not a trust verdict on any memory record.** E1 points at `cap:23cb26ad8570`; E3 counts records
  and names one degraded-evidence id. Those verdicts belong to the ledger, read here via `memory
  op=status` / `memory op=search`; this file neither adjudicates nor restates them. A bin may
  point at a record id; it may not speak for it (`.crib/bins/README.md:46`–`:47`).

---

## Anchor re-check note

The line numbers in this file were corrected on 2026-09-24, after the six-line `.crib/bins/`
comment block inserted into `.gitignore` pushed the `.crib/*` pattern from `HEAD`'s `:65` down to
the working tree's `:71`. E4 now cites the working tree and carries the `HEAD` numbers alongside,
so a stale copy is detectable.

Sections **E1**–**E5** keep their identifiers: `../../memory/enhancement/pending-captures.md`
cites (E1) and (E4) by number — its two links are at `:57` and `:59`, the section names they
attach to at `:58` and `:60`.
