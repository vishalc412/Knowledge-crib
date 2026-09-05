# Knowledge-crib — Executive Brief

> A portable "project soul" for AI coding agents. Index a codebase **once** into a local knowledge
> graph, then serve it to any AI agent over a standard protocol — so the agent understands the
> project **faster**, with **~22× fewer tokens**, and stops making architecture-breaking changes.

**Status:** `0.1.0` release candidate · Apache-2.0 · local-first · zero network dependency in the core path.

---

## 1. Executive summary

AI coding agents are expensive and unreliable for one avoidable reason: **they have no memory of the
codebase.** Every session, the agent re-reads whole files to rebuild understanding it had yesterday.
That re-reading is the single largest, most repetitive line item in an agent's token bill — and the
root cause of agents "breaking things" because they only ever see a keyhole view of the system.

Knowledge-crib fixes this at the source. It indexes a repository once into a queryable graph (the
*soul*) and serves precise, pre-computed answers to any agent through the Model Context Protocol
(MCP). The agent asks "what is `X` and what does it touch?" and gets a one-line snippet plus the
relationships as graph edges — instead of reading three whole files to reconstruct the same fact.

**The measured result on our own repository, for one real cross-package task:**

| | Tokens pulled into context | Cost (cache cleared) |
|---|---:|---:|
| Without Knowledge-crib (agent reads files) | 23,014 | $0.069 |
| **With Knowledge-crib** | **1,047** | **$0.003** |
| **Difference** | **22× fewer** | **22× cheaper** |

This is not a projection. It is a reproducible benchmark shipped in the product (`pnpm ab:task`).
The 22× is the **conservative, cache-cleared** number; with prompt caching in play the advantage is
larger still. Every claim in this brief is backed by a script an engineer can run in under a minute.

---

## 2. The business problem

Three costs, all growing with AI-agent adoption:

1. **Token spend.** Agents re-read source files every session. On a large codebase, a single
   "understand this area" task pulls tens of thousands of tokens of raw file text into context —
   repeatedly, across every developer, every day. Token cost scales linearly with headcount × usage.

2. **Latency.** Reading and re-reading files is the slow part of an agent turn. More tokens in
   context also means slower, more expensive model calls. Developers wait; momentum is lost.

3. **Risk / rework.** An agent that only sees the file in front of it makes changes that break
   callers it never looked at. Architecture-breaking edits become review burden, bugs, and incidents
   — the most expensive failure mode of all.

The common thread: **the agent lacks durable, structured context about the codebase.** Knowledge-crib
supplies exactly that.

---

## 3. What it is (in plain terms)

- A **one-time index** of your codebase into a compact knowledge graph — the "soul" — stored locally
  in the repository's `.crib` folder. Symbols (functions, classes, types), files, clusters, and the
  relationships between them (calls, reads, references, dependencies).
- **One fast MCP server.** MCP is the emerging open standard that connects AI agents to tools and
  data. Knowledge-crib is a server any MCP-capable agent can talk to — no bespoke integration.
- **Agent-agnostic and cross-IDE.** The same soul serves Claude Code, Cursor, VS Code extensions,
  or any custom agent. Index once; every tool benefits.
- **Local-first and private.** The core indexing and query path makes **zero network calls**. Source
  code never leaves the machine. This is enforced as a build-breaking test, not a promise.

---

## 4. The benefits, quantified

| Benefit | What it means | Evidence |
|---|---|---|
| **~22× fewer tokens per task** | The agent gets the answer, not the raw files | `pnpm ab:task` — 23,014 → 1,047 tokens |
| **~22× lower cost (cache cleared)** | Direct, plan-independent dollar saving | cold lens: $0.069 → $0.003 per task |
| **Larger saving with caching** | The served context is byte-stable, so it caches | up to 94× on a multi-turn task |
| **Faster answers** | Less context to assemble and process per turn | fewer file reads, warm queries <150 ms (CI gate) |
| **Fewer broken changes** | Agent sees callers/dependents via `impact` before editing | graph-backed blast-radius verb |
| **Lean by default, deep on demand** | Default answer ~1.3 KB/hit; full analysis one flag away | ~7.7× smaller per hit than the full blob |
| **Tiny footprint** | Ships small, adds almost nothing to the stack | ≤6 runtime deps, <5 MB packaged |

