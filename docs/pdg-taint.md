# PDG + taint analysis (Gate 5.2)

`crib explain` / MCP `explain` builds a **program dependence graph for one callable** on demand and
reports source→sink taint flows over it. It exists to answer "can request-supplied input reach this
dangerous call?" for a specific function — a question the extracted graph (calls, CFG constructs,
decision tables) does not answer, because it reasons about structure, not value flow.

---

## Capability table

| Capability | Status |
|---|---|
| Languages | **TypeScript / JavaScript only** (`.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs`) |
| Scope | **Intra-procedural only** — one function body per call |
| Control dependence | Post-dominator rule (Ferrante–Ottenstein–Warren), incl. loop-predicate self-dependence |
| Data dependence | Reaching definitions (may-analysis: both may-defs reach a join) |
| Taint propagation | CFG + local defs + conservative control dependence |
| Sanitizers | Context-scoped (`encodeURIComponent` clears the url context only) |
| Rule table | Plain data, user-extensible (`extraRules` / `--rules <file>`) |
| Opt-in | **On demand — nothing runs during `crib index`**; first run stamps `capabilities.pdg` |
| Cross-function flows | **Not supported** — see honesty statement |
| Interprocedural / whole-program | Not supported |
| Alias / field-sensitivity | Not modeled (textual + AST-name matching) |

---

## What the analysis does

1. **Control dependence** — statement B is control-dependent on branch A when A has two or more
   successors and B post-dominates one of them but not A. Loop conditions depend on themselves
   (the standard result for loop predicates). Unreachable statements (code after a terminator)
   are excluded from the graph entirely.
2. **Data dependence** — a classic reaching-definitions fixpoint over the CFG: assignments are
   definitions, identifier references are uses, a reassignment kills prior defs of the same
   variable. At branch joins every reaching definition is kept (may-analysis).
3. **Taint** — sources seed variables (`req.query`/`req.params`/`req.body`, `process.env`,
   `json.parse`, `fs` reads, `argv`, `URLSearchParams`), taint flows along CFG edges and local
   definitions, and — conservatively — a tainted branch condition taints everything it guards.
   Sinks are `eval`/`new Function`, shell exec/spawn, SQL `.query()`/`.execute()`, `innerHTML`/
   `dangerouslySetInnerHTML`/`document.write`, `fs` writes/unlinks of unvalidated paths, and
   `fetch`. Sanitizers clear contexts: schema validators (`z.object`, `.validate`, …) clear all;
   `encodeURIComponent` clears **only** the url context, so the same value reaching a shell sink
   still reports.

The default table stays deliberately small (<20 rules). It is plain data
(`DEFAULT_TAINT_RULES` in `packages/pipeline/src/pdg/taint.ts`) and callers extend it:

```jsonc
// crib explain <node-id> --rules extra-rules.json
[
  { "id": "source.config", "kind": "source", "match": ["readconfig("] },
  { "id": "sink.magic", "kind": "sink", "match": ["domagic("], "context": "code" }
]
```

---

## Honesty statement

Read this before treating any result as a security verdict.

- **An empty `flows` list is NOT proof of safety.** The analysis is intra-procedural: values
  returned to callers, passed as arguments to other functions, or stored in shared/module state
  are **not followed**. A real cross-function flow cannot appear here, so its absence proves
  nothing.
- **A reported flow is possible, not confirmed.** Matching is conservative and
  textual/AST-name-based (`req.query…`, `exec(`, `innerhtml`, …); it over-approximates on purpose
  — extra edges are the correct direction, missed real edges are the failure mode.
- **Sanitizers are context-scoped, and context-scoping is honest, not complete.**
  `encodeURIComponent` cleans a URL context, not a shell. The rule table models what it knows;
  it does not model a value being safe everywhere.
- **When no sink matched at all**, the response says *nothing was checked* — that is also not a
  safety statement.
- Every response carries a `limits` array restating the first three points, so a consumer cannot
  miss what the analysis does not claim.

## Query surface

```bash
# CLI — analyze the callable a graph node points at
crib explain sym:src/http.ts#Controller.handleLogin@L5
crib explain <node-id> --rules ./extra-rules.json

# MCP — one standalone tool
explain({ "id": "sym:src/http.ts#Controller.handleLogin@L5" })
```

Errors: `UNSUPPORTED_LANGUAGE` (non-TS/JS), `NOT_CONFIGURED` (server built without the analyzer —
`crib serve` and the CLI wire it; bare library consumers may not), `NO_BODY` (no function body
found for the symbol), `FILE_UNAVAILABLE` (source file missing on disk).