# Change localisation and co-change: crib against the baselines a developer already has

**Status: FOURTH READING — now EXTERNALLY VALIDATED on three foreign repositories in three
languages. crib beats ripgrep on all four repositories tested. Getting there required fixing a
coverage bug the external run exposed: CommonJS JavaScript was losing half its symbols.** Measured 2026-09-21. Published — including the first, worse numbers — because
every accuracy claim this project made before today rested on 22 hand-written questions authored by
someone who could already see the answer.

Reproduce:

```bash
node scripts/bench/locate-corpus.mjs --depth 150
git worktree add --detach /tmp/bench-base <base-sha>
node packages/cli/dist/bin.js index /tmp/bench-base
node scripts/bench/locate-eval.mjs --base-tree /tmp/bench-base
node scripts/bench/cochange-eval.mjs --base-tree /tmp/bench-base
```

## Why this corpus exists

The prior evidence was a regression gate, not a benchmark — `scripts/eval/code-vector-eval.mjs` says so
in its own header: "22 questions, one repository, authored by someone who knows the codebase". A
question written by someone looking at the code cannot measure whether a developer's question gets
answered.

Git history has no such problem. A commit message is a developer describing a change in their own words,
and the files it touched are ground truth that predates any benchmark. 61 localisation tasks and 75
co-change tasks were derived from this repository's history with no hand-labelling.

**Three leakage controls, because without them this measures nothing.** The index is built from a BASE
commit that predates every evaluated commit; path-like tokens and ground-truth filenames are stripped
from every question (and what was stripped is recorded per task); and only files present at the base
count as ground truth, since an index cannot find a file that does not exist yet.

## Task 1 — localisation: "here is a change, which files does it belong in?"

61 tasks, index built at `d872789840b4`, 772 files in the base tree, k = 10.

| method | phrasing | recall@1 | recall@5 | recall@10 | MRR | lift | median tokens |
|---|---|---|---|---|---|---|---|
| **crib (default, grouped)** | full message | **37.2%** | **58.6%** | **71.7%** | **0.610** | **1.22** | 3,912 |
| crib (default, grouped) | subject only | 26.1% | 50.1% | 59.8% | 0.467 | 0.93 | 3,937 |
| crib (default, grouped) | no scope | 22.3% | 47.6% | 56.5% | 0.425 | 0.85 | 3,938 |
| crib `--kinds symbol` | full message | 37.2% | 60.2% | 71.7% | 0.611 | 1.22 | **3,625** |
| crib `--kinds symbol` | subject only | 25.1% | 53.4% | 58.9% | 0.469 | 0.94 | 3,672 |
| crib `--kinds symbol` | no scope | 22.9% | 49.3% | 57.8% | 0.442 | 0.88 | 3,681 |
| crib *(old blended default)* | full message | 16.5% | 35.7% | 47.3% | 0.323 | 0.64 | 3,735 |
| crib *(old blended default)* | subject only | 13.5% | 38.3% | 49.1% | 0.299 | 0.60 | 3,718 |
| crib *(old blended default)* | no scope | 10.2% | 36.9% | 47.5% | 0.265 | 0.53 | 3,709 |
| grep-bm25 | full message | 24.8% | 36.9% | 50.9% | 0.478 | 0.95 | 24,062 |
| grep-bm25 | subject only | 20.7% | 45.7% | 54.5% | 0.466 | 0.93 | 68,963 |
| grep-bm25 | no scope | 20.7% | 43.6% | 51.9% | 0.458 | 0.91 | 62,663 |
| churn *(query-blind)* | — | 27.1% | 34.7% | 42.5% | 0.501 | — | 0 |
| recency *(query-blind)* | — | 0.0% | 0.0% | 0.0% | 0.000 | — | 0 |

`lift` = MRR ÷ best query-blind MRR. **The default now clears 1.00**, at 1.22 — ahead of ripgrep by
28% on MRR and 6.2× cheaper in tokens. The default and the explicit flag are within 0.001 of each
other, so the measured win is what a caller gets without knowing any flag exists.

### H3, shipped: prose and code are separate groups

`query` no longer blends them. By default `hits` carries code kinds ranked by BM25, and prose kinds
(`doc-section`, `media-seg`, `agent-artifact`) come back in their own `docHits` group — capped at 5,
with a lighter per-hit shape, because prose is context for a code answer rather than the answer.
Nothing is lost: the doc section that used to occupy rank 1 is still returned, just not competing for
the slot. An explicit `kinds` takes the unchanged single-ranking path, so asking for
`kinds: ['doc-section']` still ranks prose first.

