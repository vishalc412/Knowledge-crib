/**
 * G4 — PL/SQL ↔ C# decision-table parity harness.
 *
 * Indexes the PL/SQL loan-rule-engine fixture and the C# port fixture into two in-memory souls,
 * runs the SAME language-agnostic decision-table extraction (`extractRules`, the code path the MCP
 * `extract_rules` verb uses) on the `assess_application` / `AssessApplication` procedures, and reports
 * whether the C# migration faithfully reproduces the PL/SQL decision table: which rules matched,
 * which are PL/SQL-only, which are C#-only, and the overall equality.
 *
 * PURE over the souls: the only side effect is creating a temp crib dir per index (cleaned up on
 * exit). The fixture roots are read-only — indexRepo never writes into the repo root. Deterministic
 * (fixed `now` timestamp), offline, no network.
 *
 * Normalization (documented): a PL/SQL rule and its C# port are "matched" if their normalized
 * condition set + normalized action signature are equal. The normalizer closes the cosmetic gap
 * between the two languages so a faithful port compares equal:
 *   • lowercase + collapse whitespace
 *   • strip the PL/SQL `v_` local-variable prefix (`v_amount` → `amount`)
 *   • drop underscores (`credit_score` ↔ `CreditScore` both → `creditscore`) — snake/camel unification
 *   • `:=` → `=`, `AND`/`OR` → `&&`/`||`, single quotes → double quotes
 *   • strip spaces around operators
 *   • loop row-source expressions are NOT comparable (PL/SQL cursor `c_app` vs C# method
 *     `SelectApplications(pId)` — different sources, same structural role) → normalized to the
 *     constant `<loop>` so a loop-guarded rule on both sides matches on "this runs in a loop".
 *   • assignment RHS: the PL/SQL extractor stores only the RHS in `expr` (`'APPROVE'`); the C#
 *     extractor stores the full statement (`decision = "APPROVE"`). The harness strips the
 *     `<assignTarget> =` prefix from the C# expr before normalizing so both reduce to the RHS.
 *   • polarity (THEN/ELSIF/ELSE/WHEN/CASE) is NOT part of the signature — the labels differ across
 *     languages; the condition EXPRESSION is the comparable part.
 *
 * Known residual gap (honest, NOT force-matched): the C# extractor models `throw` as BOTH a
 * statement node (with an `executes` edge → a rule row) AND a `raise` node (with a `raises` edge,
 * not a rule row). The PL/SQL extractor models `RAISE_APPLICATION_ERROR` as a `raise` node with a
 * `raises` edge ONLY — NO `executes` edge, so a PL/SQL raise is NOT a rule row. The C# throw
 * statement rules therefore have no PL/SQL counterpart and appear in `onlyCSharp`. Likewise the
 * PL/SQL `UPDATE` statements (executes → sqlKind:'update') have no C# counterpart (the C# port
 * calls `UpdateApplication`, a `calls` edge) and appear in `onlyPlSql`. The PL/SQL searched-CASE
 * `ELSE` arm produces an empty-condition `case-branch` node; the C# `if/else` ELSE branch still
 * carries the IF condition in its cfgPath, so the REJECT-assignment rules do not match. These
 * asymmetries are reported, not papered over.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, extractRules, findProcedure, newManifest } from '@knowledge-crib/core';
import type { RuleRecord } from '@knowledge-crib/core';
import type { Node } from '@knowledge-crib/soul-schema';
import { indexRepo } from '../pipeline.js';

/** Options for {@link decisionParity}. */
export interface ParityOpts {
  /** Absolute path to the PL/SQL fixture root (indexed as a read-only repo). */
  plsqlRoot: string;
  /** Absolute path to the C# fixture root (indexed as a read-only repo). */
  csharpRoot: string;
  /** Deterministic commit timestamp; defaults to a fixed epoch. */
  now?: string;
  /** PL/SQL procedure qualified name to locate (default: the loan-engine assess_application). */
  plsqlProcedure?: string;
  /** C# procedure qualified name to locate (default: the LoanRuleService.AssessApplication). */
  csharpProcedure?: string;
}