**Why "more tokens can still cost less" — and why we don't rely on that.** On subscription plans,
re-read context can be subsidized by prompt-cache pricing, which can make a larger context appear
cheaper. That effect is real but plan-specific. Knowledge-crib's headline number deliberately
**clears the cache and prices every token as fresh input** — the honest floor. Even with no caching
advantage whatsoever, the product is ~22× cheaper, because *you cannot be charged for tokens you
never needed to read.* Caching only widens the gap.

---

## 5. How it works (the actual mechanism)

```
  ┌─────────────┐     index once      ┌──────────────┐     serve over MCP    ┌───────────────┐
  │  Your repo   │ ───────────────────▶│  The "soul"   │ ─────────────────────▶│   Any AI agent │
  │  (source)    │   crib index         │  .crib graph  │   query / context /   │  (Claude,      │
  └─────────────┘                       │  (local)      │   neighbors / impact  │   Cursor, …)   │
                                        └──────────────┘                       └───────────────┘
                                              ▲                                        │
                                              │        incremental re-index            │
                                              └────────  as the code evolves  ◀─────────┘
```

1. **Index (once).** `crib index` parses the codebase and extracts symbols, files, and their
   relationships into a local SQLite-backed graph. Multi-language (TypeScript/JS, PHP, and more via
   pluggable extractors). Runs on a 50-file fixture in well under the 20-second CI budget; scales to
   real repositories.

2. **Persist as the soul.** The graph lives in `.crib` inside the repo. It is the project's durable
   memory — committed or regenerated, versioned alongside the code, shared across the team and across
   tools. As the code changes, an **incremental** re-index updates only what moved.

3. **Serve, lean by default.** The agent calls verbs over MCP. The default response is deliberately
   compact — a one-line snippet per hit, plus a small 5-field pointer when a deeper LLM analysis
   exists (**not** the multi-kilobyte analysis blob). The full brief is one flag away (`--with-llm`)
   when the agent actually needs it. This tiering is what makes the crib *pay for itself* rather than
   add cost: **~1.3 KB/hit by default vs ~10.3 KB with the full blob (~7.7× smaller).**

4. **Answer, don't re-read.** Instead of reading whole files, the agent asks targeted questions:

   | Verb | Answers the question |
   |---|---|
   | `query` | "Where is `X`?" — BM25 search over code + docs |
   | `context` / `dossier` | "Explain `X` in depth" — body, callers, callees, rules |
   | `neighbors` | "What does `X` directly touch?" — graph edges |
   | `impact` | "What breaks if I change `X`?" — blast radius up/down |
   | `reconstruct` | "Rebuild this package's shape" — members, constants, tables |
   | `shortest_path` | "How are `X` and `Y` connected?" |
   | `extract_rules` | "What business rules live in this procedure?" |
   | `detect_changes` | "What changed since the last index?" (read-only) |

   *(see docs/STATS.md for counts; the above are the highest-value ones for executives to understand the shape.)*

5. **Stay honest under measurement.** The served context is **byte-deterministic** — the same query
   returns identical bytes every time — which is both a correctness property and the precondition for
   prompt-cache reuse. This is enforced by an automated cache-stability test.

---

## 6. Proof — reproducible, not marketing

The product ships its own measurement harness. Anyone can verify the claims on a checked-out,
indexed repository:

| Command | What it proves |
|---|---|
| `pnpm ab:task` | Real task, both ways: 22× fewer tokens, 22× cheaper (cold), up to 94× (warm) |
| `pnpm bench` | Per-query token savings vs reading whole files |
| `pnpm budget:check` | **Build-breaking** gates: cost saving ≥3×, hit size ≤1.5 KB, warm query <150 ms, cold index <20 s, package <5 MB, ≤6 deps, zero network calls in core |
| `pnpm cache:stability` | The served context is byte-identical across calls (cache-safe) |
| `pnpm cost:report` | Ingests real `/usage` numbers from two live sessions and reconciles the dollar difference on two pricing lenses |