This is the argument `llmHits` already won in this codebase — semantic discoveries were moved to their
own field precisely "so they never drown out BM25 ranking" after a blended ranking put a test helper
above the real implementation. Prose was the same failure with a different source.

The cost of the grouping is ~290 tokens (3,912 vs 3,625), which buys back the doc answers that
`--kinds symbol` discards. Changing a default ranking broke exactly **2 of 3,406 tests**, both of which
were asserting the old blending; one is now explicit about wanting a blended set, and `docHits` had to
join the advisory fields the token-budget fitter drops, since a fixed-size group it cannot trim could
otherwise exceed a tight ceiling on prose alone.

### The diagnosis that produced that row

The first reading had crib at 0.323, behind both grep and the query-blind control. Per-task error
analysis on 25 tasks showed the cause was NOT recall: the correct file was in crib's top-10 for 19 of
them, at ranks 13–20 for 5 more, and absent from 60 hits only once. It was purely **ranking**, and the
top slots were consistently occupied by `docs/**.md` sections.

The mechanism is not subtle. A commit message is prose, and it matches this project's own prose *about*
a change more strongly than the code implementing it. Default discovery blends doc sections and code
symbols into one BM25 ranking, so for exactly the queries where code was wanted, documentation wins.

`kinds` had always been a parameter of the MCP `query` tool; the CLI never exposed it. It does now
(`--kinds symbol,doc-section`, with an unknown kind refused rather than silently returning nothing —
a typo would otherwise look like "no matches" instead of "no such kind").

### What this row does NOT claim

**The win depends on a verbose query.** With the full commit body, MRR is 0.610. With the subject line
alone — much closer to what someone actually types — it is 0.467, still *below* the query-blind control.
Short-query localisation is unsolved, and that is the honest limit of this result.

**The choice of `kinds: ['symbol']` was made after seeing the failures.** It is a categorical fix
motivated by a mechanism rather than a threshold fitted to the numbers, which makes it far safer than a
tuned hyperparameter — but it is still a dev-set finding on one repository and needs the held-out
external repos below before it is a general claim.

## External validation — three foreign repositories, three languages

A corpus from this repository alone has one dominant author and a churn-concentrated tree, which raises
the query-blind floor and makes the measurement a weak discriminator. These three were chosen for the
opposite profile — hundreds of contributors, flat churn — and run with the same harness
(`scripts/bench/external-repo.sh`), the same leakage controls, and an index built from each repo's own
base commit.

| repository | language | tasks | authors *(in tasks)* | crib default | crib `--kinds symbol` | grep-bm25 | churn *(blind)* | crib lift |
|---|---|---|---|---|---|---|---|---|
| knowledge-crib | TypeScript | 61 | 1 | **0.610** | 0.611 | 0.478 | 0.501 | 1.22 |
| expressjs/express | JavaScript | 86 | 42 | **0.499** | 0.498 | 0.320 | 0.152 | 3.29 |
| pallets/click | Python | 93 | 22 | 0.402 | **0.441** | 0.380 | 0.119 | 3.38 |
| gin-gonic/gin | Go | 161 | 96 | 0.527 | **0.584** | 0.331 | 0.202 | 2.61 |

**crib beats ripgrep on every repository tested**, by 28% (this repo), 56% (express), 6% (click) and
59% (gin) on MRR, at 1.6–6.2× fewer tokens. Lift over the query-blind control is 2.6–3.4× on the
external repos against 1.22 here — precisely because their churn is flat, which makes them the stronger
test and not the weaker one.

**Three corrections to what the single-repo reading claimed.**

1. **The short-query weakness was an artefact of this repository.** Here, subject-only MRR drops from
   0.610 to 0.467. On express it is 0.497 against 0.499, on click 0.396 against 0.402, on gin 0.543
   against 0.527 — *above* the full-message figure. H4 was over-generalised from one corpus, whose
   commit subjects are unusually stylised. It is withdrawn as a general weakness.
2. **`--kinds symbol` is not uniformly better than the grouped default.** It wins on click (+0.039) and
   gin (+0.057), ties here (+0.001) and loses marginally on express (−0.001). The grouping keeps doc
   answers that symbol-only discards, so the default stays grouped; a caller optimising purely for
   code-localisation ranking can pass the flag.
3. **The 0.5 bar is met on three of four repositories**, with the best configuration: 0.610 here, 0.584
   on gin, 0.499 on express, and 0.441 on click. Click is the laggard and is the honest next target.

### The coverage bug this run exposed, and why it mattered more than the ranking

