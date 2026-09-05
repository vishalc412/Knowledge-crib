# Knowledge Crib — capability matrix

**Dated 6 September 2026.** Branch `debug/auditMaster` @ `0930a52c`. This page states what has been
MEASURED, on what, and what has not. It is the support boundary: if a capability is not listed as
verified here, treat it as unverified regardless of what any other document claims.

Every row links to the evidence that produced it. A row with no evidence link is a claim, and there
are none of those here by design.

## What was tested, and on what

| | |
|---|---|
| Host | Apple M4 Max, arm64, 48 GiB |
| OS | macOS (darwin) — **the only platform exercised** |
| Node | v22.23.1 |
| Packages | 8 workspace packages @ 0.1.0 |
| MCP surface | 17 tools / 47 operations |
| Test suite | **2,729 passing**, `pnpm verify` exit 0 |
| Language extractors | 10 |

Nothing below has been exercised on Linux or Windows. That is not a hedge — no run exists.

## Core capabilities

| Capability | State | Default? | Evidence |
|---|---|---|---|
| Deterministic code graph (index, query, context, impact) | verified | on | [`STATS.md`](STATS.md), 2,729 tests |
| `review` — change review from the graph | verified | on | [`bench/review-cost.md`](bench/review-cost.md) |
| Always-fresh reads while editing (`serve --watch`) | verified, 805-file scale | opt-in | [reference watch run](audits/2026-09-05/evidence/repair/full-watch-results.json) |
| Durable agent memory (record → admit → recall) | verified | opt-in (`crib memory init`) | [audit §R02/R03](audits/2026-09-05/post-merge-reaudit.md) |
| Session resume after an IDE timeout | verified, every client | on when memory is initialised | [audit §R06](audits/2026-09-05/post-merge-reaudit.md) |
| On-device semantic recall | verified | **opt-in** (`crib embed setup`) | [`bench/onnx-model-ladder.md`](bench/onnx-model-ladder.md) |
| Background freshness worker (`auto` mode) | verified with caveats | opt-in | [worker recovery](audits/2026-09-05/evidence/repair/worker-recovery.json) |
| Memory home (web UI) | verified | opt-in (`crib viz`) | [audit §R08](audits/2026-09-05/post-merge-reaudit.md) |
| Encrypted cross-device sync | synthetic soak only | opt-in | [sync soak](audits/2026-09-05/evidence/reaudit/sync-soak.json) |
| Team memory over Git | implemented; not multi-user tested | opt-in | — |
| Authenticated multi-tenancy | **not implemented** | — | [`SECURITY.md`](../SECURITY.md) |

## Semantic retrieval — the numbers, and what they cost

Measured through the launch gate on the frozen 500-query corpus
([`bench/onnx-model-ladder.md`](bench/onnx-model-ladder.md)). **No Python.**

| Tier | G2 paraphrase (≥80%) | G3 MRR (≥0.75) | Gates | Download |
|---|---:|---:|---:|---:|
| none — char-ngram fallback | 2.6% | 0.520 | 6/8 | 0 |
| `--model small` | 66.0% | 0.672 | 6/8 | 97 MB |
| `--model base` | 69.9% | 0.841 | 7/8 | 1.1 GB |
| **`--model large`** (default) | **81.1%** | **0.881** | **8/8** | 2.1 GB |

The advertised semantic tier is `large` and nothing else clears every gate. **A machine that has not
run `crib embed setup` serves the char-ngram fallback** and is at the top row — `crib doctor` and
`crib embed status` both say so rather than implying otherwise.

The ONNX path reproduces the previous Python configuration on all three models measured both ways
(81.0/81.05, 69.9/69.93, 66.0/66.01), which is the evidence the toolchain swap changed the install
and not the ranking.

## Clients

`crib init` detects the client in use and wires only that one.

| Client | Instruction file | MCP config | Lifecycle hooks | Session resume |
|---|---|---|---|---|
| Claude Code | `CLAUDE.md` | `.mcp.json` | **writer** | via hooks + MCP |
| GitHub Copilot | `.github/copilot-instructions.md` | `.vscode/mcp.json` | none | **via MCP** |
| Cursor | `.cursor/rules/crib.mdc` | `.cursor/mcp.json` | none | **via MCP** |
| Codex | `AGENTS.md` | `.codex/config.toml` | none | **via MCP** |
| Windsurf | `.windsurfrules` | global config | none | **via MCP** |
| Gemini | `GEMINI.md` | `.gemini/settings.json` | none | **via MCP** |
| VS Code (non-Copilot) | — (Copilot's file serves it) | `.vscode/mcp.json` | none | **via MCP** |

Only Claude Code exposes a lifecycle-hook surface. Session resume does not depend on it: the MCP
server records the anchor for every client, which is why the six hookless clients are covered.

**Verified end to end:** Claude Code and a Copilot-shaped MCP client. The other five are wired by
the same generated configuration and the same protocol, but have not each been driven through a
full remember → timeout → resume cycle. Treat them as configured, not proven.

## Known limits — read this before adopting

These are open, disclosed rather than fixed. None is a surprise waiting to be found.

1. **macOS only.** Service supervision (`crib freshness service`) generates Linux systemd and
   Windows Task Scheduler definitions that have never been installed or started on those platforms.
   The Windows task declares UTF-16 while the writer emits UTF-8, and the Linux unit does not quote
   a CLI path containing spaces. Both are known-wrong and unfixed.
2. **No authenticated multi-tenancy.** The HTTP boundary is local Host/Origin validation plus a body
   cap. Identity, membership, revocation and scoped audit export do not exist. Do not expose the
   server beyond the local trust model.
3. **CI cannot produce a passing release receipt.** The workflows provision Node and pnpm but not
   the model weights, so `release:evidence --require-pass` cannot go green on a hosted runner even
   though the tier passes locally.
4. **A long revalidation can trigger a spurious lease takeover.** `crib update` parses
   synchronously, blocking the worker's own heartbeat, so a second worker may see a stale lease and
   take over mid-task. Epoch fencing makes this *safe* — the original stands down instead of
   corrupting state — but the work is repeated. `crib status` reports `workerBusy` rather than
   falsely reporting the worker dead.
5. **The memory home shows counts without per-tile actions.** Pending captures and resumable intakes
   are numbers; the panel names the next command and the CLI performs it
   (`crib memory recall --include-pending`, `crib memory admit`).
6. **A restarted reader sees the last indexed commit.** If the graph has not been updated since a
   checkout, a fresh reader answers from the older commit. `crib status` reports
   `aheadOfVcsHead: true` — honest, but it will surprise you if you do not look.
7. **Cross-device sync is synthetic.** A two-device file-backend soak over v1 records, with no
   power-loss or fsync claim. Not a cross-platform network trial.
8. **Graph coverage is partial and says so.** 5,419 unresolved call sites on this repository;
   `status({op:'gaps'})` reports `analysisReadiness: incomplete`. An empty `impact` result is not
   evidence a symbol is unused.

## What would change these rows

- Linux/Windows: a native install/start/restart/uninstall run per platform.
- Multi-tenancy: an identity-bound authorization contract, then a penetration test.
- CI receipt: provision the model in the workflow and archive the receipt per release.
- Clients: drive each through remember → timeout → resume with distinct session ids.

Until those exist, this page stays as written. Historical audit reports under
[`audits/2026-09-05/`](audits/2026-09-05/) remain immutable — they record what was true on their own
date; this page is the current companion to them.
