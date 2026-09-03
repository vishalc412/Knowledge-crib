/**
 * G3.2 — the HELD-OUT paraphrase split for the retrieval-scorer eval
 * (docs/bench/retrieval-pre-registration.md, section 1).
 *
 * WHY a held-out split: the 40 paraphrase queries already published in docs/bench/memory.md are the
 * DEV set — the G3.2 fusion work was built while looking at them, so selecting the launch default on
 * them would be selection on the test set. Each entry here is a NEW hand-written paraphrase for the
 * SAME topic index as `TOPICS` (scenarios.ts), committed to the repository together with the frozen
 * pre-registration BEFORE any held-out number was measured.
 *
 * Construction invariants (asserted by `retrieval-eval.test.ts`, never hand-waved):
 *   1. zero word tokens shared with the labeled record's own claim;
 *   2. word-disjoint from the PUBLISHED (dev) paraphrase of the same topic — the held-out set is not
 *      a rewording of the dev set;
 *   3. index-aligned: `HELDOUT_PARAPHRASES[i]` labels exactly the record `relevanceCorpus()` emits
 *      for topic `i` (one query, one labeled record — the clean 1.0 ceiling the corpus fix bought).
 *
 * Determinism: a fixed literal list, no randomness, no wall clock — two runs of the eval embed the
 * identical query set, so the selection rule's input is reproducible byte-for-byte.
 *
 * Provenance note (G3.2 integration): the first gate run found 32 entries violating invariants 1–2
 * (mostly shared function words, a few content tokens). Every violating entry was rewritten to the
 * invariants BEFORE the deciding eval was ever measured — no held-out number informed the rewording
 * (the rewrite predates the first `runRetrievalEval` measurement), so the split stays honest.
 */

/**
 * The held-out paraphrase for topic `i`. Index-aligned with the private `TOPICS` bank in
 * `scenarios.ts` — the `retrieval-eval.test.ts` zero-overlap assertions are what keep this
 * alignment honest if the topic bank ever changes (a length mismatch or a token collision fails
 * the eval tests loudly).
 */
