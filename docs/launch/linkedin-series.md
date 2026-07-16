<!-- Launch asset — LinkedIn post series draft. Human-reviewed before posting (M4.6 gate). The plan references a linkedin-vishal skill; these are content drafts for that workflow. Tone: professional, story-led, one idea per post, end with a question. Grounded in technical-pitch.md; keep claims audit-consistent. -->

# Knowledge-crib — LinkedIn launch series (draft)

A 5-post arc. One idea each. Post order matters: problem → mechanism → moat → proof → ask. Keep each ≤ 1300 chars (LinkedIn truncation). Replace `[LINK]` with the canonical repo URL once M4.5 lands.

---

## Post 1 — The problem (why agents burn tokens + break architecture)

AI coding agents are amnesiacs. Every session they re-read files to rebuild an understanding a human architect already holds in their head. That's expensive (tokens) and dangerous (they miss the architectural invariants a senior engineer would never violate).

What if the project *remembered* its own architecture — not as a doc a human maintains, but as a queryable graph the agent reads on demand?

I've been building Knowledge-crib: a deterministic code knowledge graph you commit with your code and serve to any agent over MCP. The agent retrieves bounded, provenance-tagged context instead of re-reading the whole repo.

The graph is the project's soul. It's git-diffable. Every edge says whether it was extracted from code or inferred, and with what confidence.

More on the mechanism tomorrow. [LINK]

---

## Post 2 — The mechanism (parse → graph → commit → serve)

How Knowledge-crib works, in one pipeline:

Repository + docs → language extractors (TS/JS, Python, PL/SQL, Java, C#, Go, Rust, PHP, Markdown) → cross-file resolution + control-flow / SQL passes → doc-to-code links + clusters + ownership (git blame) → a committed JSONL "soul" → a rebuildable SQLite index → bounded MCP tools.

Two stores, hard trust boundary:
- **Soul**: committed, git-diffable, portable, schema-validated. Source of truth.
- **Index**: derived, gitignored, rebuildable. Never source of truth. Vectors live only here — so the committed soul stays deterministic forever.

Beyond symbols/calls: SQL tables + statements, conditions, exceptions, routes, fields, owners, outbound HTTP calls. 20 node kinds, 21 relations.

The behavior layer is the interesting part — tomorrow. [LINK]

---

## Post 3 — The moat (behavior depth + grounded LLM semantics)

Two things I couldn't find together in any other tool:

**1. A behavior layer, not just navigation.** PL/SQL control-flow extraction attaches guard chains, branch/loop/exception context to calls. Rule extraction materializes decision tables + Mermaid flows. This answers "what does this 1990s loan-rule engine actually decide?" — the legacy-modernization wedge. Joern/CodeQL own taint for security; this targets agent context + migration.

**2. Grounded LLM semantics, opt-in.** The deterministic soul creates work items. The host agent writes the analysis (the crib process never calls a model). On save, every claimed evidence span is rehydrated and requires quote overlap — ungrounded quoted submissions are rejected, model strings are scanned for secrets, and `crib audit-llm` re-verifies after refactors.

Precision: quote overlap proves source anchoring, not truth. It's grounded enrichment, not formal verification.

The matrix vs the field is in the repo. [LINK]

---

## Post 4 — The proof (reproducible, not vibes)

"Best retrieval" is a claim that should be measured, not asserted.

- A retrieval eval harness runs in CI with regression gates (recall@10, MRR, nDCG per language).
- A parser fuzzer (fast-check, 10⁶ iters/extractor nightly) found a real sync-hang bug in the C# extractor before shipping.
- A scale bench measures wall + peak RSS across LOC slices — memory is sub-linear, index time is super-linear (documented honestly, with per-module souls as the answer).
- A `crib doctor` + `crib init` give 5-minute onboarding; a GitHub Action refreshes the committed soul on every merge (and a gate pins that a no-op update is byte-idempotent, so it doesn't spam git-log).

`release:verify` is green: build + ~1000 tests + every gate. Self-indexed dogfood — the repo's own soul is committed.

Reproducible commands in the repo. [LINK]

---

## Post 5 — The honest limits + the ask

Before you ask: the honest limits.

- Hybrid retrieval (vectors + RRF + rerank) is a tested component, not the default CLI runtime path yet.
- Scale: great memory story, honest time story (per-module souls for very large repos).
- Access model inherits the repo's git ACL — local-first, not enterprise SSO/RBAC (yet).
- Language fidelity varies; PHP lacks cross-file resolver depth. Unresolved refs are dropped, not guessed.
- npm publish + canonical GitHub home are pending (user-gated, imminent).

The ask: if you run a legacy modernization program or a multi-service change-risk program, I'd like to pilot this with you. We'd measure time-to-context, agent token use, impact-path correctness, and developer trust in the provenance.

What's the one codebase you wish your AI agent already understood? [LINK]