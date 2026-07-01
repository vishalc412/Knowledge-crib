/**
 * M12 mermaid renderer — turns a {@link DecisionTable} into a `flowchart TD` graph. The procedure
 * entry node fans out to its top-level actions and, for each guard condition, a decision rhombus
 * whose THEN/ELSE/ELSIF edges lead to the guarded actions. Valid graph markup (parseable by the
 * mermaid CLI / any mermaid renderer); nodes are quoted so SQL text with special chars is safe.
 */
import type { DecisionTable, RuleRecord } from '@knowledge-crib/core';

/** Render a decision table as a mermaid flowchart. */
export function renderMermaid(table: DecisionTable): string {
  const lines: string[] = ['flowchart TD'];
  const ids = new Map<string, string>();
  let n = 0;
  const nid = (key: string): string => {
    let id = ids.get(key);
    if (id === undefined) {
      id = `n${n++}`;
      ids.set(key, id);
    }
    return id;
  };
  const label = (s: string): string => s.replace(/"/g, "'");

  const procNode = nid(`proc:${table.procedure}`);
  lines.push(`  ${procNode}["${label(table.procedureName ?? table.procedure)}"]`);

  // group rules by their materialized cfgPath key so each condition rhombus is emitted once
  const byPath = new Map<string, RuleRecord[]>();
  for (const r of table.rules) {
    const key = r.conditions.map((c) => c.id).join('|');
    const list = byPath.get(key);
    if (list) list.push(r);
    else byPath.set(key, [r]);
  }

  for (const [pathKey, rules] of byPath) {
    if (pathKey === '') {
      // top-level actions: straight from the procedure node
      for (const r of rules) lines.push(`  ${procNode} --> ${actionNode(nid, r)}`);
      continue;
    }
    // guarded actions: route through the innermost condition rhombus, labelled by polarity
    const guard = rules[0]!.guard;
    const condNode = guard ? nid(`cond:${guard}`) : procNode;
    if (guard) {
      const cond = rcondExpr(table, guard);
      lines.push(`  ${procNode} --> ${condNode}{${JSON.stringify(label(cond))}}`);
    }
    for (const r of rules) {
      const act = actionNode(nid, r);
      const polarity = r.branch ?? '*';
      lines.push(`  ${condNode} -->|${polarity}| ${act}`);
    }
  }
  return lines.join('\n');
}

/** The expression for a condition id, looked up from the table's rules; falls back to the id. */
function rcondExpr(table: DecisionTable, condId: string): string {
  for (const r of table.rules)
    for (const c of r.conditions) if (c.id === condId) return c.expr ?? condId;
  return condId;
}

/** Emit an action node definition (shape + label) and return its node id. */
function actionNode(nid: (k: string) => string, r: RuleRecord): string {
  const a = r.action;
  const id = nid(`act:${a.edgeId}`);
  const head =
    a.kind === 'calls'
      ? `call ${a.expr ?? a.target}`
      : `${a.sqlKind ?? 'stmt'}${a.expr ? `: ${a.expr}` : ''}`;
  // "[" => rounded rect node shape; quoted text keeps SQL safe
  return `${id}["${head.replace(/"/g, "'")}"]`;
}