The first express run had crib at **0.238**, well behind grep's 0.316 — which read as a ranking failure
and was not one. Express's graph held **146 symbol nodes across 231 files**: 0.63 per file, against 10.5
per file on a TypeScript repository. `lib/response.js` declares 21 public methods in the form

```js
res.send = function send(body) { … }
```

and the extractor had captured **9 symbols from that file, every one a module-private helper, and not a
single public method**. `res.send`, `res.json`, `res.status`, `res.redirect` — Express's entire response
API — were absent from the graph. The cause: the inner `function send(…)` is a FunctionExpression rather
than a declaration, so nothing along `ExpressionStatement → BinaryExpression → FunctionExpression`
matched `symbolInfo`, and the whole statement was walked past. CommonJS property assignment is one of
the most common declaration idioms in the npm ecosystem, and it was invisible.

Recognising it (plus `exports.x = …`, `module.exports.x = …`, `Foo.prototype.x = …`, and the
pre-shorthand `{ x: function(){} }` object-literal form) took express from 146 to **301 symbols**, and
`lib/response.js` from 9 to 31. The measurement moved with it:

| express | symbols | MRR | vs grep |
|---|---|---|---|
| before the fix | 146 | 0.238 | loses by 25% |
| after the fix | 301 | **0.499** | **wins by 56%** |

A deep receiver chain (`a.b.c.d = () => {}`) is deliberately still refused: those are local wiring
rather than declarations, and admitting them would trade discovery precision for noise.

**This is what external validation is for.** Run only on its own repository — TypeScript, where
declarations are declarations — the project could not see that half of a major language's symbols were
missing. No amount of ranking work on this repo would have found it.

## Task 2 — co-change: "I am changing this file, what else must I touch?"

This is the question `impact` claims to answer, measured on all four repositories. **The graph loses,
decisively and on every one.** That result changed the product rather than the framing.

| repository | `impact.affected` *(graph walk)* | `impact.coChanged` *(shipped)* | churn *(blind)* | graph lift | signal lift | graph tokens | signal tokens |
|---|---|---|---|---|---|---|---|
| expressjs/express | 0.042 | **0.352** | 0.125 | 0.34 | 2.83 | 3,391 | **549** |
| pallets/click | 0.113 | **0.332** | 0.120 | 0.94 | 2.76 | 9,502 | **807** |
| gin-gonic/gin | 0.209 | **0.631** | 0.182 | 1.15 | 3.47 | 13,138 | **846** |
| knowledge-crib | 0.351 | 0.447 | **0.640** | 0.55 | 0.70 | 89,776 | **1,412** |

The graph walk clears the query-blind control on exactly one repository, and is beaten 1.6–8.4× by
mining `git log` — at up to 100× the tokens.

### Why this is not a ranking bug to tune away

Files change together for reasons a dependency graph **cannot observe in principle**: a changelog bump
that rides along with every release, a test conventionally edited beside its implementation, two modules
one maintainer always touches at once. Co-change mining sees all of it because it models the outcome
directly; the graph models dependency, which only partly overlaps. There is also a structural advantage
worth naming plainly — the ground truth here is derived from commits, and co-change mining is *trained
on commits*, so it has access to the label-generating process. It is a very strong baseline by
construction.

The honest response to a free signal that beats your own by 3× is to ship it, clearly labelled.

### What shipped

`impact` now returns a `coChanged` group alongside `affected`:

```json
{ "affected": [ { "id": "sym:…", "rel": "calls", "distance": 1, "risk": "high" } ],
  "coChanged": [ { "file": "packages/mcp/src/server.ts", "commits": 21, "via": "git-history-cochange" } ] }
```

Four decisions in that shape, each load-bearing:

- **Separate, never blended.** A structural edge and a historical correlation support different actions.
  A single list would make them indistinguishable, and a test asserts `affected` is byte-for-byte
  unchanged when the signal is present.
- **The commit count travels with each suggestion.** "Changed together 21 times" and "…once" are not
  equally worth acting on; a bare ranked list would present them as though they were.
- **`via` names the provenance in the payload**, not only in this document. This is history, not
  structure.
- **`coChangeLimit: 0` disables it** for a caller who wants structure only, and the adapter method is
  optional, so an implementor without it degrades to no suggestions rather than a broken verb.

Bulk commits (more than 20 files) are excluded from mining: a formatting sweep would otherwise relate
every file to every other, which is the classic way this technique produces confident nonsense.

### The commit cap, and what measuring it cost

