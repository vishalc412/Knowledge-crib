# Track 3 — Statement/Condition/CFG extraction for all parsers (design spec)

**Goal:** make the language-agnostic `extract_rules` decision-table verb work for TypeScript, Java,
C#, Go, Rust, and Python — not just PL/SQL. `extract_rules` (in `packages/core/src/rules/extract.ts`)
is already pure-over-soul and language-agnostic: it walks a procedure's `executes`/`calls` edges,
reads each edge's `cfgPath`/`guard`/`branch`/`inLoop`/`inException`, and materializes the inherited
path condition. **No change to `extract_rules` or to `core` is needed.** The work is entirely in the
per-language extractors: emit the right nodes + annotated edges.

## The gold pattern (already proven): `PlSqlExtractor`

`packages/parsers/src/plsql/PlSqlExtractor.ts` already does exactly this for PL/SQL. Read it first.
Its `walkBlock` / `walkIf` / `walkLoop` / `addSql` / `addCall` / `addPlainLike` / `condition` methods
are the template. The new languages mirror this, with ONE simplification: track the **full guard
stack** inline and stamp `cfgPath` directly on the edges at emission time, so no separate CFG pass
(re-parse) is needed per language. (PL/SQL uses a two-phase design — extractor emits raw, then
`PlSqlCfgPass` re-parses to annotate `cfgPath` — because its extractor predates the inline-stack idea.
The new languages do it in one pass.)

## What each language extractor must emit (additive — keep existing symbol/member-of/calls behavior)

For each procedure/function/method symbol (a `symbol` node of type `procedure`|`function`|`method`),
walk its body's statements and emit:

### 1. `condition` nodes — one per IF / WHILE / FOR / SWITCH-CASE predicate
```ts
{
  id: ctx.idFor('condition', { file: path, line: <predicate start line> }),
  kind: 'condition',
  branch: 'THEN' | 'ELSIF' | 'ELSE' | 'LOOP' | 'CASE',   // polarity/role of this predicate
  expr: '<the predicate source text, best-effort>',
  file: path,
  span: { start: <line>, end: <line> },
  lang: '<lang>',
  hash: ctx.hash(`${path}:${line}:${expr}`),
}
```
**Convention (match PL/SQL exactly):** an IF contributes ONE condition node, keyed by
`(file, ifStartLine)` — dedupe so all branches of one IF share the same condition id. The node's
`branch` field is set by the first branch that creates it (typically `'THEN'`). The per-branch
polarity (`THEN`/`ELSIF`/`ELSE`) is carried on the EDGE's `branch` field, NOT duplicated as separate
condition nodes. `while`/`for` predicates → one condition node with `branch:'LOOP'`. A loop does not
have an ELSE polarity. Dedupe conditions by `(file, line)` in a `Set` (like PlSqlExtractor.condSeen).
For `switch`/`match`/`case`: model the switch expression as one condition (`branch:'CASE'`), or each
case predicate as a condition — keep it simple and honest; prefer one condition per `case` predicate
with `branch:'CASE'`.

### 2. `statement` nodes — one per "action" line in the body (call / return / assign / throw / raise)
```ts
{
  id: ctx.idFor('statement', { file: path, line: <stmt start line> }),
  kind: 'statement',
  type: 'call' | 'return' | 'assign' | 'throw' | 'expr' | 'plain',  // NO sqlKind for non-SQL langs
  expr: '<the statement source text, best-effort, ≤200 chars>',
  file: path,
  span: { start: <line>, end: <line> },
  lang: '<lang>',
  hash: ctx.hash(`${path}:${line}:${type}`),
  meta: {
    head: '<the action head, e.g. callee name for a call>',
    inLoop: <boolean>,
    inException: <boolean>,
    branch: <guardStack non-empty ? 'GUARDED' : undefined>,
  },
}
```
**What counts as an action line** (emit a statement node for it):
- A method/function **call** (`foo()`, `this.foo()`, `obj.foo()`, `Foo.bar()`) → `type:'call'`,
  `expr` = the call text, `meta.head` = the callee simple name.
