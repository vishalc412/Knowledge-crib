# The M2.2 structural prior: on or off?

Decided 2026-09-24. **Keep it on.** `rerank:check` becomes a ratchet: the fixture deltas may not get
worse than their recorded baseline.

## The question

Since at least 2026-09-21, `rerank:check` had failed on every PR (evidence register §4.4). It asserted
that the structural prior (centrality × stereotype × kind, applied after RRF in
`SqliteIndexStore.query`) must *beat* plain RRF on the fixture eval. On today's code it does not:

| Fixture eval (9 synthetic fixtures, about 40 conceptual pairs) | Conceptual MRR | Conceptual R@10 |
| --- | --- | --- |
| plain RRF | 0.683908 | 0.950079 |
| RRF × structural prior (the default) | 0.670347 | 0.950045 |
| Δ | **−1.36pp** | −0.003pp |

Taken at face value, the gate asks for the prior to be switched off. That would change the default
ranking for every index that carries vectors. So the same comparison was run on the stronger
instrument before deciding.

## The stronger instrument disagrees

The 61-task, leakage-controlled locate corpus (`docs/bench/locate-corpus.json`) scores the shipped
`crib query` path on this repository at the corpus base commit `d8727898`. The tree used is the one
WP4 R3 indexed with vectors (`multilingual-e5-large`), and every run reports
`servedLexically: false`. The two arms differ in one variable only: the prior, switched off by
`docs/program/tools/no-rerank-preload.mjs`. Same tree, same index, same machine, run back to back.

| 61-task corpus, `full` variant | MRR | R@1 | R@5 | R@10 |
| --- | --- | --- | --- | --- |
| prior **on** (C1, the default) | **0.4169** | **0.2178** | **0.4087** | **0.5478** |
| prior **off** (C2, plain RRF) | 0.3389 | 0.1598 | 0.3809 | 0.4989 |
| Δ (on − off) | **+7.80pp** | +5.80pp | +2.78pp | +4.89pp |

The two other query variants point the same way. On `subject` the prior is ahead on MRR (0.2939 vs
0.2823) but behind on R@5 and R@10. On `no-scope`, MRR is 0.2584 vs 0.2205. Raw outputs:
`docs/program/logs/rerank-prior-c{1,2}-2026-09-24.json`.

**Validity check.** The prior-on arm reproduces WP4 R3's published C1 exactly (MRR 0.4169). That shows
the probe measures the same path the published number did, before its prior-off number is believed.

## Why the two instruments disagree

The fixtures are small, synthetic call graphs in which degree carries little signal. On a real
repository, a symbol's connectedness is informative. The fixture eval also has a confound, found
while bisecting the gate: centrality counts **every** edge, including the `owned-by` edges the M3.1
ownership layer derives from `git blame` of the repository that contains the fixtures. At `19fa1e3c`
the gate passes with `git blame` available (Δ +0.10pp) and fails without it (Δ −0.39pp). So its
verdict depended on whether the fixtures sat in a git checkout. On today's code the confound does
not explain the red: without blame the delta is −2.40pp.

## Decision

1. **The prior stays on.** Turning it off would cost about 7.8pp MRR on real retrieval to gain 1.36pp
   on synthetic fixtures.
2. **`rerank:check` is a ratchet** (`scripts/rerank-baseline.json`). It fails if the fixture MRR delta
   or recall delta falls below the recorded baseline, and it still enforces determinism across two
   independent runs. When a change improves the MRR delta, the gate says to raise the baseline.
3. **Not decided here:** whether centrality should exclude non-code relations (`owned-by`,
   `member-of`). That is a ranking change and needs its own two-instrument measurement.

## Limits

- One repository and one corpus. The corpus was authored on this repository, and `docs/program/wp4-implementation-spec.md` §10.8(7)
  records that its discriminating power is concentrated on one frequently changed file
  (`packages/cli/src/cli.ts`). The churn control (MRR 0.5012) still beats both arms, so neither
  arm clears WP4's clause 1. This result compares the two arms; it does not certify either.
- Both arms were measured under the same machine load. Latency was not compared.