The first shipped default read 1,000 commits of history. Express scored **0.178** with it against 0.335
for the harness's full-history mining — the cap was throwing away more than half the signal, because
express's base tree has ~5,900 commits behind it. Raising it to 5,000 took express to **0.352** (now
slightly *ahead* of full history, which reads more noise) and cost click and gin 0.014 each, inside
noise. Mining 116 tasks with cold CLI starts took 60s total; inside a serving process the index is
memoised per repository.

### What this still does not fix

On **this** repository the signal (0.447) remains below the query-blind churn control (0.640). That is
the degenerate-corpus case: changes here concentrate so heavily in a few hot files that naming the
busiest files is genuinely hard to beat. It is the clearest argument yet that a benchmark on one
churn-concentrated repository cannot be trusted in either direction.

## What these numbers say, stated plainly

**1. Token efficiency and accuracy are both defensible — but only with `--kinds symbol`.** At 3,625
tokens against 24,062 for grep (6.6× fewer) and MRR 0.611 against 0.478 (28% better), the combination
holds. On the DEFAULT ranking it does not: 0.323 is worse than grep, so crib would be delivering worse
answers more cheaply. The product claim therefore depends entirely on which ranking a caller gets, and
the default is currently the losing one.

**2. Only one configuration beats guessing the busiest files.** A control that never reads the question
scores MRR 0.501 on localisation and 0.640 on co-change. `crib --kinds symbol` on a full description
clears it (0.611); crib's default, grep, and every co-change method do not. On co-change the graph
(0.357) also loses to 30-year-old co-change mining over `git log` (0.441), which needs no parser, no
index and no graph — that task remains unimproved.

**3. The commit convention is doing work the index is being credited for.** Stripping the
`fix(freshness):` scope costs crib 18% of its MRR (0.323 → 0.265). A benchmark reporting only the full
message would attribute that to retrieval.

## What these numbers do NOT say

- **This is one repository, and 89% of its commits have one author** whose messages are unusually long.
  Absolute scores are not comparable to any external benchmark. The method-to-method comparison is what
  this supports, and only here.
- **The churn control's strength is partly this repo's shape.** Changes concentrate in a few hot files
  (an 8,000-line `cli.ts` that most commits touch), which raises the query-blind floor and makes this
  corpus a weak discriminator. That is a property of the corpus, not a defence of the graph — but it
  does mean a repository with flatter churn is needed before concluding how large the real gap is.
- **Ground truth is file-level.** A method that finds the right file but the wrong symbol scores a hit,
  which flatters every method equally.
- **A commit message is a post-hoc description, not a bug report.** It proxies "an agent is told what to
  change" better than "an agent is told what is broken".
- **`crib-impact` here reproduces `impact`'s traversal with a deliberately naive ranking** (hop distance,
  then edge count, rel-agnostic, undirected, depth 2). Hub suppression is an obvious improvement. It was
  not applied, because the idea arrived *after* seeing these numbers and fitting it to this corpus would
  produce a number that means nothing — see the pre-registration below.

## What happens next, committed before measuring

Following this repository's own pre-registration practice (`docs/bench/retrieval-pre-registration.md`),
the next round is committed here BEFORE it runs:

1. **Run on three external repositories** with different churn profiles and multiple authors, chosen
   before any result is seen. The SCIP importer makes non-TypeScript repos reachable.
2. **Hypothesis H1:** suppressing hub nodes in the graph walk (excluding nodes whose degree exceeds the
   95th percentile) raises `crib-impact` lift above 1.00 on a held-out repository. Tested on repos not
   used to form the hypothesis.
3. **Hypothesis H2:** crib's localisation MRR rises above grep-bm25's when the query is a symbol-bearing
   question rather than a change description — i.e. the gap above is a property of the task, not of the
   index. If H2 fails, the retrieval path needs work, not framing.
4. **Hypothesis H3 — CONFIRMED and shipped.** Predicted: separate typed groups raise default-path MRR
   to within noise of the `--kinds symbol` row. Measured: 0.610 default against 0.611 explicit, a
   difference of 0.001. The prediction was recorded before the implementation existed.
5. **Hypothesis H4 (new):** the short-query gap is the real remaining weakness. `--kinds symbol` scores
   0.611 on a full description and 0.469 on a subject line, so a terse query still loses to a
   query-blind control. Expanding a short query (symbol-name expansion, or the vector channel, which is
   off by default) is the candidate fix.
6. **The honest interim product claim** the evidence supports today: *with code-first discovery, better
   ranking than ripgrep (MRR 0.611 vs 0.478) at 6.6× fewer tokens — on a richly described change. On a
   one-line query, and on the default blended ranking, that advantage disappears.*