/** A rule reduced to its comparable signature. */
export interface NormalizedRule {
  /** sorted normalized condition expressions (the cfgPath materialized) */
  conditions: string[];
  /** normalized action signature (e.g. `assign:decision="approve"`, `call:updateapplication`) */
  action: string;
  /** the raw rule record, for debugging / failure dumps */
  raw: RuleRecord;
}

/** A matched pair — a PL/SQL rule and its C# counterpart with equal signatures. */
export interface RuleMatch {
  plsql: NormalizedRule;
  csharp: NormalizedRule;
}

/** The parity report. `equal` is true iff every PL/SQL rule matched a C# rule and vice versa. */
export interface ParityReport {
  matched: RuleMatch[];
  onlyPlSql: NormalizedRule[];
  onlyCSharp: NormalizedRule[];
  equal: boolean;
}

/** Normalize an expression to its comparable form (see module doc). */
function normExpr(s: string): string {
  return s
    .toLowerCase()
    .replace(/\bv_/g, '') // strip PL/SQL local-variable prefix
    .replace(/_/g, '') // snake/camel unification
    .replace(/:=/g, '=') // PL/SQL assignment
    .replace(/\band\b/g, '&&')
    .replace(/\bor\b/g, '||')
    .replace(/'/g, '"') // quote unify
    .replace(/;/g, '') // statement terminator — not semantically meaningful
    .replace(/\s*([=<>!&|(),.])\s*/g, '$1') // strip spaces around operators / dotted
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract the RHS of an assignment expression.
 *  PL/SQL stores only the RHS in `expr` (e.g. `'APPROVE'`) — no `=` present → return as-is.
 *  C# stores the full statement, optionally with a type prefix (`decimal amount = rec.Amount` or
 *  `decision = "APPROVE"`) → return everything after the first standalone assignment `=`.
 *  A "standalone `=`" is one that is NOT part of `==`, `>=`, `<=`, `!=`, or `=>`. */
function rhsOf(expr: string): string {
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] !== '=') continue;
    const prev = expr[i - 1];
    const next = expr[i + 1];
    // skip ==, >=, <=, !=, and => (arrow)
    if (next === '=' || prev === '=' || prev === '!' || prev === '>' || prev === '<') continue;
    return expr.slice(i + 1).trim();
  }
  return expr; // no standalone assignment = → already RHS (PL/SQL case)
}

/** Build the normalized action signature for one rule. */
function actionSig(soul: SoulStore, rule: RuleRecord): string {
  const a = rule.action;
  if (a.kind === 'calls') {
    return `call:${normExpr(a.expr ?? '')}`;
  }
  // executes → statement / assignment node
  const target: Node | undefined = soul.getNode(a.target);
  if (target?.kind === 'assignment') {
    const t = target.assignTarget ?? '';
    const rhs = rhsOf(target.expr ?? '');
    return `assign:${normExpr(t)}=${normExpr(rhs)}`;
  }
  if (target?.sqlKind) {
    return `sql:${target.sqlKind}:${normExpr(target.expr ?? '')}`;
  }
  // statement leaf (throw / return / call statement)
  return `stmt:${target?.type ?? ''}:${normExpr(target?.expr ?? '')}`;
}

/** Build the sorted normalized condition signatures for one rule. Loop conditions collapse to
 *  `<loop>` — the row source is not comparable across languages, only the structural role is. */
function condSigs(soul: SoulStore, rule: RuleRecord): string[] {
  const out: string[] = [];
  for (const c of rule.conditions) {
    const node = soul.getNode(c.id);
    const expr = node?.expr ?? node?.whenSelector ?? '';
    if (node?.kind === 'condition' && node.branch === 'LOOP') {
      out.push('<loop>');
    } else {
      out.push(normExpr(expr));
    }
  }
  return out.sort();
}

