# Reference enrichment provider (Anthropic)

A worked example of a `crib enrich run --provider` program. **It is an example, not a shipped
feature** — the crib server makes no model calls, and that is deliberate: it is what keeps the
deterministic core offline and provider-neutral. This file exists because that stance had a cost
nobody intended, and this is the cheapest honest way to remove it.

## The problem this solves

The semantic layer is empty on a fresh index and there were only two ways to fill it:

1. `/crib-enrich`, the bundled skill, which drives the queue **one batch per host-agent turn** — fine
   for a module, impractical for a repository.
2. `crib enrich run --provider <name>`, which spawns a program from `~/.crib/providers.json` — and
   that program did not exist. You wrote it, or you got nothing.

So the measured state of a fresh index of crib's own repository was **3,826 targets pending, 0
fresh, `coverage.pct: 0`** — an entire half of the product gated behind writing an LLM integration
first. Copy this file and that gate is gone.

## Setup

```bash
npm install @anthropic-ai/sdk
export ANTHROPIC_API_KEY=...       # or: ant auth login   (then set nothing)
```

`~/.crib/providers.json` — **user-owned, never in the repository**, because a committed file could
smuggle an arbitrary `command`:

```json
{
  "providers": {
    "anthropic": {
      "command": ["node", "/absolute/path/to/examples/providers/anthropic/provider.mjs"],
      "concurrency": 2,
      "timeoutMs": 300000
    }
  }
}
```

Then, **starting small**:

```bash
crib enrich --scopes                              # how many targets are pending, by layer
crib enrich run --provider anthropic --max-batches 1
crib status                                       # graph.semantic should now be non-zero
```

## Read this before running it on a whole repository

**One model call per target, and targets are counted in thousands.** On crib's own repository:

| layer | targets |
|---|---:|
| symbol | 1,863 |
| file | 953 |
| cluster | 1,009 |
| system | 1 |
| **total** | **3,826** |

The bill scales with that number, not with your patience. Three controls worth using:

- `crib enrich --scopes` and `crib enrich --overview` tell you the count and the per-module split
  **before** you spend anything.
- `--max-batches N` bounds a run. Start at 1 and look at what came back.
- `--budget-tokens N` on `crib enrich` bounds the work handed out.

Enrichment is also **resumable by construction**: a failed item is not saved, so its target stays
pending and the next run re-offers it. Killing a run mid-way loses the in-flight items and nothing
else. There is no partial-state cleanup to do.

The bottom-up order (symbol → file → cluster → system) is not arbitrary — an upper layer is authored
from the analyses beneath it, so running only the symbol layer is a coherent stopping point while
skipping it is not.

## The protocol, if you write your own

- **One work item per invocation**, JSON on stdin: `{ targetId, seed, lowerLayer, outputSchema,
  instructions, suggestedTier }`.
- **The whole of stdout must parse as one JSON object.** A log line, a banner, or a newline before the
  opening brace is a per-item failure. Send every diagnostic to stderr.
- Return `{ targetId, model?, analysis, graph: { nodes, edges }, evidence }`.
- **Pass `instructions` and `outputSchema` through verbatim.** They are produced by crib's planner,
  which knows which layer is being authored and what grounded evidence that layer may see. A provider
  that substitutes its own prompt is answering a different question than the queue asked.
- **Take `targetId` from the work item, never from the model.** The runner checks that the returned id
  matches the dispatched one; using the dispatched id makes a mismatch impossible rather than merely
  detected — and a seed mentioning several symbols makes that an easy mistake.
- **Quotes must be copied exactly.** `crib enrich save` re-grounds every evidence quote against the
  real source and drops what it cannot verify. An approximated or reflowed quote is a quote you threw
  away, so prefer fewer exact ones. `crib audit-llm` re-checks the whole layer later.
- **Failing is safe.** Non-zero exit, timeout, bad JSON, or a shape mismatch leaves the target pending
  and resumable. Failing quietly with a plausible-but-wrong payload is the only real hazard, which is
  why the example refuses rather than repairs.

Programs are spawned with `shell:false`, so no work-item string can become a shell command, and
`concurrency` is hard-clamped to 4.

## Notes on this implementation

- **Model** is `claude-opus-5`. Enrichment output feeds every later `query` and `context` answer, and
  a cheap summary of the wrong thing is worse than no summary — it looks authoritative. Change it if
  you have measured that a smaller model holds up on your codebase.
- **Streaming** (`.finalMessage()`), because the output is large and structured; a non-streaming call
  at this `max_tokens` risks an HTTP timeout.
- **Adaptive thinking** is on. Authoring a grounded architectural summary is the kind of work it helps,
  and `budget_tokens` is rejected on this model family.
- **Refusal fallbacks** are on. A policy decline would otherwise end the turn with no output, which
  here means a permanently stuck target.
- **`stop_reason` is checked before the content is read.** A refusal and a truncation both produce a
  200 with unusable content, and checking after the JSON scan would report "no JSON object" while
  hiding the real cause.
- **The JSON extractor is brace-balanced and string-aware.** `indexOf('{')` … `lastIndexOf('}')`
  breaks on a brace inside a quoted string, which analysis prose contains routinely.
- **Structured outputs are not used.** The work item carries a raw **JSON Schema**, while the
  documented TypeScript helper (`zodOutputFormat`) takes a Zod schema. Rather than guess at an
  undocumented raw-schema form, this instructs via the prompt and validates the result. If you want
  the server to enforce the shape, convert `outputSchema` to Zod and pass
  `output_config: { format: zodOutputFormat(YourSchema) }`.

## Cheaper and local alternatives

The provider contract is just stdin/stdout JSON, so anything that can read JSON and produce JSON
works — an Ollama-backed script, a hosted model from another vendor, or a queue that batches
overnight. Two shapes worth knowing:

- **Batch API** — the same calls at roughly half the cost if you can tolerate asynchronous
  processing. It does not fit the one-item-per-invocation contract directly; you would collect work
  items with `crib enrich --save <file>`, submit them as a batch, and feed the results back.
- **A smaller model for the symbol layer, a larger one above it.** `suggestedTier` on each work item
  is the planner's own hint about which tier a target deserves — this example ignores it, and a
  cost-sensitive provider should not.
