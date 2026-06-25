# Knowledge-crib — Deep Extraction & Migration (first-class wedge)

> **Goal:** extract a system *completely enough to rebuild it on another stack* — e.g. a PL/SQL
> stored-procedure rule engine → COBOL / Java / .NET. "Everything end-to-end, with **all
> conditions**." Co-equal with the doc-link wedge [Q39]; shares the same soul/index/MCP. The hard,
> distinctive part is capturing the **guard conditions** — because for a rule engine, *the
> conditions are the rules*. Data-model extension specced here [Q40], built as the migration track
> (M10–M12 in the [build plan](knowledge-crib-build-plan.md)).

---

## 1. Why this is its own capability
A plain call graph says *`process_claim` calls `escalate_claim`*. Migration needs *`process_claim`
calls `escalate_claim` **only when `amount > 10000`***. That guard is **control-flow**, not call
structure — so it needs a CFG pass on top of the normal parse/resolve. Everything else (deep call
nesting, which queries/tables each proc touches) is the standard model + a SQL extractor.

| Need | How |
|------|-----|
| Call chains, any depth | existing `calls` edges + `impact(down)` |
| Which tables/columns a proc reads/writes | **new** `table`/`column` nodes + `reads`/`writes` edges |
| SQL statements a proc runs | **new** `statement` nodes + `executes` edges |
| **The guard on each call/action** | **new** CFG pass → `guard` + `cfgPath` on edges, `condition` nodes |
| Rebuildable rule book | **new** `extract_rules` verb + `export --format rules` |

---

## 2. Data-model extension [Q40]
### New node kinds
| `kind` | Represents | id |
|--------|-----------|----|
| `table` | a DB table | `table:<schema.NAME>` |
| `column` | a column | `col:<schema.TABLE.COL>` |
| `statement` | one SQL DML stmt (SELECT/INSERT/UPDATE/DELETE/MERGE) | `stmt:<file>@L<line>` |
| `condition` | a guard/branch predicate | `cond:<file>@L<line>` |

*(Procedures/functions/packages/triggers remain `symbol` nodes with `type` = `procedure|function|package|trigger`.)*

### New edge relations
| `rel` | from → to | meaning |
|-------|-----------|---------|
| `executes` | symbol → statement | proc runs this SQL statement |
| `reads` | symbol/statement → table/column | data read (SELECT) |
| `writes` | symbol/statement → table/column | data written (INSERT/UPDATE/DELETE) |
| `guarded-by` | edge/statement → condition | this call/action runs only if condition holds |

### New metadata on `calls` (and `executes`/`writes`) edges
```jsonc
{ "src":"sym:claims.pkb#process_claim@L10","dst":"sym:claims.pkb#escalate_claim@L80",
  "rel":"calls","method":"static","provenance":"EXTRACTED","confidence":1.0,
  "guard":"v_amt > 10000",                       // the immediate predicate
  "cfgPath":["v_amt > 10000"],                    // FULL guard chain entry→callsite (AND-ed)
  "branch":"then", "inLoop":false, "inException":false }
```
`cfgPath` is the load-bearing field for migration: **the complete ordered list of conditions that
must all hold for this call/action to execute.** Two representations, both supported:
- **lightweight:** `guard`/`cfgPath` strings on the edge (cheap, queryable, good enough for most).
- **full-fidelity:** `condition` nodes + `guarded-by` edges (compound/nested predicates become
  first-class graph objects you can query and dedup).

All deterministic → `provenance: EXTRACTED`. **No LLM guesses a rule** — exactly what migration
demands.

---

## 3. Pipeline additions (see [pipeline](knowledge-crib-pipeline.md) Phases 3c/3d)
- **Phase 3c — SQL data-flow:** parse DML in each proc → `statement` nodes; resolve table/column
  refs against DDL → `reads`/`writes`/`executes` edges.
- **Phase 3d — CFG / condition extraction:** build a per-procedure control-flow graph (IF/ELSIF/
  ELSE/CASE/LOOP/EXCEPTION); for every call site and statement compute the **guard chain** from the
  procedure entry; attach `guard`/`cfgPath`/`branch` and emit `condition` nodes. **Language-specific;
  first target PL/SQL**, framework reused for COBOL/others.

---

## 4. PL/SQL extractor (first migration target)
- Grammar: tree-sitter PL/SQL (or dedicated parser). Emit `symbol(procedure|function|package|
  trigger)`, plus `table`/`column` from DDL.