The three cost lenses, one task, so the number is never cherry-picked:

- **Cold (cache cleared):** 22× cheaper — *the conservative floor, plan-independent.*
- **Warm, both sides cached fairly:** 22× cheaper — *holds.*
- **Warm, realistic (no-crib re-reads churn):** 94× cheaper — *best case.*

The economics are guarded in CI: if a future change ever bloats the response or erases the saving,
the build breaks. **"Lightweight" and "cheaper" are facts the pipeline enforces, not opinions.**

---

## 7. Integration

**Effort to adopt: low.** Knowledge-crib is a standard MCP server plus a CLI. There is no code to
rewrite and no vendor lock-in (Apache-2.0).

1. **Install & index.** Add the package; run `crib index` on the repo. One command, one-time cost;
   incremental thereafter.
2. **Register the MCP server** with each agent/IDE (Claude Code, Cursor, VS Code, or a custom agent).
   Standard MCP configuration — the same mechanism these tools already use for other servers.
3. **Agents use it automatically.** Once registered, the agent's discovery and impact questions route
   through the crib's verbs instead of raw file reads. No prompt engineering required.
4. **Keep it fresh in CI.** Re-index on merge (incremental), and optionally run `pnpm budget:check`
   as a gate so the cost/latency guarantees hold as the codebase grows.

**Fits the existing stack:**

- **Runtime:** Node.js ≥ 22.5 (uses the built-in `node:sqlite` — no native build step, no compiler
  toolchain, no fragile install).
- **Footprint:** ≤6 external runtime dependencies, <5 MB packaged. Adds negligible weight.
- **Security posture:** zero network calls in the core path (enforced); source stays local. Suitable
  for regulated / air-gapped environments.
- **Portability:** the soul is a local artifact; index on one machine or in CI, share across the team.

---

## 8. Rollout path

| Phase | Action | Outcome |
|---|---|---|
| **1 — Pilot (1 week)** | Index one high-traffic repo; enable for a small dev group | First-hand token/latency reduction on real tasks |
| **2 — Measure** | Run `pnpm ab:task` and capture two-session `/usage` via `pnpm cost:report` | Dollar saving quantified on *your* codebase |
| **3 — Standardize** | Register the MCP server org-wide; add `budget:check` to CI | Saving locked in; guarantees enforced automatically |
| **4 — Expand** | Add language extractors as needed; index more repos | Compounding saving across the portfolio |

---

## 9. Risks & guardrails

| Concern | Mitigation (already built) |
|---|---|
| "Will it drift from the code?" | Incremental re-index + `detect_changes`; freshness is measurable |
| "Will responses bloat over time?" | CI budget gates fail the build if hit size or cost regresses |
| "Is the saving real or an artifact?" | Cold (cache-cleared) lens proves it plan-independently |
| "Does it phone home / leak code?" | Zero-network core, enforced by test; local-first by design |
| "Native-build install pain?" | `node:sqlite` — no native compilation, no toolchain |
| "Vendor lock-in?" | Apache-2.0, open standard (MCP), local artifact |

---

## 10. The ask

Approve a **one-week pilot** on a single high-traffic repository. Success criterion is objective and
self-measured: **≥5× token reduction on real discovery tasks** (the shipped benchmark already shows
~22× cold). If the pilot hits that bar, standardize the MCP server across teams and add the budget
gate to CI.

The downside is one week and one repo. The upside is a structural, compounding reduction in the
fastest-growing line item in the engineering AI budget — and fewer agent-caused regressions.

---

*Every figure in this document is reproducible from the codebase: `pnpm ab:task`, `pnpm bench`,
`pnpm budget:check`, `pnpm cache:stability`, `pnpm cost:report`.*