- A **return** statement → `type:'return'`, `expr` = `return …`.
- An **assignment** with a call on the RHS (`x = foo()`) → `type:'assign'` (or `'call'` if a call is
  the notable action — pick one and be consistent; prefer `'call'` when the RHS is a call so the
  decision table surfaces the call, else `'assign'`).
- A **throw / raise** → `type:'throw'`.
- Plain expressions / declarations → `type:'plain'` (optional — only emit if it carries a call;
  otherwise skip to keep the graph lean).

Do NOT emit a statement node for every line — only for action lines (calls, returns, throws, and
assignments-with-calls). The decision table's rows are these actions under their path conditions.

### 3. `executes` edges — procedure symbol → each statement node in its body
```ts
{
  id: edgeId(procId, stmtId, 'executes'),
  src: procId, dst: stmtId, rel: 'executes',
  method: 'static', provenance: 'EXTRACTED', confidence: 1,
  evidence: { by: '<lang>-extractor', snippet: '<expr or head>' },
  // the guard chain — the whole point:
  cfgPath: <string[]>,      // guardStack.slice() — outer→inner condition ids
  guard: <string|undefined>,   // guardStack[guardStack.length-1] — innermost condition id
  branch: <string|undefined>,  // polarity of the INNERMOST IF on the path: 'THEN'|'ELSIF'|'ELSE'|'LOOP'|'CASE'
  inLoop: <boolean>,
  inException: <boolean>,
}
```
Only include `guard`/`branch` when guardStack is non-empty. `cfgPath` is always the array (empty `[]`
at procedure top level — that's fine, extract_rules maps `[]` → no conditions). `branch` records
polarity ONLY for the innermost IF (the M11 convention — see `extract.ts` comment). An outer
condition on the path appears in `cfgPath` but its polarity is NOT recorded (leave the edge's
`branch` as the innermost branch only).

### 4. `calls` edges — procedure → callee symbol (intra-file resolved) — annotate + record call sites
The existing extractor already emits intra-file `calls` edges (proc→callee, deduped per pair).
Extend each with the guard-chain fields (best-effort — one edge per (proc,callee), so if the same
callee is called in two branches, the edge carries the cfgPath of ONE site; that's the documented
lossy-but-honest behavior, see `extract.ts` `callLineIndex`). ALSO stamp the proc node's
`meta.calls` with every call site `{ callee: <simple name>, line: <call site line> }` (extract_rules
recovers the call-site line from this when the edge's dst is the callee's definition). Mirror
PlSqlExtractor.addCall exactly.

### 5. `guarded-by` edges — statement → innermost condition (optional, graph completeness)
```ts
edge(stmtId, guardId, 'guarded-by', '<IF|LOOP|CASE>')
```
Emit only when guardStack is non-empty. Matches PlSqlExtractor.

## The body-walk (the core algorithm each extractor adds)

```
walkBody(stmts, procId, guardStack, inLoop, inException):
  for stmt in stmts:
    if stmt is a call/action:
      emit statement node (type/expr/head/span)
      emit executes edge procId→stmtId with cfgPath=guardStack.slice(), guard=last,
           branch=(innermost branch label or undefined), inLoop, inException
      if stmt is a call AND callee resolves intra-file:
        emit/annotate calls edge procId→calleeId (deduped) with same guard fields (best-effort)
        record {callee, line} on proc.meta.calls
      if guardStack non-empty: emit guarded-by stmtId→guardStack.last
    if stmt is IF:
      condId = condition(predicate, ifLine, 'THEN')   // deduped by (file,ifLine)
      walkBody(thenBranch, procId, [...guardStack, condId], inLoop, inException)  // branch THEN
      for each elif: condId2 = condition(elifPredicate, elifLine, 'ELSIF')  // OR reuse condId if you key by IF line — pick one convention and be consistent; simplest: one cond per IF, edge branch carries THEN/ELSIF/ELSE
         walkBody(elifBranch, procId, [...guardStack, condId2], inLoop, inException)
      for else: walkBody(elseBranch, procId, [...guardStack, condId], inLoop, inException)  // branch ELSE — SAME condId, edge branch='ELSE'
    if stmt is FOR/WHILE:
      condId = condition(predicate, loopLine, 'LOOP')
      walkBody(loopBody, procId, [...guardStack, condId], inLoop=true, inException)
    if stmt is TRY:
      walkBody(tryBody, procId, guardStack, inLoop, inException=true)
      except handlers: walkBody(handlerBody, procId, guardStack, inLoop, inException=true)
    if stmt is SWITCH/MATCH:
      for each case: condId = condition(casePredicate, caseLine, 'CASE'); walkBody(caseBody, procId, [...guardStack, condId], inLoop, inException)
```
**Key:** the `guardStack` is passed by VALUE (`[...guardStack, condId]`) so siblings don't pollute
each other. The `branch` on the edge is the label of the branch the statement is IN (THEN/ELSIF/ELSE
for the innermost IF; LOOP for a loop; CASE for a case) — only for the innermost condition on the
stack.

## Per-language parser work

Each hand-rolled parser (`packages/parsers/src/{java,csharp,go,rust,python}/{lexer,parser}.ts`)
currently produces a DECLARATION tree (classes/methods/fields + flat call sites) and skips compound
statement structure. Extend the parser to ALSO produce a statement tree per method body: capture
`if`/`else if`/`else`/`for`/`while`/`switch`/`case`/`try`/`catch`/`return`/`throw`/`assign`/`call`
with their predicates (source-text span) and nested bodies, so the extractor can walk it with a
guard stack. TypeScript already has a real statement AST via the compiler API — no parser change,
just an extractor body-walk over `ts.Block` / `ts.IfStatement` / `ts.ForStatement` / etc.

**Tolerant + lossy is fine** (matches the PL/SQL posture): the parser must never throw; a malformed
compound statement degrades to skipping its body. Predicate text is best-effort (`node.getText()`
for TS; a token-range slice for the hand-rolled parsers). Spans are 1-based start lines.

## Tests (each language — add to the existing `Extractor.test.ts`)

Mirror `PlSqlExtractor.test.ts` Track-2 block + `verbs.test.ts` extract_rules block. Per language,
add a fixture + tests asserting:
1. A procedure with an `if/else` emits ONE condition node (keyed by the IF line) + statement nodes
   for the calls in each branch, with `executes` edges carrying `cfgPath`=[condId], `guard`=condId,
   `branch`='THEN' for the then-branch action and 'ELSE' for the else-branch action.
2. A `for`/`while` loop body action carries `inLoop:true` on its `executes` edge + a `branch:'LOOP'`
   condition.
3. `extract_rules(procName)` on that procedure returns rules with the right `conditions` (innermost
   tagged with `polarity`), `action.kind`='executes'/'calls', `action.expr`, `inLoop`.
4. Existing declaration/member-of/intra-file-calls behavior is UNCHANGED (the new emission is
   strictly additive — re-run the existing golden tests; they must still pass).
5. Degradation: a malformed method body yields no statement/condition nodes, never throws.

Use the real `SoulStore` + `decisionTable` (from `@knowledge-crib/core`) for the extract_rules test,
exactly like `verbs.test.ts`'s `extract_rules` describe block. For the extractor unit tests, use the
same `ctxFor` pattern as `PlSqlExtractor.test.ts`.

## Wiring (minimal)

- `packages/parsers/src/index.ts`: export any new statement/condition AST types if you add them
  (optional — only if other packages need them; the extractor consumes them internally). Avoid
  changing existing exports.
- NO changes to `pipeline/src/resolve/*` or `pipeline/src/pipeline.ts` — `extract_rules` reads the
  soul directly; there is no new resolver or CFG pass to register.
- NO changes to `core/src/rules/extract.ts` — it already consumes the edges you will emit.

## Definition of done (per language)
- `pnpm --filter @knowledge-crib/parsers typecheck` clean.
- `pnpm --filter @knowledge-crib/parsers test` green (existing + new).
- `npx biome check packages/parsers/src/<lang>` clean.
- An extract_rules end-to-end test (extractor → soul → `decisionTable`) returns a non-empty
  decision table with correct conditions + actions for a guarded procedure.