- **Object types & collections**: `CREATE TYPE … AS OBJECT (…)` becomes a `symbol(type)` node
  carrying the **full attribute field list** on `meta.attributes` (the deep context that was
  previously missing for types like `T_APPLICANT_CTX_OBJ`); `AS TABLE OF` / `AS VARRAY OF` carry
  `meta.collection`. `CREATE VIEW` becomes a `table` node (`meta.kind:"view"`) with explicit
  columns. Without this, an applicant/context object type is invisible to `context`/`source`/`query`
  — only the procedure that uses it shows up.
- Resolver: cross-package proc→proc calls; table/column refs → DDL nodes.
- Pairs with Phase 3d to attach guards.

### 4a. Serving-layer deep context (universal, all languages)
The lean soul stores `file`+`span` references, never source text. Deep context is rehydrated on
demand, language-agnostically, from disk:

- `source(node)` — the full source body of one node's span, budgeted (`maxChars`/`maxLines`).
  A procedure body, a CREATE TABLE DDL, a DML statement, a doc section. Works for **every** parser
  (TS, Java, C#, Go, Rust, Python, PL/SQL), because rehydration is span-based, not AST-based.
- `context(node, {withSource, withRules})` — folds the rehydrated body (`withSource`) and/or the
  decision table (`withRules`, procedures/functions only) into the 360° context, and surfaces every
  captured deep node field rather than just the symbol header.
- `rehydrateBody(repoRoot, node, {maxChars, maxLines})` (exported from `@knowledge-crib/mcp`) — the
  primitive under both verbs, for callers that want the body directly.

This is what closes the "high-level only, not low-level" gap for **all** parsers without per-language
AST deepening: any symbol's full body is one `source` call away.

---

### 4b. Schema 1.2 — behavior-bearing fidelity (the "detailed-level" part)
A call graph + guard chain says *what runs under what condition*. Migration (and any deep analysis)
also needs *what the body **does*** — the raises, the exception handlers, the cursors it iterates, the
case arms, the assignments. Schema **1.2** makes those first-class so the analysis is detailed-level,
not a skeleton. Forward-compatible (1.0/1.1 souls load verbatim; 1.1 `cfgPath:string[]` +
`inLoop`/`inException` are preserved, never widened).

| `kind` | Represents | id | key fields |
|--------|-----------|----|------------|
| `raise` | a throw/`RAISE_APPLICATION_ERROR`/`panic!`/`return Err(…)` | `raise:<file>@L<line>` | `errorCode`, `errorMessage` |
| `exception-handler` | a catch/`except`/`WHEN …`/`defer recover` | `exch:<file>@L<line>` | `whenSelector` |
| `assignment` | `v := …` / `let x = …` / `x = …` | `asgn:<file>@L<line>` | `assignTarget` |
| `case-branch` | one WHEN arm / `case` / `match` arm / `switch` case | `case:<file>@L<line>` | `whenSelector` (omitted for ELSE/default/`_`) |
| `cursor` | a SQL cursor (PL/SQL) | `crs:<file>#<name>@L<line>` | `cursorQuery` |
| `explanation` | a doc comment attached to a symbol | `expl:<path>@L<start>` | `commentRef`, `meta.text` |

| new `rel` | from → to | meaning |
|-----------|-----------|---------|
| `raises` | symbol → raise | this callable throws here |
| `handles` | exception-handler → stmt/raise | handler catches this body action |
| `iterates` | condition → cursor | this loop iterates that cursor |
| `declares` | symbol → cursor | this callable declares that cursor |
| `describes` | explanation → symbol | this doc comment documents that symbol |

All deterministic → `provenance: EXTRACTED`, `confidence: 1`. The guard chain from §2 still stamps
`cfgPath`/`branch`/`inLoop`/`inException` on `raises`/`executes`/`calls` edges, so a raise knows the
*conditions under which it fires* — that is the migration-critical fact (error -20001 happens *only
when `v_decision='REJECT'`*).

### 4c. Cross-language parity (Track 3 + Workstream B)
The same 1.2 constructs are emitted by **every** extractor, capability-honest per language:

| Language | raise | exception-handler | assignment | case-branch | explanation | cursor/iterates |
|----------|-------|-------------------|------------|-------------|-------------|-----------------|
| PL/SQL | `RAISE_APPLICATION_ERROR` | `WHEN …` | `:=` | `CASE WHEN` | `--`/`/* */` | ✅ full |
| TypeScript | `throw` | `catch (e)` | `=`/`let` | `case`/discriminated | `//`/`/** */` | n/a |
| Java | `throw` | `catch`/multi-catch | `=` | `case`+default | `//`/`/* */`/Javadoc | n/a |
| C# | `throw` | `catch`+`when` filter | `=` | `case`+switch-expr | `//`/`///`/`/* */` | n/a |
| Go | `panic`/`errors.New`/`fmt.Errorf` | `defer recover` | `=` | `case`+type-switch | `//`/`/* */` | n/a |
| Rust | `panic!`/`return Err` | *(skipped — no try/catch)* | `let`/`=` | `match` arm | `//`/`///`/`/* */` | n/a |
| Python | `raise` | `except`/tuple/bare | `=`/`:=`/aug | `case`+`_` | `#`/docstring | n/a |

**Capability-honest skips** are documented per extractor: `cursor`/`iterates` are PL/SQL-only (no SQL
cursors elsewhere); Rust has no exception handlers (a `match` on `Result` is already a `case-branch`,
so a handler would double-count); `iterates` over a non-resolvable local collection is skipped rather
than guessed. The extractor never invents a node it can't deterministically ground — so a local LLM
consuming a dossier is never misled by a fabricated edge.

### 4d. Dossier — the persisted reusable deep context (Workstream D/E)
`buildDossier(soul, repoRoot, nodeId, now, opts)` is **pure** over the soul + repoRoot and folds
together everything an agent otherwise assembles from `context` + `source` + `extract_rules`: the
deep node, the paged rehydrated source body, callers/callees, linked docs, the decision table (for a
callable), and the 1.2 control-flow constructs. The pipeline builds + persists it post-resolve
(`runDossiers`, sharded under `.crib/dossiers/`, atomic, hash-anchored to `node.hash`); the MCP
`dossier` verb rebuilds it from the **same code path** on a cache miss — so the persisted artifact
and the live verb output are byte-identical in shape. See [prompts](knowledge-crib-prompts.md) for
how a local LLM consumes it in one call, and [mcp-api](knowledge-crib-mcp-api.md#dossiersymbol) for
the verb contract.

---

## 5. The example, fully represented
```sql
PROCEDURE process_claim(p_id) IS v_amt NUMBER;
BEGIN
  SELECT amount INTO v_amt FROM claims WHERE id=p_id;     -- stmt → reads CLAIMS.amount
  IF v_amt > 10000 THEN escalate_claim(p_id);             -- calls {cfgPath:["v_amt>10000"]}
  ELSE                  auto_approve(p_id);                -- calls {cfgPath:["NOT(v_amt>10000)"]}
  END IF;
END;
-- escalate_claim → notify_manager, hold_funds, log_audit, create_review  (cfgPath inherits)
```
`impact("process_claim","down")` returns the whole tree; each downstream call carries its **inherited
cfgPath** (e.g. `create_review` is reachable only when `v_amt > 10000`). That inherited chain is the
rule.

---

## 6. Migration outputs (what you hand the rebuild)
### `extract_rules` (new MCP verb)
Flattens the CFG into a decision table: for each terminal action, the AND-chain of guards that reach it.
```jsonc
// req: { "proc":"sym:claims.pkb#process_claim@L10" }   // omit → whole system
// res:
{ "rules":[
  { "action":"escalate_claim", "conditions":["v_amt > 10000"], "source":"claims.pkb@L12",
    "reads":["CLAIMS.amount"] },
  { "action":"auto_approve",  "conditions":["v_amt <= 10000"], "source":"claims.pkb@L14" },
  { "action":"create_review", "conditions":["v_amt > 10000"], "source":"claims.pkb@L84",
    "via":["escalate_claim"] }
] }
```
### `crib export --format rules`
Per-procedure **rule book** (CSV/JSON): condition columns + action + source + data touched. This is
the spec a COBOL/Java/.NET rebuild is driven from — and a diff target to prove the rebuild matches.
### `crib export --format mermaid`
The call/condition flow diagram (as shown in chat).

---

## 7. Scale & trust
- Stored-proc systems are large → soul chunking + index handle it; `extract_rules` is per-procedure
  → parallelizable. Ties to **scale-first** [Q11] and C4 (largest-system sizing).
- Guards are **deterministic/EXTRACTED** → trustworthy; an LLM is never in the rule path. Optional
  LLM (via IDE sampling [Q18]) only *names* or *summarizes* rules, always `INFERRED` + filterable.

---

## 8. Build track (first-class, alongside the doc-link MVP) — depends on M0–M3
| M | Deliverable | Gate |
|---|-------------|------|
| **M10** | PL/SQL extractor + SQL data-flow (`table`/`column`/`statement`, `reads`/`writes`/`executes`) | golden: a package → expected procs/tables/edges |
| **M11** | CFG pass + `guard`/`cfgPath`/`branch` on calls + `condition` nodes (PL/SQL) | guard-chain correctness on a branchy fixture proc |
| **M12** | `extract_rules` verb + `export --format rules` (the rule book) | decision-table matches hand-derived rules on fixture |