/** Full signature for a rule: conditions + action. */
function sigOf(soul: SoulStore, rule: RuleRecord): string {
  return `${condSigs(soul, rule).join('|')}::${actionSig(soul, rule)}`;
}

function normalizeRules(soul: SoulStore, rules: RuleRecord[]): NormalizedRule[] {
  return rules.map((raw) => ({
    conditions: condSigs(soul, raw),
    action: actionSig(soul, raw),
    raw,
  }));
}

/**
 * Index `root` into a fresh temp soul and return the soul (caller must clean up `cribDir`). The
 * fixture root is treated as a read-only repo — indexRepo discovers files but never writes into it.
 */
async function indexRoot(root: string, now: string): Promise<{ soul: SoulStore; cribDir: string }> {
  const cribDir = mkdtempSync(join(tmpdir(), 'crib-parity-'));
  const soul = new SoulStore(cribDir, { manifest: newManifest({ now }) });
  soul.load();
  // dossiers OFF — we only need the soul graph + cfgPath-annotated edges for extractRules.
  await indexRepo(soul, root, { now, dossiers: false });
  return { soul, cribDir };
}

/**
 * Run the decision-table parity comparison between the PL/SQL `assess_application` and the C#
 * `AssessApplication` procedures. Returns the matched / only-PL/SQL / only-C# rule sets + equality.
 *
 * Greedy multiset match: each rule is matched at most once (a rule signature that appears N times on
 * one side matches at most N times on the other). Equal iff both only-* sets are empty.
 */
export async function decisionParity(opts: ParityOpts): Promise<ParityReport> {
  const now = opts.now ?? '2026-01-01T00:00:00.000Z';
  const plsqlProc = opts.plsqlProcedure ?? 'loan_engine.assess_application';
  const csharpProc =
    opts.csharpProcedure ?? 'Crib.LoanRuleEngine.LoanRuleService.AssessApplication';

  const pl = await indexRoot(opts.plsqlRoot, now);
  const cs = await indexRoot(opts.csharpRoot, now);
  try {
    const plProc = findProcedure(pl.soul, plsqlProc);
    const csProc = findProcedure(cs.soul, csharpProc);
    // If either procedure is missing, return an empty report with equal:false — the harness reports
    // the gap honestly rather than throwing. The caller asserts the procedures are found separately.
    if (!plProc || !csProc) {
      return { matched: [], onlyPlSql: [], onlyCSharp: [], equal: false };
    }
    const plRules = normalizeRules(pl.soul, extractRules(pl.soul, plProc.id));
    const csRules = normalizeRules(cs.soul, extractRules(cs.soul, csProc.id));

    // multiset match on the full signature
    const csBySig = new Map<string, NormalizedRule[]>();
    for (const r of csRules) {
      const k = `${r.conditions.join('|')}::${r.action}`;
      const arr = csBySig.get(k) ?? [];
      arr.push(r);
      csBySig.set(k, arr);
    }
    const matched: RuleMatch[] = [];
    const onlyPlSql: NormalizedRule[] = [];
    for (const r of plRules) {
      const k = `${r.conditions.join('|')}::${r.action}`;
      const arr = csBySig.get(k);
      if (arr && arr.length > 0) {
        const c = arr.shift()!;
        matched.push({ plsql: r, csharp: c });
        if (arr.length === 0) csBySig.delete(k);
      } else {
        onlyPlSql.push(r);
      }
    }
    const onlyCSharp: NormalizedRule[] = [...csBySig.values()].flat();

    return {
      matched,
      onlyPlSql,
      onlyCSharp,
      equal: onlyPlSql.length === 0 && onlyCSharp.length === 0,
    };
  } finally {
    rmSync(pl.cribDir, { recursive: true, force: true });
    rmSync(cs.cribDir, { recursive: true, force: true });
  }
}

/** Re-export for tests / consumers that want to debug a single rule's signature. */
export { sigOf, normalizeRules };
