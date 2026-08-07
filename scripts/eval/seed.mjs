/**
 * Mechanical golden-pair generation for the M1.1 eval harness.
 *
 * Walks a loaded SoulStore and emits three template-driven question families, each pinned to
 * deterministic expected node ids (stable `sym:`/`file:`/`route:` ids — never `c:` cluster ids,
 * which are re-derived each run):
 *
 *  - IDENTITY: one question per named symbol — "what is <qualifiedName>" → [node.id]. Uses
 *    qualifiedName (not bare name) so colliding simple names (e.g. `login` the method vs `Login`
 *    the class) are disambiguated in the query text.
 *  - CALLER: for every resolved `calls` edge A→B, "what does <A> call" → [B.id].
 *  - CALLEE: for every resolved `calls` edge A→B, "who calls <B>" → [A.id].
 *  - ROUTE: for every `route` node, "which handler serves <METHOD> <path>" → [node.id].
 *
 * This is the deterministic complement to the hand-curated conceptual packs in conceptual.mjs.
 * The plan's contract: "mechanically seeded (every route, rule, caller pair)". Rule/decision
 * coverage is carried by IDENTITY on the decision procedures (assess_application, AssessApplication,
 * grade, authorize, approve, …) plus the conceptual packs; the M12 decision-table branch nodes are
 * not yet extracted for all fixtures, so we do not template off them here.
 */

/**
 * A mechanically-seeded golden pair. `expectedIds` are concrete soul node ids resolved at seed
 * time (the seeder has the loaded soul).
 */
export function seedGoldenPairs(soul, lang) {
  const pairs = [];

  // IDENTITY — every named symbol, disambiguated by qualifiedName.
  for (const node of soul.iterate('symbol')) {
    const label = node.qualifiedName ?? node.name;
    if (!label) continue;
    pairs.push({
      id: `${lang}:identity:${node.id}`,
      template: 'identity',
      lang,
      question: `what is ${label}`,
      expectedIds: [node.id],
    });
  }

  // CALLER / CALLEE — every resolved calls edge, both directions.
  for (const edge of soul.iterateEdges('calls')) {
    const a = soul.getNode(edge.src);
    const b = soul.getNode(edge.dst);
    if (!a || !b) continue;
    const aLabel = a.qualifiedName ?? a.name;
    const bLabel = b.qualifiedName ?? b.name;
    if (!aLabel || !bLabel) continue;
    pairs.push({
      id: `${lang}:caller:${edge.id}`,
      template: 'caller',
      lang,
      question: `what does ${aLabel} call`,
      expectedIds: [edge.dst],
    });
    pairs.push({
      id: `${lang}:callee:${edge.id}`,
      template: 'callee',
      lang,
      question: `who calls ${bLabel}`,
      expectedIds: [edge.src],
    });
  }

  // ROUTE — every HTTP route node (java/csharp fixtures only carry real route decorators).
  for (const node of soul.iterate('route')) {
    const method = (node.httpMethod ?? 'GET').toUpperCase();
    const path = node.routePath ?? '';
    pairs.push({
      id: `${lang}:route:${node.id}`,
      template: 'route',
      lang,
      question: `which handler serves ${method} ${path}`,
      expectedIds: [node.id],
    });
  }

  return pairs;
}
