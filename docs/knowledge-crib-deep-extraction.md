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
- Resolver: cross-package proc→proc calls; table/column refs → DDL nodes.
- Pairs with Phase 3d to attach guards.

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