export const HELDOUT_PARAPHRASES: readonly string[] = [
  // 0 — deploy retries / exponential backoff
  'ship pipeline stalls then holds off longer on each go and surrenders after a few rounds',
  // 1 — pnpm dedupe / lockfile churn
  'eliminating repeated package copies restores a tidy node_modules',
  // 2 — parser hangs on stray WHEN blocks
  'unexpected reserved words stall the scanner because error recovery stops making headway',
  // 3 — evaluator re-grounds claims on recall
  'statements are checked versus fresh knowledge whenever answers get fetched rather than assumed true',
  // 4 — secrets never land in the ledger
  'password material is refused at ingestion so nothing sensitive reaches disk',
  // 5 — blake3 content addressing dedupes observations
  'cryptographic fingerprints merge recurring entries beneath a single identifier',
  // 6 — gate refuses without a committed policy
  'elevation stays halted until its signed ruleset document lands somewhere readable',
  // 7 — local quarantine cannot retract team trust
  'a single workstation disapproval leaves colleague beliefs intact',
  // 8 — candidates stay out of recall until evaluated
  'unvetted observations hide from answers pending successful review',
  // 9 — receipts store a digest, not raw output
  'proof artifacts keep checksums rather than full terminal transcripts',
  // 10 — conflicts surface together, no silent winner
  'opposing claims are shown jointly with no quiet champion selected',
  // 11 — merge driver unions shards by content id
  'concurrent authors reconcile across identical payload keys only',
  // 12 — watch mode reindexes only dirty files
  'edits trigger refreshes scoped to touched sources, never everything',
  // 13 — snapshot tests fail on rendered drift
  'pixel comparisons versus approved baselines halt release whenever UI changes',
  // 14 — connection pool drains before worker exit
  'spare sessions close tidily ahead of thread termination',
  // 15 — rate limiter sheds load with 429
  'traffic spikes are refused upstream once capacity would overflow',
  // 16 — migrations in one transaction roll back wholly
  'database version bumps are all-or-nothing: any breakdown reverts wholly',
  // 17 — cache invalidation on write, not timers
  'refresh callbacks respond per mutation rather than by clocks',
  // 18 — isolated commits rebased before merging
  'sideline branches undergo a rebase atop trunk first, shipping afterward',
  // 19 — deadlock detector aborts the sweep
  'mutual blocking between contended latches ends patrol execution early',
  // 20 — idempotency keys make retried deliveries safe
  'repeat callbacks land once because request markers dedupe them',
  // 21 — feature flags default off until flipped
  'toggles ship disabled, awaiting maintainer activation',
  // 22 — schema validation rejects malformed shards
  'corrupt chunks are turned away ahead of ingestion',
  // 23 — backpressure propagates when the queue is full
  'saturated send channels ask emitters for restraint',
  // 24 — retry budget caps attempts across the path
  'repeat delivery spending is pooled over one shared journey',
  // 25 — canonical JSON sorts keys for stable hashing
  'properties emit alphabetized, keeping byte fingerprints reproducible',
  // 26 — shard checksums verified after transport
  'payload digests undergo re-checking upon arrival, preceding consumption',
  // 27 — health checks probe a real dependency
  'readiness pings touch genuine backing systems, not canned acknowledgments',
  // 28 — log sampling keeps 1 in 10 spans, errors always
  'ordinary traces drop nine tenths, though failures persist',
  // 29 — index rebuilds offline under a lock
  'rebuilding occurs guarded by mutual exclusion, handing consumers an unchanging view',
  // 30 — garbage collector removes unresolvable records
  'dangling references are swept away amid tidy-up',
  // 31 — audit trail records who approved promotion
  'approval ledgers name whoever signed plus their moment',
  // 32 — bulk import streams rows in chunks
  'oversized feeds are consumed through bounded slices, RAM held level',
  // 33 — optimistic concurrency rejects stale revisions
  'out-of-date assumptions make saves fail rather than clobber newer data',
  // 34 — query results capped before pagination metadata
  'row counts undergo truncation inside service code, preceding paging construction',
  // 35 — zero downtime deploys swap the socket
  'connections migrate onto replacement workers as soon as their checks pass',
  // 36 — telemetry batches emit every five seconds
  'measurements flow out in grouped windows rather than singly',
  // 37 — dependency graph resolves build order topologically
  'inter-package links decide construction ordering preceding any translation',
  // 38 — token budget truncates context before the model call
  'overlong histories shrink within their allowance preceding dispatch',
  // 39 — adversarial prompts stripped before tool execution
  'malicious user text is scrubbed free from smuggled orders prior to command invocation',
];

/**
 * The held-out queries over the relevance corpus: identical labels to `relevanceCorpus(n)`'s own
 * paraphrase family, with the held-out wording swapped in. `n` is capped at the bank size exactly
 * like `relevanceCorpus` (cycling would emit duplicate labels for near-identical records).
 */
export function heldOutQueries(
  n: number,
  corpusQueries: ReadonlyArray<{
    query: string;
    relevantIds: string[];
    family: 'exact' | 'paraphrase';
  }>,
): Array<{ query: string; relevantIds: string[]; family: 'heldout-paraphrase' }> {
  const count = Math.min(n, HELDOUT_PARAPHRASES.length);
  const out: Array<{ query: string; relevantIds: string[]; family: 'heldout-paraphrase' }> = [];
  for (let i = 0; i < count; i++) {
    // The corpus emits [exact(i), paraphrase(i)] per topic — the paraphrase label at 2i+1 carries
    // the same relevant record id the held-out query must label.
    const label = corpusQueries[2 * i + 1];
    if (!label) break;
    out.push({
      query: HELDOUT_PARAPHRASES[i]!,
      relevantIds: [...label.relevantIds],
      family: 'heldout-paraphrase',
    });
  }
  return out;
}
